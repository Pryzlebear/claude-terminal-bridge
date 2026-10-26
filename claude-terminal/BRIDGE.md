# Claude Terminal Bridge

This fork adds an MCP server to Claude Terminal. With it, the Claude app (chat, Cowork, scheduled tasks) can hand tasks to the Claude Code instance running in this add-on. That instance keeps working with its full project memory, its tools and ha-mcp, exactly as in the interactive terminal.

```
Claude app ──MCP──▶ Tailscale Funnel ──▶ :8099 bridge ──▶ claude -p (headless, in this container)
                                                     │
                                                     └─ same HOME, memory, ha-mcp as the terminal
```

## Tools offered to the Claude app

| Tool | Purpose |
|---|---|
| `ha_delegate` | Start a task (or continue one with `continue_job_id`). Waits up to 50 s, then returns the status. |
| `ha_job_status` | Status/result of a task; also waits up to 50 s. |
| `ha_list_jobs` | Recent tasks. |
| `ha_cancel_job` | Cancel a task. |

Every task ends in one of these states:
- `done`: finished, with a summary.
- `needs_input`: one specific question. The answer goes back via `ha_delegate` with `continue_job_id`, and the same Claude Code session continues with its full history.
- `handoff`: the task is better finished interactively. The bridge writes a handoff file to `/config/.claude/handoffs/`, keeps `OPEN.md` there current, creates an HA notification, and returns the command `claude --resume <session>`. Running that command in the terminal continues exactly where the run stopped.
- `error` / `cancelled`.

### When a task ends in a handoff

Claude Code decides this itself, guided by the bridge prompt. Typical reasons are debugging with live feedback, restarts, HACS or add-on management, security-relevant devices, large changes, or a missing permission. The bridge also forces a handoff in these cases:
- the time limit (`bridge_timeout_minutes`) is reached
- a second follow-up question would be needed in the same chain
- an action was blocked or a permission was denied and the task returned no structured result

## Security

- **OAuth with an access key.** The connector only works after the access key has been entered once on the consent page. Redirect URIs are limited to the claude.ai callback. Tokens are stored as hashes in `/data/bridge/oauth-state.json`. After 5 wrong keys, consent is locked for 15 minutes.
- **Guard hook.** This hook applies only to bridge runs, never to the interactive terminal. It blocks:
  - actions on `bridge_protected_domains` (default `lock`, `alarm_control_panel`)
  - actions matching `bridge_protected_patterns`
  - access to `secrets.yaml` and `.storage/auth*`
  - restarts and host or OS operations

  Read access stays allowed. The guard is a tripwire against unattended mistakes and against prompt injection, not a sandbox.
- **Permission mode** for runs: `bridge_permission_mode`, default `auto`, the same classifier mode as the interactive terminal. Prompts that nobody can answer are denied automatically.
- Port 8099 serves nothing without a token except the OAuth endpoints. `bridge_allowed_sources` can additionally restrict it to the IP of the funnel host.

## Options

| Option | Default | Meaning |
|---|---|---|
| `enable_bridge` | `true` | Turns the bridge on or off |
| `bridge_public_url` | `""` | Public HTTPS URL (e.g. `https://ha-bridge.<tailnet>.ts.net`); used for OAuth metadata |
| `bridge_access_key` | `""` | Access key for the consent page; if empty, one is generated (`cat /data/bridge/access_key`) |
| `bridge_permission_mode` | `auto` | `auto`, `acceptEdits`, `dontAsk`, `plan`, `bypassPermissions` |
| `bridge_model` | `""` | Model for bridge runs; empty means the same as the terminal |
| `bridge_timeout_minutes` | `20` | Maximum run time per task; exceeding it leads to a handoff |
| `bridge_protected_domains` | `lock`, `alarm_control_panel` | Blocked domains |
| `bridge_protected_patterns` | `[]` | Additional blocked strings (e.g. script or entity names) |
| `bridge_allowed_sources` | `[]` | Only these client IPs (empty means all) |
| `bridge_notify` | `true` | Create an HA notification on handoff |

## Development

```bash
cd claude-terminal/bridge && npm install && node selftest.mjs   # 23 checks, no HA required
```

The fork deliberately keeps its changes in separate files (`bridge/`, `scripts/start-bridge.sh`, `BRIDGE.md`) plus a few lines in `config.yaml`, `Dockerfile` and `run.sh`, so that upstream updates can be merged with "Sync fork".
