import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const load = (context, path) => vm.runInContext(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), context);
const clean = value => JSON.parse(JSON.stringify(value));
const legacy = { url: 'https://legacy.test', key: 'old', model: 'legacy', provider: 'newapi', streamEnabled: false };
const node = (id, protocol = 'openai_chat') => ({ id, name: id, enabled: true, protocol, url: `https://${id}.test`, key: `key-${id}`, model: `model-${id}`, features: [], streamEnabled: false });
const bind = (nodeId, features, extra = {}) => ({ defaultNodeId: nodeId, features, overrides: {}, ...extra });
function runtime() {
    const context = vm.createContext({ console, Date, Math, JSON, TextDecoder, TextEncoder, AbortController, DOMException, Response,
        setTimeout, clearTimeout, navigator: {}, document: { addEventListener() {}, getElementById() { return null; } },
        db: { apiSettings: { ...legacy }, apiNodes: [node('a'), node('b', 'anthropic'), node('c', 'gemini')], apiNodeRoutes: {}, characters: [], groups: [] },
        getRandomValue: value => value, showToast() {}, showErrorModal() {}, pad: value => value,
        isGenerating: false, currentChatId: 'other-chat', currentChatType: 'private', currentReplyAbortController: null,
        getReplyBtn: {}, regenerateBtn: {}, typingIndicator: { style: {} },
        saveGroup: async () => true, saveCharacter: async () => true, renderMessages() {},
        customPrompt: async () => null, customAlert() {}, normalizeMessagesForProvider: messages => messages
    });
    context.window = context;
    load(context, 'js/core/ui-and-content-utils.js');
    load(context, 'js/core/api-and-image-utils.js');
    load(context, 'js/core/role-api-routing.js');
    load(context, 'js/group-chat/member-api-runtime.js');
    return context;
}

{
    const ctx = runtime();
    const a = { id: 'alice', apiBinding: bind('a', ['chat', 'groupChat', 'background']) };
    const b = { id: 'bob', apiBinding: bind('b', ['chat']) };
    ctx.db.characters.push(a, b);
    assert.deepEqual(clean(ctx.getApiConfigForFeature('chat', legacy)), legacy);
    assert.equal(ctx.getApiConfigForFeature('chat', legacy, a).model, 'model-a');
    assert.equal(ctx.getApiConfigForFeature('webSearch', legacy, a).model, 'model-a', 'search-enabled chat still uses the character chat API unless explicitly overridden');
    assert.equal(ctx.getApiConfigForFeature('chat', legacy, b).apiProtocol, 'anthropic');
    assert.deepEqual(clean(ctx.getApiConfigForFeature('call', legacy, a)), legacy, 'unchecked features preserve old routing');
    a.apiBinding.overrides.chat = { nodeId: 'c' };
    assert.equal(ctx.getApiConfigForFeature('chat', legacy, a).model, 'model-c');
    ctx.db.apiNodes[2].name = 'renamed';
    assert.equal(ctx.getApiConfigForFeature('chat', legacy, a).sourceApiNodeName, 'renamed');
    const snapshot = ctx.getApiConfigForFeature('chat', legacy, a);
    ctx.db.apiNodes[2].model = 'new-model';
    assert.equal(snapshot.model, 'model-c', 'running requests keep a configuration snapshot');
    a.apiBinding.overrides.chat = { nodeId: 'system' };
    assert.deepEqual(clean(ctx.getApiConfigForFeature('chat', legacy, a)), legacy);
    ctx.db.apiNodes[0].features = ['chat'];
    ctx.db.apiNodes[0].ownerCharacterId = 'alice';
    assert.deepEqual(clean(ctx.getApiConfigForFeature('chat', legacy)), legacy, 'private nodes cannot affect unbound roles');
    a.apiBinding.overrides = {};
    const member = { id: 'member-alice', originalCharId: a.id };
    const group = { id: 'g', members: [member], apiBinding: bind('c', ['groupChat']) };
    assert.equal(ctx.MemberApiRuntime.isIndependent({ id: 'unbound', members: [] }), false, 'unbound groups retain global unified generation');
    assert.equal(ctx.MemberApiRuntime.isIndependent(group), true, 'an individual member binding overrides the global group request');
    assert.equal(ctx.MemberApiRuntime.isIndependent({ ...group, memberApiSettings: { mode: 'legacy' } }), false, 'explicit unified generation remains available');
    assert.equal(ctx.getApiConfigForFeature('groupChat', legacy, { chat: group, member }).model, 'model-a');
    member.apiBinding = bind('b', ['groupChat']);
    assert.equal(ctx.getApiConfigForFeature('groupChat', legacy, { chat: group, member }).model, 'model-b');
    member.apiBinding = { inheritRole: false, features: [] };
    assert.equal(ctx.getApiConfigForFeature('groupChat', legacy, { chat: group, member }).model, 'new-model');
    a.apiBinding.defaultNodeId = 'missing';
    assert.match(ctx.getApiConfigForFeature('chat', legacy, a)._bindingError, /删除/);
    a.apiBinding.failureMode = 'system';
    assert.equal(ctx.getApiConfigForFeature('chat', legacy, a).model, 'legacy');
    a.apiBinding = bind('b', ['callVision']);
    ctx.db.apiNodes[1].capabilities = ['text'];
    assert.match(ctx.getApiConfigForFeature('callVision', legacy, a)._bindingError, /图片理解/);
    const targets = [{ id: 'one', apiBinding: bind('a', ['chat']) }, { id: 'two' }];
    ctx.RoleApiBindings.bindTargets(targets, 'b', ['chat', 'call']);
    assert.equal(ctx.RoleApiBindings.selection(targets[0], 'chat').nodeId, 'a');
    assert.equal(ctx.RoleApiBindings.selection(targets[0], 'call').nodeId, 'b');
    ctx.RoleApiBindings.bindTargets(targets, 'c', ['chat'], true);
    assert.equal(ctx.RoleApiBindings.selection(targets[0], 'chat').nodeId, 'c');
    assert.equal(ctx.RoleApiBindings.selection(targets[0], 'call').nodeId, 'b');
}

{
    const ctx = runtime();
    const a = { id: 'alice', apiBinding: bind('a', ['chat'], { failureMode: 'backup', backupNodeIds: ['b', 'c'] }) };
    const config = ctx.getApiConfigForFeature('chat', legacy, a);
    const requests = [];
    ctx.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
        if (url.startsWith('https://a.')) throw new TypeError('network unavailable');
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'backup reply' }] }), { headers: { 'content-type': 'application/json' } });
    };
    assert.equal(await ctx.fetchAiResponse(config, { model: 'wrong', messages: [{ role: 'user', content: 'hello' }] }, {}, 'https://wrong.test'), 'backup reply');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.model, 'model-b');
    assert.equal(requests[1].headers['x-api-key'], 'key-b');
    assert.ok(config._lastRoleApiUsed.fallback);
    a.apiBinding.failureMode = 'error';
    requests.length = 0;
    await assert.rejects(() => ctx.fetchAiResponse(ctx.getApiConfigForFeature('chat', legacy, a), { messages: [] }, {}, ''), /network unavailable/);
    assert.equal(requests.length, 1, 'explicit bindings never silently use global automatic fallbacks');
    const anthro = ctx.getApiConfigForFeature('chat', legacy, { apiBinding: bind('b', ['chat']) });
    const prepared = ctx.prepareAiProviderRequest(anthro, { contents: [{ role: 'user', parts: [{ text: 'from Gemini' }] }], system_instruction: { parts: [{ text: 'system' }] } });
    assert.equal(prepared.body.messages[0].content[0].text, 'from Gemini');
    assert.equal(prepared.body.system, 'system');
}

async function groupScenario(execution = 'sequential') {
    const ctx = runtime();
    const a = { id: 'alice', apiBinding: bind('a', ['groupChat']) };
    const b = { id: 'bob', apiBinding: bind('b', ['groupChat']) };
    ctx.db.characters.push(a, b);
    const members = [{ id: 'ma', originalCharId: a.id, realName: 'Alice', groupNickname: 'A' }, { id: 'mb', originalCharId: b.id, realName: 'Bob', groupNickname: 'B' }];
    const group = { id: 'group', members, history: [{ id: 'u', role: 'user', content: 'hello' }], memberApiSettings: { mode: 'members', participants: 'all', execution, maxParticipants: 2 } };
    ctx.db.groups.push(group);
    const calls = [];
    ctx.getAiReply = async (id, type, background, summary, blocked, revoke, options) => {
        calls.push({ id: options.member.id, config: options.apiConfigSnapshot, history: clean(options.workingChat.history) });
        if (options.member.id === 'ma' && execution === 'parallel') await new Promise(resolve => setTimeout(resolve, 8));
        await options.onResult({ fullResponse: `reply-${options.member.id}`, runtimeChat: options.workingChat, apiUsage: ctx.RoleApiBindings.describe(options.apiConfigSnapshot) });
        return true;
    };
    ctx.handleAiReplyContent = async (text, chat, id, type, background, blocked, options) => chat.history.push({ id: `reply-${chat.history.length}`, role: 'assistant', senderId: options.memberId, content: text });
    assert.equal(await ctx.MemberApiRuntime.reply(group), true);
    assert.deepEqual(group.history.slice(1).map(item => item.senderId), ['ma', 'mb']);
    assert.deepEqual(calls.map(call => call.config.model), ['model-a', 'model-b']);
    assert.equal(calls[1].history.length, execution === 'sequential' ? 2 : 1);
    assert.equal(ctx.isGenerating, false);
    assert.equal(ctx.currentReplyAbortController, null);
    return { ctx, group, calls, members };
}
await groupScenario();
await groupScenario('parallel');
{
    const ctx = runtime();
    const a = { id: 'alice', apiBinding: bind('a', ['groupChat']), history: [{ role: 'user', content: 'Alice private secret' }] };
    const b = { id: 'bob', apiBinding: bind('b', ['groupChat']), history: [{ role: 'user', content: 'Bob private secret' }] };
    const members = [{ id: 'ma', originalCharId: a.id, realName: 'Alice', groupNickname: 'A' }, { id: 'mb', originalCharId: b.id, realName: 'Bob', groupNickname: 'B' }];
    const group = { id: 'real-request', name: 'Test group', realName: 'Test group', members, maxMemory: 20, history: [{ id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() }], me: { nickname: 'User', persona: '' }, memberApiSettings: { mode: 'members', participants: 'all', maxParticipants: 2 } };
    ctx.db.characters.push(a, b); ctx.db.groups.push(group); ctx.db.worldBooks = [];
    ctx.isInQuietHours = () => false; ctx.AudioManager = { unlock() {} };
    ctx.generateGroupSystemPrompt = (chat, options) => `Only speak as ${options.targetMember.realName}`;
    ctx.formatTimeGap = () => ''; ctx.filterHistoryForAI = (chat, messages) => messages;
    ctx.handleAiReplyContent = async (text, chat, id, type, background, blocked, options) => chat.history.push({ id: `real-${chat.history.length}`, role: 'assistant', senderId: options.memberId, content: text });
    const sent = [];
    ctx.fetch = async (url, options) => {
        const body = JSON.parse(options.body); sent.push({ url, body });
        return new Response(JSON.stringify(url.startsWith('https://b.') ? { content: [{ type: 'text', text: '[Bob的消息：hello]' }] } : { choices: [{ message: { content: '[Alice的消息：hello]' } }] }), { headers: { 'content-type': 'application/json' } });
    };
    load(ctx, 'js/modules/chat-ai/request-and-stream.js');
    assert.equal(await ctx.MemberApiRuntime.reply(group), true);
    assert.equal(sent.length, 2, 'each member executes the actual provider request pipeline');
    assert.equal(sent[0].body.model, 'model-a');
    assert.equal(sent[1].body.model, 'model-b');
    assert.match(sent[1].url, /\/v1\/messages$/);
    assert.match(JSON.stringify(sent[1].body), /Alice的消息/);
    assert.deepEqual(group.history.slice(1).map(message => message.senderId), ['ma', 'mb']);
}
{
    const { ctx, group, calls, members } = await groupScenario();
    const succeededIds = group.history.map(item => item.id);
    ctx.getAiReply = async (...args) => { args.at(-1).onError(new Error('bad key')); return false; };
    assert.equal(await ctx.MemberApiRuntime.reply(group, false, { memberIds: ['mb'], retry: true }), false, 'a failed retry must not be mistaken for a successful peer');
    assert.deepEqual(group.history.map(item => item.id), succeededIds);
    assert.equal(group.memberApiRun.tasks.find(task => task.memberId === 'mb').state, 'failed');
    group.history.push({ id: 'private', role: 'assistant', content: '[Private: Alice -> User: secret]' });
    assert.equal(ctx.MemberApiRuntime.visibleHistory(group, members[1], group.history).some(item => item.id === 'private'), false);
    assert.equal(ctx.MemberApiRuntime.allowedItem({ content: '[Bob的消息：forged]' }, members[0], group), false);
    assert.equal(ctx.MemberApiRuntime.allowedItem({ content: '[unknown的消息：plain]' }, members[0], group), true);
    assert.equal(ctx.MemberApiRuntime.guardCommands('[poke:actor=Bob|target=Alice]', members[0]), '');
    const chosen = ctx.MemberApiRuntime.chooseMembers({ ...group, history: [{ role: 'user', content: '@B please' }] }, { participants: 'natural', maxParticipants: 1 });
    assert.equal(chosen[0].id, 'mb');
    assert.equal(calls.length, 2);
}
{
    const { ctx, group } = await groupScenario();
    const count = group.history.length;
    ctx.getAiReply = async (...args) => {
        const options = args.at(-1);
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        options.onError(new DOMException('stopped', 'AbortError'));
        return false;
    };
    const pending = ctx.MemberApiRuntime.reply(group);
    setTimeout(() => ctx.MemberApiRuntime.stop(group.id), 5);
    await pending;
    assert.equal(group.history.length, count, 'late or cancelled responses cannot write messages');
    assert.equal(ctx.isGenerating, false);
    assert.ok(group.memberApiRun.tasks.every(task => task.state === 'stopped' || task.state === 'failed'));
}

{
    const ctx = runtime();
    load(ctx, 'js/modules/chat-ai/response-and-control.js');
    ctx.getMixedContent = text => [{ type: 'text', content: text }];
    ctx.renderChatList = () => {};
    ctx.addMessageBubble = () => {};
    const member = { id: 'member', realName: 'Alice', groupNickname: 'A' };
    const group = { id: 'stop-during-display', members: [member], history: [] };
    let stopped = false;
    const pending = ctx.handleAiReplyContent('[Alice的消息：late reply]', group, group.id, 'group', false, false, { memberId: member.id, suppressAutoTasks: true, shouldStop: () => stopped });
    stopped = true;
    await pending;
    assert.equal(group.history.length, 0, 'stopping during the display delay prevents a late message write');
}

console.log('Role API routing, provider fallback, independent group ordering, identity and retry tests passed.');
