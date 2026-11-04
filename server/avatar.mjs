// LiveAvatar LITE renders audio from the SAME Gemini text conversation.
// Protocol: https://docs.liveavatar.com/docs/lite-mode/events
// TTS: https://aistudio.google.com/docs/speech-generation
const PROVIDER = 'https://api.liveavatar.com/v1';
const COOKIE = 'kira_avatar_session';
const SESSION_SECONDS = 300;
const encoder = new TextEncoder();

class AvatarError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message); Object.assign(this, { status, code, retryable });
  }
}
function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode64(value) {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
// Gemini documents WAV containers for unary responses and raw PCM for
// streaming. LiveAvatar requires headerless mono PCM16 at 24 kHz.
function normalizePcm(audio) {
  if (!audio || typeof audio.data !== 'string' || !audio.data || audio.data.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw new Error('Invalid audio');
  const bytes = decode64(audio.data);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let pcm = bytes;
  if (tag(0) === 'RIFF') {
    if (bytes.length < 12 || tag(8) !== 'WAVE') throw new Error('Invalid WAV');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 > bytes.length) throw new Error('Truncated WAV');
    let format;
    let samples;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = tag(offset);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (size > bytes.length - start) throw new Error('Truncated WAV chunk');
      if (type === 'fmt ') {
        if (size < 16) throw new Error('Invalid WAV format');
        format = { codec: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
      }
      if (type === 'data') samples = bytes.subarray(start, start + size);
      offset = start + size + (size % 2);
    }
    if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 24000 || format.bits !== 16 || !samples) throw new Error('Unsupported WAV format');
    pcm = samples;
  } else if (audio.mime_type && !audio.mime_type.startsWith('audio/l16')) {
    throw new Error('Unsupported audio format');
  }
  if (!pcm.length || pcm.length % 2) throw new Error('Invalid PCM samples');
  let binary = '';
  for (let offset = 0; offset < pcm.length; offset += 16_384) binary += String.fromCharCode(...pcm.subarray(offset, offset + 16_384));
  return btoa(binary);
}
async function sessionKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`kira-avatar-cookie-v1:${env.LIVEAVATAR_API_KEY}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function owner(request) {
  // Sites authenticates this header at its private ingress. Local development has no account layer.
  return request.headers.get('oai-authenticated-user-id') || 'local-development';
}
async function seal(session, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(env), encoder.encode(JSON.stringify(session)));
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
async function readSession(request, env) {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return null;
  try {
    const [iv, ciphertext, extra] = value.split('.');
    if (!iv || !ciphertext || extra || value.length > 3800) throw new Error('Invalid cookie');
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(iv) }, await sessionKey(env), decode64(ciphertext));
    const session = JSON.parse(new TextDecoder().decode(decrypted));
    if (session.owner !== owner(request)) throw new Error('Different owner');
    if (session.expiresAt <= Date.now()) return null;
    if (typeof session.token !== 'string' || typeof session.id !== 'string') throw new Error('Invalid session');
    return session;
  } catch {
    throw new AvatarError(403, 'AVATAR_SESSION_INVALID', 'The avatar session expired or belongs to another browser. Reconnect KIRA.');
  }
}
function cookie(request, value = '', seconds = 0) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/api/avatar; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}
export function avatarConfig(env = {}) {
  const requirements = ['LIVEAVATAR_API_KEY', 'LIVEAVATAR_AVATAR_ID', 'GEMINI_API_KEY'].filter(key => !env[key]?.trim());
  return {
    configured: requirements.length === 0,
    provider: 'liveavatar', mode: 'LITE', requirements,
    maxSessionSeconds: SESSION_SECONDS,
    animation: 'streamed-video',
    description: requirements.length ? 'Connect a licensed custom LiveAvatar and Gemini TTS to enable facial animation.' : 'LiveAvatar LITE renders the audio of your Gemini conversation.',
  };
}
async function providerRequest(path, { apiKey, token, body, fetcher }) {
  let response;
  try {
    response = await fetcher(`${PROVIDER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : { Authorization: `Bearer ${token}` }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AvatarError(504, 'AVATAR_TIMEOUT', 'The avatar service did not respond. Try reconnecting.', true);
  }
  if (!response.ok) throw new AvatarError(502, 'AVATAR_PROVIDER_ERROR', response.status === 401 || response.status === 403 ? 'The avatar service rejected its server credentials or avatar entitlement.' : 'The avatar service could not complete this request.', response.status >= 500 || response.status === 429);
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 100 || !payload.data && path !== '/sessions/stop') throw new AvatarError(502, 'AVATAR_INVALID_RESPONSE', 'The avatar service returned an unexpected response.', true);
  return payload.data;
}
async function stopProvider(token, fetcher) {
  await providerRequest('/sessions/stop', { token, body: { reason: 'USER_CLOSED' }, fetcher });
}
function safeConnectionUrl(value, protocols) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
    return url.href;
  } catch { throw new AvatarError(502, 'AVATAR_INVALID_RESPONSE', 'The avatar service returned an invalid connection address.'); }
}
async function start(request, env, fetcher) {
  const previous = await readSession(request, env);
  if (previous) await stopProvider(previous.token, fetcher);
  const tokenData = await providerRequest('/sessions/token', {
    apiKey: env.LIVEAVATAR_API_KEY, fetcher,
    body: { mode: 'LITE', avatar_id: env.LIVEAVATAR_AVATAR_ID, max_session_duration: SESSION_SECONDS, video_settings: { quality: 'medium', encoding: 'H264' } },
  });
  if (typeof tokenData.session_token !== 'string' || !tokenData.session_token || typeof tokenData.session_id !== 'string') throw new AvatarError(502, 'AVATAR_INVALID_RESPONSE', 'The avatar service did not create a session.');
  try {
    const connection = await providerRequest('/sessions/start', { token: tokenData.session_token, fetcher });
    const session = { id: tokenData.session_id, token: tokenData.session_token, owner: owner(request), expiresAt: Date.now() + SESSION_SECONDS * 1000 };
    if (typeof connection.livekit_client_token !== 'string' || !connection.livekit_client_token) throw new AvatarError(502, 'AVATAR_INVALID_RESPONSE', 'The avatar service omitted its browser connection token.');
    const result = {
      sessionId: session.id,
      livekitUrl: safeConnectionUrl(connection.livekit_url, ['wss:', 'https:']),
      livekitClientToken: connection.livekit_client_token,
      websocketUrl: safeConnectionUrl(connection.ws_url, ['wss:']),
      expiresAt: session.expiresAt,
    };
    const sealed = await seal(session, env);
    if (sealed.length > 3800) throw new AvatarError(502, 'AVATAR_INVALID_RESPONSE', 'The avatar service session exceeds the supported cookie size.');
    return json(result, 200, { 'Set-Cookie': cookie(request, sealed, SESSION_SECONDS) });
  } catch (error) {
    await stopProvider(tokenData.session_token, fetcher).catch(() => {});
    throw error;
  }
}
async function synthesize(request, env, fetcher) {
  if (!await readSession(request, env)) throw new AvatarError(409, 'AVATAR_SESSION_REQUIRED', 'Connect the live avatar before generating its speech.');
  let input;
  try { input = await request.json(); } catch { throw new AvatarError(400, 'INVALID_REQUEST', 'Speech requires valid JSON.'); }
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 5000 || !['en', 'de', 'hu'].includes(input.language)) throw new AvatarError(400, 'INVALID_REQUEST', 'Speech requires text of 1–5000 characters and an English, German, or Hungarian language.');
  const languages = { en: 'English', de: 'German', hu: 'Hungarian' };
  const model = env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) throw new AvatarError(503, 'TTS_CONFIGURATION_INVALID', 'The server TTS model configuration is invalid.');
  let response;
  try {
    response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ type: 'user_input', content: [{ type: 'text', text: input.text, annotations: [{ type: 'speech_metadata', style: `Warm, calm female delivery in ${languages[input.language]}. Natural conversational pace.` }] }] }],
        response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
        generation_config: { speech_config: [{ voice: env.GEMINI_TTS_VOICE || 'Kore' }] },
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });
  } catch { throw new AvatarError(504, 'TTS_TIMEOUT', 'Voice generation did not finish. You can continue in text.', true); }
  if (!response.ok) throw new AvatarError(502, 'TTS_PROVIDER_ERROR', 'Gemini could not generate speech. Check TTS model access and quota on the server.', response.status === 429 || response.status >= 500);
  const data = await response.json().catch(() => null);
  const audio = data?.steps?.flatMap(step => step.type === 'model_output' ? step.content || [] : []).filter(part => part.type === 'audio').at(-1);
  let pcm;
  try { pcm = normalizePcm(audio); }
  catch { throw new AvatarError(502, 'TTS_INVALID_AUDIO', 'Gemini did not return supported PCM speech audio.'); }
  return json({ audio: pcm, format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
}
export async function handleAvatarRequest(request, env = {}, context = {}) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/avatar/')) return null;
  const fetcher = context.fetch || globalThis.fetch;
  try {
    if (path === '/api/avatar/status' && request.method === 'GET') return json(avatarConfig(env));
    if (!['/api/avatar/start', '/api/avatar/stop', '/api/avatar/audio'].includes(path)) return json({ error: { code: 'NOT_FOUND', message: 'Avatar endpoint not found.', retryable: false } }, 404);
    if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This avatar action requires POST.', retryable: false } }, 405, { Allow: 'POST' });
    if (!avatarConfig(env).configured) throw new AvatarError(503, 'AVATAR_NOT_CONFIGURED', 'A licensed custom LiveAvatar, its server API key, and Gemini TTS must be configured first.');
    if (path === '/api/avatar/start') return await start(request, env, fetcher);
    if (path === '/api/avatar/audio') return await synthesize(request, env, fetcher);
    const session = await readSession(request, env);
    if (session) await stopProvider(session.token, fetcher);
    return json({ stopped: true }, 200, { 'Set-Cookie': cookie(request) });
  } catch (error) {
    const known = error instanceof AvatarError;
    return json({ error: { code: known ? error.code : 'AVATAR_UNAVAILABLE', message: known ? error.message : 'The avatar service is temporarily unavailable.', retryable: known ? error.retryable : true } }, known ? error.status : 502, error.code === 'AVATAR_SESSION_INVALID' ? { 'Set-Cookie': cookie(request) } : {});
  }
}
