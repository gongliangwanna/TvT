import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const image = 'data:image/png;base64,' + 'A'.repeat(1000);
const chat = { id: 'old', realName: '旧会话', history: [
    { id: 'text', content: '你好', parts: [{ type: 'text', text: '你好' }] },
    { id: 'image', content: image, parts: [{ type: 'text', text: '[图片]' }, { type: 'image', data: image }] },
    { id: 'generated', novelAiImageUrl: image, imageGenerationMeta: { originalImageUrl: image },
        _imageVersions: [{ imageUrl: image, metadata: { originalImageUrl: image } }] },
    { id: 'sticker', stickerData: image, parts: [{ type: 'sticker', data: image }] }
] };
const before = JSON.stringify(chat);
const fakeConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, () => {}]));
const context = vm.createContext({
    window: { addEventListener() {} }, console: fakeConsole, setTimeout,
    collections: [[[chat], 'private']]
});
vm.runInContext(fs.readFileSync('js/modules/storage.js', 'utf8'), context);
const report = await vm.runInContext('analyzeLegacyChatStorage(collections)', context);

assert.equal(report.chats, 1);
assert.equal(report.messages, 4);
assert.equal(report.cleanableCopies, 3, '仅统计现有整理逻辑可清理的完全相同图片副本');
assert.equal(report.retainedCopies, 2, '当前仍依赖的文字和表情包字段只报告');
assert.equal(report.cleanableSize, image.length * 3);
assert.ok(report.fields.content > 0 && report.fields.parts > 0 && report.fields.stickerData > 0);
assert.ok(report.partTypes.image > 0 && report.partTypes.sticker > 0 && report.partTypes.text > 0);
assert.ok(report.otherFields.id > 0);
assert.equal(report.largestChats[0].name, '旧会话');
assert.equal(JSON.stringify(chat), before, '扫描不能修改旧聊天数据');

const longText = '文字'.repeat(100000);
const textChat = { realName: '文字会话', history: [{
    id: 'large', content: longText, parts: [{ type: 'text', text: longText }],
    _regenVersions: [{ replies: [{ content: longText }] }]
}] };
context.textCollections = [[[textChat], 'private']];
const textReport = await vm.runInContext('analyzeLegacyChatStorage(textCollections)', context);
assert.equal(textReport.cleanableCopies, 0, '大文字消息不应被误判为可清理图片');
assert.ok(textReport.size > 500000);
assert.ok(textReport.fields._regenVersions > 100000);
assert.equal(textReport.largestMessages[0].field, '重说旧版本');
assert.equal(textReport.largestChats[0].field, '重说旧版本');
console.log('Storage audit tests passed.');
