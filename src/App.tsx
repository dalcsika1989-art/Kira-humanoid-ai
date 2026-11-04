import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AudioLines, ChevronDown, CircleHelp, Expand, History, MessageSquare, Mic, MicOff, Plus, Send, Settings as SettingsIcon, Sparkles, Square, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { BrowserSpeech } from './lib/speech';
import type { SpeechState } from './lib/speech';
import { startLiveAvatar } from './lib/avatar';
import type { AvatarState, LiveAvatarHandle } from './lib/avatar';
import { clearMemory, createConversation, createMessage, loadConversations, loadMemory, loadSettings, sanitizeApiBase, saveConversations, saveMemory, saveSettings } from './lib/memory';
import type { Conversation, Language, Personality, Settings } from './lib/memory';

type Status = { gemini: { configured: boolean; model: string }; avatar: { configured: boolean }; speech: { provider: string } };
type Panel = 'settings' | 'history' | null;

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [conversations, setConversations] = useState<Conversation[]>(() => { const saved = loadConversations(); return saved.length ? saved : [createConversation()]; });
  const [activeId, setActiveId] = useState(() => loadConversations()[0]?.id ?? '');
  const [context, setContext] = useState(loadMemory);
  const [draft, setDraft] = useState('');
  const [interim, setInterim] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [speechState, setSpeechState] = useState<SpeechState>('idle');
  const [avatarState, setAvatarState] = useState<AvatarState>('disconnected');
  const [level, setLevel] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [apiInput, setApiInput] = useState(settings.apiBase);
  const speech = useRef<BrowserSpeech | null>(null);
  const avatar = useRef<LiveAvatarHandle | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations);
  const activeRef = useRef(activeId);
  const settingsRef = useRef(settings);
  const endRef = useRef<HTMLDivElement>(null);
  conversationsRef.current = conversations; activeRef.current = activeId; settingsRef.current = settings;
  const current = conversations.find(c => c.id === activeId) ?? conversations[0];

  useEffect(() => { if (!activeId && conversations[0]) setActiveId(conversations[0].id); }, [activeId, conversations]);
  useEffect(() => { saveSettings(settings); }, [settings]);
  useEffect(() => { if (settings.remember) saveConversations(conversations); }, [conversations, settings.remember]);
  useEffect(() => { if (settings.remember) saveMemory(context); }, [context, settings.remember]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: settings.reducedMotion ? 'auto' : 'smooth', block: 'end' }); }, [current?.messages.length, busy, settings.reducedMotion]);
  useEffect(() => {
    const handler = new BrowserSpeech({ onState: setSpeechState, onInterim: setInterim, onAudioLevel: setLevel, onError: setError,
      onTranscript: text => setDraft(previous => `${previous}${previous ? ' ' : ''}${text}`) });
    speech.current = handler;
    const refresh = () => setVoices(handler.voices());
    refresh(); window.speechSynthesis?.addEventListener('voiceschanged', refresh);
    return () => { handler.dispose(); speech.current = null; window.speechSynthesis?.removeEventListener('voiceschanged', refresh); request.current?.abort(); void avatar.current?.stop(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setStatusError(false);
    fetch(`${settings.apiBase}/api/status`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Status unavailable');
      setStatus(await response.json() as Status);
    }).catch(() => { if (!controller.signal.aborted) setStatusError(true); });
    return () => controller.abort();
  }, [settings.apiBase]);

  function updateConversation(id: string, updater: (c: Conversation) => Conversation) {
    setConversations(previous => { const next = previous.map(c => c.id === id ? updater(c) : c); conversationsRef.current = next; return next; });
  }
  const stopAll = useCallback(() => { request.current?.abort(); request.current = null; setBusy(false); speech.current?.stop(); avatar.current?.interrupt(); }, []);
  function newConversation() { stopAll(); const next = createConversation(); setConversations(previous => [next, ...previous]); setActiveId(next.id); setDraft(''); setError(''); setPanel(null); }
  function switchConversation(id: string) { stopAll(); setActiveId(id); setDraft(''); setError(''); setPanel(null); }
  function deleteConversation(id: string) {
    stopAll(); const left = conversationsRef.current.filter(c => c.id !== id); const next = left.length ? left : [createConversation()];
    conversationsRef.current = next; setConversations(next); if (activeRef.current === id) setActiveId(next[0].id); if (settings.remember) saveConversations(next);
  }
  async function speak(text: string) {
    try {
      if (avatar.current?.connected()) await avatar.current.speak(text, settingsRef.current.language);
      else await speech.current?.speak(text, settingsRef.current.language, settingsRef.current.voiceURI);
    } catch (e) { setError(e instanceof Error ? e.message : 'Speech could not be played.'); }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim(); const selected = conversationsRef.current.find(c => c.id === activeRef.current) ?? conversationsRef.current[0];
    if (!text || !selected || busy) return;
    if (text.length > 12000) { setError('Please keep each message under 12,000 characters.'); return; }
    speech.current?.stop(); avatar.current?.interrupt(); setError(''); setDraft('');
    const user = createMessage('user', text); const messages = [...selected.messages, user];
    updateConversation(selected.id, c => ({ ...c, messages, title: c.messages.length ? c.title : text.slice(0, 60), updatedAt: Date.now() }));
    setBusy(true); const controller = new AbortController(); request.current = controller;
    try {
      // Bounded context fits the gateway while keeping recent multi-turn history.
      const recent = messages.slice(-40); let size = 0; const kept = [] as typeof recent;
      for (let i = recent.length - 1; i >= 0; i--) { size += recent[i].content.length; if (size > 48000) break; kept.unshift(recent[i]); }
      const response = await fetch(`${settings.apiBase}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ messages: kept.map(m => ({ role: m.role, content: m.content })), language: settings.language, personality: settings.personality, memory: settings.remember ? context : '', sessionId: selected.id }) });
      const result = await response.json().catch(() => null) as { text?: string; error?: { message?: string } } | null;
      if (!response.ok || !result?.text) throw new Error(result?.error?.message || 'KIRA could not complete that request. Check the server connection.');
      const answer = createMessage('assistant', result.text);
      updateConversation(selected.id, c => ({ ...c, messages: [...c.messages, answer], updatedAt: Date.now() }));
      if (settingsRef.current.autoSpeak && activeRef.current === selected.id) void speak(answer.content);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to reach the server.'); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  async function toggleMic() {
    if (speechState === 'listening') { speech.current?.stopListening(); return; }
    if (busy) return;
    setError(''); avatar.current?.interrupt();
    await speech.current?.startListening(settings.language, { measureAudio: true });
  }
  async function toggleAvatar() {
    if (avatar.current?.connected()) { await avatar.current.stop(); avatar.current = null; return; }
    if (!video.current || !audio.current) return;
    if (settings.apiBase && settings.apiBase !== window.location.origin) { setError('Live avatar requires the app and API on the same HTTPS origin.'); return; }
    setError('');
    try { avatar.current = await startLiveAvatar(video.current, audio.current, (state, message) => { setAvatarState(state); if (message) setError(message); }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not connect the avatar.'); }
  }
  function setRemember(remember: boolean) { if (!remember) clearMemory(); setSettings(s => ({ ...s, remember })); }
  function clearAll() { if (!window.confirm('Delete all conversations and remembered context from this device?')) return; stopAll(); clearMemory(); setContext(''); const next = createConversation(); setConversations([next]); setActiveId(next.id); setPanel(null); }
  function applyApi() { const value = sanitizeApiBase(apiInput); if (apiInput.trim() && !value) { setError('Enter an HTTPS server origin, for example https://your-server.example.'); return; } setSettings(s => ({ ...s, apiBase: value })); setApiInput(value); setError(''); }
  const connectedAvatar = ['idle', 'listening', 'thinking', 'speaking'].includes(avatarState);
  const stateLabel = busy ? 'Thinking' : speechState === 'listening' ? 'Listening' : speechState === 'speaking' || avatarState === 'speaking' ? 'Speaking' : 'Ready when you are';
  const sameOrigin = !settings.apiBase || settings.apiBase === window.location.origin;
  return <main className={immersive ? 'app immersive' : 'app'}>
    <header className="topbar"><a className="brand" href="#home" aria-label="KIRA home"><span className="brand-mark"><Sparkles size={19}/></span><span>KIRA<small>PERSONAL AI</small></span></a><span className="header-caption">YOUR PERSONAL INTELLIGENCE</span><div className="top-actions"><button className="icon-button" title="Conversation history" aria-label="Conversation history" onClick={() => setPanel('history')}><History size={19}/></button><button className="icon-button" title="Settings" aria-label="Settings" onClick={() => { setApiInput(settings.apiBase); setPanel('settings'); }}><SettingsIcon size={19}/></button></div></header>
    <div className="workspace" id="home"><section className="visual-panel" aria-label="KIRA character"><div className="visual-top"><span className="eyebrow"><span className="live-dot"/> YOUR AI COMPANION</span><span className="micro-label">EST. 2026&nbsp; / &nbsp;KIRA.01</span></div>
      <div className="portrait" aria-label={connectedAvatar ? 'Live avatar stream' : 'Static portrait of KIRA'}><img src={`${import.meta.env.BASE_URL}kira-portrait.webp`} alt="KIRA, a dark-haired digital character with blue eyes and a cyan cybernetic neck"/><video ref={video} autoPlay playsInline muted className={connectedAvatar ? 'avatar-video visible' : 'avatar-video'}/><audio ref={audio} autoPlay/><div className="portrait-overlay"/><div className="portrait-meta"><span className="portrait-chip"><span className="live-dot"/>{connectedAvatar ? 'AVATAR STREAM' : 'PORTRAIT PREVIEW'}</span><button className="icon-button expand" aria-label={immersive ? 'Exit immersive mode' : 'Enter immersive mode'} onClick={() => setImmersive(v => !v)}>{immersive ? <X size={19}/> : <Expand size={18}/>}</button></div><div className="portrait-bottom"><p className="eyebrow">MEET YOUR COMPANION</p><h1>More than an<br/><em>assistant.</em></h1><p>Here for the ideas, the questions,<br/>and everything in between.</p><div className="visual-status"><span className="status-orb"><AudioLines size={16}/></span><span><strong>{stateLabel}</strong><small>{connectedAvatar ? 'Live avatar connected' : 'Static portrait · Live avatar not connected'}</small></span></div></div></div>
      <div className="visual-footer"><span>DESIGNED FOR CONNECTION</span><span>◌ &nbsp; KIRA AI</span></div></section>
      <section className="chat-panel" aria-label="Conversation with KIRA"><div className="chat-heading"><div><p className="eyebrow">YOUR SPACE TO THINK</p><h2>Let’s talk<span>.</span></h2><p>A little intelligence. A lot of possibility.</p></div><button className="new-chat" onClick={newConversation}><Plus size={17}/> <span>New chat</span></button></div>
        <div className="connection-row"><span className={status?.gemini.configured ? 'connection configured' : 'connection'}><i/>{statusError ? 'SERVER UNAVAILABLE' : status?.gemini.configured ? 'SERVER CONFIGURED' : status ? 'GEMINI NOT CONFIGURED' : 'CHECKING SERVER'}</span><span className="lang-label">{settings.language.toUpperCase()} <ChevronDown size={13}/></span></div>
        <div className="messages" aria-live="polite">{!current?.messages.length && <div className="welcome"><span className="welcome-icon"><Sparkles size={20}/></span><h3>What’s on your mind?</h3><p>Ask a question, explore an idea, or just start a conversation. KIRA is here to help.</p><div className="suggestions">{['Help me plan my day', 'Let’s explore an idea', 'Teach me something new'].map(t => <button key={t} onClick={() => setDraft(t)}>{t}<span>↗</span></button>)}</div></div>}
          {current?.messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <Sparkles size={15}/> : 'YOU'}</div><div className="message-body"><div className="message-label">{message.role === 'assistant' ? 'KIRA' : 'YOU'}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.content}</p>{message.role === 'assistant' && <button className="speak-again" onClick={() => void speak(message.content)} aria-label="Read message aloud"><Volume2 size={15}/> Listen</button>}</div></article>)}
          {busy && <div className="thinking"><span className="pulse-dot"/> KIRA is thinking</div>}<div ref={endRef}/></div>
        {error && <div className="error" role="alert"><CircleHelp size={17}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
        {interim && <p className="interim">Hearing: {interim}</p>}
        <form className="composer" onSubmit={send}><button type="button" className={`mic ${speechState === 'listening' ? 'active' : ''}`} title={speechState === 'listening' ? 'Stop listening' : 'Speak to KIRA'} aria-label={speechState === 'listening' ? 'Stop listening' : 'Speak to KIRA'} onClick={() => void toggleMic()}>{speechState === 'listening' ? <MicOff size={20}/> : <Mic size={20}/>}</button><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message KIRA..." aria-label="Message KIRA" maxLength={12000}/>{busy ? <button type="button" className="send" aria-label="Stop response" onClick={stopAll}><Square size={17}/></button> : <button className="send" type="submit" disabled={!draft.trim()} aria-label="Send message"><Send size={18}/></button>}</form>
        <div className="composer-footer"><span>{speechState === 'listening' ? <>MIC LEVEL <span className="meter"><i style={{ width: `${Math.round(level * 100)}%` }}/></span></> : 'VOICE OR TEXT · YOUR CHOICE'}</span><button onClick={() => { if (speechState === 'speaking' || avatarState === 'speaking') { speech.current?.stop(); avatar.current?.interrupt(); } else setSettings(s => ({ ...s, autoSpeak: !s.autoSpeak })); }}>{settings.autoSpeak ? <Volume2 size={14}/> : <VolumeX size={14}/>} {speechState === 'speaking' || avatarState === 'speaking' ? 'STOP SPEAKING' : settings.autoSpeak ? 'VOICE ON' : 'VOICE OFF'}</button></div>
      </section></div>
    {panel && <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setPanel(null); }}><section className="drawer" role="dialog" aria-modal="true" aria-label={panel === 'settings' ? 'Settings' : 'Conversation history'}><div className="drawer-header"><div><p className="eyebrow">MAKE IT YOURS</p><h2>{panel === 'settings' ? 'Settings' : 'Conversations'}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setPanel(null)}><X size={20}/></button></div>
      {panel === 'history' ? <><button className="outline-button full" onClick={newConversation}><Plus size={16}/> New conversation</button><div className="history-list">{conversations.map(c => <div key={c.id} className={c.id === current?.id ? 'history-item selected' : 'history-item'}><button className="history-select" onClick={() => switchConversation(c.id)}><MessageSquare size={17}/><span><strong>{c.title}</strong><small>{new Date(c.updatedAt).toLocaleDateString()}</small></span></button><button className="delete" aria-label={`Delete ${c.title}`} onClick={() => { if (window.confirm('Delete this conversation?')) deleteConversation(c.id); }}><Trash2 size={16}/></button></div>)}</div></> : <div className="settings-content">
        <label>Language<select value={settings.language} onChange={e => setSettings(s => ({ ...s, language: e.target.value as Language, voiceURI: '' }))}><option value="en">English</option><option value="hu">Magyar</option><option value="de">Deutsch</option></select><small>Sets KIRA’s response and speech language.</small></label>
        <label>Personality<select value={settings.personality} onChange={e => setSettings(s => ({ ...s, personality: e.target.value as Personality }))}><option value="balanced">Balanced</option><option value="warm">Warm</option><option value="precise">Precise</option></select></label>
        <label>Device voice<select value={settings.voiceURI} onChange={e => setSettings(s => ({ ...s, voiceURI: e.target.value }))}><option value="">Automatic</option>{voices.filter(v => v.lang.toLowerCase().startsWith(settings.language)).map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}</select><small>Available voices depend on your device.</small></label>
        <label className="toggle-row"><span><strong>Speak responses</strong><small>Read new messages aloud.</small></span><input type="checkbox" checked={settings.autoSpeak} onChange={e => setSettings(s => ({ ...s, autoSpeak: e.target.checked }))}/></label>
        <label className="toggle-row"><span><strong>Remember on this device</strong><small>Save conversations and context locally.</small></span><input type="checkbox" checked={settings.remember} onChange={e => setRemember(e.target.checked)}/></label>
        <label>Remember about me<textarea value={context} onChange={e => setContext(e.target.value)} maxLength={4000} disabled={!settings.remember} placeholder="For example: I prefer short answers."/><small>Sent to Gemini with your messages when memory is enabled.</small></label>
        <label>Server URL<input value={apiInput} onChange={e => setApiInput(e.target.value)} placeholder="Same origin (default)" inputMode="url" autoCapitalize="none"/><small>Use the HTTPS address of your KIRA server. Never enter an API key here.</small></label><button className="outline-button full" onClick={applyApi}>Save server address</button>
        <div className="settings-block"><strong>Live avatar</strong><p>The live avatar requires a configured custom asset and server credentials. This integration has not yet been verified with a provider.</p><button className="outline-button full" onClick={() => void toggleAvatar()} disabled={avatarState === 'connecting' || (!connectedAvatar && (!status?.avatar.configured || !sameOrigin))}>{avatarState === 'connecting' ? 'Connecting…' : connectedAvatar ? 'Disconnect avatar' : 'Connect avatar'}</button>{!status?.avatar.configured && <small>Avatar service is not configured.</small>}{!sameOrigin && <small>Live avatar requires same-origin hosting.</small>}</div>
        <button className="danger-button" onClick={clearAll}><Trash2 size={15}/> Clear local memory</button>
      </div>}</section></div>}
  </main>;
}
