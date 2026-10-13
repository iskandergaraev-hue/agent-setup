import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_TAIL = 16 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const READ_BUDGET_MS = 2000;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 10000;
const EVENTS = new Set(['UserPromptSubmit', 'Stop', 'PreCompact', 'SessionStart']);
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const PREFIX = 'CLAUDE_COORDINATOR_HANDOFF_';
const hash = value => createHash('sha256').update(value).digest('hex');
const unknown = signature => ({ tokens: null, messageId: null, signature });
const diagnostic = (report, code) => report(`context-handoff: ${/^[A-Z0-9_]+$/.test(code ?? '') ? code : 'INTERNAL_ERROR'}`);
const reportError = error => diagnostic(message => process.stderr.write(message + '\n'), error.code);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function contextTokens(usage) {
  if (!object(usage) || !Object.hasOwn(usage, 'input_tokens')) return null;
  const values = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .map(key => Object.hasOwn(usage, key) ? usage[key] : 0);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function isHardLatched(state) { return state?.hard_latched === true; }

export function configFromEnv(env) {
  const coordinator = path.join(os.homedir(), '.claude', 'coordinator');
  const number = (key, fallback, ceiling = Number.MAX_SAFE_INTEGER) => {
    const raw = env[PREFIX + key];
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > ceiling) {
      throw Object.assign(new Error(), { code: 'INVALID_CONFIG' });
    }
    return Number(raw);
  };
  const config = {
    enabled: env.CLAUDE_COORDINATOR_MODE !== 'off' && env[PREFIX + 'ENABLED'] !== '0',
    prepare: number('PREPARE_TOKENS', 180000), clear: number('CLEAR_TOKENS', 200000),
    maxBytes: number('MAX_TAIL_BYTES', MAX_TAIL, MAX_TAIL),
    ttl: number('PENDING_TTL_SECONDS', 600) * 1000,
    cooldown: number('CLEAR_COOLDOWN_SECONDS', 600) * 1000,
    maxChars: number('MAX_CHARS', 8500, 8500),
    stateDir: path.resolve(env[PREFIX + 'STATE_DIR'] ?? path.join(coordinator, 'state', 'context-handoff')),
    handoffDir: path.resolve(env[PREFIX + 'DIR'] ?? path.join(coordinator, 'handoffs')),
  };
  if (config.prepare >= config.clear) throw Object.assign(new Error(), { code: 'INVALID_CONFIG' });
  return config;
}

export function cwdKey(cwd) {
  const normalized = path.resolve(cwd).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validPayload(payload) {
  return object(payload) && typeof payload.session_id === 'string' &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(payload.session_id) &&
    !['__proto__', 'constructor', 'prototype'].includes(payload.session_id) &&
    typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) &&
    typeof payload.transcript_path === 'string' && path.isAbsolute(payload.transcript_path) &&
    EVENTS.has(payload.hook_event_name) &&
    (payload.hook_event_name !== 'SessionStart' || SOURCES.has(payload.source)) &&
    (payload.stop_hook_active === undefined || typeof payload.stop_hook_active === 'boolean');
}

// Read a fixed snapshot in blocks, decode only after joining bytes. A partial first
// line is discarded, preventing UTF8 corruption and trusting truncated JSON.
export async function readUsage(filename, sessionId, options = {}) {
  const { maxBytes = MAX_TAIL, blockBytes = BLOCK_BYTES, budgetMs = READ_BUDGET_MS,
    boundary = 0, afterSnapshot } = options;
  const deadline = performance.now() + budgetMs;
  let file;
  let signature;
  try {
    file = await fs.open(filename, 'r');
    const stat = await file.stat();
    signature = { path: filename, size: stat.size, mtimeMs: stat.mtimeMs, boundary };
    if (performance.now() >= deadline || stat.size <= boundary) return unknown(signature);
    await afterSnapshot?.(stat);
    const start = Math.max(boundary, stat.size - maxBytes);
    let position = stat.size;
    const chunks = [];
    while (position > start) {
      if (performance.now() >= deadline) return unknown(signature);
      const length = Math.min(blockBytes, position - start);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) return unknown(signature);
      chunks.push(buffer);
    }
    const buffer = Buffer.concat(chunks.reverse());
    // boundary is the previous snapshot's byte length, hence already a line boundary
    // only when that snapshot ended in LF. Verify with the preceding byte.
    let skip = 0;
    if (start > 0) {
      const preceding = Buffer.alloc(1);
      await file.read(preceding, 0, 1, start - 1);
      if (preceding[0] !== 10) skip = buffer.indexOf(10) + 1 || buffer.length;
    }
    const records = [];
    let lineStart = skip;
    for (let end = skip; end <= buffer.length; end++) {
      if (end !== buffer.length && buffer[end] !== 10) continue;
      if (performance.now() >= deadline) return unknown(signature);
      const line = buffer.subarray(lineStart, end).toString('utf8').replace(/^\uFEFF/, '');
      lineStart = end + 1;
      try {
        const row = JSON.parse(line);
        if (row.sessionId === sessionId && row.isSidechain !== true && !row.agentId && !row.teamName &&
          ['assistant', 'user'].includes(row.type) && typeof row.uuid === 'string') records.push(row);
      } catch { /* Bad or unfinished JSONL lines carry no trusted usage. */ }
    }
    return selectUsage(records, signature, deadline);
  } catch { return unknown(signature); }
  finally { await file?.close(); }
}

function selectUsage(records, signature, deadline) {
  const byId = new Map(records.map(row => [row.uuid, row]));
  let latest = records.at(-1);
  const visited = new Set();
  while (latest && latest.type !== 'assistant') {
    if (performance.now() >= deadline || visited.has(latest.uuid)) return unknown(signature);
    visited.add(latest.uuid);
    latest = byId.get(latest.parentUuid);
  }
  if (!latest) return unknown(signature);
  const id = latest.message?.id;
  const request = latest.requestId;
  // Only this answer's duplicates can supply usage. Never borrow an older response.
  for (let i = records.length - 1; i >= 0; i--) {
    if (performance.now() >= deadline) return unknown(signature);
    const row = records[i];
    const sameAnswer = id ? row.message?.id === id : request && row.requestId === request;
    const same = row.uuid === latest.uuid || (sameAnswer &&
      (!request || !row.requestId || row.requestId === request));
    if (row.type === 'assistant' && same && Object.hasOwn(row.message ?? {}, 'usage')) {
      return { tokens: contextTokens(row.message.usage), messageId: id ?? latest.uuid, signature };
    }
  }
  return unknown(signature);
}

async function readJson(filename, fallback) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    if ((await file.stat()).size > MAX_STATE_BYTES) throw Object.assign(new Error(), { code: 'INVALID_STATE' });
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw Object.assign(new Error(), { code: 'INVALID_STATE' });
  } finally { await file?.close(); }
}

async function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, filename);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(temp, { force: true }).catch(reportError);
  }
}

async function locked(filename, action) {
  const lockPath = filename + '.lock';
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try { return await action(); }
  finally {
    await lock.close().catch(reportError);
    await fs.unlink(lockPath).catch(reportError);
  }
}

function newState(payload, now) {
  return {
    version: 1, session_id: payload.session_id, generation_id: randomUUID(),
    cwd_key: cwdKey(payload.cwd), project_root_key: cwdKey(payload.cwd), updated_at: now,
    generation_boundary: 0, last_usage: null, last_message_id: null, transcript_signature: null,
    prepare_notified: false, hard_notified: false, hard_latched: false,
    soft_stop_issued: false, hard_stop_issued: false, clear_attempted: false,
    transition_status: 'idle', compact_pending: false,
  };
}

function validateState(state, payload) {
  if (!object(state) || state.version !== 1 || state.session_id !== payload.session_id ||
    state.cwd_key !== cwdKey(payload.cwd) || typeof state.generation_id !== 'string' ||
    !Number.isSafeInteger(state.generation_boundary) || state.generation_boundary < 0 ||
    ['hard_latched', 'prepare_notified', 'hard_notified', 'soft_stop_issued', 'hard_stop_issued', 'clear_attempted']
      .some(key => typeof state[key] !== 'boolean')) throw Object.assign(new Error(), { code: 'INVALID_STATE' });
}

function ensureHandoff(state, config, now) {
  if (state.handoff_id) return;
  state.handoff_id = randomUUID();
  state.handoff_generation_id = state.generation_id;
  state.handoff_path = path.join(config.handoffDir, `${new Date(now).toISOString().slice(0, 10)}-handoff-${state.handoff_id}.md`);
}

function signal(state, config, level) {
  const common = `Последний доступный usage: ${state.last_usage ?? 'unknown'} входных токенов. ` +
    `Пороги: подготовка ${config.prepare}, переход ${config.clear}. Handoff: ${state.handoff_path}. ` +
    `Шаблон: ${path.resolve(config.handoffDir, '../templates/handoff.md')}. ` +
    `Метаданные: handoff_id=${state.handoff_id}, source_session_id=${state.session_id}, ` +
    `source_generation_id=${state.handoff_generation_id}, source_cwd=${state.cwd_key}. ` +
    'Сохрани цель и критерии, решения, сделано и принято, последнюю просьбу пользователя и невыполненные действия, ' +
    'активные Codex job-id, cwd и пути брифов, записей задач и результатов, ветки/PR, следующий шаг, вопросы и запреты. ';
  if (level === 'PREPARE') return `[COORDINATOR_HANDOFF:PREPARE]\n${common}` +
    'На ближайшей паузе создай или обнови файл. Основную работу пока можно продолжать. Не дублируй действующие задачи.';
  return `[COORDINATOR_HANDOFF:TRANSFER]\n${common}` +
    'Новую работу и новые Codex-задачи не начинай. Заверши handoff, проверь его чтением и поставь handoff_status: ready. ' +
    'Заверши текущий ответ: Stop проверит файл и выдаст CLEAR_READY. Только после CLEAR_READY один раз вызови ' +
    'mcp__ccd_session_mgmt__clear_session с {"session_id":"self"}. После результата коротко ответь пользователю; ' +
    'при отложенной очистке сообщи: очистка запрошена. При отсутствии инструмента, отказе карточки, Remote Control ' +
    'или ошибке поставь transition_status: manual_required, покажи путь и промпт восстановления. Не повторяй clear ' +
    'и не продолжай основную работу в этом разговоре.';
}

function manual(reason, filename) {
  return `[COORDINATOR_HANDOFF:MANUAL]\nАвтоматический переход недоступен: ${reason}. ` +
    (filename ? `Прочитай ${filename} и ~/.claude/CLAUDE.md. Проверь активные Codex-задачи по job-id и cwd, ` +
      'продолжи со следующего шага. Уже выполненную работу и действующие задачи не дублируй.' :
      'Укажи конкретный файл handoff для ручного восстановления; неоднозначный файл автоматически не выбирается.');
}

function output(event, text) {
  if (!text) return null;
  if (text.length > MAX_CONTEXT_CHARS) throw Object.assign(new Error(), { code: 'OUTPUT_TOO_LARGE' });
  return event === 'Stop' ? { decision: 'block', reason: text } :
    { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

async function insideHandoff(filename, directory) {
  const base = await fs.realpath(directory);
  const resolved = await fs.realpath(filename);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error(), { code: 'INVALID_HANDOFF_PATH' });
  }
  return resolved;
}

const SECTIONS = ['Цель и критерии готовности', 'Последняя просьба пользователя', 'Принятые решения',
  'Сделано и принято', 'Активные Codex-задачи', 'Ветки, изменения и PR', 'Следующий шаг',
  'Открытые вопросы и риски', 'Чего не делать и не переделывать', 'Возобновление'];

// Intentionally a restricted frontmatter format, not a YAML parser or interpreter.
export function parseHandoff(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw Object.assign(new Error(), { code: 'INVALID_HANDOFF' });
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-z_]+): (.+)$/);
    if (!pair || Object.hasOwn(metadata, pair[1])) throw Object.assign(new Error(), { code: 'INVALID_HANDOFF' });
    metadata[pair[1]] = pair[2].startsWith('"') ? JSON.parse(pair[2]) : pair[2];
  }
  if (metadata.handoff_version !== '1' || metadata.handoff_status !== 'ready' ||
    !['preparing', 'clear_pending'].includes(metadata.transition_status) ||
    ['handoff_id', 'source_session_id', 'source_generation_id', 'source_cwd', 'project_root',
      'created_at_utc', 'updated_at_utc'].some(key => typeof metadata[key] !== 'string' || !metadata[key].trim()) ||
    !Number.isFinite(Date.parse(metadata.created_at_utc)) || !Number.isFinite(Date.parse(metadata.updated_at_utc)) ||
    /\{\{|<[^>]+>/.test(text) ||
    SECTIONS.some(section => !text.includes(`## ${section}`)) ||
    !/^- Цель:[ \t]*\S.+$/m.test(text) || !/^1\. Первый конкретный шаг:[ \t]*\S.+$/m.test(text)) {
    throw Object.assign(new Error(), { code: 'INVALID_HANDOFF' });
  }
  return metadata;
}

async function verifiedHandoff(state, config) {
  const filename = await insideHandoff(state.handoff_path, config.handoffDir);
  const file = await fs.open(filename, 'r');
  let text;
  try {
    if ((await file.stat()).size > config.maxChars * 4) throw Object.assign(new Error(), { code: 'HANDOFF_TOO_LARGE' });
    text = await file.readFile('utf8');
  } finally { await file.close(); }
  if (text.length > config.maxChars) throw Object.assign(new Error(), { code: 'HANDOFF_TOO_LARGE' });
  const metadata = parseHandoff(text);
  if (metadata.handoff_id !== state.handoff_id || metadata.source_session_id !== state.session_id ||
    metadata.source_generation_id !== state.handoff_generation_id || cwdKey(metadata.source_cwd) !== state.cwd_key ||
    (metadata.project_root !== 'none' && cwdKey(metadata.project_root) !== state.project_root_key)) {
    throw Object.assign(new Error(), { code: 'HANDOFF_MISMATCH' });
  }
  return { text, hash: hash(text) };
}

async function withIndex(config, action) {
  const filename = path.join(config.stateDir, 'index.json');
  return locked(filename, async () => {
    const index = await readJson(filename, { version: 1, entries: [], active: {}, cooldowns: {} });
    if (!object(index) || index.version !== 1 || !Array.isArray(index.entries) ||
      !object(index.active) || !object(index.cooldowns)) throw Object.assign(new Error(), { code: 'INVALID_STATE' });
    const result = await action(index);
    await atomicJson(filename, index);
    return result;
  });
}

async function armClear(state, config, now, index) {
  const handoff = await verifiedHandoff(state, config);
  const cooldownKey = hash(state.project_root_key);
  if (index.cooldowns[cooldownKey] !== undefined && now - index.cooldowns[cooldownKey] < config.cooldown) {
    state.transition_status = 'manual_required';
    state.clear_attempted = true;
    return manual(`cooldown одной автоочистки на ${config.cooldown / 1000} секунд`, state.handoff_path);
  }
  index.cooldowns[cooldownKey] = now;
  index.entries.push({ handoff_id: state.handoff_id, source_session_id: state.session_id,
    source_generation_id: state.handoff_generation_id, source_cwd_key: state.cwd_key,
    project_root_key: state.project_root_key, handoff_path: state.handoff_path, handoff_hash: handoff.hash,
    ready_at_utc: new Date(now).toISOString(), clear_attempted_at_utc: new Date(now).toISOString(),
    delivery_status: 'pending', claimed_by: null, emitted_at_utc: null, consumed_at_utc: null });
  state.handoff_hash = handoff.hash;
  state.clear_attempted = true;
  state.transition_status = 'clear_pending';
  return `[COORDINATOR_HANDOFF:CLEAR_READY]\nФайл ${state.handoff_path} проверен; маркер ожидаемой очистки записан. ` +
    'Один раз вызови mcp__ccd_session_mgmt__clear_session с {"session_id":"self"}. ' +
    'После результата коротко ответь: очистка запрошена. Не утверждай, что контекст уже восстановлен. ' +
    'При отсутствии инструмента, отказе карточки, Remote Control или ошибке поставь transition_status: manual_required ' +
    'и выдай путь и промпт ручного восстановления. Не повторяй clear.';
}

async function restore(state, payload, config, now, index) {
  const candidates = index.entries.filter(entry => entry.delivery_status === 'pending' &&
    entry.source_cwd_key === state.cwd_key && entry.project_root_key === state.project_root_key &&
    entry.clear_attempted_at_utc && now >= Date.parse(entry.clear_attempted_at_utc) &&
    now - Date.parse(entry.clear_attempted_at_utc) <= config.ttl);
  const exact = candidates.filter(entry => entry.source_session_id === payload.session_id);
  const eligible = exact.length ? exact : candidates;
  const active = Object.entries(index.active).filter(([id, chat]) => id !== payload.session_id &&
    chat.cwd_key === state.cwd_key && now - chat.updated_at <= config.ttl);
  if (eligible.length !== 1 || (!exact.length && active.some(([id]) => id !== eligible[0]?.source_session_id))) {
    return candidates.length ? manual('несколько чатов или кандидатов одного cwd', null) : null;
  }
  const entry = eligible[0];
  const previous = { ...state, session_id: entry.source_session_id, handoff_id: entry.handoff_id,
    handoff_generation_id: entry.source_generation_id, handoff_path: entry.handoff_path };
  const handoff = await verifiedHandoff(previous, config);
  if (handoff.hash !== entry.handoff_hash) return manual('hash передачи изменился', entry.handoff_path);
  const wrapper = `Передача из предыдущего разговора: ${entry.handoff_path}. ` +
    'Сначала проверь принадлежность, актуальность и перечисленные задачи. Подтверди приём первым ответом с путём файла, ' +
    'продолжи со следующего шага. Утверждённые текущие правила имеют приоритет над историческими предложениями.\n\n';
  if (wrapper.length + handoff.text.length > MAX_CONTEXT_CHARS) return manual('слишком большой контекст передачи', entry.handoff_path);
  entry.claimed_by = `${state.session_id}:${state.generation_id}`;
  entry.delivery_status = 'emitted';
  entry.emitted_at_utc = new Date(now).toISOString();
  state.received_handoff_id = entry.handoff_id;
  state.received_handoff_path = entry.handoff_path;
  delete index.active[entry.source_session_id];
  return wrapper + handoff.text;
}

async function transcriptSize(filename) {
  try { return (await fs.stat(filename)).size; } catch { return 0; }
}

async function sessionStart(state, payload, config, now, index) {
  if (payload.source === 'startup' || payload.source === 'resume') return null;
  if (state.last_start_source === payload.source &&
    (payload.source === 'clear' ? !state.clear_attempted : !state.compact_pending)) return null;
  const size = await transcriptSize(payload.transcript_path);
  const signature = `${payload.source}:${payload.transcript_path}:${size}`;
  if (state.last_start_signature === signature) return null;
  if (payload.source === 'clear') {
    const fresh = newState(payload, now);
    fresh.generation_boundary = size;
    fresh.last_start_signature = signature;
    fresh.last_start_source = payload.source;
    const text = await restore(fresh, payload, config, now, index);
    Object.keys(state).forEach(key => delete state[key]);
    Object.assign(state, fresh);
    return text;
  }
  state.generation_id = randomUUID();
  state.generation_boundary = size;
  state.last_start_signature = signature;
  state.last_start_source = payload.source;
  state.last_usage = null;
  state.transcript_signature = null;
  state.compact_pending = false;
  return state.hard_latched ? signal(state, config, 'TRANSFER') :
    state.prepare_notified ? signal(state, config, 'PREPARE') : null;
}

async function measure(state, payload, config) {
  const stat = await fs.stat(payload.transcript_path).catch(() => null);
  const old = state.transcript_signature;
  if (stat && old?.path === payload.transcript_path && old.size === stat.size && old.mtimeMs === stat.mtimeMs &&
    old.boundary === state.generation_boundary) return;
  const usage = await readUsage(payload.transcript_path, payload.session_id,
    { maxBytes: config.maxBytes, boundary: state.generation_boundary });
  state.last_usage = usage.tokens;
  state.last_message_id = usage.messageId;
  state.transcript_signature = usage.signature ?? null;
  if (usage.tokens !== null && usage.tokens >= config.clear) state.hard_latched = true;
  if (state.hard_latched || (usage.tokens !== null && usage.tokens >= config.prepare)) ensureHandoff(state, config, Date.now());
}

function touchIndex(state, payload, now, index) {
  index.active[state.session_id] = { cwd_key: state.cwd_key, updated_at: now };
  if (payload.hook_event_name !== 'Stop' || !state.received_handoff_id ||
    typeof payload.last_assistant_message !== 'string' ||
    !payload.last_assistant_message.includes(state.received_handoff_path) ||
    !/при[её]м|приня[лт]|получ[еи]|подтвержд/i.test(payload.last_assistant_message)) return;
  const entry = index.entries.find(entry => entry.handoff_id === state.received_handoff_id &&
    entry.claimed_by === `${state.session_id}:${state.generation_id}` && entry.delivery_status === 'emitted');
  if (entry) { entry.delivery_status = 'consumed'; entry.consumed_at_utc = new Date(now).toISOString(); }
}

async function stop(state, payload, config, now, report, index) {
  if (state.clear_attempted) return null;
  if (state.hard_latched && !state.hard_stop_issued) {
    try {
      const text = await armClear(state, config, now, index);
      state.hard_stop_issued = true;
      return text;
    } catch (error) {
      if (!['ENOENT', 'INVALID_HANDOFF', 'HANDOFF_MISMATCH', 'HANDOFF_TOO_LARGE'].includes(error.code)) throw error;
      diagnostic(report, error.code);
      if (state.soft_stop_issued) {
        state.transition_status = 'manual_required';
        if (state.soft_stop_phase !== 'prepare') return null;
        state.hard_stop_issued = true;
        return signal(state, config, 'TRANSFER') + '\n' + manual('ready отсутствует; лимит продолжений Stop исчерпан', state.handoff_path);
      }
      state.soft_stop_issued = true;
      state.soft_stop_phase = 'transfer';
      return signal(state, config, 'TRANSFER');
    }
  }
  if (state.prepare_notified && !state.soft_stop_issued && !payload.stop_hook_active) {
    const draft = await fs.stat(state.handoff_path).catch(() => null);
    if (draft?.isFile() && draft.size > 0) return null;
    state.soft_stop_issued = true;
    state.soft_stop_phase = 'prepare';
    return signal(state, config, 'PREPARE');
  }
  return null;
}

async function processEvent(state, payload, config, now, report, index) {
  if (payload.hook_event_name === 'SessionStart') return sessionStart(state, payload, config, now, index);
  await measure(state, payload, config);
  if (payload.hook_event_name === 'PreCompact') {
    state.compact_pending = true;
    if (!state.hard_latched && state.last_usage !== null && state.last_usage >= config.prepare) state.prepare_notified = true;
    return null;
  }
  if (payload.hook_event_name === 'Stop') {
    if (state.hard_latched) state.hard_notified = true;
    else if (state.last_usage !== null && state.last_usage >= config.prepare) state.prepare_notified = true;
    return stop(state, payload, config, now, report, index);
  }
  if (state.hard_latched && !state.hard_notified) {
    state.hard_notified = true;
    return signal(state, config, 'TRANSFER');
  }
  if (!state.hard_latched && state.last_usage !== null && state.last_usage >= config.prepare && !state.prepare_notified) {
    state.prepare_notified = true;
    return signal(state, config, 'PREPARE');
  }
  return null;
}

export async function handleEvent(payload, { env = process.env, now = Date.now(),
  report = message => process.stderr.write(message + '\n') } = {}) {
  try {
    if (env.CLAUDE_COORDINATOR_MODE === 'off' || env[PREFIX + 'ENABLED'] === '0' || !validPayload(payload)) return null;
    const config = configFromEnv(env);
    await fs.mkdir(config.stateDir, { recursive: true });
    const filename = path.join(config.stateDir, `session-${hash(payload.session_id)}.json`);
    return await locked(filename, async () => {
      const state = await readJson(filename, newState(payload, now));
      validateState(state, payload);
      // One index transaction covers claim, cooldown and active-chat tracking.
      // Once committed, session-write errors must never suppress its output.
      const result = await withIndex(config, async index => {
        const text = await processEvent(state, payload, config, now, report, index);
        state.updated_at = now;
        touchIndex(state, payload, now, index);
        return output(payload.hook_event_name, text);
      });
      try { await atomicJson(filename, state); }
      catch (error) { diagnostic(report, error.code); }
      return result;
    });
  } catch (error) { diagnostic(report, error.code); return null; }
}
