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
console.log('poke tests passed');
