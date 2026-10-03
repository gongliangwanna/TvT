// Keep the existing distribution chart and profile-card entry point.
function openTokenDistributionModal(charId, chatType = 'private', reason = '') {
    const modal = document.getElementById('token-distribution-modal');
    if (!modal) return;
    if (modal.dataset.chatId !== charId || modal.dataset.chatType !== chatType) {
        modal._officialCount = null;
        const status = document.getElementById('token-status'); if (status) status.textContent = '';
    }
    modal.dataset.chatId = charId; modal.dataset.chatType = chatType; modal.dataset.engine = ChatTokenStats.ENGINE;
    const generation = (modal._tokenGeneration || 0) + 1; modal._tokenGeneration = generation;
    let data;
    try { data = getChatTokenBreakdown(charId, chatType); }
    catch (_) {
        renderTokenDistributionModal(charId, null);
        document.getElementById('token-method').textContent = '上下文数据异常，暂不显示不可靠数字；请点击检测纠错。';
        modal._tokenData = null; installTokenPanelActions(modal); return;
    }
    if (!data) return;
    const visibleData = { ...data, details: data.details.some(d => d.key === 'worldBook') ? data.details : [...data.details, { key: 'worldBook', name: '世界书', value: 0, desc: '本次上下文未注入世界书。' }] };
    renderTokenDistributionModal(charId, visibleData); modal._tokenData = data;
    document.getElementById('token-method').textContent = `${data.model || '尚未选择模型'} · ${data.method}${data.mediaUnknown ? '\n当前数字为文字部分，图片等媒体用量待接口核对。' : ''}${data.encodedMediaText ? '\n检测到媒体编码嵌入文字，请点击检测纠错查看原因。' : ''}${data.pending.length ? '\n' + data.pending.join('；') : ''}`;
    const change = ChatTokenStats.delta(charId, chatType, data);
    document.getElementById('token-change').textContent = change ? `占用变化：${change}` : reason;
    const official = modal._officialCount;
    if (official?.fingerprint === data.fingerprint) document.getElementById('token-status').textContent = `官方预计算输入 ${official.input} Token；分类为本地文本统计。`;
    else if (official) { modal._officialCount = null; document.getElementById('token-status').textContent = '上下文已改变，原官方计数已失效。'; }
    const ledger = data.requestLedger.slice(-8);
    const latestRound = data.requestLedger.at(-1)?.roundId, round = data.requestLedger.filter(r => r.roundId === latestRound);
    const roundSummary = round.length ? `最近一轮 ${round.length} 次请求 · 已返回输入合计 ${round.reduce((n,r) => n + (r.usage?.input || 0),0)} · 输出合计 ${round.reduce((n,r) => n + (r.usage?.output || 0),0)}${round.some(r => r.usage?.input == null || r.usage?.output == null) ? '（存在未返回用量，合计不完整）' : ''}\n\n` : '';
    document.getElementById('token-request-ledger').textContent = ledger.length ? roundSummary + ledger.map(r => {
        const scope = r.scope === 'background' ? '后台' : r.scope === 'tools' ? '工具回合' : r.scope === 'summary' ? '总结' : r.scope === 'auxiliary' ? '辅助调用' : '聊天';
        return `${new Date(r.at).toLocaleTimeString()} · ${scope} · ${r.model || '未知模型'}\n预计文字 ${r.estimatedInput} · 实际输入 ${r.usage?.input ?? '未返回'} · 输出 ${r.usage?.output ?? '未返回'}${r.usage?.cached != null ? ' · 缓存 ' + r.usage.cached : ''}${r.usage?.thinking != null ? ' · 思考 ' + r.usage.thinking : ''}${r.status === 'failed' ? ' · 请求失败，用量未知' : ''}`;
    }).join('\n\n') : '尚无请求记录。实际发送后会显示对应请求的用量，失败且未返回用量的请求不会记作零消耗。';
    installTokenPanelActions(modal);
    const chat = (chatType === 'private' ? db.characters : db.groups)?.find(c => c.id === charId);
    if (!modal._tokenAutoDetect && ['worldBookIds', 'offlineWorldBookIds'].some(k => Array.isArray(chat?.[k]) && new Set(chat[k]).size !== chat[k].length)) {
        modal._tokenAutoDetect = true;
        ChatTokenStats.detect(charId, chatType, true).then(results => {
            if (modal.dataset.chatId === charId) document.getElementById('token-status').textContent = results.some(r => r.corrected) ? '已自动纠正重复绑定；可在请求明细与自检中撤销。' : '重复引用未能保存，请点击检测纠错核对。';
        }).catch(() => {
            if (modal.dataset.chatId === charId) document.getElementById('token-status').textContent = '自动纠正未完成，请点击检测纠错核对。';
        }).finally(() => { modal._tokenAutoDetect = false; });
    }
    if (data.encoding && !data.textExact) ChatTokenStats.refine(data).then(() => {
        if (modal._tokenGeneration !== generation || !modal.classList.contains('visible')) return;
        const current = getChatTokenBreakdown(charId, chatType);
        if (current.fingerprint === data.fingerprint && current.textExact) {
            openTokenDistributionModal(charId, chatType);
            if (document.getElementById('pc-message-btn')?.dataset.charId === charId) document.getElementById('pc-stat-memory').textContent = current.total;
        }
    }).catch(() => {
        if (modal._tokenGeneration === generation) document.getElementById('token-method').textContent = `${data.model} · 本地分词暂不可用，当前为字符估算；可使用官方精算或实际用量核对。`;
    });
}

function installTokenPanelActions(modal) {
    if (modal._tokenActionsInstalled) return;
    modal._tokenActionsInstalled = true;
    modal.addEventListener('click', async event => {
        const button = event.target.closest('[data-token-action]'); if (!button || button.disabled) return;
        const action = button.dataset.tokenAction, id = modal.dataset.chatId, type = modal.dataset.chatType || 'private', status = document.getElementById('token-status');
        button.disabled = true;
        try {
            if (action === 'detect' || action === 'all') {
                status.textContent = '正在检测数据与统计一致性…';
                const results = await ChatTokenStats.detect(id, type, true, action === 'all');
                if (modal.dataset.chatId !== id || modal.dataset.chatType !== type) return;
                const corrected = results.reduce((n, r) => n + r.corrected, 0), issues = results.flatMap(r => r.issues);
                openTokenDistributionModal(id, type);
                status.textContent = `已检测 ${results.length} 个聊天，纠正 ${corrected} 处重复绑定。${issues.length ? '\n' + issues.map(i => i.message).slice(0, 10).join('\n') : '未发现统计一致性异常。'}\n检测不会删除聊天、人设或有意重复的提示词。`;
            } else if (action === 'official') {
                const data = modal._tokenData; if (!data) throw new Error('上下文尚不可用，请先检测数据');
                status.textContent = '正在使用当前配置的接口预计算…';
                const result = await ChatTokenStats.official(data), current = getChatTokenBreakdown(id, type);
                if (modal.dataset.chatId !== id || current.fingerprint !== result.fingerprint) throw new Error('上下文已改变，请重新精算');
                modal._officialCount = result;
                status.textContent = `官方预计算输入 ${result.input} Token；分类为本地文本统计。${current.pending.length ? '\n发送时准备的动态内容仍可能改变用量。' : ''}`;
            } else if (action === 'copy') {
                const text = JSON.stringify(ChatTokenStats.diagnostics(id, type), null, 2);
                try { await navigator.clipboard.writeText(text); status.textContent = '诊断已复制，不含密钥、聊天正文、人设全文或图片数据。'; }
                catch (_) {
                    let box = document.getElementById('token-diagnostic-copy');
                    if (!box) { box = document.createElement('textarea'); box.id = 'token-diagnostic-copy'; box.className = 'token-diagnostic-copy'; box.readOnly = true; box.setAttribute('aria-label', '脱敏统计诊断'); status.after(box); }
                    box.value = text; box.focus(); box.select(); status.textContent = '自动复制不可用，请复制下方已选中的脱敏诊断。';
                }
            } else if (action === 'undo') {
                status.textContent = await ChatTokenStats.undo(id, type) ? '已撤销最近一次数据纠正。' : '当前聊天没有可撤销的纠正。';
            } else if (action === 'selftest') {
                const result = ChatTokenStats.selfTest(); status.textContent = result.passed ? `统计自检通过（${result.checks} 项），媒体运输数据未混入文字计数。` : '统计自检失败，请复制诊断反馈。';
            } else if (action === 'simulate') {
                const n = Number(document.getElementById('token-sim-limit').value);
                if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('请输入 1–10000 之间的历史条数');
                let data = getChatTokenBreakdown(id, type, { overrides: { maxMemory: n } });
                await ChatTokenStats.refine(data); data = getChatTokenBreakdown(id, type, { overrides: { maxMemory: n } });
                if (modal.dataset.chatId !== id || modal.dataset.chatType !== type) return;
                document.getElementById('token-sim-result').textContent = `模拟 ${data.total} Token · ${data.method}；${data.messageCount} 条消息。未修改聊天设置。`;
            }
        } catch (error) { if (modal.dataset.chatId === id && modal.dataset.chatType === type) status.textContent = error.name === 'AbortError' ? '计数超时，当前估算仍可使用。' : error.message; }
        finally { button.disabled = false; }
    });
}
