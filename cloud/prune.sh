#!/bin/bash
# Remove ECC components not listed in keep.txt to shrink per-session context,
# and disable noisy hooks through ECC_DISABLED_HOOKS in settings.json.
set -uo pipefail

KEEP_FILE="${1:?usage: prune.sh <keep.txt> [claude_dir]}"
CLAUDE_DIR="${2:-$HOME/.claude}"

log() { printf '[agent-setup] %s\n' "$*"; }

section() {
    awk -v s="[$1]" '
        /^\[/ { on = ($0 == s); next }
        on && NF && $0 !~ /^#/ { print }
    ' "$KEEP_FILE"
}

prune_dir() {
    local directory="$1" keep="$2" suffix="$3" entry name removed=0
    [[ -d "$directory" ]] || return 0
    for entry in "$directory"/*; do
        [[ -e "$entry" ]] || continue
        name="$(basename "$entry")"
        name="${name%"$suffix"}"
        if ! grep -qxF -- "$name" <<<"$keep"; then
            rm -rf -- "$entry" && removed=$((removed + 1))
        fi
    done
    log "Pruned $removed from ${directory#"$CLAUDE_DIR"/}"
}

disable_hooks() {
    local settings="$CLAUDE_DIR/settings.json" ids
    ids="$(section disabled-hooks | paste -sd, -)"
    [[ -n "$ids" && -f "$settings" ]] || return 0
    node -e '
        const fs = require("fs");
        const [file, ids] = process.argv.slice(1);
        const settings = JSON.parse(fs.readFileSync(file, "utf8"));
        const next = { ...settings, env: { ...(settings.env || {}), ECC_DISABLED_HOOKS: ids } };
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    ' "$settings" "$ids" && log "Disabled hooks: $ids"
}

[[ -f "$KEEP_FILE" ]] || { log "WARNING: $KEEP_FILE not found; skipping prune"; exit 0; }

prune_dir "$CLAUDE_DIR/skills" "$(section skills)" ""
prune_dir "$CLAUDE_DIR/agents" "$(section agents)" ".md"
prune_dir "$CLAUDE_DIR/commands" "$(section commands)" ".md"
prune_dir "$CLAUDE_DIR/rules/ecc" "$(section rules)" ""

while IFS= read -r file; do
    rm -f -- "$CLAUDE_DIR/rules/ecc/$file"
done < <(section drop-rule-files)

disable_hooks
