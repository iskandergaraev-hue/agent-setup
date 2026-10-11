import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistant, jsonl } from './fixtures/transcript.mjs';

// A missing module is the intended RED signal: no production implementation exists yet.
const core = await import('../hooks/context-handoff-core.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '../hooks/context-handoff.mjs');
const templatePath = path.join(here, '../templates/handoff.md');
const sandbox = path.resolve(here, '../../../../.handoff-tests');
await fs.mkdir(sandbox, { recursive: true });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(sandbox, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'transcript.jsonl');
  const env = { CLAUDE_COORDINATOR_HANDOFF_STATE_DIR: path.join(root, 'state'),
    CLAUDE_COORDINATOR_HANDOFF_DIR: path.join(root, 'handoffs') };
  const payload = { session_id: 'session-test', cwd: root, transcript_path: transcript,
    hook_event_name: 'UserPromptSubmit' };
  const write = records => fs.writeFile(transcript, jsonl(records));
  const invoke = (extra = {}, options = {}) => core.handleEvent({ ...payload, ...extra }, { env, ...options });
  await write([assistant(0)]);
  return { root, transcript, env, payload, write, invoke };
}
const context = output => output?.hookSpecificOutput?.additionalContext ?? output?.reason ?? '';
async function state(f) {
  const files = await fs.readdir(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR);
  const name = files.find(file => file.startsWith('session-') && file.endsWith('.json'));
  return JSON.parse(await fs.readFile(path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, name), 'utf8'));
}
async function ready(f, now) {
  await f.write([assistant(200000)]);
  await f.invoke({}, { now });
  const s = await state(f);
  let text = await fs.readFile(templatePath, 'utf8');
  const replacements = { HANDOFF_ID: s.handoff_id, SESSION_ID: s.session_id,
    GENERATION_ID: s.generation_id, CWD: f.root, CREATED_AT: new Date(now ?? Date.now()).toISOString() };
  for (const [key, value] of Object.entries(replacements)) text = text.replaceAll(`{{${key}}}`, JSON.stringify(value));
  text = text.replace('handoff_status: draft', 'handoff_status: ready')
    .replaceAll('{{FILL}}', 'Синтетический заполненный пункт; активных задач нет; PR нет.');
  await fs.mkdir(f.env.CLAUDE_COORDINATOR_HANDOFF_DIR, { recursive: true });
  await fs.writeFile(s.handoff_path, text);
  const output = await f.invoke({ hook_event_name: 'Stop', stop_hook_active: false }, { now });
  assert.match(context(output), /clear_session/);
  return s;
}

test('usage formula excludes outputs and nested repeated counters', () => {
  assert.equal(core.contextTokens({ input_tokens: 1000, cache_read_input_tokens: 170000,
    cache_creation_input_tokens: 9000, output_tokens: 99999,
    cache_creation: { ephemeral_5m_input_tokens: 9000 }, iterations: [{}] }), 180000);
  assert.equal(core.contextTokens({ input_tokens: 0 }), 0);
  for (const value of [null, '1', -1, 1.2, NaN, Infinity]) {
    assert.equal(core.contextTokens({ input_tokens: value }), null);
    assert.equal(core.contextTokens({ input_tokens: 1, cache_read_input_tokens: value }), null);
  }
  for (const value of [null, undefined, {}, [], 'invalid']) assert.equal(core.contextTokens(value), null);
});

for (const [tokens, level] of [[179999, null], [180000, 'PREPARE'], [199999, 'PREPARE'],
  [200000, 'TRANSFER'], [240000, 'TRANSFER']]) {
  test(`threshold ${tokens} emits ${level ?? 'nothing'} once`, async t => {
    const f = await fixture(t);
    await f.write([assistant(tokens)]);
    const output = await f.invoke();
    if (level) assert.match(context(output), new RegExp(`COORDINATOR_HANDOFF:${level}`));
    else assert.equal(output, null);
    assert.equal(await f.invoke(), null);
  });
}

test('hard latch persists with unknown usage; Stop issues only one continuation per phase', async t => {
  const f = await fixture(t);
  await f.write([assistant(180000)]);
  assert.equal((await f.invoke({ hook_event_name: 'Stop', stop_hook_active: true })), null);
  assert.equal((await f.invoke({ hook_event_name: 'Stop', stop_hook_active: false })).decision, 'block');
  assert.equal(await f.invoke({ hook_event_name: 'Stop', stop_hook_active: false }), null);
  await f.write([assistant(200000)]);
  assert.match(context(await f.invoke({ hook_event_name: 'Stop', stop_hook_active: true })), /TRANSFER/);
  assert.equal(await f.invoke({ hook_event_name: 'Stop', stop_hook_active: true }), null);
  await f.write([assistant(0, { uuid: 'a2', parentUuid: 'a1', message: { id: 'm2' } })]);
  assert.equal(core.isHardLatched(await state(f)), true);
  assert.equal(await f.invoke(), null);
});

test('latest response respects duplicates, sidechains, foreign sessions, services and parent branch', async t => {
  const f = await fixture(t);
  const records = [assistant(190000), assistant(240000, { uuid: 'abandoned', parentUuid: 'a1',
    message: { id: 'old', usage: { input_tokens: 240000 } } }),
  { type: 'user', sessionId: 'session-test', uuid: 'u2', parentUuid: 'a1' },
  assistant(180000, { uuid: 'a2', parentUuid: 'u2', requestId: 'r2',
    message: { id: 'm2', usage: { input_tokens: 180000 }, content: [{ type: 'tool_use' }] } }),
  assistant(0, { uuid: 'a3', parentUuid: 'a2', requestId: 'r2', message: { id: 'm2' } }),
  assistant(999999, { uuid: 'side', isSidechain: true }),
  assistant(999999, { uuid: 'foreign', sessionId: 'other' }), { type: 'system', subtype: 'notification' }];
  await f.write(records);
  assert.equal((await core.readUsage(f.transcript, f.payload.session_id)).tokens, 180000);
  // New user branch abandons the previous assistant entirely.
  await f.write([...records, { type: 'user', sessionId: 'session-test', uuid: 'u3', parentUuid: 'a1' }]);
  assert.equal((await core.readUsage(f.transcript, f.payload.session_id)).tokens, 190000);
});

test('latest answer without usage never borrows an older answer', async t => {
  const f = await fixture(t);
  await f.write([assistant(240000), assistant(0, { uuid: 'a2', parentUuid: 'a1',
    requestId: 'r2', message: { id: 'm2' } })]);
  assert.equal((await core.readUsage(f.transcript, 'session-test')).tokens, null);
});

test('requestId identifies duplicates when message.id is absent', async t => {
  const f = await fixture(t);
  await f.write([assistant(0, { uuid: 'a1', requestId: 'request-only', message: { usage: { input_tokens: 180000 } } }),
    assistant(0, { uuid: 'a2', parentUuid: 'a1', requestId: 'request-only', message: { content: [{ type: 'tool_use' }] } })]);
  assert.equal((await core.readUsage(f.transcript, 'session-test')).tokens, 180000);
});

test('oversized signal is diagnosed without emitting oversized JSON context', async t => {
  const f = await fixture(t);
  await f.write([assistant(200000)]);
  const messages = [];
  assert.equal(await f.invoke({ cwd: path.join(f.root, 'x'.repeat(12000)) }, { report: value => messages.push(value) }), null);
  assert.deepEqual(messages, ['context-handoff: OUTPUT_TOO_LARGE']);
});

test('bounded reading handles BOM, CRLF, UTF8 boundaries, long lines, malformed and unfinished records', async t => {
  const f = await fixture(t);
  const large = assistant(180000, { padding: 'я🙂'.repeat(20000) });
  await fs.writeFile(f.transcript, '\uFEFF' + jsonl([large], '\r\n') + '{broken}\r\n{"unfinished":');
  assert.equal((await core.readUsage(f.transcript, 'session-test', { blockBytes: 17 })).tokens, 180000);
  assert.equal((await core.readUsage(f.transcript, 'session-test', { maxBytes: 32 })).tokens, null);
  assert.equal((await core.readUsage(f.transcript, 'session-test', { budgetMs: 0 })).tokens, null);
  assert.equal((await core.readUsage(f.transcript + '.missing', 'session-test')).tokens, null);
  await fs.writeFile(f.transcript, '');
  assert.equal((await core.readUsage(f.transcript, 'session-test')).tokens, null);
});

test('snapshot length excludes growth during block reads', async t => {
  const f = await fixture(t);
  await f.write([assistant(180000, { padding: 'a'.repeat(70000) })]);
  let grew = false;
  const result = await core.readUsage(f.transcript, 'session-test', { afterSnapshot: async () => {
    grew = true;
    await fs.appendFile(f.transcript, jsonl([assistant(240000, { uuid: 'a2', parentUuid: 'a1' })]));
  } });
  assert.equal(grew, true);
  assert.equal(result.tokens, 180000);
});

test('invalid payload/config and disabling settings fail open without touching runtime', async t => {
  const f = await fixture(t);
  for (const input of [null, '', [], {}, { ...f.payload, session_id: '../evil' },
    { ...f.payload, cwd: 1 }, { ...f.payload, hook_event_name: 'PreToolUse' }]) {
    assert.equal(await core.handleEvent(input, { env: f.env }), null);
  }
  for (const env of [{ CLAUDE_COORDINATOR_MODE: 'off' }, { CLAUDE_COORDINATOR_HANDOFF_ENABLED: '0' },
    { CLAUDE_COORDINATOR_HANDOFF_PREPARE_TOKENS: 'bad' },
    { CLAUDE_COORDINATOR_HANDOFF_CLEAR_TOKENS: '1' }]) {
    assert.equal(await core.handleEvent(f.payload, { env: { ...f.env, ...env } }), null);
  }
  assert.deepEqual(await fs.readdir(f.root), ['transcript.jsonl']);
});

test('sessions independent, corrupted state and conflicting lock fail open', async t => {
  const f = await fixture(t);
  await f.write([assistant(180000)]);
  await f.invoke();
  const files = await fs.readdir(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR);
  const filename = path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, files.find(x => x.startsWith('session-')));
  await fs.writeFile(filename + '.lock', 'busy');
  assert.equal(await f.invoke({ hook_event_name: 'Stop' }), null);
  await fs.unlink(filename + '.lock');
  await fs.writeFile(filename, '{corrupt');
  assert.equal(await f.invoke(), null);
  await f.write([assistant(180000, { sessionId: 'other' })]);
  assert.match(context(await f.invoke({ session_id: 'other' })), /PREPARE/);
});

test('clear waits for ready; ready is armed once with hash and marker', async t => {
  const f = await fixture(t);
  const s = await ready(f);
  const current = await state(f);
  assert.equal(current.clear_attempted, true);
  assert.equal(current.transition_status, 'clear_pending');
  assert.equal(current.handoff_hash.length, 64);
  assert.equal(await f.invoke({ hook_event_name: 'Stop' }), null);
  assert.equal(s.clear_attempted, false);
});

test('clear restores once, same ID starts new generation; reply consumes emitted claim', async t => {
  const f = await fixture(t);
  const previous = await ready(f);
  const output = await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' });
  assert.match(context(output), /Синтетический заполненный пункт/);
  assert.notEqual((await state(f)).generation_id, previous.generation_id);
  assert.equal(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' }), null);
  await fs.appendFile(f.transcript, jsonl([assistant(100, { uuid: 'new', parentUuid: null })]));
  await f.invoke({ hook_event_name: 'Stop', last_assistant_message: `Приём передачи подтверждаю: ${previous.handoff_path}` });
  const index = JSON.parse(await fs.readFile(path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, 'index.json')));
  assert.equal(index.entries[0].delivery_status, 'consumed');
});

for (const source of ['startup', 'resume']) test(`${source} never auto-restores`, async t => {
  const f = await fixture(t);
  await ready(f);
  assert.equal(await f.invoke({ hook_event_name: 'SessionStart', source }), null);
});

test('clear supports changed ID but refuses cwd mismatch, TTL expiry and hash changes', async t => {
  for (const scenario of ['changed', 'cwd', 'ttl', 'hash']) {
    const f = await fixture(t);
    const now = Date.now();
    const s = await ready(f, now);
    if (scenario === 'hash') await fs.appendFile(s.handoff_path, '\nchanged');
    const output = await f.invoke({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'new',
      ...(scenario === 'cwd' ? { cwd: path.join(f.root, 'different') } : {}) },
    { now: scenario === 'ttl' ? now + 600001 : now });
    if (scenario === 'changed') assert.match(context(output), /Передача из предыдущего/);
    else assert.doesNotMatch(context(output), /Синтетический заполненный пункт/);
  }
});

test('multiple active chats or candidates use fallback; concurrent claim has one winner', async t => {
  const f = await fixture(t);
  await ready(f);
  const outputs = await Promise.all(['new1', 'new2'].map(session_id =>
    f.invoke({ hook_event_name: 'SessionStart', source: 'clear', session_id })));
  assert.equal(outputs.filter(output => context(output).includes('Синтетический заполненный пункт')).length, 1);
  const g = await fixture(t);
  await ready(g);
  await g.write([assistant(10, { sessionId: 'parallel' })]);
  await g.invoke({ session_id: 'parallel' });
  assert.match(context(await g.invoke({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'new' })), /MANUAL/);
});

for (const tokens of [100, 180000, 200000]) test(`compact preserves transition at ${tokens}, resets measurement`, async t => {
  const f = await fixture(t);
  await f.write([assistant(tokens)]);
  await f.invoke();
  const old = await state(f);
  assert.equal(await f.invoke({ hook_event_name: 'PreCompact', trigger: 'auto' }), null);
  const output = await f.invoke({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.notEqual((await state(f)).generation_id, old.generation_id);
  assert.equal((await state(f)).hard_latched, tokens >= 200000);
  if (tokens >= 180000) assert.match(context(output), tokens >= 200000 ? /TRANSFER/ : /PREPARE/);
  else assert.equal(output, null);
  assert.equal(await f.invoke(), null);
  assert.equal((await state(f)).last_usage, null);
});

test('entry emits one JSON or nothing; internal diagnostics contain no transcript', async t => {
  const f = await fixture(t);
  await f.write([assistant(200000)]);
  for (const input of ['', '{bad', JSON.stringify(f.payload), JSON.stringify({ ...f.payload, hook_event_name: 'Stop' }),
    JSON.stringify({ ...f.payload, hook_event_name: 'PreCompact', trigger: 'manual' }),
    JSON.stringify({ ...f.payload, hook_event_name: 'SessionStart', source: 'compact' })]) {
    const result = spawnSync(process.execPath, [entry], { input, encoding: 'utf8', env: { ...process.env, ...f.env } });
    assert.equal(result.status, 0);
    if (result.stdout.trim()) assert.equal(typeof JSON.parse(result.stdout), 'object');
    assert.doesNotMatch(result.stderr, /Синтетический ответ/);
  }
});

test('ready validation rejects incomplete, wrong owner, outside path and oversize files', async t => {
  for (const scenario of ['draft', 'placeholder', 'goal', 'step', 'section', 'metadata', 'owner', 'generation', 'cwd', 'size', 'path']) {
    const f = await fixture(t);
    const s = await ready(f);
    const stateFile = path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR,
      (await fs.readdir(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR)).find(x => x.startsWith('session-')));
    const original = await fs.readFile(s.handoff_path, 'utf8');
    const changes = {
      draft: text => text.replace('handoff_status: ready', 'handoff_status: draft'),
      placeholder: text => text + '\n{{FILL}}',
      goal: text => text.replace(/^- Цель:.*$/m, '- Цель: '),
      step: text => text.replace(/^1\. Первый конкретный шаг:.*$/m, '1. Первый конкретный шаг: '),
      section: text => text.replace('## Принятые решения', '## Missing'),
      metadata: text => text.replace('handoff_version: 1', 'handoff_version: 2'),
      owner: text => text.replace('source_session_id: "session-test"', 'source_session_id: "other"'),
      generation: text => text.replace(s.generation_id, 'other-generation'),
      cwd: text => text.replace(JSON.stringify(f.root), JSON.stringify(path.join(f.root, 'other'))),
      size: text => text + 'a'.repeat(8501), path: text => text,
    };
    await fs.writeFile(s.handoff_path, changes[scenario](original));
    const saved = await state(f);
    saved.clear_attempted = false;
    saved.hard_stop_issued = false;
    if (scenario === 'path') {
      saved.handoff_path = path.join(f.root, 'outside.md');
      await fs.writeFile(saved.handoff_path, original);
    }
    await fs.writeFile(stateFile, JSON.stringify(saved));
    const output = await f.invoke({ hook_event_name: 'Stop' });
    assert.doesNotMatch(context(output), /COORDINATOR_HANDOFF:CLEAR_READY/);
    assert.equal((await state(f)).clear_attempted, false);
  }
});

test('cooldown is shared by project, expires after ten minutes', async t => {
  const f = await fixture(t);
  const now = Date.now();
  await ready(f, now);
  const files = await fs.readdir(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR);
  const filename = path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, files.find(x => x.startsWith('session-')));
  const s = await state(f);
  s.clear_attempted = false;
  s.hard_stop_issued = false;
  await fs.writeFile(filename, JSON.stringify(s));
  assert.match(context(await f.invoke({ hook_event_name: 'Stop' }, { now: now + 1 })), /cooldown/);
  assert.equal(await f.invoke({ hook_event_name: 'Stop' }, { now: now + 2 }), null);
  s.clear_attempted = false;
  await fs.writeFile(filename, JSON.stringify(s));
  assert.match(context(await f.invoke({ hook_event_name: 'Stop' }, { now: now + 600000 })), /CLEAR_READY/);
});

test('two candidates and tampered index fail open without arbitrary recovery', async t => {
  const f = await fixture(t);
  await ready(f);
  const filename = path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, 'index.json');
  const index = JSON.parse(await fs.readFile(filename, 'utf8'));
  index.entries.push({ ...index.entries[0], source_session_id: 'other' });
  await fs.writeFile(filename, JSON.stringify(index));
  assert.match(context(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'new' })), /MANUAL/);
  await fs.writeFile(filename, '{bad');
  assert.equal(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'new2' }), null);
});

test('unknown parent beyond bounded tail returns unknown and an unchanged file uses cached measurement', async t => {
  const f = await fixture(t);
  await f.write([assistant(240000), { type: 'user', sessionId: 'session-test', uuid: 'u2', parentUuid: 'missing' }]);
  assert.equal((await core.readUsage(f.transcript, 'session-test')).tokens, null);
  await f.write([assistant(180000)]);
  await f.invoke();
  const first = await state(f);
  await f.invoke();
  assert.deepEqual((await state(f)).transcript_signature, first.transcript_signature);
});

test('handoff emits separately from consumption; unrelated reply does not consume', async t => {
  const f = await fixture(t);
  await ready(f);
  await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' });
  await f.invoke({ hook_event_name: 'Stop', last_assistant_message: 'Unrelated response' });
  const index = JSON.parse(await fs.readFile(path.join(f.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, 'index.json')));
  assert.equal(index.entries[0].delivery_status, 'emitted');
  assert.equal(index.entries[0].consumed_at_utc, null);
});

test('entry is disabled, missing transcript, blocked state directory and oversized input fail open', async t => {
  const f = await fixture(t);
  await f.write([assistant(200000)]);
  for (const extra of [{ CLAUDE_COORDINATOR_MODE: 'off' }, { CLAUDE_COORDINATOR_HANDOFF_ENABLED: '0' },
    { CLAUDE_COORDINATOR_HANDOFF_STATE_DIR: f.transcript }]) {
    const result = spawnSync(process.execPath, [entry], { input: JSON.stringify(f.payload), encoding: 'utf8',
      env: { ...process.env, ...f.env, ...extra } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  }
  const result = spawnSync(process.execPath, [entry], { input: 'a'.repeat(1024 * 1024 + 1), encoding: 'utf8',
    env: { ...process.env, ...f.env } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INPUT_TOO_LARGE/);
  await fs.unlink(f.transcript);
  assert.equal(await f.invoke(), null);
});

test('post-claim session write failure cannot suppress committed delivery or clear instruction', async t => {
  const originalRename = fs.rename;
  const f = await fixture(t);
  await ready(f);
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to).startsWith('session-')) throw Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'EIO' });
    return originalRename(from, to);
  });
  assert.match(context(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' })), /Передача из предыдущего/);
  mock.mock.restore();
  const g = await fixture(t);
  await ready(g);
  // Retest arming a fresh transition with only final session persistence failing.
  const indexFile = path.join(g.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR, 'index.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  index.entries = [];
  index.cooldowns = {};
  await fs.writeFile(indexFile, JSON.stringify(index));
  const sessionFile = path.join(g.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR,
    (await fs.readdir(g.env.CLAUDE_COORDINATOR_HANDOFF_STATE_DIR)).find(x => x.startsWith('session-')));
  const s = await state(g);
  s.clear_attempted = false;
  s.hard_stop_issued = false;
  await fs.writeFile(sessionFile, JSON.stringify(s));
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to).startsWith('session-')) throw Object.assign(new Error(), { code: 'EIO' });
    return originalRename(from, to);
  });
  assert.match(context(await g.invoke({ hook_event_name: 'Stop' })), /COORDINATOR_HANDOFF:CLEAR_READY/);
});

test('PreCompact observing threshold for first time preserves preparation need', async t => {
  const f = await fixture(t);
  await f.write([assistant(179999)]);
  await f.invoke();
  await f.write([assistant(180000)]);
  await f.invoke({ hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.match(context(await f.invoke({ hook_event_name: 'SessionStart', source: 'compact' })), /PREPARE/);
});

test('repeat SessionStart after transcript growth does not reset received generation', async t => {
  const f = await fixture(t);
  await ready(f);
  await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' });
  const first = await state(f);
  await fs.appendFile(f.transcript, jsonl([assistant(100, { uuid: 'new' })]));
  await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' });
  assert.equal((await state(f)).generation_id, first.generation_id);
});

test('reserved object keys cannot bypass active chat tracking', async t => {
  const f = await fixture(t);
  await f.write([assistant(180000, { sessionId: '__proto__' })]);
  assert.equal(await f.invoke({ session_id: '__proto__' }), null);
  assert.deepEqual(await fs.readdir(f.root), ['transcript.jsonl']);
});

test('lock cleanup failure after commit never suppresses emitted context', async t => {
  const f = await fixture(t);
  await ready(f);
  const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async filename => {
    if (filename.endsWith('.lock')) throw Object.assign(new Error(), { code: 'EIO' });
    return unlink(filename);
  });
  assert.match(context(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' })), /Передача из предыдущего/);
});

test('successful rename does not require temp cleanup to deliver context', async t => {
  const f = await fixture(t);
  await ready(f);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (filename, options) => {
    if (filename.endsWith('.tmp')) throw Object.assign(new Error(), { code: 'EIO' });
    return rm(filename, options);
  });
  assert.match(context(await f.invoke({ hook_event_name: 'SessionStart', source: 'clear' })), /Передача из предыдущего/);
  mocked.mock.restore();
});

test('a prepared draft needs no redundant soft Stop; hard finalization and clear each occur once', async t => {
  const f = await fixture(t);
  await f.write([assistant(180000)]);
  await f.invoke();
  const s = await state(f);
  await fs.mkdir(f.env.CLAUDE_COORDINATOR_HANDOFF_DIR, { recursive: true });
  await fs.writeFile(s.handoff_path, 'Draft of a coordinator handoff');
  assert.equal(await f.invoke({ hook_event_name: 'Stop' }), null);
  await f.write([assistant(200000)]);
  assert.match(context(await f.invoke({ hook_event_name: 'Stop' })), /TRANSFER/);
  await ready(f);
  assert.equal(await f.invoke({ hook_event_name: 'Stop' }), null);
});
