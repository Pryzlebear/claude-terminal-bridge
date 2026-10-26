// Minimal OAuth 2.1 authorization server for claude.ai custom connectors.
//
// claude.ai only offers OAuth for custom connectors (no static bearer
// header), so the bridge brings its own: RFC 8414 metadata, RFC 9728
// protected-resource metadata, RFC 7591 dynamic client registration, the
// authorization-code flow with mandatory PKCE (S256), and refresh tokens.
//
// Consent is gated by the bridge access key: whoever completes /authorize
// must type it in. Redirect URIs are restricted to the claude.ai callback
// (plus any configured extras), so a stranger who finds the public URL can
// neither register a client that redirects elsewhere nor obtain a token
// without the key. Tokens are stored only as SHA-256 hashes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACCESS_TTL_S = 60 * 60; // 1 hour
const CODE_TTL_S = 10 * 60; // 10 minutes
const REFRESH_TTL_S = 180 * 24 * 60 * 60; // 180 days, sliding
const MAX_FAILS = 5;
const LOCK_S = 15 * 60;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function timingSafeEqualStr(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) {
        crypto.timingSafeEqual(ba, ba);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class OAuthServer {
    constructor(config, log = console) {
        this.config = config;
        this.log = log;
        this.file = path.join(config.dataDir, 'oauth-state.json');
        this.codes = new Map(); // in memory only: short-lived
        this.fails = []; // timestamps of failed key attempts
        this.lockedUntil = 0;
        this.state = { clients: {}, access: {}, refresh: {} };
        this.load();
    }

    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.state = { clients: raw.clients || {}, access: raw.access || {}, refresh: raw.refresh || {} };
        } catch {
            /* first start */
        }
        this.prune();
    }

    save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    prune() {
        const t = now();
        for (const [k, v] of Object.entries(this.state.access)) if (v.exp < t) delete this.state.access[k];
        for (const [k, v] of Object.entries(this.state.refresh)) if (v.exp < t) delete this.state.refresh[k];
    }

    baseUrl(req) {
        if (this.config.publicUrl) return this.config.publicUrl;
        const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${this.config.port}`).split(',')[0].trim();
        return `${proto}://${host}`;
    }

    // ---- metadata -------------------------------------------------------

    authServerMetadata(req) {
        const base = this.baseUrl(req);
        return {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
            scopes_supported: ['bridge'],
        };
    }

    resourceMetadata(req) {
        const base = this.baseUrl(req);
        return {
            resource: `${base}/mcp`,
            authorization_servers: [base],
            bearer_methods_supported: ['header'],
            scopes_supported: ['bridge'],
            resource_name: 'Claude Terminal Bridge',
        };
    }

    wwwAuthenticate(req) {
        return `Bearer resource_metadata="${this.baseUrl(req)}/.well-known/oauth-protected-resource"`;
    }

    // ---- registration ---------------------------------------------------

    register(body) {
        const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
        if (redirectUris.length === 0) {
            return { status: 400, json: { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' } };
        }
        const bad = redirectUris.filter((u) => !this.config.redirectUris.includes(u));
        if (bad.length) {
            this.log.warn(`[oauth] registration refused, redirect_uri not allowed: ${bad.join(', ')}`);
            return { status: 400, json: { error: 'invalid_redirect_uri', error_description: 'redirect_uri not allowed by this server' } };
        }
        const method = body.token_endpoint_auth_method || 'none';
        if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
            return { status: 400, json: { error: 'invalid_client_metadata', error_description: 'unsupported token_endpoint_auth_method' } };
        }
        const clientId = token(16);
        const client = {
            client_id: clientId,
            client_name: String(body.client_name || 'unnamed').slice(0, 100),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: method,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_id_issued_at: now(),
        };
        let secret;
        if (method !== 'none') {
            secret = token(32);
            client.secret_hash = sha256(secret);
        }
        this.state.clients[clientId] = client;
        this.save();
        this.log.info(`[oauth] registered client "${client.client_name}" (${clientId})`);
        const out = { ...client };
        delete out.secret_hash;
        if (secret) {
            out.client_secret = secret;
            out.client_secret_expires_at = 0;
        }
        return { status: 201, json: out };
    }

    // ---- authorization --------------------------------------------------

    validateAuthorizeParams(p) {
        const client = this.state.clients[p.client_id];
        if (!client) return { error: 'Unbekannter Client (client_id). Bitte den Connector in Claude neu verbinden.' };
        if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) return { error: 'redirect_uri passt nicht zum registrierten Client.' };
        if (p.response_type !== 'code') return { error: 'response_type muss "code" sein.', redirect: true };
        if (!p.code_challenge || p.code_challenge_method !== 'S256') return { error: 'PKCE (S256) ist erforderlich.', redirect: true };
        return { client };
    }

    consentPage(p, message = '') {
        const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
            .filter((k) => p[k] !== undefined)
            .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p[k])}">`)
            .join('\n');
        const client = this.state.clients[p.client_id];
        return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Terminal Bridge</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#1f1e1c;--muted:#6b6862;--accent:#c96442;--err:#b3261e;--line:#e3e0da}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--fg:#ecebe7;--muted:#a19d95;--line:#3a3833}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}
label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font-size:16px}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:0 0 14px}
</style></head><body><main>
<h1>Claude Terminal Bridge</h1>
<p>„${escapeHtml(client?.client_name || 'Claude')}“ möchte Aufträge an Claude Code auf deinem Home Assistant schicken. Zum Freigeben den Zugangsschlüssel der Bridge eingeben.</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ''}
<form method="post" action="authorize">
${hidden}
<label for="k">Zugangsschlüssel</label>
<input id="k" name="access_key" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Freigeben</button>
</form></main></body></html>`;
    }

    // Returns {status, headers, body}
    authorizeGet(p) {
        const v = this.validateAuthorizeParams(p);
        if (v.error && !v.redirect) return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: v.error };
        if (v.error) return this.redirectError(p, 'invalid_request', v.error);
        return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: this.consentPage(p) };
    }

    authorizePost(p) {
        const v = this.validateAuthorizeParams(p);
        if (v.error && !v.redirect) return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: v.error };
        if (v.error) return this.redirectError(p, 'invalid_request', v.error);

        const t = now();
        if (this.lockedUntil > t) {
            const mins = Math.ceil((this.lockedUntil - t) / 60);
            return { status: 429, headers: { 'content-type': 'text/html; charset=utf-8' }, body: this.consentPage(p, `Zu viele Fehlversuche. Bitte in ${mins} Minuten erneut versuchen.`) };
        }
        if (!timingSafeEqualStr(p.access_key || '', this.config.accessKey)) {
            this.fails = this.fails.filter((x) => x > t - LOCK_S);
            this.fails.push(t);
            this.log.warn(`[oauth] wrong access key (${this.fails.length}/${MAX_FAILS})`);
            if (this.fails.length >= MAX_FAILS) {
                this.lockedUntil = t + LOCK_S;
                this.fails = [];
                this.log.warn('[oauth] consent locked for 15 minutes after repeated failures');
            }
            return { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' }, body: this.consentPage(p, 'Zugangsschlüssel falsch.') };
        }
        this.fails = [];
        const code = token(24);
        this.codes.set(code, {
            client_id: p.client_id,
            redirect_uri: p.redirect_uri,
            code_challenge: p.code_challenge,
            scope: p.scope || 'bridge',
            resource: p.resource,
            exp: t + CODE_TTL_S,
        });
        const url = new URL(p.redirect_uri);
        url.searchParams.set('code', code);
        if (p.state !== undefined) url.searchParams.set('state', p.state);
        this.log.info(`[oauth] consent granted for client ${p.client_id}`);
        return { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' }, body: '' };
    }

    redirectError(p, error, description) {
        const url = new URL(p.redirect_uri);
        url.searchParams.set('error', error);
        url.searchParams.set('error_description', description);
        if (p.state !== undefined) url.searchParams.set('state', p.state);
        return { status: 302, headers: { location: url.toString() }, body: '' };
    }

    // ---- token endpoint -------------------------------------------------

    authenticateClient(p, authHeader) {
        let clientId = p.client_id;
        let secret = p.client_secret;
        if (authHeader && authHeader.startsWith('Basic ')) {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
            const i = decoded.indexOf(':');
            clientId = decodeURIComponent(decoded.slice(0, i));
            secret = decodeURIComponent(decoded.slice(i + 1));
        }
        const client = this.state.clients[clientId];
        if (!client) return null;
        if (client.token_endpoint_auth_method !== 'none') {
            if (!secret || !timingSafeEqualStr(sha256(secret), client.secret_hash)) return null;
        }
        return client;
    }

    issueTokens(clientId, scope, refreshToken) {
        const t = now();
        const access = token(32);
        this.state.access[sha256(access)] = { client_id: clientId, scope, exp: t + ACCESS_TTL_S };
        let refresh = refreshToken;
        if (refresh) {
            // sliding expiry, same token: avoids breaking a client that
            // refreshes twice concurrently
            this.state.refresh[sha256(refresh)].exp = t + REFRESH_TTL_S;
        } else {
            refresh = token(32);
            this.state.refresh[sha256(refresh)] = { client_id: clientId, scope, exp: t + REFRESH_TTL_S };
        }
        this.prune();
        this.save();
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
    }

    token(p, authHeader) {
        const bad = (error, description, status = 400) => ({ status, json: { error, error_description: description } });
        const client = this.authenticateClient(p, authHeader);
        if (!client) return bad('invalid_client', 'client authentication failed', 401);

        if (p.grant_type === 'authorization_code') {
            const entry = this.codes.get(p.code);
            this.codes.delete(p.code); // single use, even on failure
            if (!entry || entry.exp < now()) return bad('invalid_grant', 'code invalid or expired');
            if (entry.client_id !== client.client_id) return bad('invalid_grant', 'code was issued to another client');
            if (p.redirect_uri && p.redirect_uri !== entry.redirect_uri) return bad('invalid_grant', 'redirect_uri mismatch');
            if (!p.code_verifier) return bad('invalid_request', 'code_verifier required');
            const challenge = crypto.createHash('sha256').update(p.code_verifier).digest('base64url');
            if (!timingSafeEqualStr(challenge, entry.code_challenge)) return bad('invalid_grant', 'PKCE verification failed');
            this.log.info(`[oauth] tokens issued to client ${client.client_id}`);
            return { status: 200, json: this.issueTokens(client.client_id, entry.scope) };
        }

        if (p.grant_type === 'refresh_token') {
            const rec = this.state.refresh[sha256(p.refresh_token || '')];
            if (!rec || rec.exp < now() || rec.client_id !== client.client_id) return bad('invalid_grant', 'refresh token invalid');
            return { status: 200, json: this.issueTokens(client.client_id, rec.scope, p.refresh_token) };
        }

        return bad('unsupported_grant_type', 'unsupported grant_type');
    }

    // ---- resource server ------------------------------------------------

    verifyBearer(authHeader) {
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const rec = this.state.access[sha256(authHeader.slice(7).trim())];
        if (!rec || rec.exp < now()) return null;
        return { clientId: rec.client_id, scopes: [rec.scope], expiresAt: rec.exp };
    }

    revokeAll() {
        this.state = { clients: {}, access: {}, refresh: {} };
        this.save();
    }
}
