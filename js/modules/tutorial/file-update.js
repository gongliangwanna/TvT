// Manual application-file refresh. User data stays in its existing IndexedDB/localStorage.
(() => {
    const baseUrl = new URL('../../../', document.currentScript.src).href;
    let operation = null;
    let lastStatus = '更新前建议先备份重要数据。';
    let reloadPending = false;

    function renderState() {
        const button = document.getElementById('ovo-file-update-btn');
        const status = document.getElementById('ovo-file-update-status');
        if (button) {
            const label = button.querySelector('span') || button;
            label.textContent = operation ? (operation.committing ? '正在更新…' : '取消拉取') : '拉取最新文件';
            button.disabled = !!operation && (operation.confirming || operation.committing);
            button.setAttribute('aria-busy', String(!!operation));
        }
        if (status) status.textContent = lastStatus;
    }

    function report(message) {
        lastStatus = message;
        renderState();
    }

    function busy() {
        if ((typeof isGenerating !== 'undefined' && isGenerating)
            || (typeof loadingBtn !== 'undefined' && loadingBtn)) return true;
        if (document.getElementById('gh-backup-btn')?.style.pointerEvents === 'none') return true;
        if (window.ReplyResilience && typeof db !== 'undefined') {
            return (db.characters || []).some(chat => window.ReplyResilience.hasActive(chat.id, 'private'))
                || (db.groups || []).some(chat => window.ReplyResilience.hasActive(chat.id, 'group'));
        }
        return false;
    }

    function abortError() { return new Error('已取消拉取，当前应用保持不变'); }

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(abortError()); return; }
            const cancel = () => { clearTimeout(timer); reject(abortError()); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
            signal.addEventListener('abort', cancel, { once: true });
        });
    }

    function send(worker, type, token, { signal, progress, timeout = 45000 } = {}) {
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            let timer;
            const finish = (error, value) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                channel.port1.close();
                error ? reject(error) : resolve(value);
            };
            const cancel = () => finish(abortError());
            const armTimer = () => {
                clearTimeout(timer);
                timer = setTimeout(() => finish(new Error('更新服务响应超时，请检查网络后重试')), timeout);
            };
            channel.port1.onmessage = event => {
                const data = event.data;
                if (data.type === 'progress') { armTimer(); progress?.(data); }
                else if (data.type === 'error') finish(new Error(data.message));
                else if (data.type === 'done') finish(null, data);
            };
            if (signal?.aborted) { cancel(); return; }
            signal?.addEventListener('abort', cancel, { once: true });
            armTimer();
            try { worker.postMessage({ type, token }, [channel.port2]); }
            catch (error) { finish(error); }
        });
    }

    async function getWorker(signal) {
        const registration = await new Promise((resolve, reject) => {
            const finish = (error, value) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                error ? reject(error) : resolve(value);
            };
            const cancel = () => finish(abortError());
            const timer = setTimeout(() => finish(new Error('更新服务连接超时，请检查网络后重试')), 30000);
            if (signal.aborted) { cancel(); return; }
            signal.addEventListener('abort', cancel, { once: true });
            navigator.serviceWorker.register(new URL('sw.js', baseUrl).href,
                { scope: baseUrl, updateViaCache: 'none' }).then(value => finish(null, value), finish);
        });
        const deadline = Date.now() + 180000;
        while ((registration.installing || !registration.active || registration.active.state === 'activating') && Date.now() < deadline) {
            await delay(250, signal);
        }
        if (signal.aborted) throw abortError();
        const worker = registration.active;
        if (!worker || registration.installing) throw new Error('更新服务尚未准备好，请稍后重试');
        const reply = await send(worker, 'OVO_UPDATE_PING', '', { signal, timeout: 5000 });
        if (reply.protocol !== 1) throw new Error('网站更新服务尚未发布完成，请稍后重试');
        return worker;
    }

    async function run() {
        if (reloadPending) return;
        if (operation) {
            if (!operation.committing && !operation.confirming) operation.controller.abort();
            return;
        }
        if (!/^https?:$/.test(location.protocol) || !navigator.serviceWorker || !window.isSecureContext) {
            report('请通过 HTTPS 网站链接打开后再更新。');
            return;
        }
        if (busy()) { report('请先等待回复生成或备份完成，再拉取更新。'); return; }
        const current = { controller: new AbortController(), confirming: true, committing: false,
            token: `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '')}`, worker: null };
        operation = current;
        renderState();
        let applied = false;
        try {
            const confirmation = customConfirm('更新前建议先使用「备份数据」或上方的仓库备份保存重要数据。\n\n将重新下载当前站点的应用文件，完成后刷新一次；不会主动删除聊天记录、角色和设置。', '拉取最新文件');
            const confirmButton = document.getElementById('custom-confirm-ok-btn');
            const originalLabel = confirmButton.textContent;
            confirmButton.textContent = '拉取并更新';
            let confirmed;
            try { confirmed = await confirmation; }
            finally { confirmButton.textContent = originalLabel; }
            if (!confirmed) return;
            current.confirming = false;
            const signal = current.controller.signal;
            report('正在连接更新服务…');
            current.worker = await getWorker(signal);
            await send(current.worker, 'OVO_UPDATE_PREPARE', current.token, {
                signal, progress: data => report(`正在拉取文件：${data.completed} / ${data.total}`)
            });
            if (busy()) throw new Error('文件已拉取，但当前仍有回复或备份进行中，请完成后重试');
            report('文件已拉取，正在保存当前数据…');
            // Drain existing chat writes before the full save, preserving their original order.
            if (typeof characterSaveQueues !== 'undefined' && typeof groupSaveQueues !== 'undefined') {
                const results = await Promise.all([...characterSaveQueues.values(), ...groupSaveQueues.values()].map(task => task.promise));
                if (results.some(value => value === false)) throw new Error('当前数据保存失败，更新已停止，请先备份');
            }
            if (typeof saveData !== 'function' || await saveData() === false) {
                throw new Error('当前数据保存失败，更新已停止，请先备份');
            }
            if (signal.aborted) throw abortError();
            if (busy()) throw new Error('当前仍有回复或备份进行中，请完成后重试');
            current.committing = true;
            renderState();
            await send(current.worker, 'OVO_UPDATE_APPLY', current.token);
            applied = true;
            report('拉取完成，即将刷新…');
            // A task started during the commit must finish before reloading.
            const deadline = Date.now() + 90000;
            while (busy() && Date.now() < deadline) {
                report('文件已更新，正在等待当前操作完成后刷新…');
                await delay(500, signal);
            }
            if (busy()) { report('文件已更新，请在当前操作完成后手动刷新页面。'); return; }
            reloadPending = true;
            await delay(500, signal);
            location.reload();
        } catch (error) {
            report(current.controller.signal.aborted ? '已取消拉取，当前应用保持不变。'
                : `${error.message || '拉取失败，请检查网络后重试'}${applied ? '' : '。当前应用保持不变。'}`);
        } finally {
            if (current.worker && !applied) {
                await send(current.worker, 'OVO_UPDATE_DISCARD', current.token, { timeout: 5000 }).catch(() => {});
            }
            operation = null;
            renderState();
        }
    }

    window.OVOFileUpdate = { baseUrl, run, renderState };
})();
