import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class MemoryTable {
    constructor() { this.rows = new Map(); }
    async put(row) { this.rows.set(row.id, structuredClone(row)); }
    async get(id) { const row = this.rows.get(id); return row ? structuredClone(row) : undefined; }
    where(field) { return { equals: value => ({ toArray: async () => [...this.rows.values()].filter(row => row[field] === value).map(row => structuredClone(row)) }) }; }
    async toArray() { return [...this.rows.values()].map(row => structuredClone(row)); }
    filter(predicate) { return { primaryKeys: async () => [...this.rows.values()].filter(predicate).map(row => row.id) }; }
    async bulkDelete(ids) { ids.forEach(id => this.rows.delete(id)); }
}

const pendingReplies = new MemoryTable();
const storage = new Map();
const listeners = new Map();
const windowListeners = new Map();
const keepAliveEvents = [];
const chat = { id: 'chat-1', history: [{ id: 'user-1', role: 'user', content: 'hello' }] };
const messageArea = { scrollTop: 25, scrollHeight: 100, addEventListener() {} };
const messageInput = { value: '草稿' };
const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    crypto,
    dexieDB: { pendingReplies },
    db: { characters: [chat], groups: [] },
    currentChatId: 'chat-1',
    currentChatType: 'private',
    currentPage: 1,
    isGenerating: false,
    localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value))
    },
    navigator: { onLine: true },
    document: {
        visibilityState: 'visible',
        wasDiscarded: false,
        querySelector: selector => selector === '.screen.active' ? { id: 'chat-room-screen' } : null,
        getElementById: id => id === 'message-area' ? messageArea : id === 'message-input' ? messageInput : null,
        addEventListener: (name, handler) => listeners.set(name, handler)
    },
    window: {
        addEventListener: (name, handler) => windowListeners.set(name, handler),
        KeepAliveModule: {
            notifyTaskStart: id => keepAliveEvents.push(`start:${id}`),
            notifyTaskEnd: id => keepAliveEvents.push(`end:${id}`)
        }
    },
    requestAnimationFrame: callback => callback()
});
context.window.window = context.window;
context.window.document = context.document;
vm.runInContext(fs.readFileSync(new URL('../js/modules/chat-ai/reply-resilience.js', import.meta.url), 'utf8'), context);

const service = context.window.ReplyResilience;
assert.ok(service, 'reply resilience module should export itself');
const task = await service.begin({ chatId: 'chat-1', chatType: 'private', provider: 'openai', model: 'test', streamEnabled: true, initialState: 'preparing' });
assert.equal(task.state, 'preparing');
assert.equal(task.userMessageId, 'user-1');
assert.equal(keepAliveEvents.at(-1), `start:${task.id}`, 'reply start should activate task-aware wake lock');

service.checkpoint(task, '部分回复', '思考', { transportBytes: 32 });
await service.flush(task);
let stored = await pendingReplies.get(task.id);
assert.equal(stored.state, 'streaming');
assert.equal(stored.rawPartial, '部分回复');
assert.equal(stored.reasoningPartial, '思考');
assert.equal(stored.transportBytes, 32);

const httpError = new Error('bad key');
httpError.response = { status: 401 };
await service.fail(task, httpError, false);
stored = await pendingReplies.get(task.id);
assert.equal(stored.state, 'failed', 'permanent client errors must not auto-retry');
assert.equal(keepAliveEvents.at(-1), `end:${task.id}`, 'reply failure should release task-aware wake lock');

const recoverable = await service.begin({ chatId: 'chat-1', chatType: 'private', reuseExisting: false, initialState: 'requesting' });
await service.fail(recoverable, new TypeError('network failed'), false);
assert.equal((await pendingReplies.get(recoverable.id)).state, 'interrupted');

await service.complete(recoverable);
stored = await pendingReplies.get(recoverable.id);
assert.equal(stored.state, 'completed');
assert.equal(stored.rawPartial, '');

const foregroundTask = await service.begin({ chatId: 'chat-1', chatType: 'private', reuseExisting: false, isBackground: false });
const backgroundTask = await service.begin({ chatId: 'chat-1', chatType: 'private', isBackground: true });
assert.notEqual(backgroundTask.id, foregroundTask.id, 'background recovery must never reuse a foreground reply task');
assert.equal(backgroundTask.isBackground, true);
await service.complete(foregroundTask);
await service.complete(backgroundTask);

service.saveSessionNow();
const session = JSON.parse(storage.get('ovo_reply_ui_session_v1'));
assert.equal(session.activeScreen, 'chat-room-screen');
assert.equal(session.chatId, 'chat-1');
assert.equal(session.inputDraft, '草稿');

context.TextDecoder = TextDecoder;
context.extractAiProviderResponse = payload => ({
    content: payload.choices?.[0]?.delta?.content || '',
    reasoning: ''
});
context.db.cotSettings = { enabled: false };
vm.runInContext(fs.readFileSync(new URL('../js/modules/chat-ai/request-and-stream.js', import.meta.url), 'utf8'), context);
const encodedChunks = [
    new TextEncoder().encode('data:{"choices":[{"delta":{"content":"A"}}]}\r\n\r\n'),
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"B"}}]}')
];
const response = {
    body: {
        getReader() {
            return { read: async () => encodedChunks.length ? { done: false, value: encodedChunks.shift() } : { done: true } };
        }
    }
};
const streamed = await context.processStream(response, chat, 'openai', 'chat-1', 'private', false, false, task);
assert.equal(streamed, 'AB', 'SSE parser must accept CRLF, data without a space, and a final unterminated event');

console.log('Reply resilience tests passed: lifecycle journal, checkpoints, retry classification, completion cleanup, UI session snapshot, and resilient SSE parsing.');
