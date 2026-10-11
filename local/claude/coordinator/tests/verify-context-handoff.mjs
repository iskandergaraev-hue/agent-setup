// Synthetic entrypoint checks and wall-clock benchmark; no installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { assistant, jsonl } from './fixtures/transcript.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const sandbox = path.join(workspace, '.handoff-tests');
await fs.mkdir(sandbox, { recursive: true });
const root = await fs.mkdtemp(path.join(sandbox, 'verify-'));
const transcript = path.join(root, 'transcript.jsonl');
const stateDir = path.join(root, 'state');
const env = { ...process.env, CLAUDE_COORDINATOR_MODE: 'on', CLAUDE_COORDINATOR_HANDOFF_ENABLED: '1',
  CLAUDE_COORDINATOR_HANDOFF_STATE_DIR: stateDir, CLAUDE_COORDINATOR_HANDOFF_DIR: path.join(root, 'handoffs'),
  CLAUDE_COORDINATOR_HANDOFF_PREPARE_TOKENS: '180000', CLAUDE_COORDINATOR_HANDOFF_CLEAR_TOKENS: '200000' };
const payload = { session_id: 'synthetic-verify', cwd: root, transcript_path: transcript };

function invoke(hook_event_name, extra = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [path.join(here, '../hooks/context-handoff.mjs')], {
    env, input: JSON.stringify({ ...payload, hook_event_name, ...extra }), encoding: 'utf8', timeout: 5000,
  });
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stderr);
  return { elapsed, output: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

async function benchmark() {
  const normal = jsonl([assistant(179999, { sessionId: payload.session_id })]);
  const bytes = 16 * 1024 * 1024;
  const line = JSON.stringify({ type: 'progress', padding: 'x'.repeat(900) }) + '\n';
  const repeats = Math.floor((bytes - Buffer.byteLength(normal)) / Buffer.byteLength(line));
  const remaining = bytes - Buffer.byteLength(normal) - repeats * Buffer.byteLength(line);
  const large = line.repeat(repeats) + ' '.repeat(remaining - 1) + '\n' + normal;
  assert.equal(Buffer.byteLength(large), bytes);
  for (const [name, text] of [['ordinary', normal], ['16MiB', large]]) {
    await fs.writeFile(transcript, text);
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const result = invoke('UserPromptSubmit');
      assert.equal(result.output, null);
      assert.equal(result.stderr, '');
      samples.push(result.elapsed);
      const stateFile = (await fs.readdir(stateDir)).find(file => file.startsWith('session-') && file.endsWith('.json'));
      const saved = JSON.parse(await fs.readFile(path.join(stateDir, stateFile), 'utf8'));
      assert.equal(saved.last_usage, 179999);
      // Discard only synthetic session-state between calls to force an uncached read.
      await fs.unlink(path.join(stateDir, stateFile));
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ benchmark: name, bytes: Buffer.byteLength(text), calls: samples.length,
      p50_ms: +samples[9].toFixed(2), p95_ms: +samples[18].toFixed(2), max_ms: +samples.at(-1).toFixed(2) }));
  }
}

async function smoke() {
  const display = (event, result) => console.log(`${event}: ${JSON.stringify(result.output)}`);
  await fs.writeFile(transcript, jsonl([assistant(180000, { sessionId: payload.session_id })]));
  let result = invoke('UserPromptSubmit');
  assert.match(result.output.hookSpecificOutput.additionalContext, /PREPARE/);
  display('UserPromptSubmit', result);
  await fs.writeFile(transcript, jsonl([assistant(200000, { sessionId: payload.session_id })]));
  result = invoke('Stop', { stop_hook_active: false });
  assert.equal(result.output.decision, 'block');
  display('Stop (finalize)', result);
  const filename = (await fs.readdir(stateDir)).find(name => name.startsWith('session-') && name.endsWith('.json'));
  const state = JSON.parse(await fs.readFile(path.join(stateDir, filename), 'utf8'));
  let text = await fs.readFile(path.join(here, '../templates/handoff.md'), 'utf8');
  for (const [key, value] of Object.entries({ HANDOFF_ID: state.handoff_id, SESSION_ID: payload.session_id,
    GENERATION_ID: state.handoff_generation_id, CWD: root, CREATED_AT: new Date().toISOString() })) {
    text = text.replaceAll(`{{${key}}}`, JSON.stringify(value));
  }
  text = text.replace('handoff_status: draft', 'handoff_status: ready').replaceAll('{{FILL}}', 'Синтетический пункт; активных задач нет; PR нет.');
  await fs.mkdir(env.CLAUDE_COORDINATOR_HANDOFF_DIR, { recursive: true });
  await fs.writeFile(state.handoff_path, text);
  result = invoke('Stop', { stop_hook_active: true });
  assert.match(result.output.reason, /COORDINATOR_HANDOFF:CLEAR_READY/);
  display('Stop (ready)', result);
  display('PreCompact', invoke('PreCompact', { trigger: 'manual' }));
  result = invoke('SessionStart', { source: 'clear' });
  assert.match(result.output.hookSpecificOutput.additionalContext, /Передача из предыдущего/);
  display('SessionStart (clear)', result);
  result = invoke('SessionStart', { source: 'clear' });
  assert.equal(result.output, null);
  display('SessionStart (repeat)', result);
}

try {
  if (process.argv.includes('--benchmark')) await benchmark();
  else await smoke();
} finally {
  assert.ok(path.relative(workspace, root).startsWith('.handoff-tests' + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}
