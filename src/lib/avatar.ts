import { Room, RoomEvent, Track } from 'livekit-client';

export type AvatarState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'disconnected' | 'error';
export type AvatarLanguage = 'en' | 'de' | 'hu';
export interface LiveAvatarHandle {
  speak(text: string, language: AvatarLanguage): Promise<void>;
  interrupt(): void;
  setListening(listening: boolean): void;
  stop(): Promise<void>;
  connected(): boolean;
}
interface AvatarConnection {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  websocketUrl: string;
  expiresAt: number;
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/avatar/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}), signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || 'The live avatar could not complete this request.');
  return data as T;
}

/**
 * LITE is an audio renderer, not a second conversation engine. Call speak() with
 * the exact reply returned by KIRA's existing Gemini chat endpoint. No provider
 * API key, Gemini key, or provider session-management token reaches this module.
 * Web-only session cookies; Android WebView authentication needs device QA.
 */
export async function startLiveAvatar(
  video: HTMLVideoElement,
  audio: HTMLAudioElement,
  onState: (state: AvatarState, message?: string) => void,
  _onTranscript?: (text: string, role?: 'user' | 'assistant') => void,
): Promise<LiveAvatarHandle> {
  onState('connecting');
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const startupAbort = new AbortController();
  let socket: WebSocket | undefined;
  let closed = false;
  let ready = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let speechAbort: AbortController | undefined;
  let speechTimer: ReturnType<typeof setTimeout> | undefined;
  let speechDone: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let utteranceId: string | undefined;

  function send(type: string, payload: Record<string, unknown> = {}) {
    if (closed || !ready || socket?.readyState !== WebSocket.OPEN) throw new Error('The live avatar is disconnected. Reconnect to continue.');
    socket.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...payload }));
  }
  function finishSpeech(error?: Error) {
    clearTimeout(speechTimer);
    const current = speechDone;
    speechDone = undefined;
    utteranceId = undefined;
    if (error) current?.reject(error); else current?.resolve();
  }
  function interrupt() {
    speechAbort?.abort();
    speechAbort = undefined;
    if (ready && !closed && socket?.readyState === WebSocket.OPEN) send('agent.interrupt');
    finishSpeech();
    if (!closed) onState('idle');
  }
  async function stop() {
    if (closed) return;
    interrupt();
    closed = true;
    ready = false;
    startupAbort.abort();
    clearInterval(heartbeat);
    clearTimeout(expiry);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    socket?.close();
    // Attempt provider cleanup even when a broken WebRTC transport cannot close.
    try { await room.disconnect(); } catch { /* Transport is already unavailable. */ }
    video.srcObject = null;
    audio.srcObject = null;
    // Provider cap is a second boundary if network loss prevents explicit stop.
    try { await request('stop'); }
    catch { onState('disconnected', 'Connection closed locally. The provider session expires within five minutes.'); return; }
    onState('disconnected');
  }
  function onVisibility() { if (document.hidden) void stop(); }
  function onPageHide() {
    // keepalive survives navigation; the server uses the HttpOnly session cookie.
    void fetch('/api/avatar/stop', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
    void stop();
  }
  room.on(RoomEvent.TrackSubscribed, track => {
    if (track.kind === Track.Kind.Video) { video.muted = true; video.playsInline = true; track.attach(video); }
    else if (track.kind === Track.Kind.Audio) { audio.muted = false; track.attach(audio); }
  });
  room.on(RoomEvent.TrackUnsubscribed, track => { track.detach(); });
  room.on(RoomEvent.Disconnected, () => { if (!closed) void stop(); });

  try {
    const connection = await request<AvatarConnection>('start', {}, startupAbort.signal);
    // The only tokens here are short-lived client transport credentials.
    socket = new WebSocket(connection.websocketUrl);
    await Promise.all([
      room.connect(connection.livekitUrl, connection.livekitClientToken, { autoSubscribe: true }),
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The avatar control connection timed out.')), 20_000);
        socket!.addEventListener('message', event => {
          let data: Record<string, unknown>;
          try { data = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
          if (data.type === 'session.state_updated' && data.state === 'connected') {
            ready = true; clearTimeout(timer); resolve();
          }
          if (data.type === 'agent.speak_started' && data.source_event_id === utteranceId) onState('speaking');
          if ((data.type === 'agent.speak_ended' || data.type === 'agent.speak_interrupted') && data.source_event_id === utteranceId) {
            finishSpeech(); if (!closed) onState('idle');
          }
          if (data.type === 'error') {
            const error = new Error('The avatar service could not render this speech. Try reconnecting.');
            if (!ready) { clearTimeout(timer); reject(error); }
            finishSpeech(error); onState('error', error.message);
          }
        });
        socket!.addEventListener('error', () => {
          clearTimeout(timer); reject(new Error('The avatar control connection failed.'));
          finishSpeech(new Error('The avatar connection was lost.'));
          if (ready && !closed) void stop();
        });
        socket!.addEventListener('close', () => {
          clearTimeout(timer);
          if (!ready) reject(new Error('The avatar control connection closed.'));
          if (!closed) void stop();
        });
      }),
    ]);
    await room.startAudio();
    heartbeat = setInterval(() => {
      if (!ready || closed) return;
      try { send('session.keep_alive'); }
      catch { void stop(); }
    }, 45_000);
    expiry = setTimeout(() => { void stop(); }, Math.max(0, connection.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    onState('idle');
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : 'The live avatar could not connect.';
    onState('error', message);
    throw error;
  }

  return {
    connected: () => ready && !closed,
    interrupt,
    setListening(listening) {
      if (!ready || closed) return;
      if (listening) interrupt();
      send(listening ? 'agent.start_listening' : 'agent.stop_listening');
      onState(listening ? 'listening' : 'idle');
    },
    async speak(text, language) {
      if (!ready || closed) throw new Error('Connect the live avatar before speaking.');
      interrupt();
      const controller = new AbortController();
      speechAbort = controller;
      onState('thinking');
      try {
        const result = await request<{ audio: string; format: string; sampleRate: number; channels: number }>('audio', { text, language }, controller.signal);
        if (controller.signal.aborted || closed) return;
        if (result.format !== 'pcm_s16le' || result.sampleRate !== 24000 || result.channels !== 1) throw new Error('The voice audio format is unsupported.');
        const binary = atob(result.audio);
        if (!binary.length || binary.length % 2) throw new Error('The voice service returned invalid PCM audio.');
        utteranceId = crypto.randomUUID();
        const id = utteranceId;
        const completion = new Promise<void>((resolve, reject) => { speechDone = { resolve, reject }; });
        // Attach a handler immediately; a transport error can arrive while uploading.
        void completion.catch(() => {});
        speechTimer = setTimeout(() => {
          if (ready && !closed && socket?.readyState === WebSocket.OPEN) send('agent.interrupt');
          finishSpeech(new Error('Avatar speech timed out. Reconnect to continue.'));
          if (!closed) onState('error', 'Avatar speech timed out.');
        }, Math.ceil(binary.length / 48_000 * 1000) + 45_000);
        for (let offset = 0; offset < binary.length; offset += 48_000) {
          if (controller.signal.aborted || closed || utteranceId !== id) return;
          while (socket!.bufferedAmount > 256_000) {
            await new Promise(resolve => setTimeout(resolve, 25));
            if (controller.signal.aborted || closed) return;
          }
          send('agent.speak', { event_id: id, audio: btoa(binary.slice(offset, offset + 48_000)) });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!controller.signal.aborted && !closed && utteranceId === id) send('agent.speak_end');
        await completion;
      } catch (error) {
        if (controller.signal.aborted || closed) return;
        if (ready && socket?.readyState === WebSocket.OPEN) send('agent.interrupt');
        finishSpeech();
        const message = error instanceof Error ? error.message : 'Avatar voice generation failed.';
        onState('error', message);
        throw error;
      } finally {
        if (speechAbort === controller) speechAbort = undefined;
      }
    },
    stop,
  };
}
