# Architecture

The browser owns presentation, the current conversation, explicit device memory and device audio permissions. The gateway owns Google and LiveAvatar credentials. Gemini provides every assistant reply.

```text
Text or browser speech recognition
    → React conversation history
    → POST /api/chat
    → server-side Gemini generateContent
    → actual reply saved to device history
    → device TTS, or optional Gemini TTS → LiveAvatar LITE → streamed video/audio
```

## API contract

- `GET /api/status` reports configured integration names and booleans. Configuration is not a successful remote-service health check.
- `POST /api/chat` accepts `{messages, language, personality, memory?, sessionId?}`. Each message has `role: "user" | "assistant"` and `content`. The last message must be from the user. Success returns `{text, model}`; failures return `{error: {code, message, retryable}}`.
- `/api/avatar/status`, `/api/avatar/start`, `/api/avatar/audio` and `/api/avatar/stop` manage the optional professional renderer. Provider management tokens stay encrypted in an HttpOnly session cookie. The browser receives only short-lived transport credentials. Sessions are capped at five minutes and closed when the app is backgrounded.

The gateway bounds requests to 80 KB, conversation input to 40 messages and 48,000 characters, and each message to 12,000 characters. Remembered context is untrusted data, never part of a privileged role. API tests use injected provider mocks to exercise boundaries without transmitting credentials or consuming quota.

## Deployment and storage

For a single user, the Node server can serve the built client and API together behind a TLS/authentication proxy. The Worker bundle provides the same fetch handler for an appropriate Workers host; platform routing and secrets must be configured separately. There is no external database requirement. Local storage persists only on the current browser/device.

Rate limiting is bounded but process-local. Multi-instance public deployment needs authenticated users and a shared quota store such as a Durable Object or Redis. Frontend origin checks do not replace authentication. `TRUST_PROXY=1` is appropriate only behind an ingress that strips caller-supplied identity/IP headers.

## Rendering and battery

The portrait fallback is intentionally still. The application does not distort independent eyes or lips or represent CSS motion as skeletal animation. Professional avatar video is subscribed through adaptive LiveKit streaming; sessions stop on backgrounding and have a provider duration cap. Real microphone metering stops when capture ends. User reduced-motion preferences should suppress decorative HUD animation.

A true 3D model path remains possible: replace the video renderer with a licensed custom GLB, a compatible skeleton, facial morphs and timestamped viseme audio. Keep the conversational gateway and local memory modules unchanged.
