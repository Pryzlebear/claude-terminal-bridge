// End-to-end self-test: starts the bridge against a fake `claude` binary,
// walks the full OAuth flow like claude.ai does, and exercises every tool and
// escalation rule. Run with `node selftest.mjs` (no network, no HA needed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { evaluate } from './guard.mjs';
import { parseBridgeResult } from './jobs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const fake = path.join(HERE, 'test', 'fake-claude.mjs');
fs.chmodSync(fake, 0o755);

Object.assign(process.env, {
    BRIDGE_DATA_DIR: path.join(tmp, 'data'),
    BRIDGE_HANDOFF_DIR: path.join(tmp, 'config', '.claude', 'handoffs'),
    BRIDGE_WORKDIR: tmp,
    BRIDGE_PORT: '18099',
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_CLAUDE_BIN: fake,
    BRIDGE_ACCESS_KEY: 'test-key-123',
    BRIDGE_PUBLIC_URL: 'https://bridge.example.ts.net',
    BRIDGE_PROTECTED_PATTERNS: 'asterisk,haustuer_oeffnen',
    BRIDGE_TIMEOUT_SECONDS: '3',
    BRIDGE_NOTIFY: 'false',
});

let passed = 0;
const check = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
};

// ---- guard unit tests -----------------------------------------------------
const cfg = { protectedDomains: ['lock', 'alarm_control_panel'], protectedPatterns: ['asterisk'], protectedPaths: ['secrets.yaml', '.storage/auth'] };
console.log('guard');
await check('read-only tools pass even with protected words', () => {
    assert.equal(evaluate({ tool_name: 'Read', tool_input: { file_path: '/config/secrets.yaml' } }, cfg), null);
    assert.equal(evaluate({ tool_name: 'mcp__home-assistant__ha_get_state', tool_input: { entity_id: 'lock.haustuer' } }, cfg), null);
    assert.equal(evaluate({ tool_name: 'mcp__home-assistant__ha_search_entities', tool_input: { query: 'lock' } }, cfg), null);
});
await check('lock service call is blocked', () => {
    assert.match(evaluate({ tool_name: 'mcp__home-assistant__ha_call_service', tool_input: { domain: 'lock', service: 'unlock', entity_id: 'lock.haustuer' } }, cfg), /lock/);
    assert.match(evaluate({ tool_name: 'mcp__home-assistant__ha_call_service', tool_input: { domain: 'lock', service: 'unlock' } }, cfg), /lock/);
    assert.match(evaluate({ tool_name: 'Bash', tool_input: { command: 'curl -X POST http://supervisor/core/api/services/lock/unlock -d \'{"entity_id":"lock.haustuer"}\'' } }, cfg), /lock/);
});
await check('alarm and custom patterns are blocked', () => {
    assert.ok(evaluate({ tool_name: 'Edit', tool_input: { file_path: '/config/automations.yaml', new_string: 'service: alarm_control_panel.alarm_disarm' } }, cfg));
    assert.ok(evaluate({ tool_name: 'Write', tool_input: { file_path: '/share/asterisk/extensions.conf', content: 'x' } }, cfg));
});
await check('no false positive on clock./block. and ordinary edits', () => {
    assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: '/config/automations.yaml', new_string: 'sensor.clock.time block.x' } }, cfg), null);
    assert.equal(evaluate({ tool_name: 'mcp__home-assistant__ha_config_set_automation', tool_input: { config: { alias: 'Licht', action: [{ action: 'light.turn_on', target: { entity_id: 'light.flur' } }] } } }, cfg), null);
    assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: 'ha core check' } }, cfg), null);
});
await check('secrets and system operations are blocked', () => {
    assert.ok(evaluate({ tool_name: 'Edit', tool_input: { file_path: '/config/secrets.yaml', new_string: 'x' } }, cfg));
    assert.ok(evaluate({ tool_name: 'Bash', tool_input: { command: 'ha core restart' } }, cfg));
    assert.ok(evaluate({ tool_name: 'Bash', tool_input: { command: 'ha host reboot' } }, cfg));
    assert.ok(evaluate({ tool_name: 'mcp__home-assistant__ha_call_service', tool_input: { domain: 'homeassistant', service: 'restart' } }, cfg));
    assert.equal(evaluate({ tool_name: 'mcp__home-assistant__ha_call_service', tool_input: { domain: 'homeassistant', service: 'reload_core_config' } }, cfg), null);
    assert.ok(evaluate({ tool_name: 'Bash', tool_input: { command: 'curl -X POST http://supervisor/host/reboot' } }, cfg));
    assert.ok(evaluate({ tool_name: 'mcp__home-assistant__ha_restart', tool_input: {} }, cfg));
});
await check('guard hook process exits 2 with BRIDGE_GUARD reason', async () => {
    const { spawnSync } = await import('node:child_process');
    const cfgFile = path.join(tmp, 'g.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [path.join(HERE, 'guard.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ha core restart' } }),
        env: { ...process.env, BRIDGE_GUARD_CONFIG: cfgFile },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr.toString(), /^BRIDGE_GUARD/);
    const ok = spawnSync(process.execPath, [path.join(HERE, 'guard.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls /config' } }),
        env: { ...process.env, BRIDGE_GUARD_CONFIG: cfgFile },
    });
    assert.equal(ok.status, 0);
});
await check('bridge-result parsing', () => {
    assert.equal(parseBridgeResult('x <bridge-result>{"status":"done","summary":"a"}</bridge-result>').status, 'done');
    assert.equal(parseBridgeResult('<bridge-result>```json\n{"status":"handoff"}\n```</bridge-result>').status, 'handoff');
    assert.equal(parseBridgeResult('<bridge-result>{"status":"weird"}</bridge-result>'), null);
    assert.equal(parseBridgeResult('no block'), null);
});

// ---- server ---------------------------------------------------------------
const { httpServer } = await import('./server.mjs');
await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
const BASE = 'http://127.0.0.1:18099';
const CB = 'https://claude.ai/api/mcp/auth_callback';

console.log('oauth');
await check('unauthenticated /mcp returns 401 with resource metadata', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/bridge\.example\.ts\.net\/\.well-known\/oauth-protected-resource"/);
});
await check('metadata documents', async () => {
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.token_endpoint, 'https://bridge.example.ts.net/token');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(pr.resource, 'https://bridge.example.ts.net/mcp');
});
await check('registration rejects foreign redirect URIs', async () => {
    const r = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    assert.equal(r.status, 400);
});

let clientId;
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
let tokens;
await check('register + consent (wrong key, then right key) + token', async () => {
    const reg = await (await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], client_name: 'Claude', token_endpoint_auth_method: 'none' }) })).json();
    clientId = reg.client_id;
    assert.ok(clientId);
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
    const page = await fetch(`${BASE}/authorize?${q}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Zugangsschlüssel/);
    const wrong = await fetch(`${BASE}/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), access_key: 'nope' }), redirect: 'manual' });
    assert.equal(wrong.status, 401);
    const right = await fetch(`${BASE}/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), access_key: 'test-key-123' }), redirect: 'manual' });
    assert.equal(right.status, 302);
    const loc = new URL(right.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, CB);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    const code = loc.searchParams.get('code');
    const badPkce = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CB, code_verifier: 'wrong' }) });
    assert.equal(badPkce.status, 400);
    // code is single-use: get a fresh one
    const again = await fetch(`${BASE}/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), access_key: 'test-key-123' }), redirect: 'manual' });
    const code2 = new URL(again.headers.get('location')).searchParams.get('code');
    const t = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: CB, code_verifier: verifier }) });
    assert.equal(t.status, 200);
    tokens = await t.json();
    assert.ok(tokens.access_token && tokens.refresh_token);
});
await check('refresh token works and survives a reload from disk', async () => {
    const { OAuthServer } = await import('./oauth.mjs');
    const { loadConfig } = await import('./config.mjs');
    const reloaded = new OAuthServer(loadConfig(), { info() {}, warn() {} });
    const r = reloaded.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(r.status, 200);
    assert.ok(reloaded.verifyBearer(`Bearer ${tokens.access_token}`));
});

console.log('mcp');
const client = new Client({ name: 'selftest', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
}));
const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return r.structuredContent;
};

await check('tools are listed and instructions delivered', async () => {
    const t = await client.listTools();
    assert.deepEqual(t.tools.map((x) => x.name).sort(), ['ha_cancel_job', 'ha_delegate', 'ha_job_status', 'ha_list_jobs']);
    assert.match(client.getInstructions() || '', /handoff/);
});
await check('simple delegation returns done', async () => {
    const r = await call('ha_delegate', { task: 'Lege eine Automation an', wait_seconds: 10 });
    assert.equal(r.status, 'done');
    assert.equal(r.summary, 'Automation angelegt');
});
let askJob;
await check('needs_input then continuation resumes the same session', async () => {
    const r = await call('ha_delegate', { task: 'FRAGE: Sensor bauen', wait_seconds: 10 });
    assert.equal(r.status, 'needs_input');
    assert.equal(r.question, 'Alle 5 oder 15 Minuten?');
    askJob = r.job_id;
    const c = await call('ha_delegate', { task: '15 Minuten', continue_job_id: askJob, wait_seconds: 10 });
    assert.equal(c.status, 'done');
    assert.match(c.summary, /Fortgesetzt in [0-9a-f-]{36}/);
    assert.equal(c.continues_job, askJob);
});
await check('second question in the same chain escalates to handoff', async () => {
    const r = await call('ha_delegate', { task: 'NOCHMAL', continue_job_id: askJob, wait_seconds: 10 });
    assert.equal(r.status, 'handoff');
    assert.match(r.handoff.reason, /Zweite Rückfrage/);
    assert.match(r.resume_command, /^claude --resume /);
    assert.ok(fs.existsSync(r.handoff_file));
    const open = fs.readFileSync(path.join(process.env.BRIDGE_HANDOFF_DIR, 'OPEN.md'), 'utf8');
    assert.match(open, new RegExp(r.job_id));
});
await check('guard denial without result block becomes handoff', async () => {
    const r = await call('ha_delegate', { task: 'SPERRE: Haustür öffnen', wait_seconds: 10 });
    assert.equal(r.status, 'handoff');
    assert.ok(r.guard_denials?.[0]?.includes('lock'));
});
await check('timeout becomes handoff', async () => {
    const r = await call('ha_delegate', { task: 'HANG', wait_seconds: 15 });
    assert.equal(r.status, 'handoff');
    assert.match(r.handoff.reason, /Zeitlimit/);
});
await check('crash becomes error', async () => {
    const r = await call('ha_delegate', { task: 'KAPUTT', wait_seconds: 10 });
    assert.equal(r.status, 'error');
    assert.match(r.error, /boom/);
});
await check('short wait returns running, ha_job_status waits for result', async () => {
    const r = await call('ha_delegate', { task: 'SLEEP', wait_seconds: 0 });
    assert.ok(['queued', 'running'].includes(r.status));
    const s = await call('ha_job_status', { job_id: r.job_id, wait_seconds: 10 });
    assert.equal(s.status, 'done');
});
await check('jobs run one at a time and can be cancelled', async () => {
    const a = await call('ha_delegate', { task: 'SLEEP a', wait_seconds: 0 });
    const b = await call('ha_delegate', { task: 'SLEEP b', wait_seconds: 0 });
    assert.equal(b.status, 'queued');
    const cb = await call('ha_cancel_job', { job_id: b.job_id });
    assert.equal(cb.status, 'cancelled');
    const ca = await call('ha_cancel_job', { job_id: a.job_id });
    assert.equal(ca.status, 'cancelled');
});
await check('list jobs', async () => {
    const r = await call('ha_list_jobs', { limit: 3 });
    assert.equal(r.jobs.length, 3);
});
await check('expired/garbage token is rejected', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer garbage', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
});

await client.close();
httpServer.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nall ${passed} checks passed`);
process.exit(0);
