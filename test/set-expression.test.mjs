import assert from 'node:assert/strict';
import test from 'node:test';
import { createSetExpressionTool } from '../dist/agents/ava/tools/set-expression.js';
import { createOrbClient } from '../dist/channels/voice/orb-client.js';

test('set_expression waits for application confirmation and defaults to 3000 ms', async () => {
  const gate = Promise.withResolvers();
  let request, completed = false;
  const signal = new AbortController().signal;
  const tool = createSetExpressionTool(async (value, actualSignal) => {
    request = value;
    assert.equal(actualSignal, signal);
    await gate.promise;
  });
  const execution = tool.execute('call', { expression: 'feliz' }, signal).then((result) => { completed = true; return result; });
  assert.deepEqual(request, { expression: 'feliz', duration_ms: 3000 });
  assert.equal(completed, false);
  gate.resolve();
  const result = await execution;
  assert.deepEqual(result.details, { applied: true, ...request });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test('invalid parameters, failed application and cancellation never report success', async () => {
  let calls = 0;
  const tool = createSetExpressionTool(async () => { calls++; throw new Error('Disconnected'); });
  for (const params of [{ expression: 'unknown' }, { expression: 'feliz', duration_ms: 799 }, { expression: 'feliz', duration_ms: 15001 }, { expression: 'feliz', duration_ms: 900.5 }]) {
    await assert.rejects(tool.execute('call', params), /Invalid expression/);
  }
  assert.equal(calls, 0);
  await assert.rejects(tool.execute('call', { expression: 'feliz' }), /Disconnected/);
  await assert.rejects(tool.execute('call', { expression: 'feliz' }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('Orb client scopes requests to the Live session and authenticates locally', async () => {
  const request = { expression: 'piscadinha', duration_ms: 800 };
  const signal = new AbortController();
  const client = createOrbClient({
    sessionId: 'live_test', token: 'test-secret',
    fetchImpl: async (url, options) => {
      assert.equal(url.href, 'http://127.0.0.1:3000/api/orb/live_test/expression');
      assert.equal(options.headers.authorization, 'Bearer test-secret');
      assert.deepEqual(JSON.parse(options.body), request);
      assert.equal(options.redirect, 'error');
      signal.abort();
      assert.equal(options.signal.aborted, true);
      return Response.json({ applied: true, ...request });
    },
  });
  await client.setExpression(request, signal.signal);
});

test('Orb client rejects HTTP failures and mismatched or missing acknowledgements', async () => {
  for (const response of [new Response('', { status: 504 }), Response.json({ applied: false }), Response.json({ applied: true, expression: 'triste', duration_ms: 3000 })]) {
    const client = createOrbClient({ sessionId: 'live_test', token: 'secret', fetchImpl: async () => response });
    await assert.rejects(client.setExpression({ expression: 'feliz', duration_ms: 3000 }), /Orb/);
  }
});

test('Orb credentials cannot be sent to a nonlocal or redirecting origin', () => {
  for (const baseUrl of ['https://example.com', 'http://example.com', 'http://user:pass@localhost:3000', 'http://localhost:3000/path', 'http://localhost:3000?token=bad']) {
    assert.throws(() => createOrbClient({ sessionId: 'live_test', token: 'secret', baseUrl }), /local HTTP origin/);
  }
});
