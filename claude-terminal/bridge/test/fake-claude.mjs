#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format json` used by selftest.mjs.
// Behaviour is selected by keywords in the prompt.
import fs from 'node:fs';
import { evaluate } from '../guard.mjs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
const settingsFile = args[args.indexOf('--settings') + 1];

const out = (result, extra = {}) => {
    process.stdout.write(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 3,
        permission_denials: [], result, ...extra,
    }));
};
const block = (o) => `Fertig.\n<bridge-result>\n${JSON.stringify(o)}\n</bridge-result>`;

// sanity: the guard settings file must exist and reference guard.mjs
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
if (!JSON.stringify(settings).includes('guard.mjs')) {
    process.stderr.write('settings without guard');
    process.exit(3);
}

if (prompt.includes('SLEEP')) {
    await new Promise((r) => setTimeout(r, 1500));
    out(block({ status: 'done', summary: 'nach Pause erledigt', question: '', handoff: null }));
} else if (prompt.includes('HANG')) {
    await new Promise((r) => setTimeout(r, 60000));
} else if (prompt.includes('FRAGE')) {
    out(block({ status: 'needs_input', summary: 'Sensor vorbereitet', question: 'Alle 5 oder 15 Minuten?', handoff: null }));
} else if (prompt.includes('SPERRE')) {
    // simulate the hook firing on an unlock call
    const cfg = JSON.parse(fs.readFileSync(process.env.BRIDGE_GUARD_CONFIG, 'utf8'));
    const reason = evaluate({ tool_name: 'mcp__home-assistant__ha_call_service', tool_input: { domain: 'lock', service: 'unlock', entity_id: 'lock.haustuer' } }, cfg);
    fs.appendFileSync(process.env.BRIDGE_GUARD_LOG, JSON.stringify({ tool: 'mcp__home-assistant__ha_call_service', reason }) + '\n');
    out('Ich konnte das Schloss nicht bedienen.');
} else if (prompt.includes('KAPUTT')) {
    process.stderr.write('boom');
    process.exit(1);
} else if (args.includes('--resume')) {
    if (prompt.includes('NOCHMAL')) {
        out(block({ status: 'needs_input', summary: 'weiter', question: 'Und welche Farbe?', handoff: null }));
    } else {
        out(block({ status: 'done', summary: `Fortgesetzt in ${sid}`, question: '', handoff: null }));
    }
} else {
    out(block({ status: 'done', summary: 'Automation angelegt', question: '', handoff: null }));
}
