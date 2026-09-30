import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const image = 'data:image/png;base64,' + 'A'.repeat(100000);
const message = {
    id: 'image-1', role: 'user', content: image,
    parts: [{ type: 'text', text: '[我发来了一张图片：]' }, { type: 'image', data: image }]
};
const character = { id: 'char-1', realName: '她', myName: '我', maxMemory: 20,
    history: [message], imageGenerationMeta: null };
const tokenContext = vm.createContext({
    db: { characters: [character], groups: [], myStickers: [] }, window: {},
    getActiveWorldBooksContents: () => ({ before: '', middle: '', after: '' }),
    getEffectivePersona: () => '角色人设',
    generatePrivateSystemPrompt: () => '系统规则。角色人设。',
    generateGroupSystemPrompt: () => '群聊规则。',
    filterHistoryForAI: (_, history) => history
});
vm.runInContext(fs.readFileSync('js/modules/chat-ai/token-stats.js', 'utf8'), tokenContext);
const privateResult = vm.runInContext("getChatTokenBreakdown('char-1', 'private')", tokenContext);
assert.equal(privateResult.mediaCount, 1);
assert.equal(privateResult.messageCount, 1);
assert.ok(privateResult.total < 1000, '图片 Base64 不应成为文字 Token');
assert.equal(privateResult.details.reduce((sum, item) => sum + item.value, 0), privateResult.total);

tokenContext.db.groups.push({ id: 'group-1', maxMemory: 20, history: [message] });
const groupResult = vm.runInContext("getChatTokenBreakdown('group-1', 'group')", tokenContext);
assert.equal(groupResult.mediaCount, 1);
assert.ok(groupResult.total < 1000);
assert.equal(groupResult.details.reduce((sum, item) => sum + item.value, 0), groupResult.total);

const historyContext = vm.createContext({ window: {}, db: {}, console });
vm.runInContext(fs.readFileSync('js/core/ui-and-content-utils.js', 'utf8'), historyContext);
const original = { role: 'assistant', content: '<thinking>隐藏</thinking> 正文',
    parts: [{ type: 'text', text: '<thinking>隐藏</thinking> 正文' }, { type: 'image', data: image }] };
historyContext.original = original;
const filtered = vm.runInContext('filterHistoryForAI({}, [original])', historyContext);
assert.equal(original.content, '<thinking>隐藏</thinking> 正文');
assert.equal(original.parts[0].text, '<thinking>隐藏</thinking> 正文');
assert.equal(filtered[0].content, '正文');
assert.equal(filtered[0].parts[1].data, image);

const legacyChat = { id: 'old-char', history: [
    { ...message, parts: message.parts.map(part => ({ ...part })), novelAiImageUrl: image,
        imageGenerationMeta: { originalImageUrl: image },
        _imageVersions: [{ imageUrl: image, metadata: { originalImageUrl: image } }] },
    { id: 'different-original', novelAiImageUrl: 'preview', imageGenerationMeta: { originalImageUrl: 'original' } }
] };
let writes = 0;
const storageContext = vm.createContext({
    db: { characters: [legacyChat], groups: [] },
    dexieDB: { characters: { put: async () => { writes++; } }, groups: { put: async () => { writes++; } } },
    window: { dispatchEvent() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout, console
});
vm.runInContext(fs.readFileSync('js/data/indexed-db.js', 'utf8'), storageContext);
const compacted = await vm.runInContext('compactLegacyChatMedia()', storageContext);
assert.equal(compacted.chats, 1);
assert.equal(writes, 1);
assert.equal(legacyChat.history[0].content, '[我发来了一张图片：]');
assert.equal(legacyChat.history[0].parts[1].data, image);
assert.equal(legacyChat.history[0].imageGenerationMeta.originalImageUrl, undefined);
assert.equal(legacyChat.history[0]._imageVersions[0].metadata.originalImageUrl, undefined);
assert.equal(legacyChat.history[1].imageGenerationMeta.originalImageUrl, 'original');
const repeated = await vm.runInContext('compactLegacyChatMedia()', storageContext);
assert.equal(repeated.chats, 0);
assert.equal(writes, 1);

console.log('Token and chat media compaction tests passed.');
