// 酒馆互通补丁 · 随机测试（给 Claude Code 用，维护者不用运行）
// 用法：在 tavern 文件夹里运行  node 测试/随机测试.cjs            （默认跑 100 组 × 60 轮，大约 50 秒；只打印出问题的组）
//                              node 测试/随机测试.cjs 201 200    （从第 201 组开始跑 200 组，想多跑时用）
// 组数不能太少：“精简记号挡住别的楼层”那个问题 200 组里大约 1/5 的组能撞上，只跑 20 组可能一次都撞不上。
// 做法：假酒馆用维护者酒馆真实的时间格式（June 5, 2026 3:27pm，只到分钟），随机地发楼、同一分钟连发、改字、删楼、
//       重新抽卡、番外楼、柏宝书写摘要、小手机发消息/推送（两种推送模式）/删消息、在小手机里改卡片写回、精简/取回原文，
//       每做几步同步一次，自动核对：
//         - 同步后：酒馆里该同步的楼层 = 小手机卡片 + 精简时收走的 user 楼（而且真属于那一回合）；
//                   没精简的卡片内容 = 酒馆正文（去掉小手机那段），精简的 = 柏宝书摘要；没有重复、没有多余；顺序按楼层号
//         - 推送后：同一条小手机消息在酒馆里不出现两次；小手机里删掉的，酒馆里也没有
// 模拟测试.cjs 是一条条想好的情况；这个专门找“好几种操作按特定顺序凑在一起才出问题”的情况
// （2026-09-21 用它找到过：同步后顺序乱、精简记号挡住别的楼层）。
// 发现问题时会打印是哪一组、第几轮、最后做了哪些操作，用同一组号重跑能复现。
const fs = require('fs');
const vm = require('vm');
const path = require('path').join(__dirname, '..', 'tavern_sync.js');

function makeEnv() {
    const chats = {};
    const el = () => ({ style: {}, classList: { add() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        db: { characters: [], worldBooks: [] },
        saveData: async () => {},
        showToast: () => {},
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        document: { getElementById: () => null, createElement: el, head: el(), documentElement: el(), addEventListener() {}, querySelectorAll: () => [] },
        setTimeout, clearTimeout, Promise, Map, Set, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, AbortController,
        BroadcastChannel: class { postMessage() {} addEventListener() {} },
        fetch: async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : {};
            const ok = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) });
            if (url === '/csrf-token') return ok({ token: 't' });
            if (url === '/api/chats/get') return ok(chats[body.avatar_url + '|' + body.file_name] || []);
            if (url === '/api/chats/save') { chats[body.avatar_url + '|' + body.file_name] = JSON.parse(JSON.stringify(body.chat)); return ok({}); }
            if (url === '/api/characters/chats') return ok([]);
            throw new Error('unexpected ' + url);
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path, 'utf8'), ctx, { filename: 'tavern_sync.js' });
    return { ctx, TS: ctx.TavernSync, chats };
}

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const human = (t) => {
    const d = new Date(t);
    let h = d.getHours();
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`;
};

// 一组随机测试（seed 决定这组怎么乱玩，同一个 seed 每次结果一样）。没问题返回 null，有问题返回说明文字
async function runGroup(seed) {
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let clock = Date.UTC(2026, 5, 5, 7, 0);
    let n = 0, pid = 0;
    const mk = (isUser) => {
        clock += rnd() < 0.4 ? 5000 : 60000 * (1 + Math.floor(rnd() * 3));
        n++;
        return { is_user: isUser, mes: (isUser ? 'U' : 'A') + n, send_date: human(clock),
            gen_started: isUser ? undefined : new Date(clock + 1).toISOString(),
            gen_finished: isUser ? undefined : new Date(clock + 2).toISOString(), extra: {} };
    };

    for (let run = 0; run < 60; run++) {
        const { ctx, TS, chats } = makeEnv();
        const char = { id: 'c1', name: 'A', history: [] };
        ctx.db.characters.push(char);
        chats['a.png|A'] = [{ chat_metadata: {} }];
        for (let i = 0; i < 6; i++) chats['a.png|A'].push(mk(i % 2 === 0));
        const b = { uwuCharId: 'c1', stCharAvatar: 'a.png', stChatFile: 'A', initialImportCount: 999, autoPush: true, firstPushCount: 999 };
        const mode = rnd() < 0.5 ? 'append' : 'new';
        ctx.db.tavernSync = { bindings: [b], enabled: true, pushMode: mode };
        const log = [];
        const phoneMsgs = () => char.history.filter(m => !m.fromTavern);
        const fail = (what) => `第 ${run} 轮（推送模式 ${mode}）${what}\n   最后的操作：${log.slice(-25).join(' ')}`;

        for (let step = 0; step < 50; step++) {
            const c = chats['a.png|A'];
            const r = rnd();
            try {
                if (r < 0.18) { c.push(mk(rnd() < 0.5)); log.push('发楼'); }
                else if (r < 0.24 && c.length > 2) {
                    const i = 1 + Math.floor(rnd() * (c.length - 1));
                    if (!c[i].extra.uwu_created) { c[i].mes = c[i].mes.replace(/^([^<]*)/, (all, head) => head + '改'); log.push('改第' + (i - 1) + '楼'); }
                } else if (r < 0.30 && c.length > 3) {
                    const i = 1 + Math.floor(rnd() * (c.length - 1));
                    c.splice(i, 1); log.push('删第' + (i - 1) + '楼');
                } else if (r < 0.34) {
                    // 同一分钟里再发一楼 user（和上一楼同一个发送时间）
                    const prev = c[c.length - 1]; n++;
                    c.push({ is_user: true, mes: 'U' + n, send_date: prev && !prev.extra.uwu_created ? prev.send_date : human(clock), extra: {} });
                    log.push('同分钟连发');
                } else if (r < 0.42) {
                    const ais = c.filter(m => m.mes && !m.is_user && !m.extra.uwu_created);
                    if (ais.length) {
                        const m = ais[Math.floor(rnd() * ais.length)];
                        m.extra.bbs_leaf = { id: 'l' + n, delta: {}, text: '摘' + m.mes.replace(/<[\s\S]*$/, '').trim(), swipe: 0 };
                        log.push('写摘要');
                    }
                } else if (r < 0.50) {
                    clock += 20000; pid++;
                    char.history.push({ id: 'p' + pid, role: rnd() < 0.5 ? 'user' : 'assistant', content: '手机' + pid, timestamp: clock });
                    log.push('小手机发消息');
                } else if (r < 0.56) {
                    await TS.pushToTavern(b); log.push('推送');
                    const ids = c.flatMap(m => (m.extra && m.extra.uwu_msg_ids) || []);
                    const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
                    const phoneIds = new Set(phoneMsgs().map(m => m.id));
                    const ghost = ids.filter(x => !phoneIds.has(x));
                    if (dup.length || ghost.length) return fail(`推送后：酒馆里重复的 ${dup.join(',') || '无'}，小手机删了酒馆还在的 ${ghost.join(',') || '无'}`);
                } else if (r < 0.60) {
                    const ph = phoneMsgs();
                    if (ph.length) {
                        char.history.splice(char.history.indexOf(ph[Math.floor(rnd() * ph.length)]), 1);
                        await TS.pushToTavern(b, 0); log.push('小手机删消息');
                    }
                } else if (r < 0.62) {
                    const last = c[c.length - 1];
                    if (last && !last.is_user && !last.extra.uwu_created) {
                        clock += 3000; n++;
                        Object.assign(last, { mes: 'S' + n, send_date: human(clock), gen_started: new Date(clock).toISOString(), gen_finished: new Date(clock + 1).toISOString() });
                        delete last.extra.bbs_leaf;
                        log.push('重新抽卡');
                    }
                } else if (r < 0.63) {
                    n++; clock += 60000;
                    c.push({ is_user: false, mes: '番外' + n, send_date: human(clock), gen_started: new Date(clock).toISOString(), extra: { bbs_omit: true } });
                    log.push('番外楼');
                } else if (r < 0.645) {
                    const cds = char.history.filter(m => m.fromTavern && !m.tavern.trimmed);
                    if (cds.length) {
                        const cd = cds[Math.floor(rnd() * cds.length)];
                        const old = cd.content;
                        cd.content = old + '机改';
                        const w = await TS.writeBackFloorEdit(b, cd, old);
                        if (!w.ok) cd.content = old;
                        log.push(w.ok ? '小手机改卡片写回' : '写回没成功');
                    }
                } else if (r < 0.66) { await TS.trimFloors(b, { keepLast: Math.floor(rnd() * 4) }); log.push('精简'); }
                else if (r < 0.70) { await TS.restoreRawFloors(b, {}); log.push('取回原文'); }
                else {
                    await TS.pullFromTavern(b); log.push('同步');
                    const problem = checkAfterPull(c, char);
                    if (problem) return fail('同步后：' + problem);
                }
            } catch (e) {
                return fail('出错：' + e.message);
            }
        }
    }
    return null;
}

// 同步后核对小手机卡片和酒馆楼层是否一一对应。没问题返回 null
function checkAfterPull(c, char) {
    const floors = c.slice(1).map((m, i) => ({ m, i })).filter(x => x.m.mes.trim() && !x.m.extra.uwu_created && !x.m.extra.bbs_omit);
    // 酒馆正文：合并进去的小手机内容（最后那段 <phone_chat>）去掉
    const body = (m) => {
        if (!m.extra.from_uwu) return m.mes.trim();
        const k = m.mes.lastIndexOf('<phone_chat>');
        return (k >= 0 ? m.mes.slice(0, k) + m.mes.slice(m.mes.indexOf('</phone_chat>', k) + 13) : m.mes).trim();
    };
    const cards = char.history.filter(m => m.fromTavern);
    // 先后序号和所属回合，按酒馆现在的楼层表自己算一遍
    const nthOf = new Map(), seen = new Map();
    c.slice(1).forEach(m => {
        const k = m.send_date + '|' + (m.is_user ? 1 : 0) + '|' + (m.gen_started || '');
        const v = seen.get(k) || 0; seen.set(k, v + 1); nthOf.set(m, v);
    });
    const roundOf = new Map();
    { let wait = []; c.slice(1).forEach((m, i) => { if (m.extra.bbs_omit) return; if (!m.is_user) { wait.forEach(f => roundOf.set(f, i)); wait = []; } else wait.push(i); }); }
    // 精简时收走的 user 楼：必须由“这一回合的那张已精简 AI 卡片”记着
    const marks = [];
    cards.forEach(cd => (cd.tavern.roundUsers || []).forEach(u => marks.push(Object.assign({ owner: cd }, u))));
    const isHidden = (m, i) => marks.some(u => u.owner.tavern.trimmed && u.owner.tavern.floor === roundOf.get(i)
        && u.sendDate === m.send_date && !!m.is_user === !!u.isUser
        && (u.genStarted === undefined || String(m.gen_started || '') === u.genStarted)
        && (u.nth === undefined || u.nth === nthOf.get(m)));

    const byFloor = new Map();
    for (const cd of cards) {
        if (byFloor.has(cd.tavern.floor)) return `第 ${cd.tavern.floor} 楼有两张卡片`;
        byFloor.set(cd.tavern.floor, cd);
    }
    for (const { m, i } of floors) {
        const cd = byFloor.get(i);
        if (!cd) {
            if (!isHidden(m, i)) return `少了第 ${i} 楼「${m.mes}」\n   酒馆：${c.slice(1).map((x, k) => k + ':' + x.mes.replace(/<[\s\S]*/, '')).join(' ')}`;
            continue;
        }
        const want = cd.tavern.trimmed ? (m.extra.bbs_leaf && m.extra.bbs_leaf.text) : body(m);
        if (cd.content !== want) return `第 ${i} 楼内容不对：小手机「${cd.content}」，酒馆「${want}」${cd.tavern.trimmed ? '（已精简）' : ''}`;
    }
    const valid = new Set(floors.map(x => x.i));
    const extra = cards.find(cd => !valid.has(cd.tavern.floor));
    if (extra) return `多了一张卡片：第 ${extra.tavern.floor} 楼「${extra.content}」`;
    const order = cards.map(cd => cd.tavern.floor);
    if (order.some((f, k) => k && f < order[k - 1])) return `顺序乱了：${order.join(',')}`;
    return null;
}

(async () => {
    const from = parseInt(process.argv[2], 10) || 1;
    const groups = parseInt(process.argv[3], 10) || 100;
    let failed = 0;
    for (let g = from; g < from + groups; g++) {
        const problem = await runGroup(g);
        if (problem) { failed++; console.log(`  FAIL 第 ${g} 组 ${problem}`); }
    }
    console.log(`\n通过 ${groups - failed} 组，失败 ${failed} 组`);
    process.exit(failed ? 1 : 0);
})();
