import assert from 'node:assert/strict';
import test from 'node:test';
import { createGetLocalTimeTool } from '../dist/agents/ava/tools/get-local-time.js';
import { createWebSearchTool } from '../dist/agents/ava/tools/web-search.js';

function searchResponse() {
  return {
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
        { url: 'https://example.com/news' }, { url: 'https://example.com/background', title: 'Background' },
        { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com' },
      ] } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A sourced answer.', annotations: [
        { type: 'url_citation', url: 'https://example.com/news', title: 'News' },
        { type: 'url_citation', url: 'https://example.com/news', title: 'News' },
        { type: 'url_citation', url: 'not a URL', title: 'Invalid' },
      ] }] },
    ],
  };
}

test('local time uses Sao Paulo across UTC date boundaries and reads a fresh clock', async () => {
  const dates = ['2026-10-13T01:02:03.000Z', '2026-10-13T03:00:00.000Z'];
  const tool = createGetLocalTimeTool(() => new Date(dates.shift()));
  const first = await tool.execute('first', {});
  assert.deepEqual(first.details, { timeZone: 'America/Sao_Paulo', date: '2026-10-12', time: '22:02:03', weekday: 'Monday', utcOffset: '-03:00', utc: '2026-10-13T01:02:03.000Z' });
  assert.deepEqual(JSON.parse(first.content[0].text), first.details);
  const second = await tool.execute('second', {});
  assert.equal(second.details.date, '2026-10-13');
  assert.equal(second.details.time, '00:00:00');
});

test('local time respects cancellation before reading the clock', async () => {
  const tool = createGetLocalTimeTool(() => { throw new Error('Clock should not be read'); });
  await assert.rejects(tool.execute('call', {}, AbortSignal.abort()), { name: 'AbortError' });
});

test('web search forces hosted search with only the query and returns cited and consulted sources', async () => {
  const tool = createWebSearchTool({ apiKey: 'test-key', model: 'configured-search-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'configured-search-model');
    assert.equal(body.store, false);
    assert.equal(body.input, 'Recent news?');
    assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.equal(body.previous_response_id, undefined);
    return Response.json(searchResponse());
  } });
  const result = await tool.execute('call', { query: ' Recent news? ' });
  assert.equal(result.details.query, 'Recent news?');
  assert.equal(result.details.answer, 'A sourced answer.');
  assert.deepEqual(result.details.citations, [{ url: 'https://example.com/news', title: 'News' }]);
  assert.deepEqual(result.details.sources, [{ url: 'https://example.com/news', title: 'News' }, { url: 'https://example.com/background', title: 'Background' }]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test('invalid web search input is rejected before a request', async () => {
  let calls = 0;
  const tool = createWebSearchTool({ apiKey: 'key', fetchImpl: async () => { calls++; throw new Error('Unexpected request'); } });
  for (const query of ['', '   ', 'a'.repeat(2001), null]) await assert.rejects(tool.execute('call', { query }), /query/);
  assert.equal(calls, 0);
  assert.throws(() => createWebSearchTool({ apiKey: ' ' }), /OPENAI_API_KEY/);
  assert.throws(() => createWebSearchTool({ apiKey: 'key', model: ' ' }), /AVA_WEB_SEARCH_MODEL/);
});

test('provider failures and invalid JSON do not expose credentials or raw error bodies', async () => {
  for (const fetchImpl of [
    async () => new Response('sensitive-provider-body', { status: 401 }),
    async () => { throw new Error('sensitive-provider-body'); },
    async () => new Response('sensitive-provider-body', { status: 200 }),
  ]) {
    const tool = createWebSearchTool({ apiKey: 'private-key', fetchImpl });
    await assert.rejects(tool.execute('call', { query: 'News?' }), error => {
      assert.doesNotMatch(error.message, /sensitive-provider-body|private-key/);
      return true;
    });
  }
});

test('incomplete, refused, and search-free responses do not become successful search results', async () => {
  for (const response of [
    { ...searchResponse(), status: 'incomplete' },
    { status: 'failed', output: [] },
    { status: 'completed', output: searchResponse().output.slice(1) },
    { status: 'completed', output: [{ type: 'web_search_call', status: 'failed' }] },
    { status: 'completed', output: [searchResponse().output[0], { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] },
  ]) {
    const tool = createWebSearchTool({ apiKey: 'key', fetchImpl: async () => Response.json(response) });
    await assert.rejects(tool.execute('call', { query: 'News?' }), /Web search/);
  }
});

test('web search cancellation prevents new requests and aborts an active fetch', async () => {
  const controller = new AbortController();
  let requestSignal;
  const tool = createWebSearchTool({ apiKey: 'key', fetchImpl: (_url, { signal }) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(tool.execute('call', { query: 'News?' }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(requestSignal, undefined);
  const pending = tool.execute('call', { query: 'News?' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
});

test('web search enforces its request timeout', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const tool = createWebSearchTool({ apiKey: 'key', timeoutMs: 10, fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    await assert.rejects(tool.execute('call', { query: 'News?' }), { name: 'TimeoutError' });
  } finally { clearTimeout(keepAlive); }
});
