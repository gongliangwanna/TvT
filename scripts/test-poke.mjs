import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = {
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    window: {},
    document: { addEventListener() {}, getElementById() { return null; } },
    db: { characters: [], groups: [] }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../js/modules/poke.js', import.meta.url), 'utf8'), context);

const PokeSystem = context.window.PokeSystem;
assert.ok(PokeSystem, '拍一拍模块应挂载到 window');

const privateChat = {
    id: 'char_1',
    realName: '陆沉',
    remarkName: '陆沉',
    myName: '小鹿',
    history: [],
    pokeEnabled: true,
    pokeCharacterSuffix: '的肩膀💣',
    pokeUserSuffix: '的猫耳朵'
};
context.db.characters.push(privateChat);
PokeSystem.ensureSettings(privateChat);
const userPoke = PokeSystem.createEvent(privateChat, 'private', 'user_me', 'char_1', 'double_tap');
assert.equal(userPoke.type, 'poke');
assert.equal(userPoke.displayText, '你拍了拍陆沉的肩膀💣');
assert.equal(userPoke.effect, 'bomb');
assert.equal(userPoke.suffixSnapshot, '的肩膀💣');

privateChat.pokeCharacterSuffix = '的袖口';
assert.equal(userPoke.suffixSnapshot, '的肩膀💣', '旧事件应保留当时的后缀快照');

const aiResult = PokeSystem.consumeAiCommands('[POKE:actor=陆沉|target=用户]\n[陆沉的消息：怎么了？]', privateChat, 'private');
assert.equal(aiResult.messages.length, 1);
assert.equal(aiResult.messages[0].targetId, 'user_me');
assert.equal(aiResult.cleaned, '[陆沉的消息：怎么了？]');

const disabledChat = { id: 'char_2', history: [], pokeEnabled: false };
const disabledResult = PokeSystem.consumeAiCommands('[POKE:actor=某人|target=用户]\n正常内容', disabledChat, 'private');
assert.equal(disabledResult.messages.length, 0);
assert.equal(disabledResult.cleaned, '正常内容', '关闭时也不应泄露内部指令');

const group = {
    id: 'group_1',
    history: [],
    pokeEnabled: true,
    pokeAllowCharacterInitiated: true,
    pokeAllowMemberToMember: false,
    pokeAllowSelf: true,
    me: { nickname: '小鹿' },
    members: [
        { id: 'm1', realName: '林夏', groupNickname: '夏夏' },
        { id: 'm2', realName: '周予安', groupNickname: '安安' }
    ]
};
context.db.groups.push(group);
const blockedMemberPoke = PokeSystem.consumeAiCommands('[POKE:actor=林夏|target=周予安]', group, 'group');
assert.equal(blockedMemberPoke.messages.length, 0, '关闭成员互拍时必须拦截');
const groupUserPoke = PokeSystem.consumeAiCommands('[POKE:actor=林夏|target=用户]', group, 'group');
assert.equal(groupUserPoke.messages.length, 1);
assert.equal(groupUserPoke.messages[0].actorId, 'm1');

assert.equal(PokeSystem.cleanSuffix('  的脑袋\n✨  '), '的脑袋 ✨');

const clickHandlers = [];
const makeClassList = () => {
    const values = new Set();
    return {
        contains: value => values.has(value),
        toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); }
    };
};
const title = { classList: makeClassList(), setAttribute() {}, removeAttribute() {} };
const groupButton = { style: {}, addEventListener(type, handler) { this[type] = handler; } };
const panelCalls = [];
const overlays = [];
const makeElement = () => ({
    children: [],
    appendChild(child) { this.children.push(child); },
    addEventListener(type, handler) { this[type] = handler; },
    remove() { const index = overlays.indexOf(this); if (index >= 0) overlays.splice(index, 1); }
});
const screen = { classList: { contains: value => value === 'active' } };
const interactionContext = {
    console, Date, Math, setTimeout, clearTimeout,
    CSS: { escape: value => String(value) },
    window: {}, db: { characters: [], groups: [] },
    currentChatId: '', currentChatType: 'private',
    isInMultiSelectMode: false, isDebugMode: false, isGenerating: false,
    requestAnimationFrame(callback) { callback(); },
    messageArea: { querySelectorAll() { return []; } },
    addMessageBubble() {}, saveCharacter() {}, renderChatList() {},
    showPanel(type) { panelCalls.push(type); },
    document: {
        addEventListener(type, handler) { if (type === 'click') clickHandlers.push(handler); },
        createElement: makeElement,
        body: { appendChild(overlay) { overlays.push(overlay); } },
        getElementById(id) {
            return {
                'chat-room-title': title,
                'group-poke-expansion-btn': groupButton,
                'chat-room-screen': screen
            }[id] || overlays.find(overlay => overlay.id === id) || null;
        }
    }
};
vm.createContext(interactionContext);
vm.runInContext(fs.readFileSync(new URL('../js/modules/poke.js', import.meta.url), 'utf8'), interactionContext);
interactionContext.window.PokeSystem.init();

function doubleClick(target, targetId = interactionContext.currentChatId) {
    const event = {
        target: { closest: selector => selector === '#chat-room-title' && target === 'title' ? title : null },
        preventDefault() {}, stopPropagation() {}
    };
    // The avatar must be the same DOM element for both taps.
    if (target === 'avatar') {
        const avatar = { dataset: { pokeTargetId: targetId } };
        event.target.closest = selector => selector === '.message-avatar[data-poke-target-id]' ? avatar : null;
    }
    clickHandlers.forEach(handler => handler(event));
    clickHandlers.forEach(handler => handler(event));
}

for (const [mode, avatarMode, target, expected] of [
    ['auto', 'hidden', 'title', 1],
    ['auto', 'hidden', 'avatar', 0],
    ['auto', 'full', 'avatar', 1],
    ['auto', 'full', 'title', 0],
    ['avatar', 'hidden', 'title', 0],
    ['title', 'full', 'title', 1],
    ['both', 'full', 'avatar', 1],
    ['both', 'hidden', 'title', 1]
]) {
    const chat = { id: `trigger_${mode}_${avatarMode}_${target}`, history: [], pokeEnabled: true, pokeTriggerMode: mode, avatarMode, pokeEffectMode: 'off', pokeVibrationEnabled: false, pokeTriggerReply: false };
    interactionContext.db.characters.push(chat);
    interactionContext.currentChatId = chat.id;
    interactionContext.window.PokeSystem.updateTriggerUI(chat, 'private');
    doubleClick(target);
    assert.equal(chat.history.length, expected, `${mode}/${avatarMode}/${target} 触发结果`);
}
const groupButtonChat = { id: 'group_trigger', pokeEnabled: true };
interactionContext.window.PokeSystem.updateTriggerUI(groupButtonChat, 'group');
assert.equal(groupButton.style.display, 'flex', '群聊开启拍一拍时显示拓展入口');
assert.equal(typeof groupButton.click, 'function', '群聊拓展入口已连接选择弹层');
assert.equal(title.classList.contains('poke-title-trigger'), false, '群名不作为拍一拍目标');
interactionContext.window.PokeSystem.updateTriggerUI({ pokeEnabled: false }, 'group');
assert.equal(groupButton.style.display, 'none', '群聊关闭拍一拍时隐藏拓展入口');
interactionContext.window.PokeSystem.updateTriggerUI({ pokeEnabled: true }, 'private');
assert.equal(groupButton.style.display, 'none', '私聊不显示群聊拓展入口');
const interactionGroup = { id: 'group_trigger', history: [], pokeEnabled: true, members: [{ id: 'member_1', groupNickname: '群成员' }] };
interactionContext.db.groups.push(interactionGroup);
interactionContext.currentChatId = interactionGroup.id;
interactionContext.currentChatType = 'group';
interactionContext.window.PokeSystem.updateTriggerUI(interactionGroup, 'group');
groupButton.click();
assert.deepEqual(panelCalls, ['none'], '选择群成员前关闭聊天拓展面板');
assert.equal(overlays[0]?.id, 'poke-member-picker', '群聊拓展入口打开成员选择弹层');
assert.equal(overlays[0]?.children[0]?.children.length, 4, '选择弹层包含标题、自己、群成员和取消按钮');
doubleClick('title');
assert.equal(interactionGroup.history.length, 0, '双击群名不触发拍一拍');
doubleClick('avatar', 'member_1');
assert.equal(interactionGroup.history.length, 1, '群成员头像拍一拍保持可用');
console.log('poke tests passed');
