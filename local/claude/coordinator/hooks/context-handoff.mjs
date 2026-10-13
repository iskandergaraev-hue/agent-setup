#!/usr/bin/env node
// Hooks are fail-open. Never write input, transcript contents or exception messages to stderr.
const MAX_INPUT_BYTES = 1024 * 1024;
const INPUT_TIMEOUT_MS = 2000;
let timer;
try {
  let size = 0;
  const chunks = [];
  timer = setTimeout(() => process.stdin.destroy(), INPUT_TIMEOUT_MS);
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw Object.assign(new Error(), { code: 'INPUT_TOO_LARGE' });
    chunks.push(chunk);
  }
  clearTimeout(timer);
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (text && process.env.CLAUDE_COORDINATOR_MODE !== 'off' && process.env.CLAUDE_COORDINATOR_HANDOFF_ENABLED !== '0') {
    const payload = JSON.parse(text);
    const { handleEvent } = await import('./context-handoff-core.mjs');
    const output = await handleEvent(payload);
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  }
} catch (error) {
  process.stderr.write(`context-handoff: ${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'INVALID_INPUT'}\n`);
} finally {
  clearTimeout(timer);
  process.exitCode = 0;
}
