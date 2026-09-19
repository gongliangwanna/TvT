import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const context = vm.createContext({
    console, TextDecoder, Blob, FormData, Response, DataView, Uint8Array,
    window: {}, db: { apiSettings: {}, apiNodes: [], apiNodeRoutes: {} }, document: {}, navigator: {},
    normalizeMessagesForProvider: messages => messages, showErrorModal: () => {},
    pad: value => value, formatTimeGap: () => '', getLocalTimeInTimezone: () => '',
    filterHistoryForAI: value => value, showToast: () => {}, showAppConfirmDialog: async () => true,
    writeOvoPngMetadata: value => value, readOvoPngMetadata: () => null
});
vm.runInContext(fs.readFileSync(path.join(root, 'js/core/ui-and-content-utils.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'js/core/api-and-image-utils.js'), 'utf8'), context);

{
    const presetSource = fs.readFileSync(path.join(root, 'js/settings/api-presets.js'), 'utf8');
    const applyBlock = presetSource.slice(presetSource.indexOf('async function applyApiPreset'), presetSource.indexOf('function openApiManageModal'));
    const subApiBlock = presetSource.slice(presetSource.indexOf('function setupSubApiSettings'));
    assert.match(applyBlock, /setMainApiGenerationParams/);
    assert.match(applyBlock, /latestTurnProtectionEnabled/);
    assert.doesNotMatch(subApiBlock, /p\.data\?\.generationParams/);
}

const defaults = context.createDefaultApiGenerationParams(false);
assert.equal(defaults.temperature.enabled, true);
assert.equal(defaults.topP.enabled, false);

{
    const params = context.createDefaultApiGenerationParams(false);
    params.temperature.enabled = false;
    params.topP = { enabled: true, value: 0.85 };
    params.maxOutputTokens = { enabled: true, value: 1234 };
    params.stopSequences = { enabled: true, value: 'END\nSTOP' };
    params.responseFormat = { enabled: true, value: 'json_object' };
    const prepared = context.prepareAiProviderRequest({
        url: 'https://openai.test', key: 'secret', model: 'model', provider: 'newapi', generationParams: params
    }, { model: 'model', messages: [{ role: 'user', content: 'hello' }], temperature: 0.7 }, {}, 'https://openai.test/v1/chat/completions');
    assert.equal(prepared.body.temperature, undefined);
    assert.equal(prepared.body.top_p, 0.85);
    assert.equal(prepared.body.max_tokens, 1234);
    assert.deepEqual(Array.from(prepared.body.stop), ['END', 'STOP']);
    assert.equal(prepared.body.response_format.type, 'json_object');
}

{
    const params = context.createDefaultApiGenerationParams(false);
    params.temperature = { enabled: true, value: 0 };
    params.topK = { enabled: true, value: 20 };
    params.maxOutputTokens = { enabled: true, value: 2048 };
    params.responseFormat = { enabled: true, value: 'json_object' };
    const prepared = context.prepareAiProviderRequest({
        url: 'https://gemini.test', key: 'secret', model: 'gemini-test', provider: 'gemini', apiProtocol: 'gemini', generationParams: params
    }, { messages: [{ role: 'user', content: 'hello' }] }, {}, '');
    assert.equal(prepared.body.generationConfig.temperature, 0);
    assert.equal(prepared.body.generationConfig.topK, 20);
    assert.equal(prepared.body.generationConfig.maxOutputTokens, 2048);
    assert.equal(prepared.body.generationConfig.responseMimeType, 'application/json');
}

{
    const params = context.createDefaultApiGenerationParams(false);
    params.temperature.enabled = false;
    params.topK = { enabled: true, value: 32 };
    params.maxOutputTokens = { enabled: true, value: 1024 };
    const prepared = context.prepareAiProviderRequest({
        url: 'https://anthropic.test', key: 'secret', model: 'claude-test', provider: 'claude', apiProtocol: 'anthropic', generationParams: params
    }, { messages: [{ role: 'user', content: 'hello' }], temperature: 0.6 }, {}, '');
    assert.equal(prepared.body.temperature, undefined);
    assert.equal(prepared.body.top_k, 32);
    assert.equal(prepared.body.max_tokens, 1024);
}

{
    context.db.apiSettings = { generationParams: context.createDefaultApiGenerationParams(false), temperature: 1 };
    context.db.apiNodes = [{
        id: 'node-a', name: 'A', enabled: true, features: ['chat'], protocol: 'openai_chat', url: 'https://node.test', model: 'model',
        generationParamMode: 'custom', generationParams: {
            temperature: { mode: 'off', value: 0.5 }, topP: { mode: 'on', value: 0.7 }
        }
    }];
    context.db.apiNodeRoutes = { chat: { parameterMode: 'node' } };
    const nodeConfig = context.getApiConfigForFeature('chat', null);
    assert.equal(nodeConfig.generationParams.temperature.enabled, false);
    assert.equal(nodeConfig.generationParams.topP.enabled, true);
    assert.equal(nodeConfig.generationParams.topP.value, 0.7);

    context.db.apiNodeRoutes.chat.parameterMode = 'provider';
    const providerConfig = context.getApiConfigForFeature('chat', null);
    assert.equal(Object.values(providerConfig.generationParams).some(entry => entry.enabled), false);
}

console.log('API generation parameter tests passed: defaults, switches, protocol mapping, node overrides, and route modes.');
