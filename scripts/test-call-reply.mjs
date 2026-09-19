import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const replySource = fs.readFileSync(new URL('../js/modules/chat-ai/call-reply.js', import.meta.url), 'utf8');
const replyContext = vm.createContext({
    console,
    TextDecoder,
    globalThis: null
});
replyContext.globalThis = replyContext;
vm.runInContext(`${replySource}\nglobalThis.__callReplyTest = { normalizeCallResponseContent, extractCallResponseText, parseCallStreamBlock, readCallStreamResponse, getCallReply };`, replyContext);

const {
    normalizeCallResponseContent,
    extractCallResponseText,
    parseCallStreamBlock,
    readCallStreamResponse,
    getCallReply
} = replyContext.__callReplyTest;

assert.equal(normalizeCallResponseContent([{ type: 'text', text: '你' }, { type: 'text', text: '好' }]), '你好');
assert.equal(extractCallResponseText({ choices: [{ message: { content: [{ type: 'text', text: '数组内容' }] } }] }, 'newapi'), '数组内容');
assert.equal(extractCallResponseText({ candidates: [{ content: { parts: [{ text: 'Gemini' }, { text: '回复' }] } }] }, 'gemini'), 'Gemini回复');
assert.deepEqual(
    JSON.parse(JSON.stringify(parseCallStreamBlock('data: {"choices":[{"delta":{"content":"尾包"}}]}', 'custom-provider'))),
    { text: '尾包', parsed: true }
);

function makeResponse(chunks) {
    const encoder = new TextEncoder();
    return {
        body: new ReadableStream({
            start(controller) {
                chunks.forEach(chunk => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
                controller.close();
            }
        })
    };
}

assert.equal(
    await readCallStreamResponse(makeResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n',
        'data:{"choices":[{"delta":{"content":"好"}}]}'
    ]), 'unknown-provider'),
    '你好'
);
assert.equal(
    await readCallStreamResponse(makeResponse([
        'data:{"choices":[{"delta":{"content":"无"}}]}\n',
        'data:{"choices":[{"delta":{"content":"空行"}}]}'
    ]), 'newapi'),
    '无空行'
);
assert.equal(
    await readCallStreamResponse(makeResponse(['{"choices":[{"message":{"content":"一次性JSON"}}]}']), 'newapi'),
    '一次性JSON'
);
assert.equal(
    await readCallStreamResponse(makeResponse(['[{"candidates":[{"content":{"parts":[{"text":"Gemini流"}]}}]}]']), 'gemini'),
    'Gemini流'
);

replyContext.window = {};
replyContext.pad = value => String(value).padStart(2, '0');
replyContext.getLocalTimeInTimezone = () => null;
replyContext.getActiveWorldBooksContents = () => ({ before: '', middle: '', after: '' });
replyContext.getEffectivePersona = () => '测试人设';
replyContext.normalizeMessagesForProvider = messages => messages;
replyContext.getRandomValue = value => value;
const testChat = {
    myName: '用户',
    realName: '角色',
    status: '在线',
    history: [],
    maxMemory: 20
};
let capturedRequest;
replyContext.db = {
    apiSettings: {
        url: 'https://example.invalid',
        key: 'test-key',
        model: 'gemini-test',
        provider: 'gemini',
        streamEnabled: false
    }
};
replyContext.fetch = async (url, options) => {
    capturedRequest = { url, body: JSON.parse(options.body) };
    return {
        ok: true,
        async json() {
            return { candidates: [{ content: { parts: [{ text: '[角色的声音：Gemini非流式]' }] } }] };
        }
    };
};
assert.equal(await getCallReply(testChat, 'voice', [], () => {}), '[角色的声音：Gemini非流式]');
assert.match(capturedRequest.url, /:generateContent\?/);
assert.equal('stream' in capturedRequest.body, false);
assert.equal('model' in capturedRequest.body, false);
assert.equal(capturedRequest.body.generationConfig.temperature, 0.7);

replyContext.db.apiSettings = {
    url: 'https://example.invalid',
    key: 'test-key',
    model: 'compatible-test',
    provider: 'newapi',
    streamEnabled: true
};
replyContext.fetch = async () => ({
    ok: true,
    body: makeResponse(['data:{"choices":[{"delta":{"content":"[角色的声音：兼容流式]"}}]}']).body
});
let streamedText = '';
assert.equal(
    await getCallReply(testChat, 'voice', [], chunk => { streamedText += chunk; }),
    '[角色的声音：兼容流式]'
);
assert.equal(streamedText, '[角色的声音：兼容流式]');

const videoSource = [
    '../src/js/modules/video-call/part-01.jsfrag',
    '../src/js/modules/video-call/part-02.jsfrag',
    '../src/js/modules/video-call/part-03.jsfrag'
].map(path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const videoContext = vm.createContext({
    console,
    db: {},
    window: {},
    document: {},
    showToast() {},
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    globalThis: null
});
videoContext.globalThis = videoContext;
vm.runInContext(`${videoSource}\nglobalThis.__videoCallTest = VideoCallModule;`, videoContext);

const module = videoContext.__videoCallTest;
module.state.currentChat = {};
module.state.isCallActive = true;
module.addMessage = (who, type, content) => module.state.currentCallContext.push({ role: who, type, content });

module.state.currentCallContext = [];
let result = await module.parseAndAddAiResponse('[角色的声音：标准回复]');
assert.equal(result.renderedCount, 1);
assert.equal(result.usedFallback, false);
assert.equal(module.state.currentCallContext[0].content, '标准回复');

module.state.currentCallContext = [];
result = await module.parseAndAddAiResponse('没有使用通话标签的普通回复');
assert.equal(result.renderedCount, 1);
assert.equal(result.usedFallback, true);
assert.equal(module.state.currentCallContext[0].type, 'voice');

module.state.currentCallContext = [];
result = await module.parseAndAddAiResponse('<thinking>仅有内部思考</thinking>');
assert.equal(result.renderedCount, 0);
assert.equal(module.state.currentCallContext.length, 0);

const avatar = { style: {}, classList: { add() {}, remove() {} } };
const toastMessages = [];
videoContext.document.getElementById = () => avatar;
videoContext.showToast = message => toastMessages.push(message);
videoContext.getCallReply = async (chat, callType, callContext, onUpdate) => {
    onUpdate('头像点击得到的纯文本回复');
    return '头像点击得到的纯文本回复';
};
module.state.currentCallContext = [];
module.state.isGenerating = false;
module.state.isAiSpeaking = false;
module.state.isCallActive = true;
module.state.realCameraActive = false;
await module.triggerAiReply();
assert.equal(module.state.currentCallContext[0].content, '头像点击得到的纯文本回复');
assert.equal(module.state.isGenerating, false);
assert.equal(module.state.isAiSpeaking, false);

videoContext.getCallReply = async () => '';
module.state.currentCallContext = [];
module.state.isCallActive = true;
await module.triggerAiReply();
assert.equal(module.state.currentCallContext.length, 0);
assert.equal(toastMessages.at(-1), '没有收到有效回复，请重试');

let resolveOldReply;
videoContext.getCallReply = () => new Promise(resolve => { resolveOldReply = resolve; });
module.state.isGenerating = false;
module.state.isAiSpeaking = false;
module.state.isCallActive = true;
const oldRequest = module.triggerAiReply();
await Promise.resolve();
module.state.replyRequestId += 1;
module.state.isGenerating = true;
module.state.isAiSpeaking = true;
resolveOldReply('已经失效的旧回复');
await oldRequest;
assert.equal(module.state.isGenerating, true);
assert.equal(module.state.isAiSpeaking, true);
module.state.isGenerating = false;
module.state.isAiSpeaking = false;

console.log('Call reply tests passed: SSE, tail buffering, Gemini, content arrays, display fallback, avatar feedback, and stale-request isolation.');
