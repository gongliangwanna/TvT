import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const context = vm.createContext({
    console, TextDecoder, Blob, FormData, Response, DataView, Uint8Array,
    window: {}, db: {}, document: {}, getRandomValue: value => value,
    normalizeMessagesForProvider: messages => messages, showErrorModal: () => {},
    pad: value => value, formatTimeGap: () => '', getLocalTimeInTimezone: () => '',
    filterHistoryForAI: value => value, showToast: () => {}, showAppConfirmDialog: async () => true,
    writeOvoPngMetadata: value => value, readOvoPngMetadata: () => null
});
vm.runInContext(fs.readFileSync(path.join(root, 'js/core/api-and-image-utils.js'), 'utf8'), context);

{
    const prepared = context.prepareAiProviderRequest({
        url: 'https://api.anthropic.test', key: 'secret', model: 'claude-3-7-sonnet', apiProtocol: 'anthropic', provider: 'claude'
    }, {
        model: 'claude-3-7-sonnet', messages: [{ role: 'user', content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
        ] }], __ovoThinking: { enabled: true, effort: 'low' }
    }, { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }, 'https://wrong.test/v1/chat/completions', false);
    assert.equal(prepared.endpoint, 'https://api.anthropic.test/v1/messages');
    assert.equal(prepared.body.messages[0].content[1].source.media_type, 'image/jpeg');
    assert.equal(prepared.body.messages[0].content[1].source.data, 'QUJD');
    assert.equal(prepared.body.thinking.type, 'enabled');
    assert.equal(prepared.body.thinking.budget_tokens, 2048);
    assert.equal(prepared.headers.Authorization, undefined);
    assert.equal(prepared.headers['x-api-key'], 'secret');
}

{
    const prepared = context.prepareAiProviderRequest({
        url: 'https://generativelanguage.googleapis.com', key: 'secret', model: 'gemini-3-flash-preview', apiProtocol: 'gemini', provider: 'gemini'
    }, {
        messages: [{ role: 'user', content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
        ] }], __ovoThinking: { enabled: true, effort: 'low' }
    }, { 'Content-Type': 'application/json' }, '', false);
    assert.equal(prepared.body.contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.equal(prepared.body.generationConfig.thinkingConfig.thinkingLevel, 'low');
    const extracted = context.extractAiProviderResponse({ candidates: [{ content: { parts: [
        { thought: true, text: '内部思考' }, { text: '最终' }, { text: '回复' }
    ] } }] }, 'gemini');
    assert.equal(extracted.reasoning, '内部思考');
    assert.equal(extracted.content, '最终回复');
}

{
    const settings = {
        url: 'https://generativelanguage.googleapis.com', key: 'secret', model: 'gemini-3.7-flash', apiProtocol: 'gemini', provider: 'gemini'
    };
    const lowest = context.prepareAiProviderRequest(settings, {
        messages: [{ role: 'user', content: '直接回答' }],
        __ovoThinking: { enabled: false, incompatible: 'lowest' }
    }, { 'Content-Type': 'application/json' }, '', false);
    assert.equal(lowest.body.generationConfig.thinkingConfig.thinkingLevel, 'low');

    const providerDefault = context.prepareAiProviderRequest(settings, {
        messages: [{ role: 'user', content: '直接回答' }],
        __ovoThinking: { enabled: false, incompatible: 'provider_default' }
    }, { 'Content-Type': 'application/json' }, '', false);
    assert.equal(providerDefault.body.generationConfig.thinkingConfig, undefined);

    const automatic = context.prepareAiProviderRequest(settings, {
        messages: [{ role: 'user', content: '自行决定' }],
        __ovoThinking: { enabled: true, effort: 'auto', incompatible: 'error' }
    }, { 'Content-Type': 'application/json' }, '', false);
    assert.equal(automatic.body.generationConfig.thinkingConfig, undefined);

    assert.throws(() => context.prepareAiProviderRequest(settings, {
        messages: [{ role: 'user', content: '最低思考' }],
        __ovoThinking: { enabled: true, effort: 'minimal', incompatible: 'error' }
    }, { 'Content-Type': 'application/json' }, '', false), /不支持思考等级/);
}

{
    const extracted = context.extractAiProviderResponse({ choices: [{ message: { content: '回答', reasoning_content: '推理' } }] }, 'deepseek');
    assert.equal(extracted.content, '回答');
    assert.equal(extracted.reasoning, '推理');
}

{
    const ids = context.getLatestConversationTurnIds([
        { id: 'a1', role: 'user' }, { id: 'b1', role: 'assistant' },
        { id: 'a2-1', role: 'user' }, { id: 'a2-2', role: 'user' }
    ]);
    assert.deepEqual(Array.from(ids), ['a2-1', 'a2-2']);
    const protectedTurn = context.protectLatestConversationTurn([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'A1', __ovoMessageId: 'a1' },
        { role: 'assistant', content: 'B1', __ovoMessageId: 'b1' },
        { role: 'user', content: 'A2.1', __ovoMessageId: 'a2-1' },
        { role: 'user', content: 'A2.2', __ovoMessageId: 'a2-2' },
        { role: 'user', content: 'CoT trigger' },
        { role: 'assistant', content: 'prefill' }
    ], ids);
    assert.deepEqual(Array.from(protectedTurn.messages, message => message.content), ['system', 'A1', 'B1', 'CoT trigger', 'A2.1', 'A2.2', 'prefill']);

    const prepared = context.prepareAiProviderRequest({
        url: 'https://api.anthropic.test', key: 'secret', model: 'claude-test', apiProtocol: 'anthropic', provider: 'claude'
    }, { model: 'claude-test', messages: protectedTurn.messages }, { Authorization: 'Bearer secret' }, '', false);
    const check = context.validateAndStripLatestTurnProtection(prepared.body, prepared.protocol, ids);
    assert.equal(check.valid, true);
    assert.equal(JSON.stringify(prepared.body).includes('__ovoMessage'), false);

    const overwritten = context.prepareAiProviderRequest({
        url: 'https://proxy.test', key: 'secret', model: 'model', provider: 'newapi', customBody: { messages: [{ role: 'user', content: 'stale' }] }
    }, { model: 'model', messages: protectedTurn.messages }, { Authorization: 'Bearer secret' }, '', false);
    const failedCheck = context.validateAndStripLatestTurnProtection(overwritten.body, overwritten.protocol, ids);
    assert.equal(failedCheck.valid, false);
    assert.deepEqual(Array.from(failedCheck.missingIds), ['a2-1', 'a2-2']);
}

console.log('Chat provider adapter tests passed: provider conversion, reasoning, and latest-turn protection.');
