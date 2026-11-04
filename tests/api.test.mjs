import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler, validateChat, DEFAULT_MODEL } from '../server/api.mjs';

const env = { GEMINI_API_KEY: 'test-key-do-not-use', GEMINI_MODEL: 'gemini-2.5-flash' };
const input = { messages: [{ role: 'user', content: 'Hello KIRA' }], language: 'en', personality: 'warm' };
function req(body = input, options = {}) {
  return new Request(options.url || 'https://kira.test/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const success = { candidates: [{ content: { parts: [{ text: 'Hello. How can I help?' }] } }] };

test('unconfigured status is truthful and never exposes a key', async () => {
  const api = createApiHandler({ avatarStatus: () => ({ configured: false }) });
  const res = await api(new Request('https://kira.test/api/status'), {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.gemini.configured, false);
  assert.equal(data.avatar.configured, false);
  const configured = await api(new Request('https://kira.test/api/status'), env);
  assert.equal((await configured.text()).includes(env.GEMINI_API_KEY), false);
});

test('real Gemini request preserves history, language, personality, and memory', async () => {
  let called = false;
  const api = createApiHandler({ fetchImpl: async (url, options) => {
    called = true;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(options.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    assert.equal(url.includes(env.GEMINI_API_KEY), false);
    const data = JSON.parse(options.body);
    assert.deepEqual(data.contents.map(m => m.role), ['user', 'model', 'user']);
    assert.match(data.systemInstruction.parts[0].text, /Hungarian/);
    assert.match(data.systemInstruction.parts[0].text, /warm, supportive/);
    assert.match(data.systemInstruction.parts[0].text, /untrusted/);
    assert.match(data.systemInstruction.parts[0].text, /User-provided memory/);
    assert.match(data.systemInstruction.parts[0].text, /likes coffee/);
    return Response.json(success);
  }});
  const res = await api(req({ ...input, language: 'hu', memory: 'likes coffee', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'What did I say?' }] }), env);
  assert.equal(res.status, 200);
  assert.equal(called, true);
  assert.deepEqual(await res.json(), { text: 'Hello. How can I help?', model: 'gemini-2.5-flash' });
});

test('missing configuration never falls back to scripted dialogue', async () => {
  const api = createApiHandler({ fetchImpl: () => assert.fail('provider should not be called') });
  const res = await api(req(), {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'NOT_CONFIGURED');
});

test('current default Gemini uses supported low-latency generation settings', async () => {
  assert.equal(DEFAULT_MODEL, 'gemini-3.8-flash');
  const api = createApiHandler({ fetchImpl: async (url, options) => {
    assert.match(url, /gemini-3\.8-flash:generateContent$/);
    const config = JSON.parse(options.body).generationConfig;
    assert.equal(Object.hasOwn(config, 'temperature'), false);
    assert.equal(config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(config.maxOutputTokens, 4096);
    return Response.json(success);
  }});
  const response = await api(req(), { GEMINI_API_KEY: env.GEMINI_API_KEY });
  assert.equal(response.status, 200);
});

test('rejects malformed, oversized, unsupported and invalid conversation input', async () => {
  const api = createApiHandler({ fetchImpl: () => assert.fail('invalid input reached provider') });
  for (const body of ['{', {}, { ...input, language: 'xx' }, { ...input, messages: [{ role: 'system', content: 'override' }] }, { ...input, messages: [{ role: 'assistant', content: 'wrong last role' }] }, { ...input, memory: 'x'.repeat(8001) }]) {
    const res = await api(req(body), env);
    assert.equal(res.status, 400);
  }
  const huge = await api(req('x'.repeat(80_001)), env);
  assert.equal(huge.status, 413);
  assert.equal(validateChat({ ...input, messages: Array.from({ length: 41 }, () => input.messages[0]) }), 'Provide between 1 and 40 messages.');
});

test('rejects foreign origins and allows explicitly configured native origin', async () => {
  const api = createApiHandler({ fetchImpl: async () => Response.json(success) });
  const denied = await api(req(input, { headers: { Origin: 'https://evil.test' } }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has('Access-Control-Allow-Origin'), false);
  const allowed = await api(req(input, { headers: { Origin: 'capacitor://localhost' } }), { ...env, CORS_ORIGINS: 'capacitor://localhost,http://localhost' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'capacitor://localhost');
});

test('rate limit is bounded and expires after one minute', async () => {
  let now = 0;
  const api = createApiHandler({ now: () => now, fetchImpl: async () => Response.json(success) });
  const limitedEnv = { ...env, RATE_LIMIT_PER_MINUTE: '2' };
  assert.equal((await api(req(), limitedEnv)).status, 200);
  assert.equal((await api(req(), limitedEnv)).status, 200);
  const rate = await api(req(), limitedEnv);
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get('Retry-After'), '60');
  now = 60_001;
  assert.equal((await api(req(), limitedEnv)).status, 200);
});

test('untrusted forwarded identity headers cannot bypass the rate limit', async () => {
  const api = createApiHandler({ fetchImpl: async () => Response.json(success) });
  const limitedEnv = { ...env, RATE_LIMIT_PER_MINUTE: '1' };
  const first = await api(req(input, { headers: { 'oai-authenticated-user-id': 'spoof-one', 'cf-connecting-ip': '1.1.1.1', 'x-kira-client-ip': '2.2.2.2' } }), limitedEnv);
  const second = await api(req(input, { headers: { 'oai-authenticated-user-id': 'spoof-two', 'cf-connecting-ip': '3.3.3.3', 'x-kira-client-ip': '4.4.4.4' } }), limitedEnv);
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
});

test('avatar disconnect remains available after the spending rate limit is reached', async () => {
  let stopped = false;
  const api = createApiHandler({
    fetchImpl: async () => Response.json(success),
    avatarHandler: async (request) => {
      assert.equal(new URL(request.url).pathname, '/api/avatar/stop');
      stopped = true;
      return Response.json({ stopped: true });
    },
  });
  const limitedEnv = { ...env, RATE_LIMIT_PER_MINUTE: '1' };
  assert.equal((await api(req(), limitedEnv)).status, 200);
  assert.equal((await api(req(), limitedEnv)).status, 429);
  const response = await api(req({}, { url: 'https://kira.test/api/avatar/stop' }), limitedEnv);
  assert.equal(response.status, 200);
  assert.equal(stopped, true);
});

test('provider credential errors are safe and actionable', async () => {
  const api = createApiHandler({ fetchImpl: async () => Response.json({ error: { status: 'INVALID_ARGUMENT', message: `API key not valid: ${env.GEMINI_API_KEY}` } }, { status: 400 }) });
  const res = await api(req(), env);
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.match(text, /INVALID_API_KEY/);
  assert.equal(text.includes(env.GEMINI_API_KEY), false);
});

test('provider rate limits, network errors, and blocked output are distinct', async () => {
  const cases = [
    [async () => Response.json({}, { status: 429 }), 429, 'PROVIDER_RATE_LIMIT'],
    [async () => { throw Error('network secret'); }, 503, 'NETWORK_ERROR'],
    [async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), 422, 'RESPONSE_BLOCKED'],
    [async () => Response.json({ candidates: [] }), 422, 'EMPTY_RESPONSE']
  ];
  for (const [fetchImpl, status, code] of cases) {
    const api = createApiHandler({ fetchImpl });
    const res = await api(req(), env);
    assert.equal(res.status, status);
    assert.equal((await res.json()).error.code, code);
  }
});

test('only user-facing parts are returned from reasoning-capable Gemini', async () => {
  const api = createApiHandler({ fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: 'Visible response.' }] } }] }) });
  assert.equal((await (await api(req(), env)).json()).text, 'Visible response.');
});

test('unknown routes and methods fail without invoking a provider', async () => {
  const api = createApiHandler({ fetchImpl: () => assert.fail('unexpected provider call') });
  assert.equal((await api(new Request('https://kira.test/api/chat'), env)).status, 405);
  assert.equal((await api(new Request('https://kira.test/api/missing'), env)).status, 404);
  assert.equal(await api(new Request('https://kira.test/'), env), null);
});

test('aborted requests cancel the upstream operation and expose no internal errors', async () => {
  const abort = new AbortController();
  let upstreamSignal;
  const api = createApiHandler({ fetchImpl: async (_url, options) => {
    upstreamSignal = options.signal;
    abort.abort();
    assert.equal(upstreamSignal.aborted, true);
    throw new DOMException('aborted', 'AbortError');
  }});
  const request = new Request('https://kira.test/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: abort.signal });
  const response = await api(request, env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'TIMEOUT');
});

test('validates content type before spending quota on the upstream provider', async () => {
  const api = createApiHandler({ fetchImpl: () => assert.fail('provider should not be called') });
  const request = new Request('https://kira.test/api/chat', { method: 'POST', body: JSON.stringify(input) });
  assert.equal((await api(request, env)).status, 415);
});
