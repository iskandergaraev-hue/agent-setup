# PreToolUse guard: Claude Code is the coordinator and must not execute work itself.
# - Blocks Edit/Write/MultiEdit/NotebookEdit outside coordinator-owned paths.
# - Blocks running ECC agents inside Claude Code (they run in Codex as ecc_* roles).
# Disable for one session: set environment variable CLAUDE_COORDINATOR_MODE=off before starting Claude Code.

$ErrorActionPreference = 'Stop'
try {
    if ($env:CLAUDE_COORDINATOR_MODE -eq 'off') { exit 0 }

    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    $tool = [string]$payload.tool_name
    $toolInput = $payload.tool_input

    function Deny([string]$reason) {
        $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } }
        [Console]::Out.Write(($out | ConvertTo-Json -Depth 4 -Compress))
        exit 0
    }

    $delegateHint = 'Coordinator mode: Claude Code does not execute tasks. Write a brief and delegate to Codex: node "$HOME/.claude/coordinator/bin/delegate.mjs" task --role <ecc-role> [--tier sol|luna] --cwd <project> --prompt-file <brief>. See ~/.claude/CLAUDE.md.'

    if ($tool -in @('Agent', 'Task')) {
        $sub = [string]$toolInput.subagent_type
        if ($sub -like 'ecc:*') {
            $role = $sub.Substring(4)
            Deny "ECC agents run in Codex, not in Claude Code. Use: node `"`$HOME/.claude/coordinator/bin/delegate.mjs`" task --role $role --cwd <project> --prompt-file <brief>"
        }
        exit 0
    }

    if ($tool -in @('Edit', 'Write', 'MultiEdit', 'NotebookEdit')) {
        $target = [string]$toolInput.file_path
        if (-not $target) { $target = [string]$toolInput.notebook_path }
        if (-not $target) { exit 0 }
        $full = [System.IO.Path]::GetFullPath($target).ToLowerInvariant()
        $userHome = [System.IO.Path]::GetFullPath($env:USERPROFILE).ToLowerInvariant().TrimEnd('\')
        $allowedRoots = @("$userHome\.claude\", "$userHome\.codex\")
        if ($env:TEMP) { $allowedRoots += ([System.IO.Path]::GetFullPath($env:TEMP).ToLowerInvariant().TrimEnd('\') + '\') }
        foreach ($root in $allowedRoots) { if ($full.StartsWith($root)) { exit 0 } }
        # Coordinator-owned artifacts inside projects: .claude/ folders and agent instruction files.
        if ($full -match '\\\.claude\\') { exit 0 }
        $leaf = [System.IO.Path]::GetFileName($full)
        if ($leaf -in @('claude.md', 'claude.local.md', 'agents.md')) { exit 0 }
        Deny "$delegateHint Blocked edit: $target"
    }
    exit 0
}
catch {
    # Never break the session on guard errors; report to stderr (non-blocking).
    [Console]::Error.WriteLine("coordinator guard error: $($_.Exception.Message)")
    exit 0
}
