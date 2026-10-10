#!/usr/bin/env node
// Converts ECC (Everything Claude Code) agents into Codex custom agents.
//
// Source:  ~/.codex/plugins/cache/ecc/ecc/<latest>/agents/*.md  (falls back to the Claude Code plugin cache)
// Output:  ~/.codex/agents/ecc-<name>.toml          (Codex custom agents, name = ecc_<name>)
//          ~/.codex/ecc-adapter/roles.json          (used by the Claude coordinator's delegate.mjs)
//          ~/.claude/coordinator/ecc-roles.md       (routing table for the coordinator)
//
// Model policy: only gpt-6.1-sol and gpt-6-luna.
//   ECC opus   -> gpt-6.1-sol / high
//   ECC sonnet -> gpt-6.1-sol / medium
//   ECC haiku  -> gpt-6-luna  / medium   (simple, focused tasks only)
//
// Skills: Codex drops skill descriptions (and whole skills) when the skills context budget
// overflows, and full ECC ships ~300 skills. This script keeps the skills of the ECC install
// profiles listed in SKILL_PROFILES enabled and disables the rest via [[skills.config]] entries
// in a marked block of ~/.codex/config.toml. Disabled skills can still be used explicitly:
// delegate.mjs --skill <name> passes the SKILL.md path to Codex.
// Override profiles: ECC_CODEX_SKILL_PROFILES="developer,security,research" (or "full" to disable nothing).
//
// Re-run after every ECC update:  node "$HOME/.codex/ecc-adapter/generate-roles.mjs"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CODEX_AGENTS_DIR = path.join(HOME, ".codex", "agents");
const ADAPTER_DIR = path.join(HOME, ".codex", "ecc-adapter");
const COORDINATOR_DIR = path.join(HOME, ".claude", "coordinator");
const MARKER = "# generated-by: ecc-adapter";

const MODEL_MAP = {
  opus: { tier: "sol", model: "gpt-6.1-sol", effort: "high" },
  sonnet: { tier: "sol", model: "gpt-6.1-sol", effort: "medium" },
  haiku: { tier: "luna", model: "gpt-6-luna", effort: "medium" },
};
const DEFAULT_MODEL = MODEL_MAP.sonnet;
const SKILL_PROFILES = (process.env.ECC_CODEX_SKILL_PROFILES || "developer,security").split(",").map((s) => s.trim()).filter(Boolean);
// Extra skills kept enabled on top of the profiles (useful for everyday dev work).
const EXTRA_SKILLS = (process.env.ECC_CODEX_EXTRA_SKILLS || "documentation-lookup,deep-research,docker-patterns,deployment-patterns").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIG_TOML = path.join(HOME, ".codex", "config.toml");
const SKILLS_BLOCK_START = "# >>> ecc-adapter: skills (generated, do not edit)";
const SKILLS_BLOCK_END = "# <<< ecc-adapter: skills";
const WRITE_TOOLS = /\b(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)\b/;

function latestVersionDir(base) {
  if (!fs.existsSync(base)) return null;
  const versions = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions[versions.length - 1]) : null;
}

function findEccRoot() {
  const candidates = [
    latestVersionDir(path.join(HOME, ".codex", "plugins", "cache", "ecc", "ecc")),
    latestVersionDir(path.join(HOME, ".claude", "plugins", "cache", "ecc", "ecc")),
  ].filter(Boolean);
  const root = candidates.find((c) => fs.existsSync(path.join(c, "agents")));
  if (!root) throw new Error("ECC plugin not found in Codex or Claude Code plugin caches.");
  return root;
}

// Minimal YAML frontmatter parser: scalars, quoted strings, block scalars (| >), inline arrays.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (value === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
      value = items.join(", ");
    } else if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).join(", ");
    } else if (/^".*"$|^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

function tomlMultiline(s) {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return `"""\n${escaped}\n"""`;
}

function tomlString(s) {
  return JSON.stringify(s.replace(/\s+/g, " ").trim());
}

function adapterHeader(name, codexName, tools, readOnly, cfg) {
  return [
    `[ECC role adapted for the Codex executor]`,
    `Role: ${codexName} (source: ECC agent "${name}", written for Claude Code).`,
    `You run inside Codex as the EXECUTOR. A Claude Code coordinator assigned this work; it does not edit files itself, you do.`,
    ``,
    `Tool translation (the text below was written for Claude Code):`,
    `- Read / Grep / Glob -> read files and search with the shell (rg, git grep, Get-Content).`,
    `- Write / Edit / MultiEdit -> apply_patch (or the file-edit tool you have).`,
    `- Bash / PowerShell -> the shell tool. On Windows prefer PowerShell syntax unless the repo uses bash scripts.`,
    `- Task / Agent / "use the X agent" -> spawn a Codex subagent of type ecc_<x> (hyphens become underscores).`,
    `- TodoWrite -> the plan / update_plan tool.`,
    `- WebFetch / WebSearch -> web search if enabled for this session; otherwise say it is unavailable.`,
    `- Skill(x) / "/x" slash command -> the Codex skill $x from the ECC plugin.`,
    `- References to CLAUDE.md also apply to AGENTS.md.`,
    ``,
    `Original Claude tool allowlist: ${tools || "(inherit)"}.`,
    readOnly
      ? `This role is READ-ONLY: investigate and report; do not modify files.`
      : `This role may modify files inside the workspace; keep changes minimal and scoped to the brief.`,
    `Model policy: this role runs on ${cfg.model} (${cfg.effort}). Use only gpt-6.1-sol or gpt-6-luna; never switch to other models, including when spawning subagents.`,
    ``,
    `Finish with a report for the coordinator: outcome, files changed, commands run with results (tests/lint/build), open risks or questions.`,
    ``,
    `----- Original ECC instructions -----`,
    ``,
  ].join("\n");
}

function tomlLiteral(s) {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

// Enables the skills of SKILL_PROFILES, disables every other ECC skill in Codex.
function configureCodexSkills(eccRoot, version) {
  const codexRoot = latestVersionDir(path.join(HOME, ".codex", "plugins", "cache", "ecc", "ecc"));
  if (!codexRoot || !fs.existsSync(CONFIG_TOML)) return console.log("Codex ECC plugin or config.toml not found; skipped skills config.");
  const manifests = path.join(eccRoot, "manifests");
  const profiles = JSON.parse(fs.readFileSync(path.join(manifests, "install-profiles.json"), "utf8")).profiles;
  const modules = JSON.parse(fs.readFileSync(path.join(manifests, "install-modules.json"), "utf8")).modules;

  const allSkills = fs.readdirSync(path.join(codexRoot, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(codexRoot, "skills", d.name, "SKILL.md")))
    .map((d) => d.name);
  let keep;
  if (SKILL_PROFILES.includes("full")) {
    keep = new Set(allSkills);
  } else {
    const moduleIds = new Set(SKILL_PROFILES.flatMap((p) => profiles[p]?.modules || []));
    const unknown = SKILL_PROFILES.filter((p) => !profiles[p]);
    if (unknown.length) console.log(`Unknown ECC profiles ignored: ${unknown.join(", ")}`);
    keep = new Set(
      modules
        .filter((m) => moduleIds.has(m.id))
        .flatMap((m) => [].concat(m.paths || []).flatMap((p) => String(p).split(/\s+/)))
        .filter((p) => p.startsWith("skills/"))
        .map((p) => p.slice("skills/".length).replace(/\/$/, "")),
    );
  }
  for (const s of EXTRA_SKILLS) keep.add(s);
  const disabled = allSkills.filter((s) => !keep.has(s)).sort();

  const block = [
    SKILLS_BLOCK_START,
    `# ECC ${version}: profiles [${SKILL_PROFILES.join(", ")}] keep ${allSkills.length - disabled.length} skills, ${disabled.length} disabled.`,
    ...disabled.flatMap((s) => [
      `[[skills.config]]`,
      `path = ${tomlLiteral(path.join(codexRoot, "skills", s, "SKILL.md"))}`,
      `enabled = false`,
    ]),
    SKILLS_BLOCK_END,
  ].join("\n");

  let config = fs.readFileSync(CONFIG_TOML, "utf8");
  const start = config.indexOf(SKILLS_BLOCK_START);
  const end = config.indexOf(SKILLS_BLOCK_END);
  if (start !== -1 && end !== -1) config = config.slice(0, start) + config.slice(end + SKILLS_BLOCK_END.length);
  config = config.replace(/\s*$/, "\n\n") + block + "\n";
  fs.copyFileSync(CONFIG_TOML, CONFIG_TOML + ".ecc-adapter.bak");
  fs.writeFileSync(CONFIG_TOML, config, "utf8");
  console.log(`Codex skills: kept ${allSkills.length - disabled.length}, disabled ${disabled.length} (profiles: ${SKILL_PROFILES.join(", ")})`);
}

function main() {
  const eccRoot = findEccRoot();
  const version = path.basename(eccRoot);
  const agentFiles = fs.readdirSync(path.join(eccRoot, "agents")).filter((f) => f.endsWith(".md")).sort();

  fs.mkdirSync(CODEX_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(ADAPTER_DIR, { recursive: true });
  fs.mkdirSync(COORDINATOR_DIR, { recursive: true });

  // Remove previously generated files only (never touch user-authored agents).
  for (const f of fs.readdirSync(CODEX_AGENTS_DIR)) {
    const p = path.join(CODEX_AGENTS_DIR, f);
    if (f.startsWith("ecc-") && f.endsWith(".toml") && fs.readFileSync(p, "utf8").startsWith(MARKER)) fs.unlinkSync(p);
  }

  const roles = [];
  for (const file of agentFiles) {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(eccRoot, "agents", file), "utf8"));
    const name = meta.name || path.basename(file, ".md");
    const codexName = "ecc_" + name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
    const cfg = MODEL_MAP[(meta.model || "").toLowerCase()] || DEFAULT_MODEL;
    const tools = meta.tools || "";
    const readOnly = tools !== "" && !WRITE_TOOLS.test(tools);
    const description = meta.description || `ECC ${name} role`;
    const instructions = adapterHeader(name, codexName, tools, readOnly, cfg) + body.trim() + "\n";

    const toml = [
      MARKER,
      `# source: ECC ${version} agents/${file} (ECC model: ${meta.model || "unset"})`,
      `name = ${tomlString(codexName)}`,
      `description = ${tomlString(description)}`,
      `model = ${tomlString(cfg.model)}`,
      `model_reasoning_effort = ${tomlString(cfg.effort)}`,
      ...(readOnly ? [`sandbox_mode = "read-only"`] : []),
      `developer_instructions = ${tomlMultiline(instructions)}`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(CODEX_AGENTS_DIR, `ecc-${name}.toml`), toml, "utf8");

    roles.push({
      ecc: name,
      codex: codexName,
      tier: cfg.tier,
      model: cfg.model,
      effort: cfg.effort,
      readOnly,
      description: description.replace(/\s+/g, " ").trim(),
      instructions,
    });
  }

  fs.writeFileSync(
    path.join(ADAPTER_DIR, "roles.json"),
    JSON.stringify({ eccVersion: version, eccRoot, generatedAt: new Date().toISOString(), roles }, null, 2),
    "utf8",
  );

  const short = (s) => (s.length > 150 ? s.slice(0, 147) + "..." : s).replace(/\|/g, "/");
  const table = [
    `# ECC roles -> Codex executor`,
    ``,
    `Generated from ECC ${version} by ~/.codex/ecc-adapter/generate-roles.mjs. Do not edit by hand.`,
    `Use with: node "$HOME/.claude/coordinator/bin/delegate.mjs" --role <ecc name> ...`,
    ``,
    `| ECC agent | Codex role | Model | Effort | Mode | When to use |`,
    `|---|---|---|---|---|---|`,
    ...roles.map(
      (r) => `| ${r.ecc} | ${r.codex} | ${r.model} | ${r.effort} | ${r.readOnly ? "read-only" : "write"} | ${short(r.description)} |`,
    ),
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(COORDINATOR_DIR, "ecc-roles.md"), table, "utf8");

  const counts = roles.reduce((a, r) => ((a[r.model] = (a[r.model] || 0) + 1), a), {});
  console.log(`ECC ${version}: generated ${roles.length} Codex roles in ${CODEX_AGENTS_DIR}`);
  console.log(`Models: ${Object.entries(counts).map(([m, n]) => `${m}=${n}`).join(", ")}`);
  console.log(`Read-only roles: ${roles.filter((r) => r.readOnly).length}`);

  configureCodexSkills(eccRoot, version);
}

main();
