export type Language = 'en' | 'hu' | 'de';
export type Personality = 'balanced' | 'warm' | 'precise';

export interface Settings {
  language: Language;
  personality: Personality;
  autoSpeak: boolean;
  voiceURI: string;
  remember: boolean;
  reducedMotion: boolean;
  /** Public gateway origin, never an API credential. Empty uses the current origin. */
  apiBase: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  language: 'en', personality: 'balanced', autoSpeak: true, voiceURI: '',
  remember: true, reducedMotion: false, apiBase: '',
});

/** Local device memory is deliberately bounded and contains no credentials. */
export const MEMORY_LIMITS = Object.freeze({ conversations: 40, messages: 120, content: 16000, context: 4000 });
const KEYS = { settings: 'kira.settings.v1', conversations: 'kira.conversations.v1', context: 'kira.context.v1' };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type UnknownRecord = Record<string, unknown>;

function deviceStorage(): StorageLike | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
}

function read(key: string, storage: StorageLike | undefined): unknown {
  try { const value = storage?.getItem(key); return value ? JSON.parse(value) : undefined; }
  catch { return undefined; }
}

function write(key: string, value: unknown, storage: StorageLike | undefined): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function record(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

/** Accept a secure public server origin only; URL credentials and query strings are rejected. */
export function sanitizeApiBase(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return '';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    return url.origin;
  } catch { return ''; }
}

function validSettings(value: unknown): Settings {
  const input = record(value) ? value : {};
  return {
    language: input.language === 'hu' || input.language === 'de' ? input.language : 'en',
    personality: input.personality === 'warm' || input.personality === 'precise' ? input.personality : 'balanced',
    autoSpeak: typeof input.autoSpeak === 'boolean' ? input.autoSpeak : DEFAULT_SETTINGS.autoSpeak,
    voiceURI: typeof input.voiceURI === 'string' ? input.voiceURI.slice(0, 512) : '',
    remember: typeof input.remember === 'boolean' ? input.remember : DEFAULT_SETTINGS.remember,
    reducedMotion: typeof input.reducedMotion === 'boolean' ? input.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    apiBase: sanitizeApiBase(input.apiBase),
  };
}

export function loadSettings(storage = deviceStorage()): Settings {
  return validSettings(read(KEYS.settings, storage));
}

export function saveSettings(settings: Settings, storage = deviceStorage()): boolean {
  return write(KEYS.settings, validSettings(settings), storage);
}

function validMessage(value: unknown): Message | undefined {
  if (!record(value) || !identifier(value.id) || !timestamp(value.createdAt) ||
      (value.role !== 'user' && value.role !== 'assistant') ||
      typeof value.content !== 'string' || !value.content.trim()) return undefined;
  return { id: value.id, role: value.role, content: value.content.slice(0, MEMORY_LIMITS.content), createdAt: value.createdAt };
}

function validConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  const conversations: Conversation[] = [];
  for (const entry of value.slice(0, MEMORY_LIMITS.conversations)) {
    if (!record(entry) || !identifier(entry.id) || unique.has(entry.id) ||
        !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || !Array.isArray(entry.messages)) continue;
    unique.add(entry.id);
    const messageIds = new Set<string>();
    const messages = entry.messages.slice(-MEMORY_LIMITS.messages).flatMap((item) => {
      const message = validMessage(item);
      if (!message || messageIds.has(message.id)) return [];
      messageIds.add(message.id);
      return [message];
    });
    conversations.push({
      id: entry.id,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.slice(0, 100) : 'New conversation',
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, messages,
    });
  }
  return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadConversations(storage = deviceStorage()): Conversation[] {
  return validConversations(read(KEYS.conversations, storage));
}

export function saveConversations(conversations: Conversation[], storage = deviceStorage()): boolean {
  return write(KEYS.conversations, validConversations(conversations), storage);
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createMessage(role: Message['role'], content: string): Message {
  return { id: id(), role, content: content.slice(0, MEMORY_LIMITS.content), createdAt: Date.now() };
}

export function createConversation(title = 'New conversation'): Conversation {
  const now = Date.now();
  return { id: id(), title: title.slice(0, 100), createdAt: now, updatedAt: now, messages: [] };
}

export function deleteConversation(idToDelete: string, storage = deviceStorage()): Conversation[] {
  const remaining = loadConversations(storage).filter((conversation) => conversation.id !== idToDelete);
  saveConversations(remaining, storage);
  return remaining;
}

export function loadMemory(storage = deviceStorage()): string {
  const value = read(KEYS.context, storage);
  return typeof value === 'string' ? value.slice(0, MEMORY_LIMITS.context) : '';
}

export function saveMemory(context: string, storage = deviceStorage()): boolean {
  return write(KEYS.context, context.slice(0, MEMORY_LIMITS.context), storage);
}

export function clearMemory(storage = deviceStorage()): boolean {
  try {
    if (!storage) return false;
    storage.removeItem(KEYS.conversations);
    storage.removeItem(KEYS.context);
    return true;
  } catch { return false; }
}
