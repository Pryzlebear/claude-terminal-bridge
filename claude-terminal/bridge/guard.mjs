#!/usr/bin/env node
// PreToolUse hook for Claude Code runs started by the bridge.
//
// Claude Code calls this before every tool use and passes
// {tool_name, tool_input, ...} on stdin. Exit code 2 blocks the call and
// hands stderr back to the model as the reason.
//
// This is a tripwire, not a sandbox: it reliably stops the obvious paths
// (calling a lock service, editing secrets.yaml, restarting the host) so a
// delegated run cannot do them unattended, and tells the model to hand the
// task to the interactive terminal instead. Someone determined to obfuscate a
// shell command could get past string matching — which is why the bridge's
// real security boundary is the OAuth access key in front of it.
//
// Loaded only for bridge runs (via --settings), never for the interactive
// terminal session.

import fs from 'node:fs';

export const READ_ONLY_TOOLS = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch',
    'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
    'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);

// ha-mcp tools that only read (ha_get_state, ha_search_entities, ...)
const READ_ONLY_MCP = /^mcp__[^_].*?__(ha_)?(get|search|list|find|deep_search|eval|check|report|read|describe|overview)/i;

const SYSTEM_OPS = [
    { re: /\bha\s+(host|os|supervisor)\b/i, why: 'Host-/OS-/Supervisor-Befehle' },
    { re: /\bha\s+(core|addons?|apps?)\s+(restart|stop|rebuild|uninstall|update|start)\b/i, why: 'Neustart/Update von Core oder Add-ons' },
    { re: /supervisor\/(host|os)\//i, why: 'Host-/OS-Aufrufe über die Supervisor-API' },
    { re: /supervisor\/(core|addons\/[^/\s"']+)\/(restart|stop|rebuild|uninstall|update)/i, why: 'Neustart/Update über die Supervisor-API' },
    { re: /\bhomeassistant\.(restart|stop)\b/i, why: 'Home-Assistant-Neustart' },
    { re: /\bhassio\.(host|addon)_/i, why: 'hassio-Systemdienste' },
    { re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(config|data|share|addon_configs)\b/i, why: 'rekursives Löschen eines Hauptverzeichnisses' },
];

function loadConfig() {
    const file = process.env.BRIDGE_GUARD_CONFIG;
    if (!file) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns null (allow) or a German reason string (deny).
export function evaluate(event, cfg) {
    const tool = String(event?.tool_name || '');
    if (READ_ONLY_TOOLS.has(tool) || READ_ONLY_MCP.test(tool)) return null;

    const input = JSON.stringify(event?.tool_input ?? {});
    const domains = cfg?.protectedDomains ?? ['lock', 'alarm_control_panel'];
    const patterns = cfg?.protectedPatterns ?? [];
    const paths = cfg?.protectedPaths ?? ['secrets.yaml'];

    for (const p of paths) {
        if (p && input.includes(p)) return `geschützte Datei/Pfad "${p}"`;
    }
    for (const d of domains) {
        const ed = escapeRe(d);
        const entity = new RegExp(`(^|[^a-z0-9_])${ed}\\.[a-z0-9_]`, 'i');
        const field = new RegExp(`domain\\\\?["']?\\s*[:=]\\s*\\\\?["']?${ed}\\b`, 'i');
        if (entity.test(input) || field.test(input)) return `geschützte Domain "${d}"`;
    }
    for (const p of patterns) {
        if (p && input.toLowerCase().includes(p.toLowerCase())) return `geschütztes Muster "${p}"`;
    }
    if (/restart|reboot|shutdown/i.test(tool) && tool.startsWith('mcp__')) return 'Neustart über ein MCP-Tool';
    const ti = event?.tool_input || {};
    const svc = String(ti.service || ti.action || '');
    const dom = String(ti.domain || '');
    if ((/^(homeassistant|hassio)$/i.test(dom) && /restart|stop|reboot|shutdown|addon_|host_/i.test(svc))
        || /^(homeassistant\.(restart|stop)|hassio\.)/i.test(svc)) {
        return 'Neustart/Systemdienst über einen Service-Aufruf';
    }
    for (const { re, why } of SYSTEM_OPS) {
        if (re.test(input)) return why;
    }
    return null;
}

async function main() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let event;
    try {
        event = JSON.parse(raw);
    } catch {
        process.exit(0); // never block on a malformed event
    }
    const reason = evaluate(event, loadConfig());
    if (!reason) process.exit(0);

    const log = process.env.BRIDGE_GUARD_LOG;
    if (log) {
        try {
            fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), tool: event.tool_name, reason }) + '\n');
        } catch { /* ignore */ }
    }
    process.stderr.write(
        `BRIDGE_GUARD: Blockiert (${reason}). Diese Aktion ist für Bridge-Aufträge gesperrt. ` +
        'Versuche KEINEN Umweg (anderes Tool, Shell, Umformulierung). Beende den Auftrag mit status "handoff" ' +
        'und beschreibe, was Kilian im Claude Terminal selbst erledigen oder bestätigen muss.\n',
    );
    process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
