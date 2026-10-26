// Runtime configuration for the bridge, read once at startup.
//
// run.sh exports the add-on options as BRIDGE_* environment variables, so
// this module never talks to the Supervisor itself and can be exercised
// outside Home Assistant (selftest.mjs sets the variables directly).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function list(value) {
    if (!value) return [];
    return String(value)
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function int(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
    const dataDir = env.BRIDGE_DATA_DIR || '/data/bridge';
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    // Access key protecting the OAuth consent page. A configured value wins;
    // otherwise one is generated once and kept in /data so it survives
    // restarts (run.sh prints where to find it).
    let accessKey = (env.BRIDGE_ACCESS_KEY || '').trim();
    let accessKeyGenerated = false;
    const keyFile = path.join(dataDir, 'access_key');
    if (!accessKey) {
        if (fs.existsSync(keyFile)) {
            accessKey = fs.readFileSync(keyFile, 'utf8').trim();
        }
        if (!accessKey) {
            accessKey = crypto.randomBytes(18).toString('base64url');
            fs.writeFileSync(keyFile, accessKey + '\n', { mode: 0o600 });
            accessKeyGenerated = true;
        }
    }

    return {
        port: int(env.BRIDGE_PORT, 8099),
        host: env.BRIDGE_HOST || '0.0.0.0',
        dataDir,
        publicUrl: (env.BRIDGE_PUBLIC_URL || '').replace(/\/+$/, ''),
        accessKey,
        accessKeyGenerated,
        accessKeyFile: keyFile,
        allowedSources: list(env.BRIDGE_ALLOWED_SOURCES),
        redirectUris: [
            'https://claude.ai/api/mcp/auth_callback',
            'https://claude.com/api/mcp/auth_callback',
            ...list(env.BRIDGE_EXTRA_REDIRECT_URIS),
        ],
        // Claude Code invocation
        claudeBin: env.BRIDGE_CLAUDE_BIN || 'claude',
        workDir: env.BRIDGE_WORKDIR || '/config',
        permissionMode: env.BRIDGE_PERMISSION_MODE || 'auto',
        model: (env.BRIDGE_MODEL || '').trim(),
        timeoutMinutes: int(env.BRIDGE_TIMEOUT_MINUTES, 20),
        // seconds override, only used by the self-test
        timeoutSeconds: int(env.BRIDGE_TIMEOUT_SECONDS, int(env.BRIDGE_TIMEOUT_MINUTES, 20) * 60),
        maxJobs: int(env.BRIDGE_MAX_JOBS_KEPT, 50),
        // Guard
        protectedDomains: list(env.BRIDGE_PROTECTED_DOMAINS || 'lock,alarm_control_panel'),
        protectedPatterns: list(env.BRIDGE_PROTECTED_PATTERNS),
        protectedPaths: list(env.BRIDGE_PROTECTED_PATHS || 'secrets.yaml,.storage/auth,.storage/auth_provider.homeassistant,.storage/onboarding'),
        // Handoffs live in /config so the interactive Claude Code session sees them
        handoffDir: env.BRIDGE_HANDOFF_DIR || '/config/.claude/handoffs',
        // HA notifications on handoff (needs SUPERVISOR_TOKEN)
        notify: (env.BRIDGE_NOTIFY || 'true') !== 'false',
        supervisorToken: env.SUPERVISOR_TOKEN || '',
        supervisorUrl: env.BRIDGE_SUPERVISOR_URL || 'http://supervisor',
    };
}
