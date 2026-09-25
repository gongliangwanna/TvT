// 酒馆互通补丁 · 酒馆页面模拟测试（给 Claude Code 用，维护者不用运行）
// 后缀是 .cjs 不是 .js：yuan 的 package.json 写了 "type": "module"，.js 会被当成另一种格式运行而报错。
// 用法：在 tavern 文件夹里运行  node 测试/酒馆页面模拟测试.cjs   （要跑十几秒，里面有真实的等待）
// 做法：假的酒馆页面，直接跑 ../st-launcher.js，核对“小手机改了聊天后酒馆重新读取、忙完回话、回答是否在同一个浏览器”。
const fs = require('fs');
const vm = require('vm');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'st-launcher.js'), 'utf8');
src = src.replace('import.meta.url', "'http://x/scripts/extensions/third-party/uwu/tavern/st-launcher.js'");

let pass = 0, fail = 0;
const check = (n, c, info) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function makePage() {
    const state = { generating: false, editing: false, reloads: 0, replies: [], listeners: [], chat: 'A', winListeners: {},
        pu: { personas: { 'old.png': '老' }, persona_descriptions: {} }, settingsSaves: 0, charReloads: 0, wiLists: 0, wiReloads: [], fields: {} };
    const stop = { id: 'mes_stop' };
    const ctx = {
        console: { log() {}, warn() {} },
        setTimeout, clearTimeout, Promise, URL, Date, Array,
        document: {
            getElementById: (id) => id === 'mes_stop' ? stop : (id === 'curEditTextarea' && state.editing ? {} : (id === 'extensionsMenu' ? { appendChild() {} }
                : (['description_textarea', 'personality_textarea', 'scenario_pole', 'persona_description'].includes(id)
                    ? { set value(v) { state.fields[id] = v; }, get value() { return state.fields[id]; } } : null))),
            createElement: () => ({ addEventListener() {}, set innerHTML(v) {} }),
        },
        getComputedStyle: (el) => ({ display: el === stop && state.generating ? 'flex' : 'none' }),
        window: { open() {} },
        addEventListener: (type, fn) => { (state.winListeners[type] = state.winListeners[type] || []).push(fn); },
        BroadcastChannel: class { postMessage(m) { state.replies.push(m); } addEventListener(t, fn) { state.listeners.push(fn); } },
        SillyTavern: { getContext: () => ({ groupId: null, characterId: 0, characters: [{ avatar: 'a.png', chat: state.chat }], chat: new Array(7), reloadCurrentChat: async () => { state.reloads++; },
            powerUserSettings: state.pu, saveSettingsDebounced: () => { state.settingsSaves++; }, getCharacters: async () => { state.charReloads++; },
            updateWorldInfoList: async () => { state.wiLists++; }, reloadWorldInfoEditor: async (name) => { state.wiReloads.push(name); } }) },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const send = (saveId) => state.listeners.forEach(fn => fn({ data: { type: 'chat-saved', avatar: 'a.png', file: 'A', saveId, time: Date.now() } }));
    const post = (data) => state.listeners.forEach(fn => fn({ data }));
    return { state, send, post };
}

(async () => {
    console.log('st-launcher.js：酒馆页面这边');
    {
        const { state, send } = makePage();
        send('s1');
        await wait(500);
        check('酒馆不忙：马上重新读一遍', state.reloads === 1);
        check('酒馆不忙：不回话（没有盖掉的风险）', state.replies.length === 0);
    }
    {
        const { state, send } = makePage();
        state.generating = true;
        send('s1');
        await wait(400);
        send('s2');
        await wait(2500);
        check('生成回复期间不重新读', state.reloads === 0);
        state.generating = false;
        await wait(4200);
        check('生成完之后重新读了一次', state.reloads === 1, state.reloads);
        const r = state.replies[0] || {};
        check('回话带上了两次保存的编号', JSON.stringify(r.saveIds) === '["s1","s2"]', r.saveIds);
        check('回话写明在忙什么、什么时候发现、什么时候忙完、几楼', r.type === 'tavern-maybe-overwrote' && r.busyReason === 'generating'
            && r.busySince && r.busyEnded && r.busyEnded >= r.busySince && r.reloaded === true && r.floorCount === 7
            && r.avatar === 'a.png' && r.file === 'A' && r.phoneSaveTimes.length === 2, r);
    }
    {
        const { state, send } = makePage();
        state.editing = true;
        send('s1');
        await wait(500);
        state.editing = false;
        await wait(4000);
        check('正在编辑楼层时：编辑完才重新读，回话写 editing', state.reloads === 1 && state.replies[0] && state.replies[0].busyReason === 'editing', state.replies[0]);
    }
    {
        const { state, send } = makePage();
        state.chat = 'B';
        send('s1');
        await wait(500);
        check('酒馆开的是别的聊天：不重新读', state.reloads === 0);
    }
    {
        const { state, send } = makePage();
        // 柏宝书刚写好摘要（发了公开通知），它要等 1.5 秒才存盘：这期间不能重新读，否则那段摘要会丢
        (state.winListeners['st-baibai-book:changed'] || []).forEach(fn => fn({ detail: { type: 'changed' } }));
        send('s1');
        await wait(1500);
        check('柏宝书刚改完摘要：先不重新读', state.reloads === 0);
        await wait(5000);
        check('等柏宝书存完再读，回话写 summary', state.reloads === 1 && state.replies[0] && state.replies[0].busyReason === 'summary', state.replies[0]);
    }
    {
        // 推送小手机人设/世界书之后
        const { state, post } = makePage();
        post({ type: 'add-persona', id: 'q1', avatarId: '111-a.png', name: '新我', description: '内容' });
        const ans = state.replies.find(m => m.type === 'page-answer' && m.id === 'q1');
        check('替小手机新建用户人设：加进设置、存盘、回话', ans && ans.ok === true && state.pu.personas['111-a.png'] === '新我'
            && state.pu.persona_descriptions['111-a.png'].description === '内容' && state.pu.personas['old.png'] === '老' && state.settingsSaves === 1, ans);
        post({ type: 'character-created', avatar: 'n.png' });
        await wait(50);
        check('新建了角色：刷新角色列表', state.charReloads === 1);
        post({ type: 'worldinfo-saved', name: '书' });
        await wait(50);
        check('改了世界书：刷新世界书列表和编辑器', state.wiLists === 1 && state.wiReloads[0] === '书', [state.wiLists, state.wiReloads]);
        // 双向更新人设：改用户人设内容（正在用的那个，连当前人设内容一起换）
        post({ type: 'update-persona', id: 'q2', avatarId: 'old.png', description: '改过', activeAvatar: 'old.png' });
        await wait(50);
        const a2 = state.replies.find(m => m.type === 'page-answer' && m.id === 'q2');
        check('替小手机改用户人设：内容、当前人设都换，存盘、回话', a2 && a2.ok && state.pu.persona_descriptions['old.png'].description === '改过'
            && state.pu.persona_description === '改过' && state.settingsSaves === 2, [a2, state.pu]);
        post({ type: 'character-updated', avatar: 'a.png', fields: { description: 'D', personality: 'P', scenario: 'S' } });
        await wait(50);
        check('角色卡改了：刷新角色列表，编辑页上的三栏换成新的', state.charReloads === 2 && state.fields.description_textarea === 'D'
            && state.fields.personality_textarea === 'P' && state.fields.scenario_pole === 'S', state.fields);
    }
    console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
})();
