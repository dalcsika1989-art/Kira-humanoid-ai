import type { Language } from './memory';

export type SpeechState = 'idle' | 'listening' | 'speaking';
export interface SpeechCallbacks {
  onState?: (state: SpeechState) => void;
  onTranscript?: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
  /** Actual microphone RMS, normalized to 0..1; browser TTS audio is not measurable. */
  onAudioLevel?: (level: number) => void;
}

interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string; confidence: number };
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  webkitAudioContext?: typeof AudioContext;
};

export const SPEECH_LOCALES: Record<Language, string> = { en: 'en-US', hu: 'hu-HU', de: 'de-DE' };

function recognitionClass(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const browser = window as SpeechWindow;
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

/** Gender metadata is unavailable in Web Speech; prefer known female names, then matching locale. */
export function selectVoice(voices: SpeechSynthesisVoice[], language: Language, preferredURI = ''): SpeechSynthesisVoice | undefined {
  const locale = SPEECH_LOCALES[language].toLowerCase();
  const matching = voices.filter((voice) => voice.lang.toLowerCase().split('-')[0] === language);
  const preferred = matching.find((voice) => voice.voiceURI === preferredURI);
  if (preferred) return preferred;
  const female = /female|samantha|victoria|karen|moira|tessa|zira|jenny|aria|ava|emma|sonia|libby|clara|katja|hedda|marlene|vicki|no[eé]mi|eszter|borb[aá]la|anna|paulina/i;
  return matching.find((voice) => voice.lang.toLowerCase() === locale && female.test(voice.name))
    ?? matching.find((voice) => female.test(voice.name))
    ?? matching.find((voice) => voice.lang.toLowerCase() === locale)
    ?? matching[0];
}

/** Browser voice fallback only. It does not produce phoneme/viseme timestamps or avatar animation. */
export class BrowserSpeech {
  private callbacks: SpeechCallbacks;
  private recognition?: Recognition;
  private stream?: MediaStream;
  private context?: AudioContext;
  private frame?: number;
  private sequence = 0;
  private utterance?: SpeechSynthesisUtterance;
  private finishSpeaking?: () => void;
  private currentState: SpeechState = 'idle';
  private disposed = false;

  constructor(callbacks: SpeechCallbacks = {}) { this.callbacks = callbacks; }
  get state(): SpeechState { return this.currentState; }
  get recognitionSupported(): boolean { return !!recognitionClass(); }
  get synthesisSupported(): boolean { return typeof window !== 'undefined' && 'speechSynthesis' in window; }
  get supported(): boolean { return this.recognitionSupported || this.synthesisSupported; }
  voices(): SpeechSynthesisVoice[] { return this.synthesisSupported ? window.speechSynthesis.getVoices() : []; }

  private setState(state: SpeechState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.callbacks.onState?.(state);
  }

  async startListening(language: Language, options: { continuous?: boolean; measureAudio?: boolean } = {}): Promise<boolean> {
    this.stop();
    if (this.disposed) return false;
    const Constructor = recognitionClass();
    if (!Constructor) {
      this.callbacks.onError?.('Speech recognition is unavailable in this browser. Use Chrome on Android or type a message.');
      return false;
    }
    if (!window.isSecureContext) {
      this.callbacks.onError?.('Microphone access requires HTTPS or localhost.');
      return false;
    }
    const sequence = this.sequence;
    if (options.measureAudio !== false && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (sequence !== this.sequence || this.disposed) { stream.getTracks().forEach((track) => track.stop()); return false; }
        this.stream = stream;
        this.startMeter(stream);
      } catch (error) {
        if (sequence !== this.sequence || this.disposed) return false;
        const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        if (denied) {
          this.callbacks.onError?.('Microphone permission was denied. Allow microphone access in your browser settings.');
          return false;
        }
        // Recognition may still work when a browser cannot provide a second stream for metering.
        this.releaseMeter();
      }
    }
    if (sequence !== this.sequence || this.disposed) return false;
    const recognition = new Constructor();
    this.recognition = recognition;
    recognition.lang = SPEECH_LOCALES[language];
    recognition.continuous = options.continuous ?? false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { if (sequence === this.sequence) this.setState('listening'); };
    recognition.onresult = (event) => {
      if (sequence !== this.sequence) return;
      const final: string[] = [];
      const interim: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (transcript) (result.isFinal ? final : interim).push(transcript);
      }
      this.callbacks.onInterim?.(interim.join(' '));
      if (final.length) this.callbacks.onTranscript?.(final.join(' '));
    };
    recognition.onerror = (event) => {
      if (sequence !== this.sequence || event.error === 'aborted') return;
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone permission was denied. Allow access in your browser settings.',
        'service-not-allowed': 'This browser does not allow its speech service. Try Chrome on Android or type a message.',
        'audio-capture': 'The microphone is unavailable or in use by another app.',
        network: 'Speech recognition could not reach its speech service. Check your connection.',
        'no-speech': 'No speech was detected. Tap the microphone and try again.',
        'language-not-supported': 'The speech service does not support this language on your device. You can still type.',
      };
      this.callbacks.onError?.(messages[event.error] ?? 'Speech recognition stopped unexpectedly. Please try again.');
      this.releaseMeter();
      this.setState('idle');
    };
    recognition.onend = () => {
      if (sequence !== this.sequence) return;
      this.recognition = undefined;
      this.callbacks.onInterim?.('');
      this.releaseMeter();
      if (this.currentState === 'listening') this.setState('idle');
    };
    try { recognition.start(); return true; }
    catch {
      this.recognition = undefined;
      this.releaseMeter();
      this.callbacks.onError?.('Could not start speech recognition. Please try again.');
      this.setState('idle');
      return false;
    }
  }

  /** Finish capture and allow the recognition engine to return its final transcript. */
  stopListening(): void {
    try { this.recognition?.stop(); } catch { /* Already ended. */ }
    this.releaseMeter();
    if (this.currentState === 'listening') this.setState('idle');
  }

  private startMeter(stream: MediaStream): void {
    const Constructor = window.AudioContext ?? (window as SpeechWindow).webkitAudioContext;
    if (!Constructor) return;
    const context = new Constructor();
    this.context = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    // Never connect to destination: microphone monitoring would cause feedback.
    const samples = new Uint8Array(analyser.fftSize);
    const update = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      this.callbacks.onAudioLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      this.frame = requestAnimationFrame(update);
    };
    void context.resume().catch(() => undefined);
    update();
  }

  private releaseMeter(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.callbacks.onAudioLevel?.(0);
  }

  private async readyVoices(sequence: number): Promise<SpeechSynthesisVoice[]> {
    const existing = this.voices();
    if (existing.length) return existing;
    await new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timeout); window.speechSynthesis.removeEventListener('voiceschanged', finish); resolve(); };
      timeout = setTimeout(finish, 1200);
      window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
      if (sequence !== this.sequence) finish();
    });
    return this.voices();
  }

  async speak(text: string, language: Language, voiceURI = ''): Promise<void> {
    this.stop();
    if (this.disposed || !text.trim()) return;
    if (!this.synthesisSupported) {
      this.callbacks.onError?.('Speech playback is unavailable in this browser. Your conversation is available as text.');
      return;
    }
    const sequence = this.sequence;
    const voices = await this.readyVoices(sequence);
    if (sequence !== this.sequence || this.disposed) return;
    const utterance = new SpeechSynthesisUtterance(text);
    this.utterance = utterance;
    utterance.lang = SPEECH_LOCALES[language];
    const voice = selectVoice(voices, language, voiceURI);
    if (voice) utterance.voice = voice;
    utterance.rate = 0.97;
    utterance.pitch = 1;
    utterance.volume = 1;
    await new Promise<void>((resolve) => {
      this.finishSpeaking = resolve;
      const finish = () => {
        if (sequence === this.sequence) {
          this.utterance = undefined;
          this.finishSpeaking = undefined;
          this.setState('idle');
        }
        resolve();
      };
      utterance.onstart = () => { if (sequence === this.sequence) this.setState('speaking'); };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (sequence === this.sequence && event.error !== 'canceled' && event.error !== 'interrupted') {
          this.callbacks.onError?.('Speech playback failed. Check your device speech settings or continue with text.');
        }
        finish();
      };
      try { window.speechSynthesis.speak(utterance); }
      catch { this.callbacks.onError?.('Could not play speech on this device.'); finish(); }
    });
  }

  /** Interrupt recognition and speech immediately; invalidate all late callbacks. */
  stop(): void {
    this.sequence++;
    if (this.recognition) {
      this.recognition.onstart = null;
      this.recognition.onend = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      try { this.recognition.abort(); } catch { /* Already stopped. */ }
      this.recognition = undefined;
    }
    this.releaseMeter();
    if (this.synthesisSupported) window.speechSynthesis.cancel();
    this.utterance = undefined;
    this.finishSpeaking?.();
    this.finishSpeaking = undefined;
    this.callbacks.onInterim?.('');
    this.setState('idle');
  }

  dispose(): void { this.stop(); this.disposed = true; this.callbacks = {}; }
}
