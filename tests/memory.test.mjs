import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';

// stripTypeScriptTypes is available in Node >=22.13 (the project's minimum is
// 22.14). Import the production module without installing a test compiler.
const source = await readFile(new URL('../src/lib/memory.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source, { mode: 'strip' });
const memory = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

function makeStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('accepts safe API origins and rejects credentials, paths and insecure remote URLs', () => {
  assert.equal(memory.sanitizeApiBase('https://example.org/'), 'https://example.org');
  assert.equal(memory.sanitizeApiBase('http://localhost:8787'), 'http://localhost:8787');
  for (const value of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org/?key=secret', 'javascript:alert(1)']) {
    assert.equal(memory.sanitizeApiBase(value), '', value);
  }
});

test('persists conversations and memory, then removes both without removing settings', () => {
  const storage = makeStorage();
  const settings = { ...memory.DEFAULT_SETTINGS, language: 'hu', personality: 'warm' };
  assert.equal(memory.saveSettings(settings, storage), true);
  const conversation = memory.createConversation('KIRA');
  conversation.messages.push(memory.createMessage('user', 'Szia KIRA'));
  assert.equal(memory.saveConversations([conversation], storage), true);
  assert.equal(memory.saveMemory('Prefers Hungarian', storage), true);
  assert.equal(memory.loadConversations(storage)[0].messages[0].content, 'Szia KIRA');
  assert.equal(memory.loadMemory(storage), 'Prefers Hungarian');
  assert.equal(memory.clearMemory(storage), true);
  assert.deepEqual(memory.loadConversations(storage), []);
  assert.equal(memory.loadMemory(storage), '');
  assert.equal(memory.loadSettings(storage).language, 'hu');
});

test('deleting one conversation preserves the rest', () => {
  const storage = makeStorage();
  const first = memory.createConversation('First');
  const second = memory.createConversation('Second');
  memory.saveConversations([first, second], storage);
  const remaining = memory.deleteConversation(first.id, storage);
  assert.deepEqual(remaining.map(item => item.id), [second.id]);
  assert.deepEqual(memory.loadConversations(storage).map(item => item.id), [second.id]);
});

test('corrupt storage and unavailable storage fail safely', () => {
  const storage = makeStorage();
  storage.setItem('kira.settings.v1', '{malformed');
  storage.setItem('kira.conversations.v1', 'null');
  assert.deepEqual(memory.loadSettings(storage), memory.DEFAULT_SETTINGS);
  assert.deepEqual(memory.loadConversations(storage), []);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(memory.loadSettings(blocked), memory.DEFAULT_SETTINGS);
  assert.equal(memory.saveMemory('hello', blocked), false);
  assert.equal(memory.clearMemory(blocked), false);
});
