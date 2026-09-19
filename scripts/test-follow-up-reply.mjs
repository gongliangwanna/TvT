import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/modules/follow_up_reply.js'), 'utf8');

function createRuntime(randomValues = [0]) {
    const saves = [];
    const math = Object.create(Math);
    let randomIndex = 0;
    math.random = () => randomValues[Math.min(randomIndex++, randomValues.length - 1)] ?? 0;
    const context = {
        console,
        Math: math,
        Date,
        db: { characters: [] },
        isGenerating: false,
        saveCharacter: async id => { saves.push(id); },
        saveData: async () => {},
        getAiReply: async () => false
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'follow_up_reply.js' });
    return { context, api: context.FollowUpReply, saves };
}

{
    const { api } = createRuntime();
    const character = {};
    const settings = api.ensureSettings(character);
    assert.equal(settings.enabled, false);
    assert.equal(settings.delayMode, 'random');
    assert.equal(settings.minDelayMinutes, 60);
    assert.equal(settings.maxDelayMinutes, 180);
    assert.equal(settings.probability, 35);
    assert.equal(settings.maxFollowUps, 1);
}

{
    const { context, api, saves } = createRuntime([0, 0.5]);
    const anchor = { id: 'assistant-1', role: 'assistant', content: '刚才忘了说一件事', timestamp: Date.now() };
    const character = {
        id: 'char-1',
        history: [anchor],
        autoReply: { quietHours: { enabled: false } },
        followUpReply: {
            ...api.defaultSettings(),
            enabled: true,
            probability: 100,
            minDelayMinutes: 60,
            maxDelayMinutes: 180
        }
    };
    context.db.characters.push(character);
    const before = Date.now();
    assert.equal(await api.scheduleAfterReply(character.id, [anchor]), true);
    assert.ok(character.followUpReply.pending);
    assert.equal(character.followUpReply.pending.anchorMessageId, anchor.id);
    assert.ok(character.followUpReply.pending.dueAt >= before + 60 * 60 * 1000);
    assert.ok(character.followUpReply.pending.dueAt <= Date.now() + 180 * 60 * 1000);
    assert.deepEqual(saves, ['char-1']);
}

{
    const { context, api } = createRuntime([0]);
    const anchor = { id: 'assistant-2', role: 'assistant', content: '晚点再聊', timestamp: Date.now() - 10_000 };
    const character = {
        id: 'char-2',
        history: [anchor, { id: 'user-2', role: 'user', content: '好呀', timestamp: Date.now() }],
        autoReply: { quietHours: { enabled: false } },
        followUpReply: { ...api.defaultSettings(), enabled: true }
    };
    context.db.characters.push(character);
    character.followUpReply.pending = {
        id: 'task-user-replied',
        anchorMessageId: anchor.id,
        originalDueAt: Date.now() - 1000,
        dueAt: Date.now() - 1000,
        state: 'pending'
    };
    await api.checkDue();
    assert.equal(character.followUpReply.pending, null);
    assert.equal(character.followUpReply.lastDecision.reason, 'user_replied');
}

{
    const { context, api } = createRuntime([0, 0]);
    const anchor = { id: 'assistant-3', role: 'assistant', content: '我再想想', timestamp: Date.now() - 10_000 };
    const character = {
        id: 'char-3',
        history: [anchor],
        autoReply: { quietHours: { enabled: false } },
        followUpReply: { ...api.defaultSettings(), enabled: true, probability: 100 }
    };
    context.db.characters.push(character);
    character.followUpReply.pending = {
        id: 'task-send',
        anchorMessageId: anchor.id,
        originalDueAt: Date.now() - 1000,
        dueAt: Date.now() - 1000,
        followUpIndex: 1,
        state: 'pending',
        failureCount: 0
    };
    context.getAiReply = async (chatId, chatType, isBackground, isSummary, isMonologue, isRevoke, options) => {
        assert.equal(chatId, 'char-3');
        assert.equal(chatType, 'private');
        assert.equal(isBackground, true);
        assert.equal(options.backgroundReason, 'followUp');
        assert.equal(options.followUpTaskId, 'task-send');
        character.history.push({ id: 'assistant-follow-up', role: 'assistant', content: '还有一句。', timestamp: Date.now() });
        return true;
    };
    await api.checkDue();
    assert.equal(character.followUpReply.pending, null);
    assert.ok(character.followUpReply.lastSuccessAt > 0);
    assert.equal(character.lastBackgroundMessageAt, character.followUpReply.lastSuccessAt);
}

{
    const { context, api } = createRuntime([0, 0]);
    const anchor = { id: 'assistant-chain-1', role: 'assistant', content: '还有后话', timestamp: Date.now() - 10_000 };
    const character = {
        id: 'char-chain',
        history: [anchor],
        autoReply: { quietHours: { enabled: false } },
        followUpReply: { ...api.defaultSettings(), enabled: true, probability: 100, maxFollowUps: 2 }
    };
    context.db.characters.push(character);
    character.followUpReply.pending = {
        id: 'task-chain-1',
        anchorMessageId: anchor.id,
        originalDueAt: Date.now() - 1000,
        dueAt: Date.now() - 1000,
        followUpIndex: 1,
        state: 'pending',
        failureCount: 0
    };
    context.getAiReply = async () => {
        character.history.push({ id: 'assistant-chain-2', role: 'assistant', content: '第二句', timestamp: Date.now() });
        return true;
    };
    await api.checkDue();
    assert.equal(character.followUpReply.pending.followUpIndex, 2);
    assert.equal(character.followUpReply.pending.anchorMessageId, 'assistant-chain-2');
    assert.equal(character.followUpReply.pending.effectiveProbability, 50);
}

{
    const { api } = createRuntime();
    const now = new Date();
    now.setHours(23, 30, 0, 0);
    const character = { autoReply: { quietHours: { enabled: true, start: '23:00', end: '07:00' } } };
    const quietEnd = api._test.nextQuietEnd(character, now.getTime());
    const expected = new Date(now.getTime());
    expected.setDate(expected.getDate() + 1);
    expected.setHours(7, 0, 0, 0);
    assert.equal(quietEnd, expected.getTime());
}

{
    const { context, api } = createRuntime();
    const anchor = { id: 'assistant-4', role: 'assistant', content: '等你有空', timestamp: Date.now() - 10_000 };
    const character = {
        id: 'char-4',
        history: [anchor],
        autoReply: { quietHours: { enabled: false } },
        followUpReply: { ...api.defaultSettings(), enabled: true }
    };
    context.db.characters.push(character);
    character.followUpReply.pending = {
        id: 'task-generating',
        anchorMessageId: anchor.id,
        originalDueAt: Date.now() - 1000,
        dueAt: Date.now() - 1000,
        state: 'generating'
    };
    character.history.push({ id: 'user-during-generation', role: 'user', content: '我来了', timestamp: Date.now() });
    assert.equal(await api.confirmBeforeFinalize(character.id, 'task-generating'), false);
    assert.equal(character.followUpReply.pending, null);
    assert.equal(character.followUpReply.lastDecision.reason, 'user_replied');
}

console.log('Follow-up reply scheduling tests passed.');
