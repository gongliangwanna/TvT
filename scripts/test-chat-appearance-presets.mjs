import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/settings/chat-appearance-presets.js'), 'utf8');
const values = {
    theme: 'sky', avatarMode: 'hidden', titleLayout: 'center',
    showTimestamp: true, timestampStyle: 'avatar', timestampFormat: 'hms',
    showStatus: false, showStatusUpdateMsg: true, showReminderMsg: false,
    showAvatarActionMsg: true, bubbleBlurEnabled: false, avatarRadius: 12
};
const original = id => ({ id, remarkName: `角色${id}`, theme: 'white_pink', avatarMode: 'full', avatar: `avatar-${id}`, chatBg: `wallpaper-${id}`, history: [{ text: id }] });
const characters = [original('a'), original('b'), original('c')];
const records = new Map();
let transactions = 0;
let rendered = 0;
let failWrite = false;
const controls = new Map();
const classNames = new Set();
const classList = {
    toggle(name, on) { if (on) classNames.add(name); else classNames.delete(name); },
    add(name) { classNames.add(name); },
    remove(...names) { names.forEach(name => classNames.delete(name)); }
};
for (const id of ['setting-theme-color', 'setting-avatar-mode', 'setting-title-layout', 'setting-show-timestamp', 'setting-timestamp-style', 'setting-timestamp-format', 'setting-show-status', 'setting-show-status-update-msg', 'setting-show-reminder-msg', 'setting-show-avatar-action-msg', 'setting-bubble-blur', 'setting-avatar-radius', 'setting-avatar-radius-value']) controls.set(id, { value: '', checked: false, textContent: '' });
controls.set('chat-room-screen', { classList });
controls.set('chat-room-header-default', { classList });
controls.set('chat-room-subtitle', { style: {} });
const cssVariables = new Map();
const context = vm.createContext({
    colorThemes: { white_pink: {}, sky: {} },
    db: { characters },
    currentChatId: 'a',
    currentChatType: 'private',
    document: {
        getElementById: id => controls.get(id),
        documentElement: { style: { setProperty: (key, value) => cssVariables.set(key, value) } }
    },
    dexieDB: {
        characters: { bulkPut: async items => { if (failWrite) throw new Error('write failed'); items.forEach(item => records.set(item.id, structuredClone(item))); } },
        transaction: async (_mode, _table, callback) => { transactions++; return callback(); }
    },
    renderMessages: () => { rendered++; },
    showToast: () => {},
    console: { error: () => {} }
});
vm.runInContext(source, context);

const keys = vm.runInContext('chatAppearanceFields.map(field => field[0])', context);
assert.equal(keys.length, 12);
assert.ok(!keys.includes('chatBg'));
assert.ok(!keys.includes('customBubbleCss'));
assert.equal(vm.runInContext('validateChatAppearanceValues', context)(values), true);
assert.equal(await context.applyChatAppearancePresetToCharacters({ name: '居中', values }, ['a', 'c']), true);
assert.equal(transactions, 1, '多选角色应一次批量写入');
assert.deepEqual([...records.keys()], ['a', 'c']);
assert.equal(characters[0].avatarMode, 'hidden');
assert.equal(characters[1].avatarMode, 'full', '未勾选角色保持原样');
assert.equal(characters[2].avatarMode, 'hidden');
assert.equal(characters[0].chatBg, 'wallpaper-a', '壁纸不得改变');
assert.equal(characters[2].avatar, 'avatar-c', '角色头像不得改变');
assert.equal(characters[0].history[0].text, 'a', '聊天记录不得改变');
assert.equal(controls.get('setting-avatar-mode').value, 'hidden', '当前角色设置页应同步');
assert.equal(controls.get('setting-avatar-radius-value').textContent, '12%');
assert.equal(cssVariables.get('--chat-avatar-radius'), '12%');
assert.equal(rendered, 1, '当前聊天应刷新');

assert.equal(await context.applyChatAppearancePresetToCharacters({ name: '居中', values }, ['a', 'b', 'c']), true);
assert.equal(characters[1].avatarMode, 'hidden', '应用全部应覆盖所有角色');
assert.equal(transactions, 2);

assert.equal(await context.applyChatAppearancePresetToCharacters({ name: '范围保护', values: { ...values, chatBg: 'unexpected' } }, ['b']), true);
assert.equal(characters[1].chatBg, 'wallpaper-b', '预设中额外字段也不得覆盖壁纸');

failWrite = true;
const changed = { ...values, avatarMode: 'merge' };
assert.equal(await context.applyChatAppearancePresetToCharacters({ name: '失败', values: changed }, ['a', 'b']), false);
assert.equal(characters[0].avatarMode, 'hidden', '保存失败时内存数据不得改变');
assert.equal(characters[1].avatarMode, 'hidden');

console.log('Chat appearance preset tests passed.');
