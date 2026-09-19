import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = [
    'src/js/modules/avatar-recognition/part-01.jsfrag',
    'src/js/modules/avatar-recognition/part-02.jsfrag',
    'src/js/modules/avatar-recognition/part-03.jsfrag',
].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('');

const toasts = [];
let saveCount = 0;
class FakeImage {
    constructor() {
        this.width = 100;
        this.height = 100;
        this.naturalWidth = 100;
        this.naturalHeight = 100;
    }
    set src(value) {
        this._src = value;
        queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
}

const document = {
    getElementById: () => null,
    createElement: tag => {
        assert.equal(tag, 'canvas');
        return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128) }) }),
            toDataURL() { return `data:image/jpeg;base64,${this.width}x${this.height}`; },
        };
    },
};

const character = {
    id: 'char-1',
    avatarSystemEnabled: true,
    charSenseAvatarChangeEnabled: true,
    charCanSwitchAvatarEnabled: false,
    charCollectImageAsAvatarEnabled: false,
    charCollectCoupleAvatarEnabled: true,
    charSenseCoupleAvatarEnabled: true,
    avatar: 'char-old',
    myAvatar: 'user-old',
    history: [],
    userAvatarLibrary: [
        { id: 'user-old-id', url: 'user-old', name: '旧头像', description: '旧描述', fingerprint: '808080:ffff', usedCount: 2 },
        { id: 'user-new-id', url: 'user-new', name: '新头像', description: '新描述', fingerprint: '818181:ffff', usedCount: 0 },
    ],
    charAvatarLibrary: [{ id: 'happy-id', url: 'char-happy', name: '开心', usedCount: 0 }],
    coupleAvatarLibrary: [{
        id: 'couple-old', name: '旧情头',
        userAvatar: { url: 'user-old' }, charAvatar: { url: 'char-old' }, usedCount: 1,
    }],
    activeCoupleAvatarId: 'couple-old',
    avatarRelationshipHistory: [],
};
const sandbox = {
    console,
    window: {},
    db: { characters: [character], apiSettings: {} },
    document,
    Image: FakeImage,
    Uint8ClampedArray,
    queueMicrotask,
    saveData: async () => { saveCount += 1; },
    renderMessages: () => {},
    showToast: message => toasts.push(message),
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'avatar-recognition.js' });
const avatar = sandbox.window.AvatarSystem;
assert.ok(avatar, 'AvatarSystem should be exported');

const ordered = avatar.parseAvatarCommands(
    '前文[couple-avatar-apply: 旧情头]\n[avatar-switch-self: 开心]\n[couple-avatar-remove]结尾',
    character.id,
);
assert.deepEqual(Array.from(ordered.actions, action => action.type), ['couple-apply', 'switch-self', 'couple-remove']);
assert.equal(ordered.cleaned, '前文\n结尾');

await avatar.executeAvatarActions([{ type: 'switch-self', name: '开心' }], character.id);
assert.equal(character.avatar, 'char-old', 'disabled self-switch permission must be enforced by the executor');

character.charCanSwitchAvatarEnabled = true;
await avatar.executeAvatarActions([{ type: 'switch-self', name: '开心' }], character.id);
assert.equal(character.avatar, 'char-happy');
assert.equal(character.activeCoupleAvatarId, null, 'changing one side must clear a mismatched active couple');
assert.equal(character.charAvatarLibrary[0].usedCount, 1);

character.avatar = 'char-old';
character.myAvatar = 'user-old';
character.activeCoupleAvatarId = 'couple-old';
character.history.push({ role: 'user', content: '[图片]', parts: [{ type: 'image', data: 'data:image/png;base64,SOURCE' }] });
await avatar.executeAvatarActions([
    { type: 'couple-crop', name: '新裁剪', description: '双人图', mode: 'overlap', userRect: [0, 0, 55, 100], charRect: [45, 0, 100, 100] },
    { type: 'couple-remove' },
], character.id);
assert.equal(character.activeCoupleAvatarId, null, 'a remove after async crop must execute after the crop finishes');
const cropped = character.coupleAvatarLibrary.find(item => item.name === '新裁剪');
assert.ok(cropped);
assert.deepEqual(Array.from(cropped.cropRecipe.userRect), [0, 0, 55, 100]);

assert.throws(() => avatar.normalizeCropRect([80, 0, 20, 100]), /宽高必须大于 0/);
assert.throws(() => avatar.normalizeCropRect([0, 0, Number.NaN, 100]), /无效数字/);
assert.deepEqual(Array.from(avatar.normalizeCropRect([-10, 2, 120, 98])), [0, 2, 100, 98]);

character.activeCoupleAvatarId = null;
await avatar.recognizeAndNotifyUserAvatarChange(character.id, 'user-old', 'user-new');
assert.equal(character.userAvatarLibrary[1].usedCount, 1, 'the first actual use must count once');
assert.match(character.history.at(-1).content, /新头像（新描述）/);
assert.equal(character.avatarRelationshipHistory.at(-1).type, 'user-avatar-changed');

const prompt = avatar.generateAvatarSystemPrompt(character);
assert.match(prompt, /新头像（新描述）/);
assert.match(prompt, /只在与当前话题自然相关时提及/);
assert.ok(saveCount > 0);

console.log('Avatar system tests passed: ordered actions, permission gates, async crop sequencing, state consistency, counts, crop validation, and relationship context.');
