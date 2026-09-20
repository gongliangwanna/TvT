import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/modules/chat-ai/prompt-studio.js', import.meta.url), 'utf8');
const db = {
    magicRoom: { customPromptEnabled: true, promptEditMode: 'items', customPromptItems: [] },
    apiSettings: { onlineRoleEnabled: true },
    characters: [], groups: [], favorites: [], myStickers: [], piggyBank: {}, forumSettings: {},
    cotSettings: {}, bubbleCssPresets: {}, forumMessages: []
};
const context = {
    window: {}, db, console,
    crypto: { randomUUID: () => 'fixed-id' },
    getActiveWorldBooksContents: () => ({ before: '世界书前', middle: '', after: '世界书后' }),
    getEffectivePersona: character => character.persona || '',
    getOnlineLogicRules: character => `逻辑-${character.realName}`,
    getOnlineOutputFormats: character => `格式-${character.realName}`,
    getLocalTimeInTimezone: timezone => `2026年09月17日 12:00 (${timezone})`,
    getMemoryTableContextBlock: () => '', getVectorMemoryContextBlock: () => '',
    filterHistoryForAI: (_, history) => history,
    pad: value => String(value).padStart(2, '0'),
    Date, Math, JSON, Set, String, Number, Array, Object
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'prompt-studio.js' });
const studio = context.window.PromptStudio;

const character = {
    id: 'char-1', realName: '小林', myName: '阿青', persona: '温柔但有主见', myPersona: '喜欢摄影', status: '在线',
    birthday: '2000-09-17', enableDynamicAge: true, charTimezone: 'Asia/Shanghai', enableDynamicTimezone: true,
    myBirthday: '2001-01-02', myEnableDynamicAge: true, myTimezone: 'Asia/Tokyo', myEnableDynamicTimezone: true,
    history: [], memoryJournals: [{ title: '旅行', content: '一起去过海边', isFavorited: true }], nodes: [],
    replyCountEnabled: true, replyCountMin: 2, replyCountMax: 4, characterAutoFavoriteEnabled: true,
    statusPanel: { enabled: true, promptSuffix: '[心情:xx]' }
};
db.characters.push(character);
db.magicRoom.customPromptItems = studio.createDefaultItems();

const result = studio.compile(character, { preview: true, weatherText: '<environment>晴天</environment>' });
assert.ok(result.prompt.includes('小林'));
assert.ok(result.prompt.includes('阿青'));
assert.ok(result.prompt.includes('世界书前'));
assert.ok(result.prompt.includes('一起去过海边'));
assert.ok(result.prompt.includes('2-4条'));
assert.ok(result.prompt.includes('<environment>晴天</environment>'));
assert.ok(!result.prompt.includes('{{'));
assert.equal(result.unresolved.length, 0);

const disabled = studio.createDefaultItems();
disabled.find(entry => entry.id === 'core.online-only').enabled = false;
const disabledResult = studio.compileItems(character, disabled, { preview: true });
assert.ok(!disabledResult.prompt.includes('纯线上互动'));

const customResult = studio.compileItems(character, [{
    id: 'custom', name: '自定义', category: 'custom', enabled: true, condition: 'always', content: '{{角色名}}/{{不存在的变量}}'
}], { preview: true });
assert.equal(customResult.unresolved[0], '不存在的变量');
assert.ok(customResult.prompt.includes('小林/{{不存在的变量}}'));

db.magicRoom.presets = [{ name: '角色专属', mode: 'items', items: [{
    id: 'preset-item', name: '专属', category: 'custom', enabled: true, condition: 'always', content: '专属-{{角色名}}'
}] }];
character.customPromptPreset = '角色专属';
assert.equal(studio.ensurePresetIds(db.magicRoom), true);
assert.ok(db.magicRoom.presets[0].id);
assert.equal(character.customPromptPresetId, db.magicRoom.presets[0].id);
assert.equal(studio.compile(character, { preview: true }).prompt, '专属-小林');

console.log('Prompt Studio tests passed.');
