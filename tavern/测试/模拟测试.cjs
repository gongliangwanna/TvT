// 酒馆互通补丁 · 模拟测试（给 Claude Code 用，维护者不用运行）
// 后缀是 .cjs 不是 .js：yuan 的 package.json 写了 "type": "module"，.js 会被当成另一种格式运行而报错。
// 用法：在 tavern 文件夹里运行  node 测试/模拟测试.cjs
// 做法：假的酒馆服务器 + 假的 yuan 数据，直接跑 ../tavern_sync.js，核对同步、推送、精简、补推、提醒等逻辑。
// 改了 tavern_sync.js 之后跑一遍，全部“ok”才算没改坏。界面长什么样测不了，要在真手机上看。
const fs = require('fs');
const vm = require('vm');
const path = require('path').join(__dirname, '..', 'tavern_sync.js');

function makeEnv() {
    const chats = {};   // key avatar|file -> array (header + floors)
    const saves = [];
    const el = () => ({ style: {}, classList: { add() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        db: { characters: [], worldBooks: [] },
        saveData: async () => {},
        showToast: () => {},
        localStorage: { getItem() { return null; }, setItem(k, v) { if (k === 'tavernSyncIssues') ctx.__issues = JSON.parse(v); }, removeItem() {} },
        document: { getElementById: () => null, createElement: el, head: el(), documentElement: el(), addEventListener() {}, querySelectorAll: () => [] },
        setTimeout, clearTimeout, Promise, Map, Set, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, AbortController,
        BroadcastChannel: class { postMessage(m) { ctx.__broadcasts.push(m); } addEventListener(t, fn) { ctx.__listeners.push(fn); } },
        __broadcasts: [],
        __listeners: [],
        __issues: [],
        fetch: async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : {};
            const ok = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) });
            if (url === '/csrf-token') return ok({ token: 't' });
            if (url === '/api/chats/get') return ok(chats[body.avatar_url + '|' + body.file_name] || []);
            if (url === '/api/chats/save') { chats[body.avatar_url + '|' + body.file_name] = JSON.parse(JSON.stringify(body.chat)); saves.push(body.file_name); return ok({}); }
            throw new Error('unexpected ' + url);
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path, 'utf8'), ctx, { filename: 'tavern_sync.js' });
    return { ctx, TS: ctx.TavernSync, chats, saves };
}

let t0 = Date.UTC(2026, 0, 1, 10, 0);
function floor(i, isUser, extra) {
    const d = new Date(t0 + i * 60000);
    return { name: isUser ? 'me' : 'ai', is_user: isUser, mes: `楼${i}${isUser ? '(user)' : ''}`, send_date: d.toISOString(),
        gen_started: isUser ? undefined : d.toISOString(), extra: extra || {} };
}
function makeChat(n, startI = 0) {
    const arr = [{ chat_metadata: {} }];
    for (let i = 0; i < n; i++) arr.push(floor(startI + i, i % 2 === 0));
    return arr;
}

let pass = 0, fail = 0;
function check(name, cond, info) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }
}
const tavernCards = (char, file) => char.history.filter(m => m.fromTavern && (!file || m.tavern.chatFile === file));

async function main() {
    // ---------- 1. 换绑聊天 ----------
    console.log('1. 换绑到另一个酒馆聊天');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|chatA'] = makeChat(400);
        chats['a.png|chatB'] = makeChat(10, 1000);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'chatA', initialImportCount: 20 };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        let r = await TS.pullFromTavern(b);
        check('聊天A 第一次导入 20 楼', r.imported === 20, r.imported);
        await TS.changeChatFile(b, 'chatB');
        check('换聊天后算作没同步过', TS.hasSynced(b) === false);
        r = await TS.pullFromTavern(b);
        check('聊天B 导入 10 楼（以前会是 0）', r.imported === 10, r);
        check('聊天A 的 20 张卡还留着', tavernCards(char, 'chatA').length === 20);
        chats['a.png|chatB'].push(floor(2000, false));
        r = await TS.pullFromTavern(b);
        check('聊天B 新楼层继续导入，旧卡不被删', r.imported === 1 && r.removedGone === 0 && tavernCards(char, 'chatA').length === 20, r);
        const rm = await TS.removeOtherChatFloors(b);
        check('一键删掉旧聊天留下的楼层', rm.removed === 20 && tavernCards(char).length === 11, rm);
        // 旧数据：卡片没记 chatFile
        const { ctx: c2, TS: T2, chats: ch2 } = makeEnv();
        const old = { id: 'c2', name: 'B', history: [] };
        c2.db.characters.push(old);
        ch2['b.png|X'] = makeChat(30);
        const b2 = { uwuCharId: 'c2', stCharAvatar: 'b.png', stChatFile: 'X' };
        c2.db.tavernSync = { bindings: [b2], enabled: true };
        await T2.pullFromTavern(b2);
        old.history.forEach(m => { if (m.tavern) delete m.tavern.chatFile; });
        ch2['b.png|X'].push(floor(500, true));
        const r2 = await T2.pullFromTavern(b2);
        check('旧卡片（没记来源）照常续上', r2.imported === 1 && r2.removedGone === 0, r2);
    }

    // ---------- 2. 第一次同步 0 楼 ----------
    console.log('2. 第一次同步填 0 楼');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(15);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', initialImportCount: 0 };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        let r = await TS.pullFromTavern(b);
        check('第一次导入 0 楼', r.imported === 0);
        chats['a.png|A'].push(floor(100, true), floor(101, false));
        r = await TS.pullFromTavern(b);
        check('之后的新楼层能进来（以前永远是 0）', r.imported === 2, r.imported);
        // 空聊天
        const { ctx: c2, TS: T2, chats: ch2 } = makeEnv();
        c2.db.characters.push({ id: 'c1', name: 'A', history: [] });
        ch2['a.png|E'] = [{ chat_metadata: {} }];
        const b2 = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'E' };
        c2.db.tavernSync = { bindings: [b2], enabled: true };
        await T2.pullFromTavern(b2);
        for (let i = 0; i < 30; i++) ch2['a.png|E'].push(floor(i, i % 2 === 0));
        r = await T2.pullFromTavern(b2);
        check('第一次时酒馆是空的，之后 30 楼全进来', r.imported === 30, r.imported);
        // 只清空后再同步，酒馆里一楼都没有时
        const { ctx: c3, TS: T3, chats: ch3 } = makeEnv();
        c3.db.characters.push({ id: 'c1', name: 'A', history: [] });
        ch3['a.png|E'] = [{ chat_metadata: {} }];
        const b3 = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'E' };
        c3.db.tavernSync = { bindings: [b3], enabled: true };
        await T3.resetImportRange(b3, null);
        ch3['a.png|E'].push(floor(1, true));
        r = await T3.pullFromTavern(b3);
        check('空聊天“只清空”后新楼层照样进来', r.imported === 1, r.imported);
    }

    // ---------- 3/4/6. 推送 ----------
    console.log('3/4/6. 推送：小总结、进度、改设置');
    {
        const { ctx, TS, chats } = makeEnv();
        const msgs = [];
        for (let i = 1; i <= 10; i++) msgs.push({ id: 'm' + i, role: i % 2 ? 'user' : 'assistant', content: '消息' + i, timestamp: i });
        const char = { id: 'c1', name: 'A', history: msgs };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(4);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoPush: true, firstPushCount: 50 };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        // 小总结覆盖 m1..m4
        await TS.pushSummaryToTavern(b, '这是总结', 'm4', ['m1', 'm2', 'm3', 'm4']);
        check('小总结推进度到 m4', b.lastPushedMsgId === 'm4');
        let r = await TS.pushToTavern(b);
        check('自动推送推 m5..m10', r.pushed === 6, r);
        // 删掉 m2 → 小总结文字要保留
        char.history = char.history.filter(m => m.id !== 'm2');
        await TS.pushToTavern(b, 0);
        let sumFloor = chats['a.png|A'].find(m => m.extra && m.extra.uwu_summary);
        check('删掉一条后小总结文字还在', sumFloor && sumFloor.mes.includes('[小总结：这是总结]') && !sumFloor.mes.includes('消息1'), sumFloor && sumFloor.mes);
        check('小总结覆盖列表去掉了 m2', sumFloor && !sumFloor.extra.uwu_msg_ids.includes('m2'));
        // 手动推一段较早的（m5..m6，已经在酒馆里了），进度不能往回退
        await TS.pushToTavern(b, undefined, true, { messages: [char.history.find(m => m.id === 'm5')] });
        check('手动推较早的一段后进度仍是 m10', b.lastPushedMsgId === 'm10', b.lastPushedMsgId);
        char.history.push({ id: 'm11', role: 'user', content: '消息11', timestamp: 11 });
        r = await TS.pushToTavern(b);
        const allIds = chats['a.png|A'].flatMap(m => (m.extra && m.extra.uwu_msg_ids) || []);
        const m5count = allIds.filter(x => x === 'm5').length;
        check('自动推送只推 m11，不重复推', r.pushed === 1, r);
        // 进度被人为弄旧（比如旧版本数据），自动推送也不重复
        b.lastPushedMsgId = 'm5';
        char.history.push({ id: 'm12', role: 'user', content: '消息12', timestamp: 12 });
        r = await TS.pushToTavern(b);
        check('进度落后时也只推酒馆里没有的 m12', r.pushed === 1, r);
        // 改设置：通话改成“不推送”，以前推过的通话消息不能被删
        char.history.push({ id: 'call1', role: 'assistant', content: '[视频通话记录：xx]', callRecordId: 'r1', timestamp: 13 });
        await TS.pushToTavern(b);
        b.callPushMode = 'none';
        r = await TS.pushToTavern(b, 0);
        const has = chats['a.png|A'].some(m => m.extra && ((m.extra && m.extra.uwu_msg_ids) || []).includes('call1') && m.mes.includes('视频通话记录'));
        check('通话改成不推送后，酒馆里以前推的通话还在', has && !r.deleted, r);
        // 清理酒馆：清掉 m11、m12 后自动推送不能又推回去
        await TS.removePushedFromTavern(b, ['m11', 'm12', 'call1']);
        r = await TS.pushToTavern(b);
        check('清理后自动推送不把它们推回去', r.pushed === 0, r);
        // 清理时选中小总结覆盖的一条 → 整段小总结删掉
        const rr = await TS.removePushedFromTavern(b, ['m3']);
        sumFloor = chats['a.png|A'].find(m => m.extra && m.extra.uwu_summary);
        check('清理小总结里的一条 → 整段小总结删掉', !sumFloor && rr.removed === 3, rr);
        void m5count;
    }

    // ---------- 7. 合并模式 + 酒馆 AI 自己的 <phone_chat> ----------
    console.log('7. 合并到最后一楼 + AI 自己写的 <phone_chat>');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [{ id: 'p1', role: 'user', content: '手机1', timestamp: 1 }] };
        ctx.db.characters.push(char);
        const chat = makeChat(3);
        chat[chat.length - 1] = floor(2, false);
        chat[chat.length - 1].mes = '剧情正文<phone_chat>\nAI写的手机内容\n</phone_chat>结尾';
        chats['a.png|A'] = chat;
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', firstPushCount: 50 };
        ctx.db.tavernSync = { bindings: [b], enabled: true, pushMode: 'append' };
        await TS.pushToTavern(b);
        let last = chats['a.png|A'][chats['a.png|A'].length - 1];
        check('小手机内容另起一段，不塞进 AI 那段', last.mes.startsWith('剧情正文<phone_chat>\nAI写的手机内容\n</phone_chat>结尾\n<phone_chat>\n手机1\n</phone_chat>'), last.mes);
        char.history.push({ id: 'p2', role: 'user', content: '手机2', timestamp: 2 });
        await TS.pushToTavern(b);
        last = chats['a.png|A'][chats['a.png|A'].length - 1];
        check('第二次接着写进小手机那段', /<phone_chat>\n手机1\n手机2\n<\/phone_chat>$/.test(last.mes) && last.mes.includes('AI写的手机内容'), last.mes);
        // 导入时只剥掉小手机那段
        const r = await TS.pullFromTavern(b);
        const card = char.history.filter(m => m.fromTavern).pop();
        check('同步进小手机时 AI 那段保留、小手机那段去掉', card && card.content.includes('AI写的手机内容') && !card.content.includes('手机1'), card && card.content);
        // 删掉 p1、p2 → 只去掉小手机那段
        char.history = char.history.filter(m => m.fromTavern);
        await TS.pushToTavern(b, 0);
        last = chats['a.png|A'][chats['a.png|A'].length - 1];
        check('删除后 AI 那段原样保留', last.mes === '剧情正文<phone_chat>\nAI写的手机内容\n</phone_chat>结尾', last.mes);
        check('每次保存都通知了酒馆页面', ctx.__broadcasts.length >= 3 && ctx.__broadcasts[0].type === 'chat-saved' && ctx.__broadcasts[0].file === 'A', ctx.__broadcasts.length);
        void r;
        // 聊天只有开头一行时，合并模式不能写进那一行
        const { ctx: c2, TS: T2, chats: ch2 } = makeEnv();
        c2.db.characters.push({ id: 'c1', name: 'A', history: [{ id: 'p1', role: 'user', content: '手机1', timestamp: 1 }] });
        ch2['a.png|A'] = [{ chat_metadata: {} }];
        const b2 = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', firstPushCount: 50 };
        c2.db.tavernSync = { bindings: [b2], enabled: true, pushMode: 'append' };
        await T2.pushToTavern(b2);
        check('空聊天时新开一楼，不改开头那行设置', ch2['a.png|A'].length === 2 && !('mes' in ch2['a.png|A'][0]));
    }

    // ---------- 重新生成替换：旧回复在小总结里 ----------
    console.log('3b. 重新生成时旧回复在小总结里');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [
            { id: 'u1', role: 'user', content: '问', timestamp: 1 },
            { id: 'new1', role: 'assistant', content: '新回复', timestamp: 2 }] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(2);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A' };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        await TS.pushSummaryToTavern(b, '总结', 'old1', ['u1', 'old1']);
        const r = await TS.replaceRegeneratedInTavern(b, ['old1'], [char.history[1]]);
        const sf = chats['a.png|A'].find(m => m.extra && m.extra.uwu_summary);
        check('小总结文字不变、覆盖列表换成新回复', r.replaced && sf.mes.includes('[小总结：总结]') && sf.extra.uwu_msg_ids.join() === 'u1,new1', sf && sf.mes);
        // 小总结推过的旧回复要算“可能在酒馆里”（不在推原文的名单里，靠 summarizedIds）
        const b2 = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', recentPushes: [] };
        b2.summarizedIds = b.summarizedIds;
        check('小总结推过的旧回复算在酒馆里', TS.mayBeInTavern(b2, ['new1']) && !(b.pushedIds || []).includes('new1'), b.summarizedIds);
    }

    // ---------- 重新生成：旧回复从没推送过 ----------
    console.log('3c. 重新生成时旧回复从没推送过');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [
            { id: 'u1', role: 'user', content: '问', timestamp: 1 },
            { id: 'u2', role: 'user', content: '问2', timestamp: 2 },
            { id: 'new1', role: 'assistant', content: '新回复', timestamp: 3 }] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(2);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', firstPushCount: 50 };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        await TS.pushToTavern(b, undefined, true, { messages: [char.history[0]] });   // 只推过 u1
        check('没推过的旧回复不算在酒馆里', !TS.mayBeInTavern(b, ['old1']));
        check('推过的算在酒馆里', TS.mayBeInTavern(b, ['u1']));
        const before = JSON.stringify(chats['a.png|A']);
        const r = await TS.replaceRegeneratedInTavern(b, ['old1'], [char.history[2]]);
        check('酒馆里找不到旧回复时不动酒馆', !r.replaced && JSON.stringify(chats['a.png|A']) === before);
    }

    // ---------- 精简 + 自动精简在同步里不卡死 ----------
    console.log('精简 / 排队');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        const chat = makeChat(40);
        chat.forEach((m, i) => { if (i > 0 && !m.is_user) m.extra.bbs_leaf = { id: 'L' + i, delta: 1, text: '摘要' + i, swipe: 0 }; });
        chats['a.png|A'] = chat;
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', initialImportCount: 40, autoTrim: true, keepRawFloors: 10 };
        ctx.db.tavernSync = { bindings: [b], enabled: true, rawFloorCount: 3 };
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('卡死')), 3000));
        const r = await Promise.race([TS.pullFromTavern(b), timeout]);
        check('同步里自动精简不卡死', r.autoTrimmed > 0, r);
        // 柏宝书撤掉摘要
        const card = char.history.filter(m => m.fromTavern && !m.tavern.isUser && !m.tavern.trimmed).pop();
        const st = chats['a.png|A'].find(m => m.send_date === card.tavern.sendDate && !m.is_user);
        delete st.extra.bbs_leaf;
        const r3 = await TS.pullFromTavern(b);
        check('柏宝书撤掉的摘要小手机里也清掉', r3.summariesCleared === 1 && !card.tavern.summary, r3);
        const r2 = await Promise.race([TS.trimFloors(b, {}), timeout]);
        check('排队后的精简按钮能用', typeof r2.trimmed === 'number', r2);
        // 酒馆删掉第 0 楼 → 所有卡片楼层号都更新（以前只更新最近 200 张）
        chats['a.png|A'].splice(1, 1);
        await TS.pullFromTavern(b);
        const nums = char.history.filter(m => m.fromTavern && m.tavern.roundUsers === undefined && !m.tavern.trimmed).map(m => m.tavern.floor);
        check('楼层号跟着往前挪', Math.min(...char.history.filter(m => m.fromTavern).map(m => m.tavern.floor)) === 0, nums.slice(0, 5));
    }

    // ---------- 被酒馆盖掉的推送 ----------
    console.log('4b. 被酒馆盖掉的推送：发现并补推');
    {
        const setup = () => {
            const env = makeEnv();
            const msgs = [];
            for (let i = 1; i <= 3; i++) msgs.push({ id: 'm' + i, role: i % 2 ? 'user' : 'assistant', content: '消息' + i, timestamp: i });
            const char = { id: 'c1', name: 'A', history: msgs };
            env.ctx.db.characters.push(char);
            env.chats['a.png|A'] = makeChat(4);
            const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoPush: true, firstPushCount: 50 };
            env.ctx.db.tavernSync = { bindings: [b], enabled: true };
            return Object.assign(env, { char, b });
        };
        const idsInTavern = (chats) => chats['a.png|A'].flatMap(m => (m.extra && m.extra.uwu_msg_ids) || []);
        const overwrite = (chats, snapshot) => { chats['a.png|A'] = JSON.parse(JSON.stringify(snapshot)); };
        const reply = async (ctx, extra) => {
            ctx.__listeners.forEach(fn => fn({ data: Object.assign({ type: 'tavern-maybe-overwrote', avatar: 'a.png', file: 'A',
                busyReason: 'generating', busySince: Date.now() - 5000, busyEnded: Date.now() - 1000, floorCount: 5 }, extra) }));
            await new Promise(r => setTimeout(r, 50));
            await ctx.TavernSync._writeQueue;
        };

        // 1. 酒馆回话 → 马上补推，原因写清楚
        {
            const { ctx, TS, chats, char, b } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushToTavern(b);
            const saveId = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            check('推送时带上了保存编号', !!saveId);
            overwrite(chats, before);   // 酒馆生成完保存了旧版本
            await reply(ctx, { saveIds: [saveId], phoneSaveTimes: [Date.now()] });
            check('酒馆回话后三条都补回来了', ['m1', 'm2', 'm3'].every(id => idsInTavern(chats).includes(id)), idsInTavern(chats));
            const text = (ctx.__issues[ctx.__issues.length - 1] || {}).text || '';
            check('页面顶部写清楚了原因', text.includes('被酒馆盖掉了') && text.includes('酒馆正在生成回复') && text.includes('「消息1」') && text.includes('共 5 楼'), text);
            // 补推之后再被盖一次（又撞上生成），回话照样能补
            const before2 = JSON.parse(JSON.stringify(chats['a.png|A']));
            void before2;
            const lastSave = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            overwrite(chats, before);
            await reply(ctx, { saveIds: [lastSave] });
            check('补推后又被盖掉，回话照样补回', idsInTavern(chats).includes('m1'));
            void char;
        }
        // 2. 别的小手机页面发的保存编号：不管
        {
            const { ctx, TS, chats, b } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushToTavern(b);
            overwrite(chats, before);
            await reply(ctx, { saveIds: ['s_别的页面'] });
            check('不是自己发的保存编号，不补推', idsInTavern(chats).length === 0);
            // 但兜底核对会补上
            await TS.pushToTavern(b);
            check('兜底核对（下次推送前）补上了', ['m1', 'm2', 'm3'].every(id => idsInTavern(chats).includes(id)), idsInTavern(chats));
            const text = (ctx.__issues[ctx.__issues.length - 1] || {}).text || '';
            check('兜底时的原因说明', text.includes('5 分钟内再看时酒馆里已经找不到了'), text);
        }
        // 3. 兜底补推的，你在酒馆里再删一次就不会再补
        {
            const { TS, chats, b } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushToTavern(b);
            overwrite(chats, before);
            await TS.pushToTavern(b);          // 兜底补推
            overwrite(chats, before);          // 你在酒馆里把那楼删了
            const r = await TS.pushToTavern(b);
            check('酒馆里故意删掉后，兜底不再补', idsInTavern(chats).length === 0 && r.pushed === 0, idsInTavern(chats));
        }
        // 4. 清理掉的不补；没被盖掉的不动
        {
            const { TS, chats, b, char } = setup();
            await TS.pushToTavern(b);
            await TS.removePushedFromTavern(b, ['m1', 'm2', 'm3']);
            char.history.push({ id: 'm4', role: 'user', content: '消息4', timestamp: 4 });
            const r = await TS.pushToTavern(b);
            check('清理掉的不会被当成盖掉补回去', r.pushed === 1 && !idsInTavern(chats).includes('m1'), idsInTavern(chats));
            const floorsBefore = chats['a.png|A'].length;
            await TS.pushToTavern(b);
            check('酒馆里都在时，核对不改任何东西', chats['a.png|A'].length === floorsBefore);
        }
        // 5. 超过 5 分钟的不兜底；但酒馆回话（生成很久）照样能对上
        {
            const { ctx, TS, chats, b } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushToTavern(b);
            const saveId = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            b.recentPushes.forEach(x => { x.time -= 6 * 60 * 1000; });
            overwrite(chats, before);
            await TS.pushToTavern(b, 0);
            check('超过 5 分钟的兜底不补', idsInTavern(chats).length === 0);
            await reply(ctx, { saveIds: [saveId] });
            check('酒馆生成了 6 分钟才回话，照样补回', idsInTavern(chats).includes('m1'));
        }
        // 6. 兜底核对时还在（酒馆还没生成完），之后才被盖掉 → 回话时记录还在，能补
        {
            const { ctx, TS, chats, b, char } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushToTavern(b);
            const saveId = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            char.history.push({ id: 'm4', role: 'user', content: '消息4', timestamp: 4 });
            await TS.pushToTavern(b);          // 这时 m1..m3 还在，兜底核对不动它们
            overwrite(chats, before);          // 酒馆生成完，把两次推送都盖掉
            const saveId2 = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            await reply(ctx, { saveIds: [saveId, saveId2] });
            check('两次推送都被盖掉，一次回话全补回', ['m1', 'm2', 'm3', 'm4'].every(id => idsInTavern(chats).includes(id)), idsInTavern(chats));
        }
        // 7. 小总结被盖掉
        {
            const { ctx, TS, chats, b } = setup();
            const before = JSON.parse(JSON.stringify(chats['a.png|A']));
            await TS.pushSummaryToTavern(b, '一段总结', 'm3', ['m1', 'm2', 'm3']);
            const saveId = ctx.__broadcasts[ctx.__broadcasts.length - 1].saveId;
            overwrite(chats, before);
            await reply(ctx, { saveIds: [saveId] });
            const sf = chats['a.png|A'].find(m => m.extra && m.extra.uwu_summary);
            check('被盖掉的小总结按原文字补回', sf && sf.mes.includes('[小总结：一段总结]'), sf && sf.mes);
            // 在小手机里删掉的消息不补
            const { ctx: c2, TS: T2, chats: ch2, b: b2, char: char2 } = setup();
            const bf = JSON.parse(JSON.stringify(ch2['a.png|A']));
            await T2.pushToTavern(b2);
            const sid = c2.__broadcasts[c2.__broadcasts.length - 1].saveId;
            overwrite(ch2, bf);
            char2.history = char2.history.filter(m => m.id !== 'm2');
            await reply(c2, { saveIds: [sid] });
            const ids = idsInTavern(ch2);
            check('小手机里已经删掉的不补', ids.includes('m1') && !ids.includes('m2'), ids);
        }
        // 8. 换聊天后旧记录清掉
        {
            const { TS, b } = setup();
            await TS.pushToTavern(b);
            await TS.changeChatFile(b, 'B');
            check('换聊天后推送记录清空', !b.recentPushes);
        }
    }

    // ---------- 推送窗口里的“丢失提示” ----------
    console.log('4c. 推送窗口：以前推过、现在酒馆里找不到的');
    {
        const setup = (n) => {
            const env = makeEnv();
            const msgs = [];
            for (let i = 1; i <= n; i++) msgs.push({ id: 'm' + i, role: i % 2 ? 'user' : 'assistant', content: '消息' + i, timestamp: i });
            const char = { id: 'c1', name: 'A', history: msgs };
            env.ctx.db.characters.push(char);
            env.chats['a.png|A'] = makeChat(4);
            const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', firstPushCount: 50 };
            env.ctx.db.tavernSync = { bindings: [b], enabled: true };
            return Object.assign(env, { char, b });
        };
        const snap = (chats) => JSON.parse(JSON.stringify(chats['a.png|A']));
        const ids = (arr) => arr.map(m => m.id).join(',');
        // 1. 跨浏览器被盖掉（超过 5 分钟，兜底已经管不到）→ 窗口里能看到
        {
            const { TS, chats, char, b } = setup(3);
            const before = snap(chats);
            await TS.pushToTavern(b);
            b.recentPushes = [];                       // 模拟过了很久
            chats['a.png|A'] = before;                 // 另一个浏览器里没刷新的酒馆页面保存了旧版本
            char.history.push({ id: 'm4', role: 'user', content: '消息4', timestamp: 4 });
            await TS.pushToTavern(b);                  // m4 正常推过去了
            const st = await TS.getPushState(b);
            check('中间被盖掉的 3 条出现在提示里', ids(st.missing) === 'm1,m2,m3', ids(st.missing));
            // 补推
            await TS.pushToTavern(b, undefined, true, { messages: st.missing });
            const st2 = await TS.getPushState(b);
            check('补推之后提示消失', st2.missing.length === 0 && b.lastPushedMsgId === 'm4', b.lastPushedMsgId);
        }
        // 2. 忽略
        {
            const { TS, chats, b } = setup(3);
            const before = snap(chats);
            await TS.pushToTavern(b);
            chats['a.png|A'] = before;
            let st = await TS.getPushState(b);
            await TS.ignoreMissing(b, st.missing.map(m => m.id));
            st = await TS.getPushState(b);
            check('点了忽略之后不再提示', st.missing.length === 0);
        }
        // 3. 清理掉的、小手机里删掉的、从没推过的都不提示
        {
            const { TS, char, b } = setup(6);
            b.firstPushCount = 2;                      // 第一次只推最近 2 条：m1~m4 从没推过
            await TS.pushToTavern(b);
            let st = await TS.getPushState(b);
            check('从没推过的老消息不提示', st.missing.length === 0, ids(st.missing));
            await TS.removePushedFromTavern(b, ['m5']);
            st = await TS.getPushState(b);
            check('清理掉的不提示', st.missing.length === 0, ids(st.missing));
            char.history = char.history.filter(m => m.id !== 'm6');
            await TS.pushToTavern(b, 0);
            st = await TS.getPushState(b);
            check('小手机里删掉的不提示', st.missing.length === 0, ids(st.missing));
        }
        // 4. 旧数据：名单是空的，但酒馆里有以前推的 → 打开窗口时补进名单，之后丢了能发现
        {
            const { TS, chats, b } = setup(3);
            await TS.pushToTavern(b);
            const after = snap(chats);
            delete b.pushedIds;                        // 模拟更新前推的
            const st0 = await TS.getPushState(b);
            check('打开窗口时把酒馆里已有的补进名单', (b.pushedIds || []).length === 3 && st0.missing.length === 0, b.pushedIds);
            chats['a.png|A'] = after.filter(m => !(m.extra && m.extra.uwu_created));
            const st = await TS.getPushState(b);
            check('之后被盖掉能发现', st.missing.length === 3);
        }
        // 5. 小总结覆盖的不按原文提示
        {
            const { TS, chats, b } = setup(3);
            const before = snap(chats);
            await TS.pushSummaryToTavern(b, '总结', 'm3', ['m1', 'm2', 'm3']);
            await TS.getPushState(b);
            chats['a.png|A'] = before;
            const st = await TS.getPushState(b);
            check('小总结覆盖的消息不提示', st.missing.length === 0, ids(st.missing));
        }
    }

    // ---------- 提醒：酒馆开了新聊天、同一浏览器检测 ----------
    console.log('5. 提醒相关');
    {
        const env = makeEnv();
        const { ctx, TS, chats } = env;
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(4);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A' };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        let list = [{ file_name: 'A.jsonl', last_mes: 'June 5, 2026 3:27pm' }, { file_name: 'B.jsonl', last_mes: 'June 6, 2026 9:00am' }];
        const origFetch = ctx.fetch;
        ctx.fetch = async (url, opts) => {
            if (url === '/api/characters/chats') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(list)) };
            return origFetch(url, opts);
        };
        await TS.pullFromTavern(b);
        check('酒馆里另一个聊天更新 → 卡片提示换过去', TS.newerChatFor(b) && TS.newerChatFor(b).file === 'B', b.newerChat);
        b.dismissedChat = 'B';
        check('点了「不换」后不再提示这个聊天', TS.newerChatFor(b) === null);
        list.push({ file_name: 'C.jsonl', last_mes: '六月 7, 2026 10:00上午' });
        await TS._checkNewerChat(b, true);
        check('酒馆里又开了新聊天 → 再提示（绑定的还在，curGone 为假）', TS.newerChatFor(b) && TS.newerChatFor(b).file === 'C' && !b.newerChat.curGone, b.newerChat);
        await TS.changeChatFile(b, 'C');
        check('换过去后提示消失', TS.newerChatFor(b) === null);
        list = [{ file_name: 'C.jsonl', last_mes: 'June 8, 2026 1:00pm' }, { file_name: 'A.jsonl', last_mes: 'June 5, 2026 3:27pm' }];
        await TS._checkNewerChat(b, true);
        check('绑定的就是最近在玩的 → 不提示', TS.newerChatFor(b) === null && !b.newerChat);
        list = [{ file_name: 'A.jsonl', last_mes: 'June 5, 2026 3:27pm' }];
        await TS._checkNewerChat(b, true);
        check('绑定的酒馆聊天在酒馆里没了 → 提示并标 curGone', TS.newerChatFor(b) && TS.newerChatFor(b).file === 'A' && b.newerChat.curGone === true, b.newerChat);
        list = [{ file_name: 'C.jsonl', last_mes: '看不懂的时间' }, { file_name: 'D.jsonl', last_mes: 'June 9, 2026 1:00pm' }];
        await TS._checkNewerChat(b, true);
        check('绑定聊天的时间读不懂 → 不乱提示', TS.newerChatFor(b) === null);
        list = { 0: { file_name: 'D.jsonl', last_mes: 'June 9, 2026 1:00pm' } };   // 老版本酒馆：返回对象；C 已被删
        await TS._checkNewerChat(b, true);
        check('绑定的聊天在酒馆里被删了 → 提示换到最近的', TS.newerChatFor(b) && TS.newerChatFor(b).file === 'D', b.newerChat);
        // 同一浏览器检测
        const none = await TS.pingTavernPage(100);
        check('没有酒馆页面回答 → false', none === false);
        const p = TS.pingTavernPage(500);
        const ping = ctx.__broadcasts.filter(m => m.type === 'ping').pop();
        ctx.__listeners.forEach(fn => fn({ data: { type: 'pong', id: ping.id } }));
        check('酒馆页面回答了 → true', (await p) === true);
    }

    // ---------- 自动更新酒馆人设 / 世界书：小手机里改过的不覆盖 ----------
    console.log('6. 自动更新人设和世界书');
    {
        const env = makeEnv();
        const { ctx, TS, chats } = env;
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(2);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoUpdatePersona: true, autoUpdateWorldBooks: true };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        const tav = { desc: '描述1', active: '我1', personas: { 'u1.png': '人设U1' }, wb: [{ uid: 1, comment: '条目1', content: '内容1', key: ['k'], order: 1 }, { uid: 2, comment: '条目2', content: '内容2', key: [], order: 2 }] };
        const origFetch = ctx.fetch;
        const ok = (d) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(d)) });
        ctx.fetch = async (url, opts) => {
            if (url === '/api/characters/get') return ok({ name: '酒馆A', data: { name: '酒馆A', description: tav.desc, extensions: { world: 'W' } } });
            if (url === '/api/settings/get') return ok({ settings: JSON.stringify({ power_user: { persona_description: tav.active, personas: { 'u1.png': 'U1' }, persona_descriptions: { 'u1.png': { description: tav.personas['u1.png'] } } } }) });
            if (url === '/api/worldinfo/get') return ok({ entries: Object.fromEntries(tav.wb.map(e => [e.uid, e])) });
            if (url === '/api/characters/chats') return ok([]);
            return origFetch(url, opts);
        };
        const issues = () => ctx.__issues.map(x => x.text);
        // 人设：小手机里还是空的 → 直接填上
        let r = await TS.pullFromTavern(b);
        check('空人设第一次同步就填上', char.persona === '描述1' && char.myPersona === '我1' && r.personaUpdated === 2, [char.persona, char.myPersona, r.personaUpdated]);
        tav.desc = '描述2';
        await TS.pullFromTavern(b);
        check('酒馆里改了、小手机没改 → 更新', char.persona === '描述2');
        char.persona = '我自己改的';
        tav.desc = '描述3';
        await TS.pullFromTavern(b);
        check('小手机里改过 → 不覆盖', char.persona === '我自己改的');
        check('页面顶部提示写对了', issues().some(t => t === '酒馆中「酒馆A」的角色人设在酒馆和小手机里都改过，没有自动更新；在绑定卡片「双向自动更新人设」下面选用哪一边的。'), issues());
        const n = ctx.__issues.length;
        await TS.pullFromTavern(b);
        check('同一次改动只提示一次', ctx.__issues.length === n);
        // 重新导入（窗口里点确认导入）之后，恢复自动更新
        char.persona = '描述3';
        TS.recordPersonaImport(b, char, await TS.importCharSettings(b), { char: true });
        tav.desc = '描述4';
        await TS.pullFromTavern(b);
        check('重新导入后恢复自动更新', char.persona === '描述4');
        // 只更新用户人设 + 跟着指定的人设
        b.personaUpdateMode = 'user';
        char.myPersona = '人设U1';
        TS.recordPersonaImport(b, char, await TS.importCharSettings(b), { user: true, userSource: 'u1.png' });
        tav.personas['u1.png'] = '人设U1改';
        tav.active = '我2';
        tav.desc = '描述5';
        await TS.pullFromTavern(b);
        check('只更新用户人设，并跟着导入时选的那个', char.myPersona === '人设U1改' && char.persona === '描述4', [char.myPersona, char.persona]);

        // 世界书
        const wi = await TS.getCharAndChatWorldBooks(b);
        const e1 = wi.charWorld.entries[0], e2 = wi.charWorld.entries[1];
        ctx.db.worldBooks = [e1, e2].map((e, i) => {
            const w = TS.applyTavernEntry({ id: 'w' + i, tavernSource: { avatar: 'a.png', world: 'W', uid: e.uid, hash: TS.wbHash(e), order: e.order } }, e, i, true);
            w.tavernSource.localHash = TS.wbLocalHash(w);
            return w;
        });
        ctx.db.worldBooks[1].content = '我改过的内容2';
        tav.wb[0].content = '内容1新';
        tav.wb[1].content = '内容2新';
        r = await TS.pullFromTavern(b);
        check('世界书：没改过的更新了', ctx.db.worldBooks[0].content === '内容1新' && r.worldUpdated === 1, r.worldUpdated);
        check('世界书：小手机里改过的不覆盖', ctx.db.worldBooks[1].content === '我改过的内容2');
        check('世界书提示写对了', issues().some(t => t.startsWith('酒馆中「a」的世界书条目 「条目2」 在酒馆和小手机里都改过，没有自动更新。')), issues().slice(-1));
        const wiNow = await TS.getCharAndChatWorldBooks(b);
        check('窗口里仍然标「酒馆里已改」（能手动更新）', ctx.db.worldBooks[1].tavernSource.hash !== TS.wbHash(wiNow.charWorld.entries[1]));
        const n2 = ctx.__issues.length;
        await TS.pullFromTavern(b);
        check('世界书同一次改动只提示一次', ctx.__issues.length === n2);
        // 更新前复制的旧条目（没有指纹）：酒馆没变时补上指纹，之后能正常自动更新
        const old = ctx.db.worldBooks[0];
        delete old.tavernSource.localHash;
        await TS.pullFromTavern(b);
        check('旧条目补上了指纹', typeof old.tavernSource.localHash === 'string' && old.tavernSource.localHash !== '');
        tav.wb[0].content = '内容1再新';
        await TS.pullFromTavern(b);
        check('旧条目补指纹后照常自动更新', old.content === '内容1再新');
    }

    // ---------- 2026-09-21 自查修复 ----------
    // 酒馆界面格式的发送时间（只精确到分钟），你发的楼层没有 gen_started
    const stFloor = (mes, isUser, minute, genMs) => ({ is_user: isUser, mes, send_date: `June 5, 2026 3:${String(minute).padStart(2, '0')}pm`,
        gen_started: isUser ? undefined : new Date(Date.UTC(2026, 5, 5, 7, minute, 0, genMs || 0)).toISOString(), extra: {} });
    const setup = (floors) => {
        const env = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        env.ctx.db.characters.push(char);
        env.chats['a.png|A'] = [{ chat_metadata: {} }, ...floors];
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', initialImportCount: 20, autoPush: true, firstPushCount: 50 };
        env.ctx.db.tavernSync = { bindings: [b], enabled: true };
        return Object.assign(env, { char, b });
    };
    const texts = (char) => char.history.filter(m => m.fromTavern).map(m => m.content).join(' / ');

    console.log('11. 同一分钟里连发的两楼 user');
    {
        const { TS, chats, char, b } = setup([stFloor('开场', false, 20), stFloor('第一句', true, 27)]);
        await TS.pullFromTavern(b);
        chats['a.png|A'].push(stFloor('第二句', true, 27), stFloor('AI 回复', false, 28));
        const r = await TS.pullFromTavern(b);
        check('中途同步过一次，同一分钟的第二句照样进来', r.imported === 2 && texts(char) === '开场 / 第一句 / 第二句 / AI 回复', texts(char));
        const r2 = await TS.pullFromTavern(b);
        check('再同步不重复导入、不误删', r2.imported === 0 && r2.removedGone === 0 && char.history.length === 4, r2);
        chats['a.png|A'].splice(3, 1);   // 酒馆里删掉“第二句”
        const r3 = await TS.pullFromTavern(b);
        check('酒馆里删掉第二句，小手机里删的也是它', r3.removedGone === 1 && texts(char) === '开场 / 第一句 / AI 回复', texts(char));
        const saved = JSON.stringify(chats['a.png|A']);
        check('先后序号不会被存进酒馆聊天', !saved.includes('__uwuNth'));
    }
    {
        // 这次更新之前导入的旧卡片（没有序号、没有指纹），同一分钟两楼各有一张
        const { TS, chats, char, b } = setup([stFloor('第一句', true, 27), stFloor('第二句', true, 27), stFloor('AI 回复', false, 28)]);
        await TS.pullFromTavern(b);
        char.history.forEach(m => { delete m.tavern.nth; delete m.tavern.rawHash; delete m.tavern.localHash; });
        const r = await TS.pullFromTavern(b);
        const nths = char.history.filter(m => m.tavern.isUser).map(m => m.tavern.nth).join();
        check('旧卡片补上序号，两张卡分别对上两楼', nths === '0,1' && r.imported === 0 && r.removedGone === 0 && r.contentUpdated === 0, [nths, r]);
        chats['a.png|A'].push(stFloor('第三句', true, 27));
        const r2 = await TS.pullFromTavern(b);
        check('补序号后同一分钟的新一楼也能进来', r2.imported === 1, r2);
    }

    console.log('12. 酒馆里改了某一楼的字');
    {
        const { ctx, TS, chats, char, b } = setup([stFloor('原来的文字', false, 20), stFloor('我说的话', true, 21)]);
        await TS.pullFromTavern(b);
        chats['a.png|A'][1].mes = '在酒馆里改过的文字';
        let r = await TS.pullFromTavern(b);
        check('酒馆里改了、小手机没改 → 更新', r.contentUpdated === 1 && char.history[0].content === '在酒馆里改过的文字', [r.contentUpdated, char.history[0].content]);
        // 小手机里也改过 → 不覆盖，只提示一次
        char.history[0].content = '我在小手机里改的';
        chats['a.png|A'][1].mes = '酒馆里又改了一次';
        const n = ctx.__issues.length;
        r = await TS.pullFromTavern(b);
        check('两边都改过 → 不覆盖', char.history[0].content === '我在小手机里改的' && r.editedBoth === 1, r);
        check('页面顶部提示了楼层号', ctx.__issues.length === n + 1 && ctx.__issues[ctx.__issues.length - 1].text.includes('酒馆第 0 楼在酒馆里改过字'), ctx.__issues.slice(-1));
        await TS.pullFromTavern(b);
        check('同一次改动只提示一次', ctx.__issues.length === n + 1);
        // 写回：先把小手机改回和酒馆一致，再在小手机里改 → 写回酒馆后，下次同步不算冲突
        char.history[0].content = '酒馆里又改了一次';
        const old = char.history[0].content;
        char.history[0].content = '小手机写回的版本';
        const w = await TS.writeBackFloorEdit(b, char.history[0], old);
        r = await TS.pullFromTavern(b);
        check('写回酒馆后再同步：两边一致、不提示', w.ok && chats['a.png|A'][1].mes === '小手机写回的版本' && r.contentUpdated === 0 && r.editedBoth === 0, [w, r]);
        // 旧卡片没有指纹：以酒馆为准对齐一次
        delete char.history[0].tavern.rawHash; delete char.history[0].tavern.localHash;
        chats['a.png|A'][1].mes = '升级前酒馆就改过';
        r = await TS.pullFromTavern(b);
        check('旧卡片第一次比对：以酒馆为准', char.history[0].content === '升级前酒馆就改过' && typeof char.history[0].tavern.rawHash === 'string', char.history[0].content);
        // 已精简的楼层不跟着改正文（正文是摘要）
        chats['a.png|A'][1].extra.bbs_leaf = { id: 'l1', delta: {}, text: '摘要', swipe: 0 };
        await TS.pullFromTavern(b);
        await TS.trimFloors(b, { ids: [char.history[0].id] });
        chats['a.png|A'][1].mes = '精简后酒馆又改了';
        await TS.pullFromTavern(b);
        check('已精简的楼层正文仍是摘要', char.history.find(m => m.tavern && m.tavern.floor === 0).content === '摘要');
        await TS.restoreRawFloors(b, { ids: [char.history.find(m => m.tavern && m.tavern.floor === 0).id] });
        r = await TS.pullFromTavern(b);
        check('取回原文拿到酒馆现在的版本，之后不误报', char.history.find(m => m.tavern && m.tavern.floor === 0).content === '精简后酒馆又改了' && r.editedBoth === 0 && r.contentUpdated === 0, r);
    }

    console.log('13. 文字里的 $ 符号');
    {
        const { TS, char, b } = setup([stFloor('价格 $$5，还有 $& 和 $1', false, 20)]);
        await TS.pullFromTavern(b);
        const out = TS.prepareHistoryForAI(char, char.history.map(m => Object.assign({}, m)));
        check('包裹后 $ 原样保留', out[0].content.includes('价格 $$5，还有 $& 和 $1'), out[0].content);
    }
    {
        const { TS, chats, char, b } = setup([]);
        char.history.push({ id: 'call1', role: 'assistant', content: '[视频通话记录：1分钟；]', callRecordId: 'r1', timestamp: 1 });
        await TS.pushToTavern(b);
        const old = char.history[0].content;
        char.history[0].content = '[视频通话记录：1分钟；花了 $$100 买 $& 东西]';
        const r = await TS.updatePushedMessage(b, char.history[0], old);
        const floor = chats['a.png|A'].find(m => m.extra && m.extra.uwu_created);
        check('通话总结补进酒馆时 $ 原样保留', r.updated && floor.mes.includes('花了 $$100 买 $& 东西'), floor && floor.mes);
    }

    console.log('14. 小总结按推送设置处理');
    {
        const { ctx, TS, b } = setup([]);
        const char = ctx.db.characters[0];
        char.history.push({ id: 'u1', role: 'user', content: '你在干嘛', timestamp: 1 },
            { id: 'a1', role: 'assistant', content: '在看书[阿明更新状态为：看书中]', timestamp: 2 });
        ctx.db.apiSettings = { url: 'http://api', key: 'k', model: 'm' };
        let sent = '';
        const origFetch = ctx.fetch;
        ctx.fetch = async (url, opts) => {
            if (String(url).startsWith('http://api')) {
                sent = JSON.parse(opts.body).messages[0].content;
                return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '总结' } }] }) };
            }
            return origFetch(url, opts);
        };
        await TS.summarizeUnpushedSlice(b, { messages: char.history });
        check('在线状态（默认不推）没进总结', sent.includes('在看书') && !sent.includes('更新状态为'), sent);
        ctx.fetch = origFetch;
    }

    console.log('15. 连接酒馆超时');
    {
        const { ctx, TS, chats, char, b } = setup([]);
        char.history.push({ id: 'm1', role: 'user', content: '消息1', timestamp: 1 });
        TS.FETCH_TIMEOUT_MS = 100;
        const origFetch = ctx.fetch;
        ctx.fetch = (url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        let err = null;
        try { await TS.pushToTavern(b); } catch (e) { err = e.message; }
        check('卡住的请求会超时报错', err && err.includes('连接酒馆超时'), err);
        ctx.fetch = origFetch;
        const r = await TS.pushToTavern(b);
        check('超时之后排队的推送照常进行', r.pushed === 1 && chats['a.png|A'].some(m => m.extra && m.extra.uwu_created), r);
    }

    console.log('16. 一次删很多条先拦下来');
    {
        const { ctx, TS, chats, char, b } = setup([]);
        for (let i = 1; i <= 30; i++) char.history.push({ id: 'm' + i, role: 'user', content: '消息' + i, timestamp: i });
        await TS.pushToTavern(b);
        char.history.splice(0, 2);   // 删 2 条：照常自动删
        let r = await TS.pushToTavern(b, 0);
        check('少量删除照常推送到酒馆', r.deleted && !chats['a.png|A'].some(m => ((m.extra && m.extra.uwu_msg_ids) || []).includes('m1')));
        const n = ctx.__issues.length;
        char.history.length = 0;     // 清空小手机聊天
        r = await TS.pushToTavern(b, 0);
        check('一次删 28 条：酒馆里一条不删', !r.deleted && chats['a.png|A'].some(m => ((m.extra && m.extra.uwu_msg_ids) || []).length === 28), r);
        check('页面顶部提示一次', ctx.__issues.length === n + 1 && ctx.__issues[ctx.__issues.length - 1].text.includes('一次少了 28 条'));
        await TS.pushToTavern(b, 0);
        check('再推送不重复提示', ctx.__issues.length === n + 1);
        const st = await TS.getPushState(b);
        check('推送窗口能看到这 28 条', st.bulkGone.length === 28, st.bulkGone.length);
        r = await TS.pushToTavern(b, 0, true, { allowBulkDelete: true });
        check('点了「从酒馆删掉」才删', r.deleted && !chats['a.png|A'].some(m => m.extra && m.extra.uwu_created), chats['a.png|A'].length);
    }
    {
        const { TS, chats, char, b } = setup([]);
        for (let i = 1; i <= 25; i++) char.history.push({ id: 'm' + i, role: 'user', content: '消息' + i, timestamp: i });
        await TS.pushToTavern(b);
        char.history.length = 0;
        let st = await TS.getPushState(b);
        await TS.keepGoneInTavern(b, st.bulkGone);
        const r = await TS.pushToTavern(b, 0);
        st = await TS.getPushState(b);
        check('选了「留在酒馆」：不删、不再提示', !r.deleted && st.bulkGone.length === 0 && chats['a.png|A'].some(m => m.extra && m.extra.uwu_created));
    }

    console.log('17. 推送时酒馆聊天只下载一遍');
    {
        const { ctx, TS, char, b } = setup([]);
        char.history.push({ id: 'm1', role: 'user', content: '消息1', timestamp: 1 });
        await TS.pushToTavern(b);        // 记下一笔最近推送，下次推送前会核对
        char.history.push({ id: 'm2', role: 'user', content: '消息2', timestamp: 2 });
        let gets = 0;
        const origFetch = ctx.fetch;
        ctx.fetch = async (url, opts) => { if (url === '/api/chats/get') gets++; return origFetch(url, opts); };
        const r = await TS.pushToTavern(b);
        check('核对和推送共用一次下载', r.pushed === 1 && gets === 1, gets);
        ctx.fetch = origFetch;
    }

    // ---------- 2026-09-21 第三次自查（随机测试找到的） ----------
    // 本地时间 15:分:秒，发送时间写成酒馆界面那种只到分钟的文字，AI 楼的开始/结束时间精确到秒
    const lt = (min, sec) => new Date(2026, 5, 5, 15, min, sec || 0).getTime();
    const hm = (min) => `June 5, 2026 3:${String(min).padStart(2, '0')}pm`;
    const userAt = (mes, min) => ({ is_user: true, mes, send_date: hm(min), extra: {} });
    const aiAt = (mes, min, sec) => ({ is_user: false, mes, send_date: hm(min), gen_started: new Date(lt(min, sec)).toISOString(), gen_finished: new Date(lt(min, sec + 1)).toISOString(), extra: {} });

    console.log('18. 酒馆里删楼后，顺序不乱');
    {
        const { TS, chats, char, b } = setup([aiAt('A1', 20, 10), userAt('U2', 20), aiAt('A3', 21, 50), userAt('U4', 21)]);
        await TS.pullFromTavern(b);
        chats['a.png|A'].splice(3, 1);                 // 酒馆里删掉 A3（U4 原来被“抬”到 A3 的时间）
        chats['a.png|A'].push(userAt('U5', 21));       // 同一分钟又发一楼
        await TS.pullFromTavern(b);
        check('删掉前一楼后新来的楼层仍排在后面', texts(char) === 'A1 / U2 / U4 / U5', texts(char));
    }

    console.log('19. 精简记号不挡住别的楼层');
    {
        const a2 = aiAt('A2', 30, 30);
        a2.extra.bbs_leaf = { id: 'l1', delta: {}, text: '摘要2', swipe: 0 };
        const { TS, chats, char, b } = setup([userAt('U1', 30), a2]);
        await TS.pullFromTavern(b);
        await TS.trimFloors(b, {});                    // A2 精简，同回合的 U1 被收走
        check('精简后 U1 收进记号', texts(char) === '摘要2' && char.history[0].tavern.roundUsers.length === 1, texts(char));
        chats['a.png|A'].splice(1, 1);                 // 酒馆里删掉 U1
        chats['a.png|A'].push(userAt('U3', 30), aiAt('A4', 31, 5));   // 同一分钟的新一楼，和 U1 长得一样
        const r = await TS.pullFromTavern(b);
        check('和已删楼层长得一样的新楼层照样同步进来', r.imported === 2 && texts(char) === '摘要2 / U3 / A4', [r.imported, texts(char)]);
        check('失效的记号清掉了', char.history.find(m => m.tavern.floor === 0).tavern.roundUsers.length === 0);
    }

    console.log('20. 超时按上传大小放宽');
    {
        const { ctx, TS } = makeEnv();
        TS.FETCH_TIMEOUT_MS = 100;
        TS.FETCH_TIMEOUT_PER_MB_MS = 1000;
        ctx.fetch = (url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
        let t = Date.now();
        await TS._fetchWithTimeout('/x', { body: 'x' }).catch(() => {});
        const small = Date.now() - t;
        t = Date.now();
        await TS._fetchWithTimeout('/x', { body: '字'.repeat(350000) }).catch(() => {});   // 约 1MB
        const big = Date.now() - t;
        check('小请求按基础时间超时，大请求多等', small < 400 && big >= 1000, [small, big]);
    }

    console.log('21. 推送小手机人设、推送小手机世界书');
    {
        const { ctx, TS, chats } = makeEnv();
        // 假酒馆：世界书、角色卡、设置、头像上传
        const worlds = { 旧书: { entries: { 0: { uid: 0, comment: '原有', content: '原有内容', key: ['x'], order: 1, position: 4, disable: false } } } };
        const cards = {};
        let settings = { power_user: { personas: { 'old.png': '老人设' }, persona_descriptions: {} } };
        let settingsSaves = 0, creates = 0;
        ctx.FormData = class { constructor() { this.fields = {}; } append(k, v) { this.fields[k] = v; } };
        ctx.Blob = class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } };
        ctx.Uint8Array = Uint8Array;
        ctx.atob = (s) => Buffer.from(s, 'base64').toString('binary');
        const origFetch = ctx.fetch;
        const ok = (d) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(d)), text: async () => d });
        ctx.fetch = async (url, opts) => {
            const form = opts && opts.body instanceof ctx.FormData ? opts.body.fields : null;
            const body = !form && opts && opts.body ? JSON.parse(opts.body) : {};
            if (url === '/img/ai4.png') return { ok: false, status: 404 };
            if (url === '/api/settings/get') return ok({ settings: JSON.stringify(settings), world_names: Object.keys(worlds) });
            if (url === '/api/settings/save') { settings = body; settingsSaves++; return ok({}); }
            if (url === '/api/worldinfo/get') return ok(worlds[body.name] || { entries: {} });
            if (url === '/api/worldinfo/edit') { worlds[body.name] = body.data; return ok({}); }
            if (url === '/api/avatars/upload') return ok({ path: '111-avatar.png' });
            if (url === '/api/characters/create') { creates++; const av = form.ch_name + '.png'; cards[av] = form; return ok(av); }
            if (url === '/api/characters/get') { const c = cards[body.avatar_url]; return ok({ name: c.ch_name, chat: c.ch_name + ' - 2026-9-22@10h00m00s', data: { name: c.ch_name } }); }
            return origFetch(url, opts);
        };
        const char = { id: 'c1', realName: '阿明', remarkName: '明', persona: '阿明人设', myName: '我', myPersona: '我的人设', history: [], offlineWorldBookIds: ['w1', 'w2'], worldBookIds: ['w3'] };
        ctx.db.characters.push(char);
        const w1 = { id: 'w1', name: '条目前', content: '内容1', keywords: ['k1', 'k2'], alwaysOn: false, position: 'before', weight: 5, category: '分组A' };
        const w2 = { id: 'w2', name: '条目中', content: '内容2', keywords: [], position: 'middle', weight: 7, category: '分组A' };
        const w3 = { id: 'w3', name: '线上', content: '内容3', position: 'after', category: '分组B' };
        const g1 = { id: 'g1', name: '全局', content: '内容G', position: 'after', isGlobal: true, category: '分组B' };
        ctx.db.worldBooks.push(w1, w2, w3, g1);
        ctx.db.tavernSync = { bindings: [], enabled: true };

        const src = TS.phoneOfflineWorldBooks(char);
        check('线下世界书：列线下的，全局另列', src.offline && src.books.map(w => w.id).join() === 'w1,w2' && src.globals.map(w => w.id).join() === 'g1', src);
        check('没设线下的退回线上', TS.phoneOfflineWorldBooks({ worldBookIds: ['w3'] }).books[0] === w3 && !TS.phoneOfflineWorldBooks({ worldBookIds: ['w3'] }).offline);

        // 同名世界书：一开始就拦下，角色也不建
        let err = null;
        try { await TS.createTavernCharacter({ charId: 'c1', name: '阿明', world: { name: '旧书', entries: [w1] } }); } catch (e) { err = e; }
        check('酒馆里已有同名世界书 → 不建，也不建角色', err && /已经有叫「旧书」/.test(err.message) && creates === 0, err && err.message);

        const r = await TS.createTavernCharacter({
            charId: 'c1', name: '阿明', description: '阿明人设', firstMes: '你好',
            userPersona: { name: '我', description: '我的人设' }, world: { name: '阿明', entries: [w1, w2, g1] }, bind: true,
        });
        const book = worlds['阿明'];
        const es = Object.values(book.entries);
        check('新建世界书：3 条', es.length === 3, es.length);
        check('位置：前 → 角色定义前，中/后 → 角色定义后', es[0].position === 0 && es[1].position === 1 && es[2].position === 1, es.map(e => e.position));
        check('关键词、常驻、权重都带过去', JSON.stringify(es[0].key) === '["k1","k2"]' && es[0].constant === false && es[1].constant === true && es[0].order === 5 && es[1].order === 7 && es[2].order === 100, es.map(e => [e.key, e.constant, e.order]));
        check('新条目有酒馆需要的完整字段', es.every(e => Array.isArray(e.keysecondary) && e.probability === 100 && e.depth === 4));
        const card = cards['阿明.png'];
        check('角色卡：名字、描述、开场白、角色世界书', card && card.ch_name === '阿明' && card.description === '阿明人设' && card.first_mes === '你好' && card.world === '阿明' && card.tags === '', card);
        check('没开酒馆页面：用户人设直接写进设置文件', r.persona && r.persona.via === 'file' && settingsSaves === 1 && settings.power_user.personas['111-avatar.png'] === '我'
            && settings.power_user.persona_descriptions['111-avatar.png'].description === '我的人设' && settings.power_user.personas['old.png'] === '老人设', settings.power_user);
        const bnd = ctx.db.tavernSync.bindings[0];
        check('绑定到新角色和它的第一个聊天文件', r.bound && bnd && bnd.uwuCharId === 'c1' && bnd.stCharAvatar === '阿明.png' && bnd.stChatFile === '阿明 - 2026-9-22@10h00m00s', bnd);
        const chat = chats['阿明.png|阿明 - 2026-9-22@10h00m00s'];
        check('聊天文件：开头一行 + 开场白', chat && chat.length === 2 && chat[0].character_name === '阿明' && chat[0].user_name === '我' && chat[1].mes === '你好' && !chat[1].is_user, chat);
        check('小手机条目记下推到了哪', w1.tavernPushes && w1.tavernPushes['阿明'] && w1.tavernPushes['阿明'].uid === 0 && g1.tavernPushes['阿明'].uid === 2);
        check('通知酒馆页面刷新角色和世界书', ctx.__broadcasts.some(m => m.type === 'character-created' && m.avatar === '阿明.png') && ctx.__broadcasts.some(m => m.type === 'worldinfo-saved' && m.name === '阿明'));
        const r2 = await TS.createTavernCharacter({ charId: 'c1', name: '阿明', bind: true });
        check('已经绑定过的角色不再绑定', !r2.bound && ctx.db.tavernSync.bindings.length === 1);

        // 状态：刚推完两边都没改
        const st = () => TS.wbPushStatus(w1, '阿明', worlds['阿明'].entries);
        check('刚推完：已推送、两边都没改', st().linked && !st().localChanged && !st().tavernChanged, st());
        w1.content = '内容1改';
        check('小手机里改了 → 小手机里改过', st().localChanged && !st().tavernChanged);
        let u = await TS.pushWorldBooksToTavern('阿明', [w1, w3], { mode: 'update' });
        check('更新：推过的更新、没推过的跳过', u.updated === 1 && u.notLinked === 1 && worlds['阿明'].entries[0].content === '内容1改', u);
        check('更新后状态又干净了', !st().localChanged && !st().tavernChanged);
        w1.weight = 9;
        check('只改权重也算改过', st().localChanged);
        worlds['阿明'].entries[0].content = '酒馆里改的';
        check('酒馆里改了 → 酒馆里改过', st().tavernChanged);
        let a = await TS.pushWorldBooksToTavern('阿明', [w1, w3], { mode: 'add' });
        check('推送：推过的跳过，新的加在最后', a.added === 1 && a.skipped === 1 && worlds['阿明'].entries[3] && worlds['阿明'].entries[3].comment === '线上', a);
        delete worlds['阿明'].entries[3];
        check('酒馆里删掉了 → 算没推过', !TS.wbPushStatus(w3, '阿明', worlds['阿明'].entries).linked);

        // 推到已有的世界书：原有条目不动；更新时 @深度 位置不被冲掉
        a = await TS.pushWorldBooksToTavern('旧书', [w2], { mode: 'add' });
        check('推到已有世界书：原来的条目不动', a.added === 1 && worlds['旧书'].entries[0].content === '原有内容' && worlds['旧书'].entries[1].comment === '条目中');
        worlds['旧书'].entries[1].position = 4;
        w2.content = '内容2改';
        await TS.pushWorldBooksToTavern('旧书', [w2], { mode: 'update' });
        check('更新：酒馆里放在 @深度 的、小手机是「中」→ 位置不动', worlds['旧书'].entries[1].position === 4 && worlds['旧书'].entries[1].content === '内容2改');
        w2.position = 'before';
        await TS.pushWorldBooksToTavern('旧书', [w2], { mode: 'update' });
        check('小手机改成「前」→ 角色定义前', worlds['旧书'].entries[1].position === 0);

        // 从酒馆导入来的条目：算已经在里面，只能更新，导入那边的记录跟着更新
        const imp = TS.applyTavernEntry({ id: 'w9', tavernSource: { avatar: 'x.png', world: '旧书', uid: 0, hash: TS.wbHash(TS._normTavernEntry(worlds['旧书'].entries[0])), order: 1 } },
            TS._normTavernEntry(worlds['旧书'].entries[0]), 0, true);
        imp.tavernSource.localHash = TS.wbLocalHash(imp);
        a = await TS.pushWorldBooksToTavern('旧书', [imp], { mode: 'add' });
        check('从这本导入的条目：推送时跳过', a.added === 0 && a.skipped === 1);
        imp.content = '小手机改了导入的';
        check('从这本导入的条目：小手机里改过', TS.wbPushStatus(imp, '旧书', worlds['旧书'].entries).localChanged);
        await TS.pushWorldBooksToTavern('旧书', [imp], { mode: 'update' });
        check('更新导入来的条目：酒馆那条更新，导入记录也更新', worlds['旧书'].entries[0].content === '小手机改了导入的'
            && imp.tavernSource.hash === TS.wbHash(TS._normTavernEntry(worlds['旧书'].entries[0])) && TS.wbEditedLocally(imp) === false);

        // 开着酒馆页面：用户人设由酒馆页面自己加，不写设置文件
        ctx.BroadcastChannel.prototype.postMessage = function (m) {
            ctx.__broadcasts.push(m);
            if (m.type === 'add-persona') setTimeout(() => ctx.__listeners.forEach(fn => fn({ data: { type: 'page-answer', id: m.id, ok: true } })), 10);
        };
        const before = settingsSaves;
        const p = await TS.createTavernPersona('新我', '新内容');
        check('开着酒馆页面：由酒馆页面新建人设', p.via === 'page' && settingsSaves === before && ctx.__broadcasts.some(m => m.type === 'add-persona' && m.name === '新我' && m.avatarId === '111-avatar.png'));

        // 头像：做好的图跟着一起传上去；没给就用默认头像
        const uploads = [];
        const f2 = ctx.fetch;
        ctx.fetch = async (url, opts) => {
            if (url === '/api/avatars/upload') uploads.push(opts.body.fields.avatar);
            return f2(url, opts);
        };
        const charBlob = new ctx.Blob(['c'], { type: 'image/png' }), userBlob = new ctx.Blob(['u'], { type: 'image/png' });
        await TS.createTavernCharacter({ name: '带头像', avatarBlob: charBlob, userPersona: { name: 'U', description: '', avatarBlob: userBlob } });
        check('角色头像跟着新建角色一起传', cards['带头像.png'].avatar === charBlob);
        check('用户头像用做好的那张', uploads[0] === userBlob);
        await TS.createTavernCharacter({ name: '不带头像' });
        check('没给头像：新建角色不带头像（酒馆用默认的）', cards['不带头像.png'].avatar === undefined);
    }

    console.log('22. 头像的截取和拼图');
    {
        const { TS } = makeEnv();
        const sq = TS._squareCrop(400, 600);
        check('酒馆竖图 → 截正中间的正方形', sq.sx === 0 && sq.sy === 100 && sq.s === 400, sq);
        const sq2 = TS._squareCrop(300, 200);
        check('横图也截正中间', sq2.sx === 50 && sq2.sy === 0 && sq2.s === 200, sq2);
        const fit = TS._fitRect(300, 300, 400, 600, false);
        check('小手机方图 → 整张放在 2:3 中间，宽占满', fit.dx === 0 && fit.dy === 100 && fit.dw === 400 && fit.dh === 400, fit);
        const tall = TS._fitRect(200, 400, 400, 600, false);
        check('小手机本来就是竖图：高占满、左右居中', tall.dh === 600 && tall.dw === 300 && tall.dx === 50 && tall.dy === 0, tall);
        const cov = TS._fitRect(300, 300, 400, 600, true);
        check('模糊底图铺满整张', cov.dw === 600 && cov.dh === 600 && cov.dx === -100 && cov.dy === 0, cov);
        check('酒馆头像地址', TS.tavernCharAvatarUrl('阿 明.png') === '/characters/%E9%98%BF%20%E6%98%8E.png' && TS.tavernUserAvatarUrl('1.png') === '/User%20Avatars/1.png');
        const env2 = makeEnv();
        const ok2 = (d) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(d)) });
        env2.ctx.fetch = async (url) => {
            if (url === '/csrf-token') return ok2({ token: 't' });
            if (url === '/api/characters/get') return ok2({ name: '甲', avatar: '甲.png', data: { name: '甲', description: 'd' } });
            if (url === '/api/settings/get') return ok2({ settings: JSON.stringify({ user_avatar: 'me.png', power_user: { persona_description: '我', personas: { 'me.png': '我' }, persona_descriptions: {} } }) });
            throw new Error('unexpected ' + url);
        };
        const ic = await env2.TS.importCharSettings({ stCharAvatar: '甲.png' });
        check('导入人设时带上角色头像和当前用户头像的文件名', ic.charAvatar === '甲.png' && ic.activeAvatar === 'me.png', ic);
    }

    console.log('23. 双向自动更新人设、世界书');
    {
        const { ctx, TS, chats } = makeEnv();
        const tav = {
            card: { description: '描述', personality: '温柔', scenario: '' },
            settings: { user_avatar: 'u1.png', power_user: { persona_description: '我1', personas: { 'u1.png': 'U1' }, persona_descriptions: { 'u1.png': { description: '我1', position: 0 } } } },
            thumbs: { 'avatar|a.png': [1, 2, 3], 'persona|u1.png': [9, 9] },
            wb: { W: { entries: { 0: { uid: 0, comment: '常驻条', content: 'C0', key: ['k'], constant: true, order: 50, position: 4 }, 1: { uid: 1, comment: '推过去的', content: 'C1', key: ['x'], constant: false, order: 7, position: 1 } } } },
        };
        const calls = [];
        ctx.FormData = class { constructor() { this.fields = {}; } append(k, v) { this.fields[k] = v; } };
        ctx.Blob = class { constructor(p) { this.p = p; } };
        const ok = (d) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(d)), text: async () => 'OK' });
        const origFetch = ctx.fetch;
        ctx.fetch = async (url, opts) => {
            const form = opts && opts.body instanceof ctx.FormData ? opts.body.fields : null;
            const body = !form && opts && opts.body ? JSON.parse(opts.body) : {};
            const u = String(url);
            if (u.startsWith('/thumbnail')) {
                const q = new URLSearchParams(u.split('?')[1]);
                const bytes = tav.thumbs[q.get('type') + '|' + q.get('file')];
                return bytes ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer } : { ok: false, status: 404 };
            }
            if (u === '/api/characters/get') return ok({ name: '酒馆A', avatar: 'a.png', data: Object.assign({ name: '酒馆A', extensions: { world: 'W' } }, tav.card) });
            if (u === '/api/characters/merge-attributes') { calls.push(['merge', body]); Object.assign(tav.card, body.data); return ok('OK'); }
            if (u === '/api/characters/edit-avatar') { calls.push(['charAvatar', form]); tav.thumbs['avatar|a.png'] = [7, 7, 7]; return ok('OK'); }
            if (u === '/api/avatars/upload') { calls.push(['userAvatar', form]); tav.thumbs['persona|' + form.overwrite_name] = [5]; return ok({ path: form.overwrite_name }); }
            if (u === '/api/settings/get') return ok({ settings: JSON.stringify(tav.settings), world_names: Object.keys(tav.wb) });
            if (u === '/api/settings/save') { calls.push(['settings', body]); tav.settings = body; return ok({}); }
            if (u === '/api/worldinfo/get') return ok(tav.wb[body.name]);
            if (u === '/api/worldinfo/edit') { calls.push(['wb', body.name]); tav.wb[body.name] = body.data; return ok({}); }
            if (u === '/api/characters/chats') return ok([]);
            return origFetch(url, opts);
        };
        // 画布在测试里没有：头像处理换成假的
        TS.avatarToSquare = async (src) => 'data:square:' + src.split('?')[0];
        TS.avatarToTall = async (src) => ({ blob: 'tall:' + src, url: '' });

        const char = { id: 'c1', name: 'A', history: [], persona: '描述\n\n性格：温柔', myPersona: '我1', avatar: 'data:me', myAvatar: 'https://外链/默认.png' };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(2);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoUpdatePersona: true, autoUpdateWorldBooks: true, personaSync: { userSource: '__active__' } };
        ctx.db.tavernSync = { bindings: [b], enabled: true };

        // 拆开再拼回去和原文一样；酒馆那一栏原来是空的就不拆
        const sp = TS._splitCharPersona('描述\n\n性格：温柔\n\n场景：海边', { personality: 'x', scenario: 'y' });
        check('角色人设拆回三栏', sp.description === '描述' && sp.personality === '温柔' && sp.scenario === '海边', sp);
        check('拆完拼回去一模一样', TS._composeCharPersona(sp) === '描述\n\n性格：温柔\n\n场景：海边');
        check('酒馆那栏本来空的：整段进描述', TS._splitCharPersona('描述\n\n场景：海边', { personality: 'x' }).description === '描述\n\n场景：海边');
        check('没有描述、只有性格也能拆', TS._splitCharPersona('性格：温柔', { personality: 'x' }).personality === '温柔');

        // 第一次：文字一样 → 记下；自己传过的角色头像 → 先记下不动；默认的用户头像 → 用酒馆的
        await TS.syncPersona(b);
        check('第一次：文字一样只记下，不推也不拉', !calls.some(c => c[0] === 'merge' || c[0] === 'settings') && b.personaSync.charHash && b.personaSync.userHash, calls);
        check('第一次：自己传过的头像不动，只记下', char.avatar === 'data:me' && b.personaSync.charAvatarHash && !calls.some(c => c[0] === 'charAvatar'));
        check('第一次：默认头像换成酒馆的', char.myAvatar === 'data:square:/User%20Avatars/u1.png', char.myAvatar);

        // 只有小手机改了 → 推到酒馆
        char.persona = '新描述\n\n性格：更温柔';
        char.myPersona = '我2';
        char.avatar = 'data:me2';
        await TS.syncPersona(b);
        check('小手机改了角色人设 → 拆开写进酒馆角色卡', tav.card.description === '新描述' && tav.card.personality === '更温柔' && tav.card.scenario === '', tav.card);
        check('小手机改了用户人设 → 没开酒馆页面，直接写设置文件（当前人设也跟着换）', tav.settings.power_user.persona_descriptions['u1.png'].description === '我2'
            && tav.settings.power_user.persona_description === '我2' && tav.settings.power_user.persona_descriptions['u1.png'].position === 0, tav.settings.power_user);
        check('小手机换了角色头像 → 推到酒馆', calls.some(c => c[0] === 'charAvatar' && c[1].avatar_url === 'a.png' && c[1].avatar === 'tall:data:me2'));
        check('通知酒馆页面刷新角色', ctx.__broadcasts.some(m => m.type === 'character-updated' && m.fields && m.fields.description === '新描述'));
        const n0 = calls.length;
        await TS.syncPersona(b);
        check('推完再检查：两边一致，什么都不做', calls.length === n0, calls.slice(n0));

        // 只有酒馆改了 → 更新小手机
        tav.card.description = '酒馆改的';
        tav.thumbs['avatar|a.png'] = [4, 4];
        await TS.syncPersona(b);
        check('酒馆改了 → 小手机跟着改', char.persona === '酒馆改的\n\n性格：更温柔' && char.avatar === 'data:square:/characters/a.png', [char.persona, char.avatar]);

        // 两边都改了 → 都不动，卡片上让选
        tav.card.description = '酒馆又改';
        char.persona = '小手机又改';
        await TS.syncPersona(b);
        check('两边都改 → 都不动', char.persona === '小手机又改' && tav.card.description === '酒馆又改');
        check('两边都改 → 卡片上列出来', JSON.stringify(TS.personaConflicts(b)) === '["char"]', TS.personaConflicts(b));
        await TS.resolvePersonaConflict(b, 'char', 'phone');
        check('选「用小手机的」→ 推到酒馆、不再列出', tav.card.description === '小手机又改' && TS.personaConflicts(b).length === 0, [tav.card, TS.personaConflicts(b)]);
        tav.card.description = '酒馆三改'; char.persona = '小手机三改';
        await TS.syncPersona(b);
        await TS.resolvePersonaConflict(b, 'char', 'tavern');
        // 上一步「用小手机的」推过去的人设里没有「性格：」，酒馆那一栏已经清空，所以这里只有描述
        check('选「用酒馆的」→ 小手机换成酒馆的', char.persona === '酒馆三改' && tav.card.personality === '' && TS.personaConflicts(b).length === 0, char.persona);

        // 开着酒馆页面：用户人设由酒馆页面自己改
        ctx.BroadcastChannel.prototype.postMessage = function (m) {
            ctx.__broadcasts.push(m);
            if (m.type === 'update-persona') setTimeout(() => ctx.__listeners.forEach(fn => fn({ data: { type: 'page-answer', id: m.id, ok: true } })), 5);
        };
        const sv = calls.filter(c => c[0] === 'settings').length;
        char.myPersona = '我3';
        await TS.syncPersona(b);
        check('开着酒馆页面：托它改人设，不写设置文件', calls.filter(c => c[0] === 'settings').length === sv
            && ctx.__broadcasts.some(m => m.type === 'update-persona' && m.description === '我3' && m.avatarId === 'u1.png'));

        // 世界书：从酒馆导入的「常驻条」、推过去的「推过去的」
        const e0 = TS._normTavernEntry(tav.wb.W.entries[0]);
        const imp = TS.applyTavernEntry({ id: 'i0', tavernSource: { avatar: 'a.png', world: 'W', uid: 0, hash: TS.wbHash(e0), order: 50 } }, e0, 0, true);
        imp.tavernSource.localHash = TS.wbLocalHash(imp);
        const pw = { id: 'p1', name: '推过去的', content: 'C1', keywords: ['x'], alwaysOn: false, position: 'middle', weight: 7 };
        pw.tavernPushes = { W: { uid: 1, hash: TS.wbHash(TS._normTavernEntry(tav.wb.W.entries[1])), localHash: TS.wbPushHash(pw) } };
        ctx.db.worldBooks = [imp, pw];
        imp.content = '小手机改C0';
        let wr = await TS.syncCopiedWorldBooks(b);
        const t0 = tav.wb.W.entries[0];
        check('导入来的条目小手机改了 → 推到酒馆', wr.pushed === 1 && t0.content === '小手机改C0', wr);
        check('推回去不动酒馆的顺序、位置，常驻条目的关键词也留着', t0.order === 50 && t0.position === 4 && JSON.stringify(t0.key) === '["k"]', t0);
        check('推完两边记录一致，再查不动', (await TS.syncCopiedWorldBooks(b)).pushed === 0 && TS.wbEditedLocally(imp) === false);
        tav.wb.W.entries[1].content = '酒馆改C1';
        tav.wb.W.entries[1].order = 9;
        wr = await TS.syncCopiedWorldBooks(b);
        check('推过去的条目酒馆里改了 → 更新小手机，权重跟着顺序，「中」保持', wr.updated === 1 && pw.content === '酒馆改C1' && pw.weight === 9 && pw.position === 'middle', [pw.content, pw.weight, pw.position]);
        pw.weight = 3;
        wr = await TS.syncCopiedWorldBooks(b);
        check('推过去的条目小手机改了权重 → 酒馆顺序跟着改', wr.pushed === 1 && tav.wb.W.entries[1].order === 3 && tav.wb.W.entries[1].position === 1, tav.wb.W.entries[1]);
        pw.content = '小手机改C1'; tav.wb.W.entries[1].content = '酒馆又改C1';
        const wn = calls.filter(c => c[0] === 'wb').length;
        wr = await TS.syncCopiedWorldBooks(b);
        check('两边都改 → 都不动，提示一次', wr.kept === 1 && pw.content === '小手机改C1' && tav.wb.W.entries[1].content === '酒馆又改C1' && calls.filter(c => c[0] === 'wb').length === wn);
        check('「导入酒馆世界书」也认得推过去的条目', TS.findCopiedWorldBook(b, 'W', 1) === pw && TS.copiedLink(pw, 'W', 1).via === 'push');
        await TS.syncSettingsBothWays(b);
        check('离开小手机时的检查能跑', true);
    }

    console.log('24. 改了正则后，已经同步进来的楼层按新规则重新清洗');
    {
        const { ctx, TS, chats, char, b } = setup([
            stFloor('剧情一<status>好感62</status>', false, 20),
            stFloor('剧情二<status>好感63</status>', false, 21),
            stFloor('剧情三<status>好感64</status>', false, 22),
        ]);
        await TS.pullFromTavern(b);
        check('没有规则时原样进来', texts(char).includes('<status>'), texts(char));
        const cards = () => char.history.filter(m => m.fromTavern);
        cards()[1].content = '我在小手机里改的剧情二';
        chats['a.png|A'][3].extra.bbs_leaf = { id: 'l3', delta: {}, text: '摘要三', swipe: 0 };
        await TS.pullFromTavern(b);
        await TS.trimFloors(b, { ids: [cards()[2].id] });
        ctx.db.tavernSync.cleanRules = [{ id: 'x', name: '删状态栏', regex: '<status>[\\s\\S]*?</status>', mode: 'exclude', scope: 'pull', enabled: true }];
        const n = ctx.__issues.length;
        let r = await TS.pullFromTavern(b);
        check('没改过的楼层重新清洗', r.recleaned === 1 && cards()[0].content === '剧情一', [r.recleaned, cards()[0].content]);
        check('小手机里改过的不覆盖、提示一次', cards()[1].content === '我在小手机里改的剧情二' && ctx.__issues.length === n + 1 && ctx.__issues[n].text.includes('没有按新规则重新清洗'), ctx.__issues.slice(n));
        check('精简过的不动', cards().find(m => m.tavern.trimmed).content === '摘要三');
        r = await TS.pullFromTavern(b);
        check('同一次改动只处理一次', r.recleaned === 0 && ctx.__issues.length === n + 1, r);
        ctx.db.tavernSync.cleanRules[0].enabled = false;
        r = await TS.pullFromTavern(b);
        check('关掉规则后又恢复原样', r.recleaned === 1 && cards()[0].content.includes('<status>'), cards()[0].content);
        ctx.db.tavernSync.cleanRules[0].enabled = true;
        ctx.db.tavernSync.cleanRules[0].scope = 'push';
        r = await TS.pullFromTavern(b);
        check('只用在推送的规则不影响同步', r.recleaned === 0 && cards()[0].content.includes('<status>'));
        ctx.db.tavernSync.cleanRules[0].scope = 'pull';
        ctx.db.tavernSync.cleanRules.push({ id: 'y', name: '全删', regex: '[\\s\\S]*', mode: 'exclude', scope: 'pull', enabled: true });
        r = await TS.pullFromTavern(b);
        check('清洗后是空的不动', cards().length === 3 && cards()[0].content.includes('<status>'), texts(char));
        await TS.restoreRawFloors(b, { ids: [cards().find(m => m.tavern.trimmed).id] });
        check('全删规则下取回原文取不到，照旧精简', cards().find(m => m.tavern.floor === 2).tavern.trimmed === true, '全删规则下取回失败，照旧精简');
    }

    console.log('25. 正则分组、导入导出、批量操作');
    {
        const { ctx, TS } = makeEnv();
        ctx.db.tavernSync = { bindings: [], enabled: true, cleanRules: [
            { id: 'r1', name: '甲', regex: 'A', mode: 'exclude', scope: 'both', enabled: true, group: '组1' },
            { id: 'r2', name: '乙', regex: 'B', mode: 'exclude', scope: 'both', enabled: true },
            { id: 'r3', name: '丙', regex: 'C', mode: 'exclude', scope: 'pull', enabled: true, group: '组2' },
            { id: 'r4', name: '丁', regex: 'D', mode: 'exclude', scope: 'both', enabled: true, group: '组1' },
        ] };
        check('起作用的顺序：不分组的在前，各组连在一起', TS.orderedCleanRules().map(r => r.id).join() === 'r2,r1,r4,r3');
        check('规则照常起作用', TS.applyCleanRules('ABCDE', 'pull') === 'E');
        ctx.db.tavernSync.ruleGroupsOff = ['组1'];
        check('整组关掉后组里的规则不起作用', TS.applyCleanRules('ABCDE', 'pull') === 'ADE');
        const all = TS.exportCleanRules(null);
        check('导出全部带上分组和关着的分组', all.rules.length === 4 && all.rules[1].group === '组1' && all.groupsOff.join() === '组1');
        const g2 = TS.exportCleanRules(['r3']);
        check('只导出勾上的', g2.rules.length === 1 && g2.rules[0].name === '丙' && g2.groupsOff.length === 0);
        check('导出按页面上的顺序', TS.exportCleanRules(['r4', 'r2', 'r1']).rules.map(r => r.name).join() === '乙,甲,丁');
        const file = JSON.stringify({ type: 'uwu-tavern-clean-rules', version: 1, groupsOff: ['新组', '组1'], rules: [
            { name: '甲', regex: 'A', mode: 'exclude', scope: 'both', group: '组1' },   // 和现有的重复
            { name: '戊', regex: 'E', mode: 'exclude', scope: 'both', group: '组1' },
            { name: '己', regex: 'F', mode: 'extract', scope: 'push', group: '新组' },
            { name: '己2', regex: 'F', mode: 'extract', scope: 'push' },                // 和文件里前一条重复
            { name: '坏', regex: '(', group: '新组' },
        ] });
        const p = TS.parseCleanRulesFile(file);
        check('读导入文件，写法有错的标出来', p.rules.length === 5 && p.rules[4].invalid === true);
        check('重复的标出来（和现有的、和文件里前面的）', TS.markDuplicateRules(p.rules).join() === 'true,false,false,true,false');
        let bad = '';
        try { TS.parseCleanRulesFile('{"rules":[]}'); } catch (e) { bad = e.message; }
        check('不是酒馆互联导出的文件拦下', bad === '不是酒馆互联导出的正则文件', bad);
        const r = await TS.importCleanRules(p.rules, '__file__', p.groupsOff);
        const cr = ctx.db.tavernSync.cleanRules;
        check('导入：重复的跳过、写法有错的不导', r.added === 2 && r.skipped === 2 && cr.length === 6, r);
        check('照文件里的分组：同名分组放进去，新分组建出来', cr.find(x => x.name === '戊').group === '组1' && cr.find(x => x.name === '己').group === '新组');
        check('文件里关着的新分组导入后关着，已有分组开关不动', ctx.db.tavernSync.ruleGroupsOff.includes('新组') && ctx.db.tavernSync.ruleGroupsOff.includes('组1'));
        const r2 = await TS.importCleanRules([{ name: '庚', regex: 'G', mode: 'exclude', scope: 'both', enabled: true, group: '组1' }], '组2');
        check('指定分组时放进指定的分组', r2.added === 1 && cr.find(x => x.name === '庚').group === '组2');
        check('组2 的规则连在一起', TS.orderedCleanRules().filter(x => x.group === '组2').map(x => x.name).join() === '丙,庚');

        // 批量操作
        const idOf = (name) => cr.find(x => x.name === name).id;
        let n = await TS.batchCleanRules([idOf('甲'), idOf('乙')], 'disable');
        check('批量关闭', n === 2 && !cr.find(x => x.name === '甲').enabled && !cr.find(x => x.name === '乙').enabled);
        n = await TS.batchCleanRules([idOf('甲')], 'enable');
        check('批量开启', n === 1 && ctx.db.tavernSync.cleanRules.find(x => x.name === '甲').enabled);
        n = await TS.batchCleanRules([idOf('丁'), idOf('己')], 'move', '组2');
        check('批量移动：排在目标分组最后，先后不变', n === 2 && TS.orderedCleanRules().filter(x => x.group === '组2').map(x => x.name).join() === '丙,庚,丁,己');
        check('分组移空后开关记录清掉', !ctx.db.tavernSync.ruleGroupsOff.includes('新组'));
        await TS.batchCleanRules([idOf('丙')], 'move', '');
        check('移到不分组', !ctx.db.tavernSync.cleanRules.find(x => x.name === '丙').group);
        n = await TS.batchCleanRules([idOf('甲'), idOf('戊')], 'delete');
        check('批量删除', n === 2 && ctx.db.tavernSync.cleanRules.length === 5 && !TS.ruleGroupsOf().includes('组1') && !ctx.db.tavernSync.ruleGroupsOff.includes('组1'));
    }

    console.log('26. 重写酒馆里小手机那一段时，用原来那一行（不丢「留在酒馆」的、不按新设置改旧的）');
    {
        const { ctx, TS, chats } = makeEnv();
        const msgs = [];
        for (let i = 1; i <= 40; i++) msgs.push({ id: 'm' + i, role: i % 2 ? 'user' : 'assistant', content: `消息${i}\n第二行${i}`, timestamp: i });
        msgs[1].content = '回复2[阿明更新状态为：开心]';
        const char = { id: 'c1', name: 'A', history: msgs };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(2);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoPush: true, firstPushCount: 100, pushIncludeOnlineStatus: true };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        await TS.pushToTavern(b);
        const own = () => chats['a.png|A'].find(m => m.extra && m.extra.uwu_created);
        check('推送时记下每一行多长', own().extra.uwu_line_lens.length === 40 && TS._blockLines(own()).get('m3') === '消息3\n第二行3');
        // 一次少 25 条 → 拦下 → 留在酒馆；再删一条
        const kept = msgs.slice(2, 27).map(m => m.id);
        char.history = msgs.filter(m => !kept.includes(m.id));
        await TS.pushToTavern(b, 0);
        await TS.keepGoneInTavern(b, kept);
        b.pushIncludeOnlineStatus = false;                 // 之后改了推送设置
        char.history = char.history.filter(m => m.id !== 'm40');
        await TS.pushToTavern(b, 0);
        const mes = own().mes;
        check('「留在酒馆」的文字还在', mes.includes('消息3\n第二行3') && mes.includes('消息27\n第二行27'), mes.slice(0, 80));
        check('删掉的那条去掉了', !mes.includes('消息40'));
        check('改设置不回头改旧的行', mes.includes('[阿明更新状态为：开心]'));
        check('长度记录和编号对得上', own().extra.uwu_msg_ids.length === 39 && !!TS._blockLines(own()));
        // 接着推新消息：写进同一楼，记录继续对得上
        char.history.push({ id: 'm41', role: 'user', content: '新的', timestamp: 41 });
        await TS.pushToTavern(b);
        check('接着写进同一楼后记录仍然对得上', TS._blockLines(own()) && TS._blockLines(own()).get('m41') === '新的' && TS._blockLines(own()).get('m3') === '消息3\n第二行3');
        // 通话总结补进去后，记录跟着改
        const call = { id: 'm42', role: 'assistant', content: '[视频通话记录：5分钟；]', callRecordId: 'r1', timestamp: 42 };
        char.history.push(call);
        await TS.pushToTavern(b);
        const oldC = call.content; call.content = '[视频通话记录：5分钟；聊了晚饭]';
        await TS.updatePushedMessage(b, call, oldC);
        check('通话总结补进去后记录跟着改', TS._blockLines(own()) && TS._blockLines(own()).get('m42') === '[视频通话记录：5分钟；聊了晚饭]');
        // 酒馆里有人改了这一段的字 → 记录对不上，退回旧办法，不出错
        own().mes = own().mes.replace('新的', '改过的');
        check('这一段被改过时记录作废', TS._blockLines(own()) === null);
        // 旧楼层（没有长度记录）照旧能删
        const { ctx: c2, TS: T2, chats: ch2 } = makeEnv();
        const m2 = [1, 2, 3].map(i => ({ id: 'x' + i, role: 'user', content: '旧' + i, timestamp: i }));
        const char2 = { id: 'c1', name: 'A', history: m2.slice() };
        c2.db.characters.push(char2);
        ch2['a.png|A'] = [{ chat_metadata: {} }, { name: 'me', is_user: true, send_date: 'x', mes: '<phone_chat>\n旧1\n旧2\n旧3\n</phone_chat>', extra: { from_uwu: true, uwu_created: true, uwu_msg_ids: ['x1', 'x2', 'x3'] } }];
        const b2 = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', autoPush: true };
        c2.db.tavernSync = { bindings: [b2], enabled: true };
        char2.history = m2.filter(m => m.id !== 'x2');
        await T2.pushToTavern(b2, 0);
        check('旧楼层照旧删得掉，之后补上长度记录', ch2['a.png|A'][1].mes === '<phone_chat>\n旧1\n旧3\n</phone_chat>' && !!T2._blockLines(ch2['a.png|A'][1]));
    }

    console.log('27. 重新生成期间自动同步过，放回酒馆卡片时不重复');
    {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = makeChat(10);
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', initialImportCount: 20 };
        ctx.db.tavernSync = { bindings: [b], enabled: true };
        await TS.pullFromTavern(b);
        char.history[char.history.length - 1].tavern.summary = { text: '原来那张的摘要', time: '' };
        const held = char.history.slice(-3);
        char.history = char.history.slice(0, -3);
        const r = await TS.pullFromTavern(b);
        const dropped = TS.putBackFloors(char, held);
        const cards = char.history.filter(m => m.fromTavern);
        check('期间同步重新导入的那份被去掉', r.imported === 3 && dropped === 3 && cards.length === 10, { imported: r.imported, dropped, n: cards.length });
        check('留下的是原来那张', held.every(h => char.history.includes(h)) && cards[9].tavern.summary.text === '原来那张的摘要');
        check('按楼层顺序排好', cards.map(m => m.tavern.floor).join() === '0,1,2,3,4,5,6,7,8,9');
        const r2 = await TS.pullFromTavern(b);
        check('再同步也不多不少', r2.imported === 0 && char.history.filter(m => m.fromTavern).length === 10);
        // 期间没同步：原样放回
        const h2 = char.history.slice(-2);
        char.history = char.history.slice(0, -2);
        check('期间没同步时原样放回', TS.putBackFloors(char, h2) === 0 && char.history.filter(m => m.fromTavern).length === 10);
    }

    console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
