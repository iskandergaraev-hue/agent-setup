// Synthetic records only: never copy real conversations into this directory.
export function assistant(tokens, overrides = {}) {
  return {
    type: 'assistant', sessionId: 'session-test', isSidechain: false,
    uuid: 'a1', parentUuid: null, requestId: 'r1',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Синтетический ответ' }],
      usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ...overrides,
  };
}
export const jsonl = (records, eol = '\n') => records.map(record => JSON.stringify(record)).join(eol) + eol;
