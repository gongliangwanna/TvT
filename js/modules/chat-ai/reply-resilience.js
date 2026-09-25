(function () {
    'use strict';

    const SESSION_KEY = 'ovo_reply_ui_session_v1';
    const DIAGNOSTIC_KEY = 'ovo_reply_lifecycle_log_v1';
    const RUNNING_STATES = new Set(['preparing', 'requesting', 'streaming', 'recovering', 'finalizing']);
    const RECOVERABLE_STATES = new Set(['stalled', 'interrupted']);
    const PENDING_STATES = new Set([...RUNNING_STATES, ...RECOVERABLE_STATES]);
    const AUTO_RECOVER_MAX_AGE = 30 * 60 * 1000;
    const MAX_AUTO_ATTEMPTS = 2;
    const CHECKPOINT_DELAY = 450;
    const ownerId = `reply_owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const pendingWrites = new Map();
    const activeTasks = new Map();
    const taskLockReleases = new Map();
    let sessionSaveTimer = null;
    let recoveryTimer = null;
    let initialized = false;

    function table() {
        return typeof dexieDB !== 'undefined' && dexieDB && dexieDB.pendingReplies ? dexieDB.pendingReplies : null;
    }

    function createId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return `reply_${globalThis.crypto.randomUUID()}`;
        return `reply_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function cloneSafe(value) {
        if (value === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    }

    function logEvent(event, task, details) {
        try {
            const entries = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || '[]');
            entries.push({
                at: Date.now(),
                event,
                taskId: task && task.id || '',
                chatId: task && task.chatId || '',
                state: task && task.state || '',
                visibility: typeof document !== 'undefined' ? document.visibilityState : '',
                online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
                details: details || ''
            });
            localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(entries.slice(-120)));
        } catch (_) { /* diagnostics must never affect chat */ }
    }

    function getChat(chatId, chatType) {
        if (typeof db === 'undefined') return null;
        return chatType === 'group'
            ? (db.groups || []).find(item => item.id === chatId)
            : (db.characters || []).find(item => item.id === chatId);
    }

    function getLatestUserMessageId(chat) {
        const message = [...(chat && chat.history || [])].reverse().find(item => item && item.role === 'user' && !item.excludeFromContext);
        return message ? message.id : '';
    }

    async function putTask(task) {
        const store = table();
        if (!store || !task) return task;
        task.updatedAt = Date.now();
        if (task.ownerId === ownerId && RUNNING_STATES.has(task.state)) activeTasks.set(task.id, task);
        else activeTasks.delete(task.id);
        await store.put(cloneSafe(task));
        return task;
    }

    function taskLockName(taskId) {
        return `ovo-reply-task-${taskId}`;
    }

    function holdTaskLock(task) {
        if (!task || taskLockReleases.has(task.id) || typeof navigator === 'undefined'
            || !navigator.locks || typeof navigator.locks.request !== 'function') return;
        let releaseLock;
        const lockLifetime = new Promise(resolve => { releaseLock = resolve; });
        taskLockReleases.set(task.id, releaseLock);
        navigator.locks.request(taskLockName(task.id), async lock => {
            if (!lock) return;
            await lockLifetime;
        }).catch(error => {
            taskLockReleases.delete(task.id);
            console.warn('[ReplyResilience] task lock unavailable:', error);
        });
    }

    function releaseTaskLock(task) {
        if (!task) return;
        const releaseLock = taskLockReleases.get(task.id);
        if (releaseLock) releaseLock();
        taskLockReleases.delete(task.id);
    }

    async function getTask(id) {
        if (!id) return null;
        if (activeTasks.has(id)) return activeTasks.get(id);
        const store = table();
        const task = store ? await store.get(id) : null;
        if (task) activeTasks.set(id, task);
        return task || null;
    }

    async function findRecoverable(chatId, chatType, userMessageId, isBackground) {
        const store = table();
        if (!store) return null;
        const candidates = await store.where('chatId').equals(chatId).toArray();
        return candidates
            .filter(task => task.chatType === chatType && !!task.isBackground === !!isBackground && PENDING_STATES.has(task.state)
                && (!userMessageId || !task.userMessageId || task.userMessageId === userMessageId))
            .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] || null;
    }

    async function begin(details) {
        const chat = getChat(details.chatId, details.chatType);
        const userMessageId = details.userMessageId || getLatestUserMessageId(chat);
        let task = details.recoveryTaskId ? await getTask(details.recoveryTaskId) : null;
        if (!task && details.reuseExisting !== false) {
            task = await findRecoverable(details.chatId, details.chatType, userMessageId, details.isBackground);
        }
        const now = Date.now();
        if (task) {
            const continuingInterruptedTask = task.state === 'interrupted' || task.state === 'stalled';
            if (task.rawPartial) task.previousPartial = task.rawPartial;
            task.state = details.recoveryTaskId ? 'recovering' : (details.initialState || 'requesting');
            task.attempt = Math.max(1, Number(task.attempt) || 1) + ((details.recoveryTaskId || continuingInterruptedTask) ? 1 : 0);
            task.ownerId = ownerId;
            task.provider = details.provider || task.provider || '';
            task.model = details.model || task.model || '';
            task.streamEnabled = !!details.streamEnabled;
            task.isBackground = details.isBackground !== undefined ? !!details.isBackground : !!task.isBackground;
            task.rawPartial = '';
            task.reasoningPartial = '';
            task.receivedBytes = 0;
            task.lastChunkAt = 0;
            task.error = null;
            task.recoveredAt = details.recoveryTaskId ? now : task.recoveredAt || null;
        } else {
            task = {
                id: createId(),
                chatId: details.chatId,
                chatType: details.chatType,
                userMessageId,
                state: details.initialState || 'requesting',
                provider: details.provider || '',
                model: details.model || '',
                streamEnabled: !!details.streamEnabled,
                isBackground: !!details.isBackground,
                rawPartial: '',
                reasoningPartial: '',
                receivedBytes: 0,
                lastChunkAt: 0,
                attempt: 1,
                ownerId,
                createdAt: now,
                updatedAt: now,
                hiddenAt: null,
                completedAt: null,
                error: null
            };
        }
        await putTask(task);
        holdTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskStart === 'function') {
            window.KeepAliveModule.notifyTaskStart(task.id);
        }
        logEvent(details.recoveryTaskId ? 'recovery-started' : 'request-started', task);
        return task;
    }

    function scheduleCheckpoint(task) {
        if (!task || pendingWrites.has(task.id)) return;
        const timer = setTimeout(() => {
            pendingWrites.delete(task.id);
            putTask(task).catch(error => console.warn('[ReplyResilience] checkpoint failed:', error));
        }, CHECKPOINT_DELAY);
        pendingWrites.set(task.id, timer);
    }

    function checkpoint(task, content, reasoning, extra) {
        if (!task) return;
        const requestedState = extra && extra.state;
        if (content !== undefined) task.rawPartial = String(content || '');
        if (reasoning !== undefined) task.reasoningPartial = String(reasoning || '');
        if (extra && typeof extra === 'object') Object.assign(task, extra);
        task.state = requestedState || (task.state === 'recovering' ? 'recovering' : 'streaming');
        task.receivedBytes = task.rawPartial.length + task.reasoningPartial.length;
        task.lastChunkAt = Date.now();
        task.updatedAt = task.lastChunkAt;
        activeTasks.set(task.id, task);
        scheduleCheckpoint(task);
    }

    async function flush(task) {
        if (!task) return;
        const timer = pendingWrites.get(task.id);
        if (timer) clearTimeout(timer);
        pendingWrites.delete(task.id);
        await putTask(task);
    }

    async function flushAll() {
        await Promise.all([...activeTasks.values()].map(task => flush(task).catch(() => {})));
    }

    async function markFinalizing(task, rawResponse) {
        if (!task) return;
        task.state = 'finalizing';
        task.rawPartial = String(rawResponse || task.rawPartial || '');
        await flush(task);
    }

    async function complete(task) {
        if (!task) return;
        task.state = 'completed';
        task.completedAt = Date.now();
        task.error = null;
        task.rawPartial = '';
        task.reasoningPartial = '';
        task.previousPartial = '';
        task.transportBytes = 0;
        await flush(task);
        activeTasks.delete(task.id);
        releaseTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
            window.KeepAliveModule.notifyTaskEnd(task.id);
        }
        logEvent('completed', task);
    }

    function hasActive(chatId, chatType) {
        return [...activeTasks.values()].some(task => task.chatId === chatId && task.chatType === chatType
            && task.ownerId === ownerId && RUNNING_STATES.has(task.state));
    }

    function canFinalize(task) {
        return !!task && task.ownerId === ownerId && RUNNING_STATES.has(task.state) && !task.cancelRequestedAt;
    }

    async function fail(task, error, cancelled) {
        if (!task) return;
        const status = error && error.response && Number(error.response.status);
        const permanentClientError = status >= 400 && status < 500 && status !== 408 && status !== 429;
        task.state = cancelled ? 'cancelled' : permanentClientError ? 'failed' : 'interrupted';
        task.error = error ? { name: error.name || 'Error', message: String(error.message || error).slice(0, 500) } : null;
        await flush(task);
        activeTasks.delete(task.id);
        releaseTaskLock(task);
        if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
            window.KeepAliveModule.notifyTaskEnd(task.id);
        }
        logEvent(task.state, task, task.error && task.error.name);
    }

    async function cancelForChat(chatId, chatType) {
        const store = table();
        const storedTasks = store ? await store.where('chatId').equals(chatId).toArray() : [];
        const candidates = new Map();
        storedTasks.forEach(task => {
            if (task.chatType === chatType && !task.isBackground && PENDING_STATES.has(task.state)) candidates.set(task.id, task);
        });
        activeTasks.forEach(task => {
            if (task.chatId === chatId && task.chatType === chatType && !task.isBackground && PENDING_STATES.has(task.state)) {
                candidates.set(task.id, task);
            }
        });
        if (!candidates.size) return false;
        const now = Date.now();
        for (const task of candidates.values()) {
            task.cancelRequestedAt = now;
            task.state = 'cancelled';
            task.error = { name: 'AbortError', message: '用户已停止本次调用' };
            await putTask(task);
            activeTasks.delete(task.id);
            releaseTaskLock(task);
            if (window.KeepAliveModule && typeof window.KeepAliveModule.notifyTaskEnd === 'function') {
                window.KeepAliveModule.notifyTaskEnd(task.id);
            }
            logEvent('cancelled', task, 'user-requested');
        }
        return true;
    }

    function readSession() {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
    }

    function captureSession() {
        const activeScreen = document.querySelector('.screen.active');
        const messageInputElement = document.getElementById('message-input');
        const messageAreaElement = document.getElementById('message-area');
        return {
            activeScreen: activeScreen ? activeScreen.id : 'home-screen',
            chatId: typeof currentChatId !== 'undefined' ? currentChatId : null,
            chatType: typeof currentChatType !== 'undefined' ? currentChatType : null,
            currentPage: typeof currentPage !== 'undefined' ? currentPage : 1,
            inputDraft: messageInputElement ? messageInputElement.value : '',
            scrollTop: messageAreaElement ? messageAreaElement.scrollTop : 0,
            scrollHeight: messageAreaElement ? messageAreaElement.scrollHeight : 0,
            updatedAt: Date.now()
        };
    }

    function saveSessionNow() {
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(captureSession())); } catch (_) { /* storage can be unavailable */ }
    }

    function scheduleSessionSave() {
        clearTimeout(sessionSaveTimer);
        sessionSaveTimer = setTimeout(saveSessionNow, 180);
    }

    function restoreSession() {
        const session = readSession();
        if (!session) return false;
        if (session.activeScreen === 'chat-room-screen' && session.chatId && getChat(session.chatId, session.chatType)
            && typeof openChatRoom === 'function') {
            openChatRoom(session.chatId, session.chatType);
            if (typeof currentPage !== 'undefined' && Number.isFinite(Number(session.currentPage))) {
                currentPage = Math.max(1, Number(session.currentPage));
                if (currentPage > 1 && typeof renderMessages === 'function') renderMessages(false, false);
            }
            const input = document.getElementById('message-input');
            if (input && session.inputDraft) input.value = session.inputDraft;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const area = document.getElementById('message-area');
                if (!area) return;
                const distanceFromBottom = Math.max(0, Number(session.scrollHeight || 0) - Number(session.scrollTop || 0));
                area.scrollTop = Math.max(0, area.scrollHeight - distanceFromBottom);
            }));
            return true;
        }
        return false;
    }

    async function recoverPending() {
        const store = table();
        if (!store || typeof getAiReply !== 'function') return;
        const now = Date.now();
        const tasks = (await store.toArray())
            .filter(task => PENDING_STATES.has(task.state))
            .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
        for (const task of tasks) {
            if (activeTasks.has(task.id) && task.ownerId === ownerId && RUNNING_STATES.has(task.state)) continue;
            const ownerHeartbeatAge = now - (task.updatedAt || task.createdAt || 0);
            if (task.ownerId && task.ownerId !== ownerId && ownerHeartbeatAge >= 0 && ownerHeartbeatAge < 6000) {
                clearTimeout(recoveryTimer);
                recoveryTimer = setTimeout(() => { void recoverPending(); }, Math.max(500, 6200 - ownerHeartbeatAge));
                continue;
            }
            const chat = getChat(task.chatId, task.chatType);
            if (!chat) {
                task.state = 'failed';
                task.error = { name: 'MissingChat', message: '原聊天已不存在，无法恢复回复' };
                await putTask(task);
                continue;
            }
            const alreadyAnswered = (chat.history || []).some(message => message && message.replyRequestId === task.id);
            if (alreadyAnswered) {
                await complete(task);
                continue;
            }
            const userMessageIndex = (chat.history || []).findIndex(message => message && message.id === task.userMessageId);
            const completedMessages = userMessageIndex >= 0
                ? chat.history.slice(userMessageIndex + 1).filter(message => message && message.role === 'assistant' && !message.isThinking
                    && Number(message.timestamp || 0) >= Number(task.createdAt || 0))
                : [];
            if (completedMessages.length) {
                completedMessages.forEach(message => { if (!message.replyRequestId) message.replyRequestId = task.id; });
                if (task.chatType === 'group' && typeof saveGroup === 'function') await saveGroup(task.chatId);
                else if (task.chatType === 'private' && typeof saveCharacter === 'function') await saveCharacter(task.chatId);
                await complete(task);
                continue;
            }
            if (now - (task.updatedAt || task.createdAt || now) > AUTO_RECOVER_MAX_AGE || (task.attempt || 1) >= MAX_AUTO_ATTEMPTS) {
                task.state = 'abandoned';
                if (!task.userNotifiedAt) {
                    task.userNotifiedAt = now;
                    if (!task.isBackground && typeof currentChatId !== 'undefined' && currentChatId === task.chatId) {
                        const indicator = document.getElementById('typing-indicator');
                        if (indicator) {
                            indicator.textContent = '上次回复已中断，点击回复可重新恢复';
                            indicator.style.display = 'block';
                        }
                        if (typeof showToast === 'function') showToast('检测到未完成回复，已保留恢复记录');
                    }
                }
                await putTask(task);
                continue;
            }
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                if (!task.isBackground && typeof currentChatId !== 'undefined' && currentChatId === task.chatId) {
                    const indicator = document.getElementById('typing-indicator');
                    if (indicator) {
                        indicator.textContent = '网络已断开，将在恢复联网后继续';
                        indicator.style.display = 'block';
                    }
                }
                continue;
            }
            // 恢复回复不改变用户所在页面。
            const isCurrentChat = typeof currentChatId !== 'undefined' && currentChatId === task.chatId
                && typeof currentChatType !== 'undefined' && currentChatType === task.chatType
                && document.querySelector('.screen.active')?.id === 'chat-room-screen';
            const indicator = task.isBackground || !isCurrentChat ? null : document.getElementById('typing-indicator');
            if (indicator) {
                const savedLength = String(task.rawPartial || task.previousPartial || '').length;
                indicator.textContent = savedLength > 0
                    ? `已保存 ${savedLength} 字回复进度，正在恢复…`
                    : '检测到未完成回复，正在恢复…';
                indicator.style.display = 'block';
            }
            const runRecovery = () => getAiReply(task.chatId, task.chatType, !!task.isBackground, false, false, false, { recoveryTaskId: task.id });
            logEvent('recovery-attempt', task);
            if (navigator.locks && typeof navigator.locks.request === 'function') {
                let acquired = false;
                await navigator.locks.request(taskLockName(task.id), { ifAvailable: true }, async lock => {
                    if (lock) {
                        acquired = true;
                        await runRecovery();
                    }
                });
                if (!acquired && indicator) indicator.textContent = '回复仍在另一页面处理中…';
            } else {
                await runRecovery();
            }
            break;
        }
    }

    function bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                const now = Date.now();
                activeTasks.forEach(task => { if (RUNNING_STATES.has(task.state)) task.hiddenAt = now; });
                saveSessionNow();
                logEvent('hidden');
                void flushAll();
            } else {
                logEvent('visible');
                activeTasks.forEach(task => { task.lastVisibleAt = Date.now(); scheduleCheckpoint(task); });
            }
        });
        window.addEventListener('pagehide', () => { saveSessionNow(); logEvent('pagehide'); void flushAll(); });
        window.addEventListener('pageshow', event => {
            logEvent(event.persisted ? 'pageshow-bfcache' : 'pageshow');
            if (event.persisted || document.wasDiscarded) void recoverPending();
        });
        window.addEventListener('online', () => { logEvent('online'); void recoverPending(); });
        document.addEventListener('freeze', () => { saveSessionNow(); void flushAll(); });
        document.addEventListener('resume', () => { void recoverPending(); });
        document.addEventListener('input', event => {
            if (event.target && event.target.id === 'message-input') scheduleSessionSave();
        });
        const area = document.getElementById('message-area');
        if (area) area.addEventListener('scroll', scheduleSessionSave, { passive: true });
    }

    async function init() {
        if (initialized) return;
        initialized = true;
        bindLifecycle();
        // 刷新后保留默认首页，不自动恢复上次打开的聊天页面。
        const store = table();
        if (store) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const oldCompleted = await store.filter(task => task.state === 'completed' && (task.completedAt || task.updatedAt || 0) < cutoff).primaryKeys();
            if (oldCompleted.length) await store.bulkDelete(oldCompleted);
        }
        // 不阻塞其余模块初始化；恢复调用在完整 UI 就绪后异步开始。
        setTimeout(() => { void recoverPending(); }, 0);
    }

    window.ReplyResilience = {
        init,
        begin,
        checkpoint,
        flush,
        flushAll,
        markFinalizing,
        complete,
        fail,
        cancelForChat,
        canFinalize,
        getTask,
        findRecoverable,
        hasActive,
        saveSessionNow,
        scheduleSessionSave,
        restoreSession,
        recoverPending,
        _test: { RUNNING_STATES, RECOVERABLE_STATES, PENDING_STATES, captureSession, readSession, createId }
    };
})();
