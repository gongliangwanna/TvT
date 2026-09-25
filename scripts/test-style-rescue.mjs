import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const rescueSource = source.slice(source.indexOf('function getRescueChatTarget()'));

function setup(type = 'private') {
    const character = { id: 'same-id', customBubbleCss: 'private css', useCustomBubbleCss: true, history: ['message'] };
    const group = { id: 'same-id', customBubbleCss: 'group css', useCustomBubbleCss: true, history: ['group message'] };
    const elements = new Map();
    for (const id of ['global-beautification-css', 'setting-custom-bubble-css', 'setting-use-custom-css',
        'setting-group-custom-bubble-css', 'setting-group-use-custom-css', 'private-bubble-css-preview', 'group-bubble-css-preview']) {
        elements.set(id, { value: 'old css', checked: true, disabled: false, innerHTML: '<style>bad css</style>' });
    }
    const writes = [];
    const toasts = [];
    const context = vm.createContext({
        db: { globalCss: 'global css', characters: [character], groups: [group], globalCssPresets: ['preset'] },
        currentChatId: 'same-id', currentChatType: type,
        document: { getElementById: id => elements.get(id) || null },
        confirm: () => true,
        console: { error() {} },
        showToast: text => toasts.push(text),
        applyGlobalCss: css => { context.liveGlobalCss = css; },
        updateCustomBubbleStyle: (id, css, enabled) => { context.liveChatCss = enabled ? css : ''; },
        liveGlobalCss: 'global css', liveChatCss: 'chat css',
        dexieDB: {
            globalSettings: { put: async record => { writes.push(record); } },
            characters: { update: async (id, fields) => { writes.push({ type: 'private', id, ...fields }); return 1; } },
            groups: { update: async (id, fields) => { writes.push({ type: 'group', id, ...fields }); return 1; } },
        },
    });
    vm.runInContext(rescueSource, context);
    return { context, elements, writes, toasts, character, group };
}

for (const type of ['private', 'group']) {
    const { context, elements, writes, character, group } = setup(type);
    const target = context.getRescueChatTarget();
    assert.equal(await context.clearRescueCss(target), true);
    assert.equal(target.chat.customBubbleCss, '');
    assert.equal(target.chat.useCustomBubbleCss, false);
    assert.equal(context.liveChatCss, '');
    assert.equal(context.liveGlobalCss, 'global css');
    assert.equal((type === 'private' ? group : character).useCustomBubbleCss, true);
    assert.equal(target.chat.history.length, 1);
    assert.equal(writes[0].type, type);
    assert.equal(writes.length, 1);
    assert.equal(elements.get(`${type === 'private' ? 'private' : 'group'}-bubble-css-preview`).innerHTML, '');
    const prefix = type === 'private' ? 'setting-' : 'setting-group-';
    assert.equal(elements.get(`${prefix}custom-bubble-css`).disabled, true);
    assert.equal(elements.get(`${prefix}use-custom-css`).checked, false);
    assert.deepEqual(context.db.globalCssPresets, ['preset']);
}

{
    const { context, writes, character } = setup();
    assert.equal(await context.clearRescueCss(), true);
    assert.equal(context.db.globalCss, '');
    assert.equal(context.liveGlobalCss, '');
    assert.equal(context.liveChatCss, 'chat css');
    assert.equal(character.customBubbleCss, 'private css');
    assert.equal(writes[0].key, 'globalCss');
}

// Slow/failed persistence must never delay removing the offending CSS.
for (const scope of ['global', 'private', 'group']) {
    const { context, toasts } = setup(scope === 'group' ? 'group' : 'private');
    let rejectSave;
    const pending = new Promise((resolve, reject) => { rejectSave = reject; });
    const target = scope === 'global' ? null : context.getRescueChatTarget();
    if (target) context.dexieDB[scope === 'private' ? 'characters' : 'groups'].update = () => pending;
    else context.dexieDB.globalSettings.put = () => pending;
    const result = context.clearRescueCss(target);
    assert.equal(target ? context.liveChatCss : context.liveGlobalCss, '');
    rejectSave(new Error('quota'));
    assert.equal(await result, false);
    assert.match(toasts.at(-1), /保存失败/);
    assert.ok(!toasts.some(text => text.includes('清空并保存')));
}

{
    const { context, writes } = setup();
    context.confirm = () => false;
    assert.equal(await context.clearRescueCss(context.getRescueChatTarget()), false);
    assert.equal(context.liveChatCss, 'chat css');
    assert.equal(writes.length, 0);
    context.currentChatId = null;
    assert.equal(context.getRescueChatTarget(), null);
    context.currentChatId = 'same-id';
    context.currentChatType = 'unknown';
    assert.equal(context.getRescueChatTarget(), null);
}

console.log('Style rescue tests passed.');
