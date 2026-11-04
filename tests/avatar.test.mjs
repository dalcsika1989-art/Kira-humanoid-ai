import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarConfig, handleAvatarRequest } from '../server/avatar.mjs';

const env = { LIVEAVATAR_API_KEY: 'provider-secret-for-tests', LIVEAVATAR_AVATAR_ID: 'licensed-avatar', GEMINI_API_KEY: 'gemini-secret-for-tests' };
const sessionToken = 'provider-management-token-not-for-the-browser';
const connection = { livekit_url: 'wss://room.example.test', livekit_client_token: 'short-lived-client-token', livekit_agent_token: 'privileged-agent-token', ws_url: 'wss://control.example.test/session' };
function req(action, { body, cookie, user = 'user-a', method = 'POST' } = {}) {
  return new Request(`https://kira.example.test/api/avatar/${action}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': user, ...(cookie ? { cookie } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
  });
}
function mockFetch(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options, parsedBody: options.body ? JSON.parse(options.body) : undefined });
    const item = responses.shift();
    assert.ok(item, `Unexpected outbound call: ${url}`);
    if (item instanceof Error) throw item;
    return Response.json(item.body ?? item, { status: item.status || 200 });
  };
  return { calls, fetch };
}
async function opened() {
  const mock = mockFetch([{ code: 100, data: { session_id: 'session-a', session_token: sessionToken } }, { code: 100, data: connection }]);
  const response = await handleAvatarRequest(req('start'), env, mock);
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], response, mock };
}

test('avatar status reports precise missing configuration without exposing secrets', async () => {
  assert.deepEqual(avatarConfig({}).requirements, ['LIVEAVATAR_API_KEY', 'LIVEAVATAR_AVATAR_ID', 'GEMINI_API_KEY']);
  assert.equal(avatarConfig(env).configured, true);
  const response = await handleAvatarRequest(req('status', { method: 'GET' }), env);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes(env.LIVEAVATAR_API_KEY));
  assert.ok(!body.includes(env.GEMINI_API_KEY));
});

test('unconfigured avatar fails explicitly before contacting a provider', async () => {
  const response = await handleAvatarRequest(req('start'), {}, { fetch: () => { throw new Error('Must not fetch'); } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AVATAR_NOT_CONFIGURED');
});

test('session start returns client transport credentials, seals management token, caps duration', async () => {
  const { response, cookie, mock } = await opened();
  const body = await response.text();
  assert.ok(body.includes(connection.livekit_client_token));
  assert.ok(!body.includes(sessionToken));
  assert.ok(!body.includes(connection.livekit_agent_token));
  assert.ok(!cookie.includes(sessionToken));
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=300; Secure/);
  assert.equal(mock.calls[0].parsedBody.mode, 'LITE');
  assert.equal(mock.calls[0].parsedBody.max_session_duration, 300);
  assert.equal(mock.calls[0].headers['X-API-KEY'], env.LIVEAVATAR_API_KEY);
  assert.equal(mock.calls[1].headers.Authorization, `Bearer ${sessionToken}`);
});

test('session management rejects different owners and tampered cookies', async () => {
  const { cookie } = await opened();
  const mock = mockFetch([]);
  const otherOwner = await handleAvatarRequest(req('stop', { cookie, user: 'user-b' }), env, mock);
  assert.equal(otherOwner.status, 403);
  assert.match(otherOwner.headers.get('set-cookie'), /Max-Age=0/);
  const tampered = await handleAvatarRequest(req('stop', { cookie: `${cookie.slice(0, -3)}abc` }), env, mock);
  assert.equal(tampered.status, 403);
  assert.equal(mock.calls.length, 0);
});

test('stop uses owned server token and clears cookie; unknown browser is idempotent', async () => {
  const { cookie } = await opened();
  const mock = mockFetch([{ code: 100, data: null }]);
  const response = await handleAvatarRequest(req('stop', { cookie }), env, mock);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(mock.calls[0].headers.Authorization, `Bearer ${sessionToken}`);
  const empty = await handleAvatarRequest(req('stop'), env, mockFetch([]));
  assert.equal(empty.status, 200);
});

test('partial startup is explicitly stopped when connection data is invalid', async () => {
  const mock = mockFetch([
    { code: 100, data: { session_id: 'session-a', session_token: sessionToken } },
    { code: 100, data: { ...connection, ws_url: 'javascript:alert(1)' } },
    { code: 100, data: null },
  ]);
  const response = await handleAvatarRequest(req('start'), env, mock);
  assert.equal(response.status, 502);
  assert.equal(mock.calls[2].url, 'https://api.liveavatar.com/v1/sessions/stop');
});

test('TTS receives the exact selected answer and returns raw audio with no key', async () => {
  const { cookie } = await opened();
  const text = 'Szia! Megőrzöm a beszélgetésünk kontextusát.';
  const mock = mockFetch([{ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'AAAAAA==', mime_type: 'audio/l16' }] }] }]);
  const response = await handleAvatarRequest(req('audio', { cookie, body: { text, language: 'hu' } }), env, mock);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { audio: 'AAAAAA==', format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  assert.equal(mock.calls[0].parsedBody.input[0].content[0].text, text);
  assert.equal(mock.calls[0].parsedBody.model, 'gemini-3.8-flash-tts');
  assert.deepEqual(mock.calls[0].parsedBody.response_format, { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 });
  assert.equal(mock.calls[0].headers['x-goog-api-key'], env.GEMINI_API_KEY);
});

test('TTS strips a 24kHz mono PCM WAV container before returning avatar audio', async () => {
  const { cookie } = await opened();
  const samples = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const wav = Buffer.alloc(44 + samples.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44);
  const mock = mockFetch([{ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' }] }] }]);
  const response = await handleAvatarRequest(req('audio', { cookie, body: { text: 'Hello', language: 'en' } }), env, mock);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).audio, samples.toString('base64'));
});

test('TTS rejects missing sessions, invalid languages and incompatible provider audio', async () => {
  const noSession = await handleAvatarRequest(req('audio', { body: { text: 'Hello', language: 'en' } }), env, mockFetch([]));
  assert.equal(noSession.status, 409);
  const { cookie } = await opened();
  const invalid = await handleAvatarRequest(req('audio', { cookie, body: { text: 'Hello', language: 'xx' } }), env, mockFetch([]));
  assert.equal(invalid.status, 400);
  const mock = mockFetch([{ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'AAAAAA==', mime_type: 'audio/wav' }] }] }]);
  const wrongAudio = await handleAvatarRequest(req('audio', { cookie, body: { text: 'Hello', language: 'en' } }), env, mock);
  assert.equal(wrongAudio.status, 502);
  assert.equal((await wrongAudio.json()).error.code, 'TTS_INVALID_AUDIO');
});

test('upstream rejection is sanitized and method/route boundaries hold', async () => {
  const response = await handleAvatarRequest(req('start'), env, mockFetch([{ status: 401, body: { error: `secret ${env.LIVEAVATAR_API_KEY}` } }]));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(env.LIVEAVATAR_API_KEY));
  assert.equal((await handleAvatarRequest(req('start', { method: 'GET' }), env)).status, 405);
  assert.equal((await handleAvatarRequest(req('unknown'), env)).status, 404);
  assert.equal(await handleAvatarRequest(new Request('https://kira.example.test/api/chat'), env), null);
});
