# Cloud mode: Claude Code executes, following ECC

Talk to the user in Russian unless they switch languages.

This is a Claude Code **cloud session**. The local setup (Claude coordinates, Codex executes) does not apply here: there is no Codex in the cloud, so **you execute the work yourself**, using the ECC agents, skills, commands, and rules installed in ~/.claude.

## Workflow (ECC)
- Feature: plan first with the `planner` agent (or `/plan`), show the plan, and wait for the user's OK on anything non-trivial. Implement test-first (`tdd-guide` agent, `tdd-workflow` skill). Review with `code-reviewer` plus the language reviewer. Use `security-reviewer` when auth, user input, DB queries, files, external APIs, crypto, or payments are involved. Verify with `verification-loop` before reporting done.
- Bug: reproduce it as a failing test first, then fix (`build-error-resolver` for build/type errors).
- Follow the ECC rules in ~/.claude/rules/ecc (coding style, testing 80%+, security, git workflow).
- Report back: what changed, the verification commands you ran and their results, and open risks.

## Git and GitHub
- Work on a feature branch (`feat/...`, `fix/...`, or the branch the session created), never directly on `main`/`master`.
- Commit freely on that branch with conventional commit messages.
- **Push, opening/merging/closing PRs, creating repos, comments, releases, and anything else visible on GitHub only after the user's explicit OK for that specific action.** Before asking, show the branch, `git log --oneline origin/<base>..HEAD`, and the PR title/body.
- Never force-push or rewrite published history unless the user explicitly asks.
- GitHub goes through Anthropic's proxy: `gh pr ...` and `gh issue ...` (GraphQL) are blocked. Use `gh api repos/{owner}/{repo}/...` (REST) or let the user create the PR from the session UI.
- Never put secrets in code, commits, or logs.
