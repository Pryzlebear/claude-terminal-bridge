#!/usr/bin/with-contenv bashio
# Claude Terminal Bridge — starts the MCP bridge server in the background.
# Sourced by run.sh after init_environment, so HOME/XDG/PATH already point
# at /data and the persistent Claude Code install wins on PATH.
#
# Must never block or kill startup: the bridge runs in a supervised
# background loop and the terminal comes up regardless of its state.

start_bridge() {
    if [ "$(bashio::config 'enable_bridge' 'true')" != "true" ]; then
        bashio::log.info "Claude Terminal Bridge disabled in configuration"
        return 0
    fi
    if [ ! -f /opt/bridge/server.mjs ]; then
        bashio::log.warning "Bridge files missing in image; bridge not started"
        return 0
    fi

    local list_opts
    # bashio returns list options one item per line. Every read carries a
    # fallback: on the 3.24 base a failed option read exits non-zero, and
    # set -e must never end startup over a bridge option (same as run.sh).
    export BRIDGE_PORT=8099
    export BRIDGE_DATA_DIR=/data/bridge
    export BRIDGE_WORKDIR
    BRIDGE_WORKDIR=$(get_working_directory) || BRIDGE_WORKDIR=/config
    export BRIDGE_PUBLIC_URL
    BRIDGE_PUBLIC_URL=$(bashio::config 'bridge_public_url' '') || BRIDGE_PUBLIC_URL=""
    export BRIDGE_ACCESS_KEY
    BRIDGE_ACCESS_KEY=$(bashio::config 'bridge_access_key' '') || BRIDGE_ACCESS_KEY=""
    export BRIDGE_PERMISSION_MODE
    BRIDGE_PERMISSION_MODE=$(bashio::config 'bridge_permission_mode' 'auto') || BRIDGE_PERMISSION_MODE="auto"
    export BRIDGE_MODEL
    BRIDGE_MODEL=$(bashio::config 'bridge_model' '') || BRIDGE_MODEL=""
    export BRIDGE_TIMEOUT_MINUTES
    BRIDGE_TIMEOUT_MINUTES=$(bashio::config 'bridge_timeout_minutes' '20') || BRIDGE_TIMEOUT_MINUTES="20"
    export BRIDGE_NOTIFY
    BRIDGE_NOTIFY=$(bashio::config 'bridge_notify' 'true') || BRIDGE_NOTIFY="true"

    list_opts=$(bashio::config 'bridge_protected_domains' '') || list_opts=""
    export BRIDGE_PROTECTED_DOMAINS="${list_opts//$'\n'/,}"
    list_opts=$(bashio::config 'bridge_protected_patterns' '') || list_opts=""
    export BRIDGE_PROTECTED_PATTERNS="${list_opts//$'\n'/,}"
    list_opts=$(bashio::config 'bridge_allowed_sources' '') || list_opts=""
    export BRIDGE_ALLOWED_SOURCES="${list_opts//$'\n'/,}"

    # bashio prints "null" for unset optional values
    local v
    for v in BRIDGE_PUBLIC_URL BRIDGE_ACCESS_KEY BRIDGE_MODEL BRIDGE_PROTECTED_PATTERNS BRIDGE_ALLOWED_SOURCES; do
        [ "${!v}" = "null" ] && export "$v="
    done
    # an explicitly emptied domain list stays empty; "null" means default
    [ "$BRIDGE_PROTECTED_DOMAINS" = "null" ] && export BRIDGE_PROTECTED_DOMAINS="lock,alarm_control_panel"

    if [ -z "$BRIDGE_ACCESS_KEY" ]; then
        bashio::log.info "No bridge_access_key set: using the generated key in /data/bridge/access_key (show it in the terminal with: cat /data/bridge/access_key)"
    fi
    if [ "$BRIDGE_PERMISSION_MODE" = "bypassPermissions" ]; then
        bashio::log.warning "Bridge runs delegated tasks with bypassPermissions — only the guard hook stands between a task and your system"
    fi

    bashio::log.info "Starting Claude Terminal Bridge on port 8099 (public URL: ${BRIDGE_PUBLIC_URL:-not set})"
    (
        # supervised loop: restart after a crash, back off if it keeps failing
        local delay=2
        while true; do
            local started
            started=$(date +%s)
            node /opt/bridge/server.mjs 2>&1 | while IFS= read -r line; do echo "$line"; done
            if [ $(( $(date +%s) - started )) -gt 60 ]; then delay=2; else delay=$(( delay < 60 ? delay * 2 : 60 )); fi
            echo "[bridge] server exited, restarting in ${delay}s"
            sleep "$delay"
        done
    ) &
}
