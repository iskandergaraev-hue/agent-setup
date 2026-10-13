#!/usr/bin/env node
// Coordinator -> executor bridge: hands a task from Claude Code to Codex through the
// official OpenAI Codex plugin runtime (codex-companion.mjs), enforcing the model policy
// (gpt-6.1-sol / gpt-6-luna only) and injecting the adapted ECC role / command / skills.
//
// Usage:
//   node "$HOME/.claude/coordinator/bin/delegate.mjs" task [options] [--prompt-file brief.md | "inline brief"]
//   node "$HOME/.claude/coordinator/bin/delegate.mjs" status|result|cancel [job-id]
//   node "$HOME/.claude/coordinator/bin/delegate.mjs" review|adversarial-review [--base <ref>] [--background]
//   node "$HOME/.claude/coordinator/bin/delegate.mjs" roles            (list ECC roles and their tiers)
//
// task options:
//   --role <name>        ECC agent (planner, tdd-guide, code-reviewer...) or Codex role (ecc_planner)
//   --tier sol|luna      override the role's model tier (luna = simple tasks only)
//   --effort <level>     low|medium|high|xhigh (default: role's effort, else medium)
//   --command <name>     inject an ECC legacy command (commands/<name>.md) into the brief
//   --skill <name>       ask Codex to use ECC skill $name (repeatable)
//   --cwd <dir>          project directory (default: current directory)
//   --read-only          no file edits (default: write-capable unless the role is read-only)
//   --background         run as a background job; check with `status` / `result`
//   --resume-last        continue the last Codex rescue thread for this repo
//                        (at most 2 in a row per cwd; then start a new task with a fresh brief)
//   --allow-long-thread  bypass the resume limit for this one call (use sparingly)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = os.homedir();
const TIERS = { sol: "gpt-6.1-sol", luna: "gpt-6-luna" };
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const ROLES_FILE = path.join(HOME, ".codex", "ecc-adapter", "roles.json");
const BRIEFS_DIR = path.join(HOME, ".claude", "coordinator", "briefs");
const PASSTHROUGH = new Set(["status", "result", "cancel", "review", "adversarial-review", "setup"]);
/* Long Codex threads accumulate context and drift; cap consecutive --resume-last calls per cwd. */
const MAX_RESUMES = 2;
const RESUME_STATE = path.join(HOME, ".claude", "coordinator", "state", "resume-chain.json");

function fail(message) {
  console.error(`delegate: ${message}`);
  process.exit(2);
}

function latestVersionDir(base) {
  if (!fs.existsSync(base)) return null;
  const versions = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions[versions.length - 1]) : null;
}

function companionPath() {
  const root = latestVersionDir(path.join(HOME, ".claude", "plugins", "cache", "openai-codex", "codex"));
  const script = root && path.join(root, "scripts", "codex-companion.mjs");
  if (!script || !fs.existsSync(script)) fail("Codex plugin for Claude Code not found. Install codex@openai-codex.");
  return script;
}

function eccCommandsDir() {
  for (const base of [
    path.join(HOME, ".codex", "plugins", "cache", "ecc", "ecc"),
    path.join(HOME, ".claude", "plugins", "cache", "ecc", "ecc"),
  ]) {
    const root = latestVersionDir(base);
    if (root && fs.existsSync(path.join(root, "commands"))) return path.join(root, "commands");
  }
  return null;
}

function loadRoles() {
  if (!fs.existsSync(ROLES_FILE)) fail(`roles not generated. Run: node "${path.join(HOME, ".codex", "ecc-adapter", "generate-roles.mjs")}"`);
  return JSON.parse(fs.readFileSync(ROLES_FILE, "utf8")).roles;
}

function findRole(roles, name) {
  const n = name.toLowerCase().replace(/^ecc[:_-]/, "").replace(/_/g, "-");
  return roles.find((r) => r.ecc === n || r.codex === name.toLowerCase());
}

function runCompanion(args, cwd) {
  const result = spawnSync(process.execPath, [companionPath(), ...args], { cwd, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function parseTaskArgs(argv) {
  const opts = { skills: [], positionals: [] };
  const valueOpts = new Set(["role", "tier", "effort", "command", "skill", "cwd", "prompt-file", "model"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts.positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    if (valueOpts.has(key)) {
      const v = argv[++i];
      if (v === undefined) fail(`--${key} needs a value`);
      if (key === "skill") opts.skills.push(v.replace(/^\$/, ""));
      else opts[key] = v;
    } else if (["read-only", "background", "resume-last", "allow-long-thread"].includes(key)) {
      opts[key] = true;
    } else {
      fail(`unknown option --${key}`);
    }
  }
  return opts;
}

function readBrief(opts, cwd) {
  if (opts["prompt-file"]) return fs.readFileSync(path.resolve(cwd, opts["prompt-file"]), "utf8");
  if (opts.positionals.length) return opts.positionals.join(" ");
  if (!process.stdin.isTTY) {
    try {
      return fs.readFileSync(0, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function resumeKey(cwd) {
  return path.resolve(cwd).toLowerCase();
}

function loadResumeState() {
  try {
    return JSON.parse(fs.readFileSync(RESUME_STATE, "utf8"));
  } catch {
    return {};
  }
}

/* Returns the new chain length for this cwd: 0 for a fresh task, n+1 for a resume. */
function trackResume(cwd, resuming, allowLong) {
  const state = loadResumeState();
  const key = resumeKey(cwd);
  const count = state[key]?.count || 0;
  if (resuming && count >= MAX_RESUMES && !allowLong) {
    fail(`--resume-last refused: this Codex thread was already resumed ${count} times in a row for ${cwd}. ` +
      `Start a new task with a fresh brief (state the remaining work and review findings), ` +
      `or pass --allow-long-thread if continuing this thread is really necessary.`);
  }
  const next = resuming ? count + 1 : 0;
  state[key] = { count: next, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(RESUME_STATE), { recursive: true });
  fs.writeFileSync(RESUME_STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
  return next;
}

function task(argv) {
  const opts = parseTaskArgs(argv);
  if (opts.model) fail("--model is not allowed. Use --tier sol (gpt-6.1-sol) or --tier luna (gpt-6-luna).");
  const cwd = path.resolve(opts.cwd || process.cwd());
  const roles = loadRoles();
  const role = opts.role ? findRole(roles, opts.role) : null;
  if (opts.role && !role) fail(`unknown ECC role "${opts.role}". Run: delegate.mjs roles`);

  const tier = opts.tier || role?.tier || "sol";
  if (!TIERS[tier]) fail(`--tier must be sol or luna`);
  const effort = opts.effort || role?.effort || "medium";
  if (!EFFORTS.has(effort)) fail(`--effort must be one of ${[...EFFORTS].join(", ")}`);
  const readOnly = Boolean(opts["read-only"] || role?.readOnly);

  const brief = readBrief(opts, cwd).trim();
  if (!brief && !opts["resume-last"]) fail("empty brief. Pass --prompt-file, inline text, or stdin.");
  const chain = trackResume(cwd, Boolean(opts["resume-last"]), Boolean(opts["allow-long-thread"]));

  const sections = [
    `# Task brief from the Claude Code coordinator`,
    ``,
    `Executor: Codex. Model policy: ${TIERS[tier]} only (allowed: gpt-6.1-sol, gpt-6-luna). Mode: ${readOnly ? "READ-ONLY (do not modify files)" : "write-capable"}.`,
    `Follow ~/.codex/AGENTS.md. Finish with a report: outcome, files changed, commands run + results, open risks/questions.`,
  ];
  if (opts.skills.length) {
    const skillsDir = eccCommandsDir() && path.join(path.dirname(eccCommandsDir()), "skills");
    const lines = opts.skills.map((s) => {
      const name = s.replace(/^ecc:/, "");
      const file = skillsDir && path.join(skillsDir, name, "SKILL.md");
      if (!file || !fs.existsSync(file)) fail(`ECC skill "${s}" not found in ${skillsDir}`);
      return `- $ecc:${name} (if it is not in your skills list, read and follow ${file})`;
    });
    sections.push(``, `## Skills to use`, ...lines);
  }
  if (opts.command) {
    const dir = eccCommandsDir();
    const file = dir && path.join(dir, `${opts.command.replace(/^\//, "").replace(/^ecc:/, "")}.md`);
    if (!file || !fs.existsSync(file)) fail(`ECC command "${opts.command}" not found in ${dir}`);
    sections.push(``, `## ECC command: ${path.basename(file, ".md")}`, `Follow this command's workflow (translate Claude tool names per AGENTS.md):`, ``, fs.readFileSync(file, "utf8").trim());
  }
  if (role) sections.push(``, `## Role: ${role.codex}`, `Act as this ECC role for the whole task. You may spawn other ecc_* roles as subagents when the role text calls for them.`, ``, role.instructions.trim());
  if (brief) sections.push(``, `## Task`, ``, brief);
  const prompt = sections.join("\n") + "\n";

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const briefFile = path.join(BRIEFS_DIR, `${stamp}-${role ? role.ecc : "task"}.md`);
  fs.writeFileSync(briefFile, prompt, "utf8");

  const args = ["task", "--model", TIERS[tier], "--effort", effort, "--cwd", cwd];
  if (!readOnly) args.push("--write");
  if (opts.background) args.push("--background");
  if (opts["resume-last"]) args.push("--resume-last");
  args.push("--prompt-file", briefFile);

  console.error(`delegate: ${role ? role.codex : "generic"} -> ${TIERS[tier]} (${effort}), ${readOnly ? "read-only" : "write"}, cwd=${cwd}`);
  console.error(`delegate: brief saved to ${briefFile}`);
  if (opts["resume-last"]) console.error(`delegate: resume ${chain}/${MAX_RESUMES} in a row for this cwd`);
  runCompanion(args, cwd);
}

function listRoles() {
  const roles = loadRoles();
  for (const r of roles) console.log(`${r.ecc.padEnd(28)} ${r.codex.padEnd(32)} ${r.model.padEnd(12)} ${r.effort.padEnd(7)} ${r.readOnly ? "read-only" : "write"}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
} else if (cmd === "task") {
  task(rest);
} else if (cmd === "roles") {
  listRoles();
} else if (PASSTHROUGH.has(cmd)) {
  runCompanion([cmd, ...rest], process.cwd());
} else {
  fail(`unknown command "${cmd}". Use task | status | result | cancel | review | adversarial-review | roles`);
}
