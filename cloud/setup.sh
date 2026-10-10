#!/bin/bash
set -uo pipefail

ECC_COMMIT="4eb71d92a39cab44ad40ac9d8a6a5ccb4029d6c2"
PROFILE="${ECC_PROFILE:-developer}"
CLAUDE_DIR="${HOME}/.claude"
ECC_STATUS="failed"
RULES_STATUS="failed"

log() { printf '[agent-setup] %s\n' "$*"; }

prepare_ecc() {
    if [[ -n "${ECC_SRC:-}" ]]; then
        ECC_DIR="$ECC_SRC"
        log "Using local ECC source: $ECC_DIR"
        [[ -d "$ECC_DIR" ]] || return 1
    else
        ECC_DIR="/opt/ecc"
        log "Fetching ECC commit $ECC_COMMIT into $ECC_DIR"
        mkdir -p "$ECC_DIR" || return 1
        git -C "$ECC_DIR" init || return 1
        if git -C "$ECC_DIR" remote get-url origin >/dev/null 2>&1; then
            git -C "$ECC_DIR" remote set-url origin https://github.com/affaan-m/ECC.git || return 1
        else
            git -C "$ECC_DIR" remote add origin https://github.com/affaan-m/ECC.git || return 1
        fi
        git -C "$ECC_DIR" fetch --depth 1 origin "$ECC_COMMIT" || return 1
        git -C "$ECC_DIR" checkout --detach FETCH_HEAD || return 1
    fi
}

install_ecc() (
    cd "$ECC_DIR" || exit 1
    log "Installing ECC dependencies"
    npm install --ignore-scripts --no-audit --no-fund --loglevel=error || exit 1
    log "Applying ECC profile $PROFILE with hooks enabled"
    node scripts/install-apply.js --target claude --profile "$PROFILE" --enable-hooks
)

install_cloud_rules() {
    local destination="$CLAUDE_DIR/CLAUDE.md"
    local temporary="$CLAUDE_DIR/CLAUDE.md.agent-setup.tmp"
    mkdir -p "$CLAUDE_DIR" || return 1
    if [[ -n "${AGENT_SETUP_LOCAL:-}" ]]; then
        log "Copying cloud instructions from $AGENT_SETUP_LOCAL"
        cp "$AGENT_SETUP_LOCAL/cloud/CLAUDE.md" "$temporary" || return 1
    else
        log "Downloading cloud instructions (ref: ${AGENT_SETUP_REF:-main})"
        curl -fsSL --connect-timeout 15 --max-time 60 \
            "https://raw.githubusercontent.com/iskandergaraev-hue/agent-setup/${AGENT_SETUP_REF:-main}/cloud/CLAUDE.md" \
            -o "$temporary" || { rm -f "$temporary"; return 1; }
    fi
    mv "$temporary" "$destination"
}

count_installed() {
    local directory="$CLAUDE_DIR/$1"
    local count
    if [[ ! -d "$directory" ]]; then
        printf '0'
        return 0
    fi
    if [[ "$1" == "skills" ]]; then
        count=$(find "$directory" -name SKILL.md -type f | wc -l) || count="unknown"
    else
        count=$(find "$directory" -name '*.md' -type f | wc -l) || count="unknown"
    fi
    printf '%s' "${count//[[:space:]]/}"
}

log "Starting cloud setup"
if prepare_ecc; then
    if install_ecc; then
        ECC_STATUS="installed"
    else
        log "WARNING: ECC installation failed; continuing"
    fi
else
    log "WARNING: ECC source preparation failed; continuing"
fi
if install_cloud_rules; then
    RULES_STATUS="installed"
else
    log "WARNING: cloud instructions installation failed; continuing"
fi
log "Summary: ECC commit=$ECC_COMMIT profile=$PROFILE ECC=$ECC_STATUS cloud-rules=$RULES_STATUS"
if [[ -n "${ECC_SRC:-}" ]]; then
    log "ECC_SRC override used; source commit is not verified against the pin"
fi
log "Installed counts: skills=$(count_installed skills) agents=$(count_installed agents) commands=$(count_installed commands)"
exit 0
