// 状态栏模板保存与手动整理。没有启动时迁移、自动删除或后台清理。
(function () {
    'use strict';
    const MODES = ['full', 'slim', 'shared'];
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const clone = value => value === undefined ? undefined : structuredClone(value);
    const equal = (a, b) => {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
    };
    const name = chat => chat.remarkName || chat.realName || chat.name || '未命名会话';
    const revision = chat => Number.isSafeInteger(chat?._statusStorageRevision) ? chat._statusStorageRevision : 0;
    const tableFor = type => type === 'group' ? dexieDB.groups : dexieDB.characters;
    const collectionFor = type => type === 'group' ? db.groups : db.characters;
    const findChat = (type, id) => (collectionFor(type) || []).find(chat => chat.id === id);
    const busy = (type, id) => window.ReplyResilience?.hasActive(id, type)
        || (typeof isGenerating !== 'undefined' && isGenerating && currentChatId === id && currentChatType === type);
    const bytes = value => typeof estimateLegacyStorageValue === 'function'
        ? estimateLegacyStorageValue(value) : JSON.stringify(value ?? null).length;
    let running = false;
    let stopRequested = false;
    let activeChatKey = null;
    let writeTail = Promise.resolve();

    // 队列覆盖事务提交、回读核验和页面同步，普通保存不能插入提交后的空档。
    function queueWrite(task) {
        const next = writeTail.then(task);
        writeTail = next.catch(() => {});
        return next;
    }

    function messageIndex(history) {
        const index = new Map();
        for (const message of history || []) if (message?.id) {
            index.set(message.id, index.has(message.id) ? null : message);
        }
        return index;
    }

    // 先移除待清理模板再交给 IndexedDB 克隆，不额外深拷贝整份大快照。
    function statusDraft(chat, rows, stripTemplates = false) {
        const ids = new Set(rows.filter(row => row.kind === 'message').map(row => row.messageId));
        const draft = { ...chat, history: (chat.history || []).map(message => {
            if (!ids.has(message?.id)) return message;
            const snapshot = { ...message.statusSnapshot };
            if (stripTemplates) { delete snapshot.replacePattern; delete snapshot.templateRef; }
            return { ...message, statusSnapshot: snapshot };
        }) };
        if (chat.statusPanel) {
            draft.statusPanel = { ...chat.statusPanel };
            if (Array.isArray(chat.statusPanel.history)) draft.statusPanel.history = [...chat.statusPanel.history];
            if (chat.statusPanel.snapshotTemplates) draft.statusPanel.snapshotTemplates = { ...chat.statusPanel.snapshotTemplates };
        }
        return draft;
    }

    function reductionOf(changes, beforePanel, afterPanel) {
        let reduction = 0;
        for (const change of changes) {
            if (change.kind === 'message') reduction += bytes(change.before) - bytes(change.after);
            if (change.kind === 'history') reduction += bytes(change.removed);
            if (change.kind === 'current') reduction += bytes(change.before) - bytes(change.after) + bytes(change.removed);
        }
        reduction += bytes(beforePanel?.snapshotTemplates || {}) - bytes(afterPanel?.snapshotTemplates || {});
        return Math.max(0, reduction);
    }

    function equalExcept(a, b, ignored) {
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        const keys = Object.keys(a).filter(key => !ignored.includes(key));
        return keys.length === Object.keys(b).filter(key => !ignored.includes(key)).length
            && keys.every(key => own(b, key) && equal(a[key], b[key]));
    }

    // 只自动同步纯模板删除：正文、顺序、关联信息、配置有任何其他差异仍拒绝覆盖。
    function templateCleanupPatch(record, disk) {
        if (revision(disk) <= revision(record)
            || !equalExcept(record, disk, ['history', '_statusStorageRevision'])
            || !Array.isArray(record.history) || !Array.isArray(disk.history)
            || record.history.length !== disk.history.length) return null;
        const patches = [];
        for (let index = 0; index < record.history.length; index++) {
            const before = record.history[index], after = disk.history[index];
            if (!equalExcept(before, after, ['statusSnapshot'])) return null;
            if (equal(before.statusSnapshot, after.statusSnapshot)) continue;
            if (!before.statusSnapshot || !after.statusSnapshot
                || own(after.statusSnapshot, 'replacePattern') || own(after.statusSnapshot, 'templateRef')
                || !equalExcept(before.statusSnapshot, after.statusSnapshot, ['replacePattern', 'templateRef'])) return null;
            patches.push({ index, snapshot: { ...after.statusSnapshot } });
        }
        return patches.length ? patches : null;
    }

    function applyTemplatePatch(record, disk, patches) {
        for (const patch of patches) {
            const snapshot = { ...record.history[patch.index].statusSnapshot };
            delete snapshot.replacePattern; delete snapshot.templateRef;
            record.history[patch.index].statusSnapshot = snapshot;
        }
        record._statusStorageRevision = revision(disk);
    }

    function policy(chat) {
        const local = chat.statusPanel?.snapshotStorageMode;
        const global = db.statusStorageSettings?.mode;
        return MODES.includes(local) ? local : MODES.includes(global) ? global : 'full';
    }

    function intern(panel, template) {
        if (typeof template !== 'string') throw new Error('模板内容异常，未处理');
        if (panel.snapshotTemplates && (typeof panel.snapshotTemplates !== 'object' || Array.isArray(panel.snapshotTemplates))) throw new Error('共享模板库异常，未处理');
        const pool = panel.snapshotTemplates || (panel.snapshotTemplates = {});
        for (const key of Object.keys(pool)) if (pool[key] === template) return key;
        // 内容逐字比较，标识只用于引用，不以哈希相同判定模板相同。
        let hash = 2166136261;
        for (let index = 0; index < template.length; index++) hash = Math.imul(hash ^ template.charCodeAt(index), 16777619);
        const base = 'tpl_' + (hash >>> 0).toString(36);
        let key = base, suffix = 0;
        while (own(pool, key)) key = base + '_' + (++suffix);
        pool[key] = template;
        return key;
    }

    function templateOf(chat, snapshot) {
        if (typeof snapshot?.replacePattern === 'string') return snapshot.replacePattern;
        const pool = chat.statusPanel?.snapshotTemplates;
        return typeof snapshot?.templateRef === 'string' && own(pool, snapshot.templateRef)
            && typeof pool[snapshot.templateRef] === 'string' ? pool[snapshot.templateRef] : undefined;
    }

    function makeSnapshot(chat, regex, oldRaw, existing) {
        const editing = existing !== undefined;
        const preserve = editing && !chat.statusPanel?.compactEditedSnapshots;
        const mode = preserve ? (own(existing, 'templateRef') ? 'shared' : own(existing, 'replacePattern') ? 'full' : 'slim') : policy(chat);
        const snapshot = { ...(editing ? existing : {}), regex };
        delete snapshot.replacePattern; delete snapshot.templateRef;
        if (oldRaw !== undefined) snapshot.oldRaw = oldRaw;
        if (mode === 'full') snapshot.replacePattern = chat.statusPanel.replacePattern;
        if (mode === 'shared') snapshot.templateRef = intern(chat.statusPanel, chat.statusPanel.replacePattern || '');
        return snapshot;
    }

    function referencedTemplates(chat) {
        const refs = new Set();
        const stack = [chat];
        const seen = new Set();
        while (stack.length) {
            const item = stack.pop();
            if (!item || typeof item !== 'object' || seen.has(item)) continue;
            seen.add(item);
            if (typeof item.templateRef === 'string') refs.add(item.templateRef);
            for (const [key, value] of Object.entries(item)) if (key !== 'snapshotTemplates') stack.push(value);
        }
        return refs;
    }

    async function scan(onProgress, signal, { persisted = false } = {}) {
        if (persisted) await writeTail;
        const rows = [];
        const issues = [];
        const stats = { snapshots: 0, templates: 0, metadata: 0, display: 0, current: 0, shared: 0 };
        let count = 0;
        for (const [chats, type] of [[db.characters || [], 'private'], [db.groups || [], 'group']]) {
            for (const local of chats) {
                if (signal?.aborted) throw new Error('检测已取消');
                const chat = persisted ? await tableFor(type).get(local.id) : local;
                if (!chat) { issues.push(`${name(local)}：数据库中没有此会话，未列为清理项`); continue; }
                if (persisted && revision(local) !== revision(chat)) {
                    const patches = templateCleanupPatch(local, chat);
                    if (patches) applyTemplatePatch(local, chat, patches);
                    else issues.push(`${name(local)}：页面与数据库版本不一致，已按数据库统计；请保留未保存内容后重新载入再处理`);
                }
                const base = { chatId: chat.id, type, name: name(chat), rev: revision(chat) };
                const history = Array.isArray(chat.history) ? chat.history : [];
                const ids = new Map();
                for (const message of history) if (message?.id) ids.set(message.id, (ids.get(message.id) || 0) + 1);
                for (let index = 0; index < history.length; index++) {
                    const message = history[index];
                    const snapshot = message?.statusSnapshot;
                    if (!snapshot) continue;
                    stats.snapshots += bytes(snapshot);
                    const template = templateOf(chat, snapshot);
                    stats.templates += typeof snapshot.replacePattern === 'string' ? bytes(snapshot.replacePattern) : 0;
                    const metadata = { ...snapshot }; delete metadata.replacePattern; delete metadata.templateRef;
                    stats.metadata += bytes(metadata);
                    if (typeof snapshot.regex !== 'string' || typeof snapshot !== 'object'
                        || Object.values(snapshot).some(value => value && typeof value === 'object')
                        || (own(snapshot, 'replacePattern') && typeof snapshot.replacePattern !== 'string')
                        || (own(snapshot, 'templateRef') && template === undefined)
                        || (own(snapshot, 'templateRef') && own(snapshot, 'replacePattern'))) {
                        issues.push(`${base.name} · 第 ${index + 1} 条：快照结构或模板引用异常，跳过`);
                    } else if (template !== undefined) {
                        if (!message.id || ids.get(message.id) !== 1) issues.push(`${base.name} · 第 ${index + 1} 条：消息标识缺失或重复，跳过`);
                        else rows.push({ ...base, key: JSON.stringify([type, chat.id, 'message', message.id]), kind: 'message',
                            messageId: message.id, index, timestamp: message.timestamp, size: bytes(snapshot), template,
                            source: { snapshot: { ...snapshot }, content: message.content, timestamp: message.timestamp },
                            label: `第 ${index + 1} 条 · ${String(message.content || '').slice(0, 65)}` });
                    }
                    if (++count % 200 === 0) {
                        if (signal?.aborted) throw new Error('检测已取消');
                        onProgress?.(count); await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
                const panel = chat.statusPanel;
                if (!panel) continue;
                if (panel.history && !Array.isArray(panel.history)) issues.push(`${base.name}：展示历史结构异常，跳过历史整理`);
                for (const [index, item] of (Array.isArray(panel.history) ? panel.history : []).entries()) {
                    if (!item || typeof item.raw !== 'string' || typeof item.html !== 'string') { issues.push(`${base.name}：第 ${index + 1} 条展示历史异常，跳过`); continue; }
                    stats.display += bytes(item);
                    // 当前状态对应的记录不能随历史全选被删。
                    const protectedCurrent = item.html === panel.currentStatusHtml && item.raw === panel.currentStatusRaw;
                    if (!protectedCurrent) rows.push({ ...base, key: JSON.stringify([type, chat.id, 'history', index]), kind: 'history',
                        index, timestamp: item.timestamp, size: bytes(item), source: { ...item }, label: String(item.raw || '历史状态').slice(0, 65) });
                }
                stats.current += bytes(panel.currentStatusHtml || '') + bytes(panel.currentStatusRaw || '');
                if ((panel.currentStatusHtml || panel.currentStatusRaw) && (!panel.history || Array.isArray(panel.history))) rows.push({ ...base, key: JSON.stringify([type, chat.id, 'current']),
                    kind: 'current', timestamp: 0, size: bytes(panel.currentStatusHtml || '') + bytes(panel.currentStatusRaw || ''),
                    source: { raw: panel.currentStatusRaw || '', html: panel.currentStatusHtml || '' }, label: '清空当前状态（包括对应展示记录）' });
                const refs = referencedTemplates(chat);
                if (panel.snapshotTemplates && (typeof panel.snapshotTemplates !== 'object' || Array.isArray(panel.snapshotTemplates))) {
                    issues.push(`${base.name}：共享模板库异常，跳过模板库整理`); continue;
                }
                for (const [key, template] of Object.entries(panel.snapshotTemplates || {})) {
                    stats.shared += bytes(template);
                    if (typeof template !== 'string' || ['__proto__','constructor','prototype'].includes(key)) { issues.push(`${base.name}：共享模板结构异常，跳过`); continue; }
                    if (!refs.has(key)) rows.push({ ...base, key: JSON.stringify([type, chat.id, 'orphan', key]), kind: 'orphan',
                        templateId: key, timestamp: 0, size: bytes(template), source: template, label: '无消息引用的共享模板' });
                }
            }
        }
        if (signal?.aborted) throw new Error('检测已取消');
        const frequencies = new Map();
        for (const row of rows) if (row.kind === 'message') {
            const key = JSON.stringify([row.type, row.chatId]);
            if (!frequencies.has(key)) frequencies.set(key, new Map());
            const templates = frequencies.get(key);
            templates.set(row.template, (templates.get(row.template) || 0) + 1);
        }
        for (const row of rows) row.duplicate = row.kind === 'message'
            && frequencies.get(JSON.stringify([row.type, row.chatId])).get(row.template) > 1;
        return { rows, issues, stats };
    }

    function buildPlan(rows, action) {
        if (!['slim', 'shared', 'history', 'current', 'orphan'].includes(action)) throw new Error('未知整理操作');
        const expectedKind = ['slim', 'shared'].includes(action) ? 'message' : action;
        if (rows.some(row => row.kind !== expectedKind)) throw new Error('选择项与操作不匹配');
        const groups = new Map();
        let reduction = 0;
        for (const row of rows) {
            const key = JSON.stringify([row.type, row.chatId]);
            if (!groups.has(key)) {
                const chat = findChat(row.type, row.chatId);
                if (!chat) throw new Error('会话不存在，请重新检测');
                if (row.rev !== undefined && row.rev !== revision(chat)) throw new Error(`${row.name} 的页面版本已过期，请保留未保存内容后重新载入再检测`);
                groups.set(key, { type: row.type, chatId: row.chatId, name: row.name, rev: revision(chat), rows: [],
                    panelBefore: clone({ history: chat.statusPanel?.history || [], currentStatusRaw: chat.statusPanel?.currentStatusRaw || '',
                        currentStatusHtml: chat.statusPanel?.currentStatusHtml || '', snapshotTemplates: chat.statusPanel?.snapshotTemplates || {} }) });
            }
            groups.get(key).rows.push(row);
        }
        for (const group of groups.values()) {
            const draft = { history: [], statusPanel: clone(group.panelBefore) };
            const backup = [];
            for (const row of group.rows) {
                if (row.kind === 'message') draft.history.push({ id: row.messageId, content: row.source.content,
                    timestamp: row.timestamp, statusSnapshot: { ...row.source.snapshot } });
            }
            applyRows(draft, group.rows, action, backup);
            reduction += reductionOf(backup, group.panelBefore, draft.statusPanel);
        }
        return { id: 'status_' + Date.now() + '_' + Math.random().toString(36).slice(2), createdAt: Date.now(),
            action, groups: [...groups.values()], count: rows.length, reduction };
    }

    function assertRows(chat, group) {
        if (revision(chat) !== group.rev) throw new Error('整理后数据已变化，请重新预览');
        const messages = messageIndex(chat.history);
        for (const row of group.rows) {
            if (row.kind === 'message') {
                const message = messages.get(row.messageId);
                if (!message || message.content !== row.source.content || message.timestamp !== row.source.timestamp
                    || !equal(message.statusSnapshot, row.source.snapshot)) throw new Error('所选消息已变化，请重新检测和预览');
                if (templateOf(chat, message.statusSnapshot) !== row.template) throw new Error('模板已变化，请重新预览');
            } else if (row.kind === 'history') {
                if (!equal(chat.statusPanel?.history || [], group.panelBefore.history)
                    || (chat.statusPanel.currentStatusRaw || '') !== group.panelBefore.currentStatusRaw
                    || (chat.statusPanel.currentStatusHtml || '') !== group.panelBefore.currentStatusHtml) throw new Error('状态展示历史已变化，请重新预览');
            } else if (row.kind === 'current') {
                if ((chat.statusPanel?.currentStatusRaw || '') !== row.source.raw || (chat.statusPanel?.currentStatusHtml || '') !== row.source.html
                    || !equal(chat.statusPanel?.history || [], group.panelBefore.history)) throw new Error('当前状态已变化，请重新预览');
            } else if (chat.statusPanel?.snapshotTemplates?.[row.templateId] !== row.source || referencedTemplates(chat).has(row.templateId)) {
                throw new Error('共享模板已变化或已被引用，请重新预览');
            }
        }
    }

    function applyRows(chat, rows, action, changes) {
        const panel = chat.statusPanel || (action === 'shared' ? (chat.statusPanel = {}) : {});
        const historyIndices = new Set();
        const messages = messageIndex(chat.history);
        for (const row of rows) {
            if (row.kind === 'message') {
                const message = messages.get(row.messageId);
                const before = { ...message.statusSnapshot };
                const template = templateOf(chat, before);
                const after = { ...before };
                delete after.replacePattern; delete after.templateRef;
                if (action === 'shared') after.templateRef = intern(panel, template);
                message.statusSnapshot = after;
                changes.push({ kind: 'message', messageId: message.id, content: message.content, timestamp: message.timestamp,
                    before, after, template });
            } else if (row.kind === 'history') historyIndices.add(row.index);
            else if (row.kind === 'current') {
                const before = { raw: panel.currentStatusRaw || '', html: panel.currentStatusHtml || '' };
                const removed = (panel.history || []).filter(item => item.raw === before.raw && item.html === before.html);
                panel.history = (panel.history || []).filter(item => !removed.includes(item));
                panel.currentStatusRaw = ''; panel.currentStatusHtml = '';
                changes.push({ kind: 'current', before, after: { raw: '', html: '' }, removed,
                    restoreCounts: removed.map(item => removed.filter(other => equal(other, item)).length) });
            } else if (row.kind === 'orphan') {
                changes.push({ kind: 'orphan', templateId: row.templateId, template: panel.snapshotTemplates[row.templateId] });
                delete panel.snapshotTemplates[row.templateId];
            }
        }
        if (historyIndices.size) {
            const removed = panel.history.filter((_, index) => historyIndices.has(index));
            const restoreCounts = removed.map(item => panel.history.filter(other => equal(other, item)).length);
            panel.history = panel.history.filter((_, index) => !historyIndices.has(index));
            changes.push({ kind: 'history', removed, restoreCounts });
        }
    }

    function publishChanges(source, draft, changes) {
        // 提交后只更新所选字段，不用整份旧历史覆盖提交期间新增的消息。
        const messages = messageIndex(source.history);
        for (const change of changes) {
            if (change.kind === 'message') {
                const message = messages.get(change.messageId);
                if (!message) continue;
                const slim = !own(change.after, 'replacePattern') && !own(change.after, 'templateRef');
                if (!slim && !equal(message.statusSnapshot, change.before)) throw new Error('模板在提交期间发生变化，已保留页面内容，请重新载入核对');
                // 精简只删除模板字段，保留提交期间更新的正则和编辑关联信息。
                const after = slim ? { ...message.statusSnapshot } : { ...change.after };
                if (slim) { delete after.replacePattern; delete after.templateRef; }
                if (own(after, 'templateRef')) {
                    source.statusPanel ||= {};
                    after.templateRef = intern(source.statusPanel, change.template);
                }
                message.statusSnapshot = after;
            } else if (change.kind === 'history') {
                for (const item of change.removed) {
                    const index = source.statusPanel.history.findIndex(existing => equal(existing, item));
                    if (index >= 0) source.statusPanel.history.splice(index, 1);
                }
            } else if (change.kind === 'current') {
                if ((source.statusPanel.currentStatusRaw || '') !== change.before.raw || (source.statusPanel.currentStatusHtml || '') !== change.before.html) continue;
                source.statusPanel.currentStatusRaw = ''; source.statusPanel.currentStatusHtml = '';
                for (const item of change.removed) {
                    const index = source.statusPanel.history.findIndex(existing => equal(existing, item));
                    if (index >= 0) source.statusPanel.history.splice(index, 1);
                }
            } else if (!referencedTemplates(source).has(change.templateId)) delete source.statusPanel.snapshotTemplates[change.templateId];
        }
        source._statusStorageRevision = draft._statusStorageRevision;
    }

    // 所有普通角色写入也检查整理修订号，防止其他标签页旧副本写回已删除字段。
    async function persistChats(table, records) {
        const write = async () => {
            const synced = [];
            await dexieDB.transaction('rw', table, async () => {
                const prepared = [];
                for (const record of records) {
                    const disk = await table.get(record.id);
                    if (disk && revision(disk) !== revision(record)) {
                        const patches = templateCleanupPatch(record, disk);
                        if (!patches) throw new Error(`${name(record)}：该会话在其他页面完成了状态栏整理。请先导出当前未保存内容，再重新载入页面，避免覆盖整理结果。`);
                        const updated = { ...record, history: record.history.map(message => ({ ...message })), _statusStorageRevision: revision(disk) };
                        applyTemplatePatch(updated, disk, patches);
                        prepared.push(updated); synced.push({ record, disk, patches });
                    } else prepared.push(record);
                }
                await table.bulkPut(prepared);
            });
            for (const { record, disk, patches } of synced) applyTemplatePatch(record, disk, patches);
        };
        // 钱包等调用可能已在 Dexie 事务中；此时数据库自身排队，不能等待持锁事务后的队列。
        if (typeof Dexie !== 'undefined' && Dexie.currentTransaction) return write();
        return queueWrite(write);
    }

    function verifyChanges(saved, draft, changes) {
        if (!saved || revision(saved) !== revision(draft)) throw new Error('数据库回读版本核验失败，未确认清理成功');
        const messages = messageIndex(saved.history);
        for (const change of changes) {
            if (change.kind === 'message') {
                const message = messages.get(change.messageId);
                if (!message || message.content !== change.content || message.timestamp !== change.timestamp
                    || !equal(message.statusSnapshot, change.after)
                    || (own(change.after, 'templateRef') && templateOf(saved, message.statusSnapshot) !== change.template)) {
                    throw new Error('数据库回读发现所选消息模板未正确整理，未确认清理成功');
                }
            } else if (change.kind === 'history' || change.kind === 'current') {
                if (!equal(saved.statusPanel?.history, draft.statusPanel?.history)
                    || (saved.statusPanel?.currentStatusRaw || '') !== (draft.statusPanel?.currentStatusRaw || '')
                    || (saved.statusPanel?.currentStatusHtml || '') !== (draft.statusPanel?.currentStatusHtml || '')) {
                    throw new Error('数据库回读状态历史核验失败，未确认清理成功');
                }
            } else if (own(saved.statusPanel?.snapshotTemplates, change.templateId)) throw new Error('数据库回读共享模板核验失败，未确认清理成功');
        }
    }

    async function persistSetting(value) {
        return dexieDB.transaction('rw', dexieDB.globalSettings, async () => {
            const disk = await dexieDB.globalSettings.get('statusStorageSettings');
            if ((disk?.value?.revision || 0) !== (value?.revision || 0)) throw new Error('其他页面已更新状态栏保存设置，请重新载入后再保存，避免覆盖新设置');
            await dexieDB.globalSettings.put({ key: 'statusStorageSettings', value });
        });
    }

    async function validate(plan) {
        for (const group of plan.groups) {
            const chat = findChat(group.type, group.chatId);
            if (!chat) throw new Error('会话已删除，请重新检测');
            if (busy(group.type, group.chatId)) throw new Error(`${group.name} 正在生成回复，请等待回复完成再整理`);
            assertRows(chat, group);
            const disk = await tableFor(group.type).get(group.chatId);
            if (!disk) throw new Error('会话尚未保存或已在其他页面删除，请先核对数据');
            if (disk && revision(disk) !== revision(chat)) throw new Error('其他页面已整理此会话，请重新载入后检测');
        }
    }

    function recoveryArchive(plan) {
        const groups = plan.groups.map(group => {
            const draft = { history: group.rows.filter(row => row.kind === 'message').map(row => ({ id: row.messageId,
                content: row.source.content, timestamp: row.timestamp, statusSnapshot: { ...row.source.snapshot } })),
                statusPanel: clone(group.panelBefore) };
            const changes = [];
            applyRows(draft, group.rows, plan.action, changes);
            return { type: group.type, chatId: group.chatId, name: group.name, changes };
        });
        return { format: 'ovo-status-recovery', formatRevision: 1, operationId: plan.id, createdAt: plan.createdAt, groups };
    }

    async function run(plan, onProgress) {
        if (running) throw new Error('已有状态栏操作正在执行');
        running = true; stopRequested = false;
        const result = { id: plan.id, action: plan.action, startedAt: Date.now(), completed: [], failed: [], pending: plan.groups.map(group => group.name), stopped: false };
        try {
            await validate(plan);
            for (let index = 0; index < plan.groups.length; index++) {
                const group = plan.groups[index];
                if (stopRequested) { result.stopped = true; result.pending = plan.groups.slice(index).map(item => item.name); break; }
                onProgress?.(index, plan.groups.length, group.name);
                activeChatKey = JSON.stringify([group.type, group.chatId]);
                let committed = false;
                try {
                    await queueWrite(async () => {
                        if (busy(group.type, group.chatId)) throw new Error('会话正在生成回复，未处理');
                        const table = tableFor(group.type);
                        const source = findChat(group.type, group.chatId);
                        if (!source) throw new Error('会话不存在');
                        assertRows(source, group);
                        const baseline = clone(statusDraft(source, group.rows, true));
                        const diskBefore = await table.get(group.chatId);
                        if (!diskBefore) throw new Error('数据库中找不到会话，未处理');
                        if (revision(diskBefore) !== revision(source)) throw new Error('其他页面数据已变化，请重新载入');
                        const draft = statusDraft(source, group.rows);
                        const changes = [];
                        applyRows(draft, group.rows, plan.action, changes);
                        draft._statusStorageRevision = revision(source) + 1;
                        const item = { name: group.name, type: group.type, chatId: group.chatId, count: group.rows.length,
                            reduction: reductionOf(changes, source.statusPanel, draft.statusPanel), verified: false };
                        const nextResult = { ...result, completed: [...result.completed, item], pending: plan.groups.slice(index + 1).map(entry => entry.name) };
                        await dexieDB.transaction('rw', table, dexieDB.globalSettings, async () => {
                            const disk = await table.get(group.chatId);
                            assertRows(source, group);
                            if (!equal(disk, diskBefore) || !equal(statusDraft(source, group.rows, true), baseline)
                                || findChat(group.type, group.chatId) !== source || busy(group.type, group.chatId)) {
                                throw new Error('会话在执行前发生变化，未处理，请重新预览');
                            }
                            await table.put(draft);
                            verifyChanges(await table.get(group.chatId), draft, changes);
                            await dexieDB.globalSettings.put({ key: '_statusStorageLastRun', value: nextResult });
                        });
                        committed = true;
                        // 事务结束后再读取一次；只有提交后的记录通过核验才同步页面并计入完成。
                        verifyChanges(await table.get(group.chatId), draft, changes);
                        if (findChat(group.type, group.chatId) !== source) throw new Error('会话在提交期间重新载入，清理已提交，请重新检测核对');
                        publishChanges(source, draft, changes);
                        item.verified = true;
                        result.completed.push(item);
                        result.pending = nextResult.pending;
                        window.ChatTokenStats?.changed(group.chatId, group.type);
                    });
                } catch (error) {
                    result.failed.push({ name: group.name, type: group.type, chatId: group.chatId, committed,
                        reason: (committed ? '写入已提交，但未完成核验或页面同步：' : '') + error.message });
                    result.pending = plan.groups.slice(index + 1).map(item => item.name);
                    break;
                } finally { activeChatKey = null; }
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            result.finishedAt = Date.now();
            try { await dexieDB.globalSettings.put({ key: '_statusStorageLastRun', value: result }); }
            catch (error) { result.failed.push({ name: '操作记录', reason: '最终报告保存失败：' + error.message + '。请核对以上已完成项目。' }); }
            return result;
        } finally { running = false; activeChatKey = null; }
    }

    function validateArchive(archive) {
        if (archive?.format !== 'ovo-status-recovery' || archive.formatRevision !== 1 || !Array.isArray(archive.groups)) throw new Error('不是支持的状态栏恢复备份');
        const seen = new Set();
        for (const group of archive.groups) {
            const key = JSON.stringify([group.type, group.chatId]);
            if (!['private', 'group'].includes(group.type) || typeof group.chatId !== 'string' || !Array.isArray(group.changes) || seen.has(key)) throw new Error('恢复备份的会话信息异常');
            seen.add(key);
            for (const change of group.changes) {
                if (!['message', 'history', 'current', 'orphan'].includes(change.kind)) throw new Error('恢复备份包含未知操作');
                if (change.kind === 'message' && (typeof change.messageId !== 'string' || typeof change.before?.regex !== 'string'
                    || !change.after || typeof change.template !== 'string')) throw new Error('恢复备份的消息信息异常');
                if (['history', 'current'].includes(change.kind) && !Array.isArray(change.removed)) throw new Error('恢复备份的历史信息异常');
                if (change.removed?.some(item => !item || typeof item.raw !== 'string' || typeof item.html !== 'string')) throw new Error('恢复备份包含异常展示记录');
                if (change.restoreCounts && (!Array.isArray(change.restoreCounts) || change.restoreCounts.length !== change.removed?.length
                    || change.restoreCounts.some(count => !Number.isSafeInteger(count) || count < 1))) throw new Error('恢复备份的历史数量信息异常');
                if (change.kind === 'current' && (typeof change.before?.raw !== 'string' || typeof change.before?.html !== 'string')) throw new Error('恢复备份的当前状态信息异常');
                if (change.kind === 'orphan' && (typeof change.templateId !== 'string' || typeof change.template !== 'string'
                    || ['__proto__', 'constructor', 'prototype'].includes(change.templateId))) throw new Error('恢复备份的模板信息异常');
            }
        }
        return archive;
    }

    function mergeRemoved(panel, change) {
        const items = panel.history || (panel.history = []);
        let added = 0;
        for (let index = 0; index < change.removed.length; index++) {
            const item = change.removed[index];
            const expected = change.restoreCounts?.[index] || change.removed.filter(other => equal(other, item)).length;
            let count = items.filter(existing => equal(existing, item)).length;
            while (count++ < expected) { items.push(clone(item)); added++; }
        }
        items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return added;
    }

    function restoreChange(chat, change, force) {
        const panel = chat.statusPanel || (chat.statusPanel = {});
        if (change.kind === 'message') {
            const matches = (chat.history || []).filter(item => item.id === change.messageId);
            if (matches.length !== 1) return '消息已删除或标识重复，无法恢复';
            const message = matches[0];
            if (equal(message.statusSnapshot, change.before)) return '已经恢复';
            if (!force && (message.content !== change.content || message.timestamp !== change.timestamp || !equal(message.statusSnapshot, change.after))) return '消息已修改，需要明确选择覆盖状态字段';
            const snapshot = clone(change.before);
            if (own(snapshot, 'templateRef')) snapshot.templateRef = intern(panel, change.template);
            message.statusSnapshot = snapshot;
        } else if (change.kind === 'history') {
            if (!mergeRemoved(panel, change)) return '已经恢复';
        } else if (change.kind === 'current') {
            if ((panel.currentStatusRaw || '') === change.before.raw && (panel.currentStatusHtml || '') === change.before.html) {
                if (!mergeRemoved(panel, change)) return '已经恢复';
                return null;
            }
            if (!force && ((panel.currentStatusRaw || '') !== '' || (panel.currentStatusHtml || '') !== '')) return '当前已有状态，需要明确选择覆盖当前状态';
            panel.currentStatusRaw = change.before.raw; panel.currentStatusHtml = change.before.html;
            mergeRemoved(panel, change);
        } else {
            const pool = panel.snapshotTemplates || (panel.snapshotTemplates = {});
            if (pool[change.templateId] === change.template) return '已经恢复';
            if (own(pool, change.templateId) && pool[change.templateId] !== change.template) return '模板标识冲突，未覆盖';
            pool[change.templateId] = change.template;
        }
        return null;
    }

    function previewRestore(archive, selected, force = false) {
        validateArchive(archive);
        const conflicts = []; let restorable = 0;
        for (const group of archive.groups) {
            if (selected && !selected.has(JSON.stringify([group.type, group.chatId]))) continue;
            const chat = findChat(group.type, group.chatId);
            if (!chat) { conflicts.push(`${group.name}：会话已删除，无法恢复`); continue; }
            const draft = clone(chat);
            for (const change of group.changes) {
                const reason = restoreChange(draft, change, force);
                if (reason) conflicts.push(`${group.name}：${reason}`); else restorable++;
            }
        }
        return { restorable, conflicts };
    }

    async function restore(archive, selected, force, onProgress) {
        validateArchive(archive);
        if (running) throw new Error('已有状态栏操作正在执行');
        running = true; stopRequested = false;
        const result = { id: archive.operationId + '_restore_' + Date.now(), action: 'restore', startedAt: Date.now(), completed: [], conflicts: [], failed: [], pending: [] };
        try {
            const groups = archive.groups.filter(group => selected.has(JSON.stringify([group.type, group.chatId])));
            result.pending = groups.map(group => group.name);
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index];
                if (stopRequested) { result.pending = groups.slice(index).map(item => item.name); break; }
                const source = findChat(group.type, group.chatId);
                result.pending = groups.slice(index + 1).map(item => item.name);
                if (!source) { result.conflicts.push(`${group.name}：会话已删除`); continue; }
                if (busy(group.type, group.chatId)) { result.conflicts.push(`${group.name}：正在生成回复`); continue; }
                activeChatKey = JSON.stringify([group.type, group.chatId]);
                onProgress?.(index, groups.length, group.name);
                const draft = clone(source), serialized = JSON.stringify(source);
                let restored = 0; const applied = [];
                for (const change of group.changes) {
                    const reason = restoreChange(draft, change, force);
                    if (reason) result.conflicts.push(`${group.name}：${reason}`); else { restored++; applied.push(change); }
                }
                if (!restored) continue;
                draft._statusStorageRevision = revision(source) + 1;
                try {
                    const table = tableFor(group.type);
                    const item = { name: group.name, count: restored };
                    await dexieDB.transaction('rw', table, dexieDB.globalSettings, async () => {
                        const disk = await table.get(group.chatId);
                        if (!disk || revision(disk) !== revision(source) || JSON.stringify(source) !== serialized || busy(group.type, group.chatId)) throw new Error('会话发生变化或已删除，请重新预览');
                        await table.put(draft);
                        await dexieDB.globalSettings.put({ key: '_statusStorageLastRun', value: { ...result, completed: [...result.completed, item] } });
                    });
                    for (const change of applied) restoreChange(source, change, force);
                    source._statusStorageRevision = draft._statusStorageRevision;
                    result.completed.push(item);
                    window.ChatTokenStats?.changed(group.chatId, group.type);
                } catch (error) { result.failed.push({ name: group.name, reason: error.message }); result.pending = groups.slice(index + 1).map(item => item.name); break; }
            }
            result.finishedAt = Date.now();
            try { await dexieDB.globalSettings.put({ key: '_statusStorageLastRun', value: result }); }
            catch (error) { result.failed.push({ name: '操作记录', reason: '最终报告保存失败：' + error.message + '。请核对以上已完成项目。' }); }
            return result;
        } finally { running = false; activeChatKey = null; }
    }

    async function setPolicies(mode, chatIds, global, compactEdited) {
        if (mode !== 'inherit' && !MODES.includes(mode)) throw new Error('未知保存方式');
        if (global && mode === 'inherit') throw new Error('全局默认需要指定具体保存方式');
        if (running) throw new Error('请等待整理操作完成');
        const drafts = [], sources = [], serialized = [];
        for (const id of chatIds) {
            const chat = findChat('private', id);
            if (!chat) continue;
            if (busy('private', id)) throw new Error(`${name(chat)} 正在生成回复，请稍后设置`);
            const draft = clone(chat); draft.statusPanel ||= {};
            if (mode === 'inherit') delete draft.statusPanel.snapshotStorageMode;
            else draft.statusPanel.snapshotStorageMode = mode;
            if (compactEdited !== undefined) draft.statusPanel.compactEditedSnapshots = compactEdited;
            draft._statusStorageRevision = revision(chat) + 1;
            drafts.push(draft); sources.push(chat); serialized.push(JSON.stringify(chat));
        }
        const settings = { ...(db.statusStorageSettings || {}), mode, revision: (db.statusStorageSettings?.revision || 0) + 1 };
        await dexieDB.transaction('rw', dexieDB.characters, dexieDB.globalSettings, async () => {
            for (let index = 0; index < drafts.length; index++) {
                const disk = await dexieDB.characters.get(drafts[index].id);
                if ((disk && revision(disk) !== revision(sources[index])) || JSON.stringify(sources[index]) !== serialized[index]
                    || busy('private', sources[index].id)) throw new Error('会话发生变化，请重新载入后设置');
            }
            if (drafts.length) await dexieDB.characters.bulkPut(drafts);
            if (global) {
                const disk = await dexieDB.globalSettings.get('statusStorageSettings');
                if ((disk?.value?.revision || 0) !== (db.statusStorageSettings?.revision || 0)) throw new Error('其他页面已更新保存设置，请重新载入');
                await dexieDB.globalSettings.put({ key: 'statusStorageSettings', value: settings });
            }
        });
        drafts.forEach((draft, index) => {
            sources[index].statusPanel ||= {};
            if (mode === 'inherit') delete sources[index].statusPanel.snapshotStorageMode;
            else sources[index].statusPanel.snapshotStorageMode = mode;
            if (compactEdited !== undefined) sources[index].statusPanel.compactEditedSnapshots = compactEdited;
            sources[index]._statusStorageRevision = draft._statusStorageRevision;
        });
        if (global) db.statusStorageSettings = settings;
        return drafts.length;
    }

    window.StatusStorage = { policy, makeSnapshot, templateOf, scan, buildPlan, validate, recoveryArchive, run,
        persistChats, persistSetting, validateArchive, previewRestore, restore, setPolicies, referencedTemplates,
        stop: () => { stopRequested = true; }, isRunning: () => running,
        isChatLocked: (type, id) => activeChatKey === JSON.stringify([type, id]) };
})();
