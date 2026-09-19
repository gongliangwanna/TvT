function migrateJournalSettings(chat) {
    if (!chat.journalStyleSettings) {
        const oldJournalIds = chat.journalWorldBookIds || [];
        let isOfflineNode = false;
        if (chat.activeNodeId && chat.nodes) {
            const activeNode = chat.nodes.find(n => n.id === chat.activeNodeId);
            if (activeNode) {
                let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                               (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
                if (baseMode === 'offline') {
                    isOfflineNode = true;
                }
            }
        }
        let chatCommonIds = chat.worldBookIds || [];
        if (isOfflineNode) {
            chatCommonIds = (chat.offlineWorldBookIds && chat.offlineWorldBookIds.length > 0) ? chat.offlineWorldBookIds : (chat.worldBookIds || []);
        }
        
        // 1. 剔除重复项 (在通用里已存在的)
        const uniqueCustomIds = oldJournalIds.filter(id => !chatCommonIds.includes(id));
        
        // 2. 决定模式
        let newMode = 'default';
        let migrationMsg = '';

        if (oldJournalIds.length > 0) {
            if (uniqueCustomIds.length === 0) {
                // 情况 A: 旧关联全是通用背景 -> 迁移到默认模式
                newMode = 'default';
                migrationMsg = '日记功能升级：已自动关联聊天室背景，您的旧设置已合并到“默认风格”。';
            } else {
                // 情况 B: 有额外的世界书 -> 迁移到自定义模式，保留额外项
                newMode = 'custom';
                migrationMsg = `日记功能升级：已自动关联聊天室背景，剩余 ${uniqueCustomIds.length} 个特殊设定已保留在“自定义风格”中。`;
            }
        } else {
            // 情况 C: 无旧关联 -> 默认
            newMode = 'default';
        }

        // 3. 应用设置
        chat.journalStyleSettings = { 
            mode: newMode, 
            customWorldBookIds: uniqueCustomIds 
        };
        
        return migrationMsg;
    }
    return null;
}

function ensureAutoJournalState(chat) {
    if (!chat) return;

    const history = Array.isArray(chat.history) ? chat.history : [];
    const legacyIndex = parseInt(chat.lastAutoJournalIndex, 10);

    if (chat.journalIncludeFavorited === undefined) {
        chat.journalIncludeFavorited = false;
    }
    if (!chat.autoJournalState) {
        chat.autoJournalState = 'idle';
    }
    if (chat.autoJournalPending === undefined) {
        chat.autoJournalPending = false;
    }

    // 页面刷新后恢复遗留的 running；内存中仍有对应任务时不得误判为卡死。
    const hasActiveTask = typeof autoJournalActiveTasks !== 'undefined' && autoJournalActiveTasks.has(chat.id);
    if (chat.autoJournalState === 'running' && !hasActiveTask) {
        chat.autoJournalState = 'idle';
    }

    if (chat.lastSummarizedMsgId === undefined) {
        if (!isNaN(legacyIndex) && legacyIndex > 0 && legacyIndex <= history.length) {
            const legacyMessage = history[legacyIndex - 1];
            chat.lastSummarizedMsgId = legacyMessage ? legacyMessage.id : null;
            chat.lastSummarizedMsgTimestamp = legacyMessage ? legacyMessage.timestamp || null : null;
        } else {
            chat.lastSummarizedMsgId = null;
            if (chat.lastSummarizedMsgTimestamp === undefined) {
                chat.lastSummarizedMsgTimestamp = null;
            }
        }
    }

}

function getAutoJournalCursorInfo(chat) {
    ensureAutoJournalState(chat);

    const history = Array.isArray(chat && chat.history) ? chat.history : [];
    const interval = Math.max(10, parseInt(chat && chat.autoJournalInterval, 10) || 100);
    
    let nextStartIndex = 0;
    
    if (chat) {
        let foundIndex = -1;
        if (chat.lastSummarizedMsgId) {
            foundIndex = history.findIndex(message => message.id === chat.lastSummarizedMsgId);
        }
        
        if (foundIndex !== -1) {
            nextStartIndex = foundIndex + 1;
        } else {
            const savedTimestamp = Number(chat.lastSummarizedMsgTimestamp);
            if (Number.isFinite(savedTimestamp) && savedTimestamp > 0) {
                for (let index = 0; index < history.length; index++) {
                    const messageTimestamp = Number(history[index] && history[index].timestamp);
                    if (Number.isFinite(messageTimestamp) && messageTimestamp <= savedTimestamp) {
                        nextStartIndex = index + 1;
                    }
                }
            }

            // 兼容没有消息 ID/时间戳的旧数据。新记录只使用稳定消息 ID 恢复。
            let maxEnd = 0;
            if (nextStartIndex === 0 && Array.isArray(chat.memoryJournals)) {
                for (const j of chat.memoryJournals) {
                    const endMessageId = j && j.range && j.range.endMessageId;
                    const journalEndIndex = endMessageId ? history.findIndex(message => message.id === endMessageId) : -1;
                    if (journalEndIndex !== -1) {
                        nextStartIndex = Math.max(nextStartIndex, journalEndIndex + 1);
                    } else if (j.range && typeof j.range.end === 'number') {
                        maxEnd = Math.max(maxEnd, j.range.end);
                    }
                }
            }
            
            if (nextStartIndex === 0 && maxEnd > 0) {
                nextStartIndex = Math.min(maxEnd, history.length); // 防越界
            } else if (nextStartIndex === 0 && chat.lastAutoJournalIndex !== undefined && !isNaN(parseInt(chat.lastAutoJournalIndex, 10))) {
                nextStartIndex = Math.max(0, Math.min(parseInt(chat.lastAutoJournalIndex, 10), history.length));
            }
        }
    }

    const unsummarizedCount = Math.max(0, history.length - nextStartIndex);
    const completedBatchCount = Math.floor(unsummarizedCount / interval);

    return {
        history,
        interval,
        cursorIndex: nextStartIndex - 1,
        nextStartIndex,
        unsummarizedCount,
        completedBatchCount
    };
}

function getNextAutoJournalRange(chat) {
    const info = getAutoJournalCursorInfo(chat);
    if (info.completedBatchCount <= 0) {
        return null;
    }

    return {
        start: info.nextStartIndex + 1,
        end: info.nextStartIndex + info.interval,
        info
    };
}

function setAutoJournalCursorByMessage(chat, message) {
    ensureAutoJournalState(chat);
    chat.lastSummarizedMsgId = message ? message.id : null;
    chat.lastSummarizedMsgTimestamp = message ? (message.timestamp || null) : null;
    chat.autoJournalState = 'idle';
}

function setAutoJournalCursorByEndIndex(chat, endIndex) {
    const history = Array.isArray(chat && chat.history) ? chat.history : [];
    const message = history[endIndex - 1] || null;
    setAutoJournalCursorByMessage(chat, message);
    chat.lastAutoJournalIndex = endIndex;
}

function resetAutoJournalCursorToLatest(chat) {
    const history = Array.isArray(chat && chat.history) ? chat.history : [];
    setAutoJournalCursorByMessage(chat, history.length ? history[history.length - 1] : null);
    chat.lastAutoJournalIndex = history.length;
    chat.autoJournalPending = false;
}

function syncAutoJournalCursorAfterManualSummary(chat, start, end) {
    ensureAutoJournalState(chat);
    if (!chat || !chat.autoJournalEnabled) return;

    const info = getAutoJournalCursorInfo(chat);
    const nextPendingStart = info.nextStartIndex + 1;

    if (start > nextPendingStart) {
        return;
    }

    setAutoJournalCursorByEndIndex(chat, Math.max(end, nextPendingStart - 1));
    chat.autoJournalPending = false;
}

function getAutoJournalChatType(chat) {
    return db.characters.some(character => character.id === chat.id) ? 'private' : 'group';
}

function askSummarizeLatestOptions(info) {
    const unsummarizedCount = Math.max(0, info && info.unsummarizedCount || 0);
    const interval = Math.max(10, parseInt(info && info.interval, 10) || 100);
    const existingModal = document.getElementById('journal-latest-choice-modal');
    if (existingModal) {
        existingModal.remove();
    }

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'journal-latest-choice-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-window" style="max-width: 360px;">
                <h3>总结到最新</h3>
                <p style="color: #666; font-size: 13px; line-height: 1.6; margin: 12px 0 8px;">
                    当前有 ${unsummarizedCount} 条新消息未纳入总结。
                </p>
                <div style="display: flex; align-items: center; gap: 8px; margin: 0 0 12px;">
                    <span style="font-size: 12px; color: #666; white-space: nowrap;">拆分条数</span>
                    <input type="number" id="journal-latest-split-size" value="${interval}" min="1" step="1"
                        style="width: 78px; text-align: right; border: none; background: rgba(0,0,0,0.05); border-radius: 4px; padding: 6px 8px;">
                </div>
                <p id="journal-latest-split-info" style="color: #888; font-size: 12px; line-height: 1.6; margin: 0 0 14px;">
                    按当前间隔 ${interval} 条计算。
                </p>
                <label id="journal-latest-remainder-label" style="display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: #666; margin-bottom: 14px;">
                    <input type="checkbox" id="journal-latest-include-remainder">
                    <span></span>
                </label>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button type="button" class="btn btn-primary" data-choice="single">合并成一整篇</button>
                    <button type="button" class="btn btn-secondary" data-choice="split">按每 ${interval} 条拆分</button>
                    <button type="button" class="btn" data-choice="cancel">取消</button>
                </div>
            </div>
        `;

        const splitInput = overlay.querySelector('#journal-latest-split-size');
        const splitInfo = overlay.querySelector('#journal-latest-split-info');
        const remainderLabel = overlay.querySelector('#journal-latest-remainder-label');
        const includeRemainderCheckbox = overlay.querySelector('#journal-latest-include-remainder');
        const splitButton = overlay.querySelector('button[data-choice="split"]');

        const getSplitSize = () => {
            const value = parseInt(splitInput ? splitInput.value : '', 10);
            return (isNaN(value) || value < 1) ? interval : value;
        };

        const updateSplitPreview = () => {
            const splitSize = getSplitSize();
            const completedBatchCount = Math.floor(unsummarizedCount / splitSize);
            const remainderCount = Math.max(0, unsummarizedCount - (completedBatchCount * splitSize));

            if (splitInfo) {
                splitInfo.textContent = `按每 ${splitSize} 条计算，可拆出 ${completedBatchCount} 个完整批次${remainderCount > 0 ? `，另有 ${remainderCount} 条零头消息。` : '。'}`;
            }

            if (splitButton) {
                splitButton.textContent = `按每 ${splitSize} 条拆分`;
            }

            if (remainderLabel) {
                remainderLabel.style.opacity = remainderCount > 0 ? '1' : '0.6';
                const remainderText = remainderLabel.querySelector('span');
                if (remainderText) {
                    remainderText.textContent = remainderCount > 0
                        ? `拆分时将末尾不足 ${splitSize} 条的 ${remainderCount} 条消息也单独总结成篇`
                        : '当前没有零头消息，拆分时会全部按完整批次生成';
                }
            }

            if (includeRemainderCheckbox) {
                if (remainderCount > 0) {
                    includeRemainderCheckbox.disabled = false;
                    if (!includeRemainderCheckbox.dataset.userTouched) {
                        includeRemainderCheckbox.checked = true;
                    }
                } else {
                    includeRemainderCheckbox.checked = false;
                    includeRemainderCheckbox.disabled = true;
                }
            }
        };

        if (includeRemainderCheckbox) {
            includeRemainderCheckbox.addEventListener('change', () => {
                includeRemainderCheckbox.dataset.userTouched = 'true';
            });
        }

        if (splitInput) {
            splitInput.addEventListener('input', updateSplitPreview);
            splitInput.addEventListener('blur', () => {
                splitInput.value = String(getSplitSize());
                updateSplitPreview();
            });
        }

        const finalize = (result) => {
            document.removeEventListener('keydown', handleKeydown);
            overlay.remove();
            resolve(result);
        };

        const handleKeydown = (event) => {
            if (event.key === 'Escape') {
                finalize(null);
            }
        };

        document.addEventListener('keydown', handleKeydown);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                finalize(null);
                return;
            }

            const button = event.target.closest('button[data-choice]');
            if (!button) return;

            const choice = button.dataset.choice;
            if (choice === 'cancel') {
                finalize(null);
                return;
            }

            finalize({
                mode: choice,
                splitSize: getSplitSize(),
                includeRemainder: !!(includeRemainderCheckbox && !includeRemainderCheckbox.disabled && includeRemainderCheckbox.checked)
            });
        });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));
        updateSplitPreview();
        if (splitInput) {
            splitInput.focus();
            splitInput.select();
        }
    });
}

function getCurrentSettingsAutoJournalElements(chatType) {
    if (chatType === 'group') {
        return {
            retryButton: document.getElementById('setting-group-auto-journal-retry-btn'),
            latestButton: document.getElementById('setting-group-summarize-latest-btn'),
            intervalInput: document.getElementById('setting-group-auto-journal-interval')
        };
    }

    return {
        retryButton: document.getElementById('setting-auto-journal-retry-btn'),
        latestButton: document.getElementById('setting-summarize-latest-btn'),
        intervalInput: document.getElementById('setting-auto-journal-interval')
    };
}

let autoJournalVisualChatId = null;
let autoJournalVisualChatType = null;
let autoJournalVisualizationInitialized = false;
let autoJournalVisualReturnFocus = null;

function getAutoJournalVisualChat(chatId, chatType) {
    return chatType === 'group'
        ? db.groups.find(group => group.id === chatId)
        : db.characters.find(character => character.id === chatId);
}

function getAutoJournalVisualState(chat, info) {
    const active = typeof autoJournalActiveTasks !== 'undefined' && autoJournalActiveTasks.has(chat.id);
    if (!chat.autoJournalEnabled) return { text: '未开启', className: '' };
    if (active || chat.autoJournalState === 'running') return { text: '正在生成', className: 'is-running' };
    if (chat.autoJournalState === 'failed') return { text: '需要处理', className: 'is-failed' };
    if (info.completedBatchCount > 0) return { text: '等待处理', className: 'is-ready' };
    if (info.unsummarizedCount === 0 && info.nextStartIndex > 0) return { text: '已到最新', className: 'is-ready' };
    return { text: '正在累计', className: 'is-ready' };
}

function refreshAutoJournalVisualizationEntry(chat, chatType, info = null) {
    const buttonId = chatType === 'group' ? 'setting-group-auto-journal-visual-btn' : 'setting-auto-journal-visual-btn';
    const button = document.getElementById(buttonId);
    if (!button || currentChatId !== chat.id || currentChatType !== chatType) return;

    const cursorInfo = info || getAutoJournalCursorInfo(chat);
    const state = getAutoJournalVisualState(chat, cursorInfo);
    const progress = cursorInfo.completedBatchCount > 0
        ? cursorInfo.interval
        : (cursorInfo.unsummarizedCount % cursorInfo.interval);
    const text = button.querySelector('.auto-journal-visual-entry-text');
    if (text) {
        text.textContent = state.className === 'is-failed'
            ? '需要重试 · 查看'
            : `${progress}/${cursorInfo.interval} · 查看`;
    }
    button.title = `${state.text}，打开自动总结进度`;
}

function createAutoJournalRangeItem({ state, rangeText, detail, failed = false, pending = false }) {
    const item = document.createElement('div');
    item.className = 'auto-journal-range-item';

    const dot = document.createElement('span');
    dot.className = `auto-journal-range-dot${failed ? ' is-failed' : (pending ? ' is-pending' : '')}`;
    dot.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'auto-journal-range-main';
    const name = document.createElement('div');
    name.className = 'auto-journal-range-name';
    name.textContent = rangeText;
    const sub = document.createElement('div');
    sub.className = 'auto-journal-range-detail';
    sub.textContent = detail;
    main.append(name, sub);

    const stateEl = document.createElement('span');
    stateEl.className = `auto-journal-range-state${failed ? ' is-failed' : ''}`;
    stateEl.textContent = state;
    item.append(dot, main, stateEl);
    return item;
}

function renderAutoJournalVisualization(chat, chatType) {
    if (!chat) return;
    ensureAutoJournalState(chat);

    const modal = document.getElementById('auto-journal-visual-modal');
    if (!modal) return;

    const info = getAutoJournalCursorInfo(chat);
    const state = getAutoJournalVisualState(chat, info);
    const completedBatchCount = info.completedBatchCount;
    const batchProgress = completedBatchCount > 0 ? info.interval : (info.unsummarizedCount % info.interval);
    const progressPercent = info.interval > 0 ? Math.min(100, Math.round((batchProgress / info.interval) * 100)) : 0;
    const remaining = completedBatchCount > 0 ? 0 : Math.max(0, info.interval - batchProgress);

    const status = document.getElementById('auto-journal-visual-status');
    status.textContent = state.text;
    status.className = `auto-journal-status-pill${state.className ? ` ${state.className}` : ''}`;

    const progressLabel = document.getElementById('auto-journal-progress-label');
    progressLabel.textContent = completedBatchCount > 0 ? '待处理完整范围' : '距下次自动总结';
    document.getElementById('auto-journal-progress-value').textContent = completedBatchCount > 0
        ? `${completedBatchCount} 个`
        : `${batchProgress} / ${info.interval} 条`;

    const progressTrack = document.getElementById('auto-journal-progress-track');
    progressTrack.setAttribute('aria-valuenow', String(progressPercent));
    document.getElementById('auto-journal-progress-fill').style.width = `${progressPercent}%`;
    document.getElementById('auto-journal-progress-cursor').textContent = info.nextStartIndex > 0
        ? `已总结至第 ${info.nextStartIndex} 条`
        : '尚未生成自动总结';
    document.getElementById('auto-journal-progress-remaining').textContent = completedBatchCount > 0
        ? `${completedBatchCount} 个范围待处理`
        : `还有 ${remaining} 条触发`;

    const isRunning = state.className === 'is-running';
    const latestButton = document.getElementById('auto-journal-visual-latest');
    const retryButton = document.getElementById('auto-journal-visual-retry');
    latestButton.disabled = isRunning || info.unsummarizedCount <= 0;
    retryButton.disabled = isRunning || completedBatchCount <= 0;
    retryButton.textContent = chat.autoJournalState === 'failed' ? '重试失败范围' : '补生成完整范围';

    const list = document.getElementById('auto-journal-range-list');
    list.replaceChildren();

    if (info.unsummarizedCount > 0) {
        const pendingEnd = completedBatchCount > 0
            ? info.nextStartIndex + info.interval
            : info.history.length;
        list.appendChild(createAutoJournalRangeItem({
            state: chat.autoJournalState === 'failed' ? '失败' : (completedBatchCount > 0 ? '待处理' : '累计中'),
            rangeText: `第 ${info.nextStartIndex + 1}–${pendingEnd} 条`,
            detail: chat.autoJournalState === 'failed'
                ? '上次未完成，消息范围没有被跳过'
                : (completedBatchCount > 0 ? `已达到每 ${info.interval} 条的总结间隔` : `当前累计 ${batchProgress} 条消息`),
            failed: chat.autoJournalState === 'failed',
            pending: chat.autoJournalState !== 'failed'
        }));
    }

    const completedJournals = (chat.memoryJournals || [])
        .filter(journal => journal
            && journal.range
            && Number.isFinite(Number(journal.range.start))
            && Number.isFinite(Number(journal.range.end))
            && !journal.isNodeSummary)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 5);
    completedJournals.forEach(journal => {
        list.appendChild(createAutoJournalRangeItem({
            state: '已总结',
            rangeText: `第 ${journal.range.start}–${journal.range.end} 条`,
            detail: journal.title || '自动总结'
        }));
    });

    if (!list.children.length) {
        const empty = document.createElement('div');
        empty.className = 'auto-journal-range-empty';
        empty.textContent = '还没有自动总结记录';
        list.appendChild(empty);
    }

    refreshAutoJournalVisualizationEntry(chat, chatType, info);
}

function closeAutoJournalVisualization() {
    const modal = document.getElementById('auto-journal-visual-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
    autoJournalVisualChatId = null;
    autoJournalVisualChatType = null;
    if (autoJournalVisualReturnFocus && autoJournalVisualReturnFocus.isConnected) {
        autoJournalVisualReturnFocus.focus();
    }
    autoJournalVisualReturnFocus = null;
}

function openAutoJournalVisualization(chat, chatType) {
    const modal = document.getElementById('auto-journal-visual-modal');
    if (!modal || !chat) return;
    autoJournalVisualReturnFocus = document.activeElement;
    autoJournalVisualChatId = chat.id;
    autoJournalVisualChatType = chatType;
    renderAutoJournalVisualization(chat, chatType);
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
    const closeButton = document.getElementById('auto-journal-visual-close');
    if (closeButton) closeButton.focus();
}

async function runAutoJournalVisualAction(action) {
    const chat = getAutoJournalVisualChat(autoJournalVisualChatId, autoJournalVisualChatType);
    if (!chat) {
        closeAutoJournalVisualization();
        return;
    }

    if (action === 'retry') {
        await retryAutoJournalForChat(chat, { chatType: autoJournalVisualChatType });
    } else if (action === 'latest') {
        const info = getAutoJournalCursorInfo(chat);
        if (info.unsummarizedCount <= 0) return;
        const choice = await askSummarizeLatestOptions(info);
        if (!choice) return;
        await summarizeUntilLatest(chat, {
            chatType: autoJournalVisualChatType,
            mode: choice.mode,
            splitSize: choice.splitSize,
            includeRemainder: choice.includeRemainder
        });
    }

    renderAutoJournalVisualization(chat, autoJournalVisualChatType);
}

function setupAutoJournalVisualization() {
    if (autoJournalVisualizationInitialized) return;
    const modal = document.getElementById('auto-journal-visual-modal');
    if (!modal) return;
    autoJournalVisualizationInitialized = true;

    document.querySelectorAll('[data-auto-journal-chat-type]').forEach(button => {
        button.addEventListener('click', () => {
            const chatType = button.dataset.autoJournalChatType;
            const chat = getAutoJournalVisualChat(currentChatId, chatType);
            openAutoJournalVisualization(chat, chatType);
        });
    });

    document.getElementById('auto-journal-visual-close').addEventListener('click', closeAutoJournalVisualization);
    document.getElementById('auto-journal-visual-latest').addEventListener('click', () => runAutoJournalVisualAction('latest'));
    document.getElementById('auto-journal-visual-retry').addEventListener('click', () => runAutoJournalVisualAction('retry'));
    modal.addEventListener('click', event => {
        if (event.target === modal) closeAutoJournalVisualization();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('visible')) {
            closeAutoJournalVisualization();
        }
    });
}

function refreshAutoJournalButton(chat, chatType = null) {
    if (!chat) return;

    ensureAutoJournalState(chat);

    const resolvedChatType = chatType || getAutoJournalChatType(chat);
    refreshAutoJournalVisualizationEntry(chat, resolvedChatType);
    if (autoJournalVisualChatId === chat.id && autoJournalVisualChatType === resolvedChatType) {
        renderAutoJournalVisualization(chat, resolvedChatType);
    }
    if (typeof currentChatId !== 'undefined' && (currentChatId !== chat.id || currentChatType !== resolvedChatType)) return;
    const { retryButton, latestButton } = getCurrentSettingsAutoJournalElements(resolvedChatType);
    if (!retryButton && !latestButton) return;

    const pendingRange = getNextAutoJournalRange(chat);
    const hasPendingBatch = !!pendingRange;
    const isRunning = chat.autoJournalState === 'running';
    const hasFailed = chat.autoJournalState === 'failed';

    if (retryButton) {
        retryButton.disabled = isRunning;
        retryButton.textContent = isRunning
            ? '自动总结进行中...'
            : (hasFailed ? '重试自动总结（上次失败）' : (hasPendingBatch ? '重试自动总结（有待补）' : '重试自动总结'));

        retryButton.style.background = hasFailed ? '#ffe7e7' : '';
        retryButton.style.color = hasFailed ? '#c62828' : '';
        retryButton.style.borderColor = hasFailed ? '#f2b8b5' : '';
        retryButton.style.fontWeight = hasFailed ? '600' : '';
    }

    if (latestButton) {
        latestButton.disabled = isRunning;
        latestButton.textContent = isRunning ? '总结进行中...' : '总结到最新';
    }
}

async function saveAutoJournalChatStrict(chat, chatType) {
    if (typeof dexieDB === 'undefined' || !dexieDB) {
        throw new Error('本地数据库尚未初始化，无法保存自动总结。');
    }

    const table = chatType === 'private' ? dexieDB.characters : dexieDB.groups;
    if (!table || typeof table.put !== 'function') {
        throw new Error('找不到自动总结对应的本地数据表。');
    }

    await table.put(chat);
}

async function commitAutoJournalBatch(chat, chatType, generationResult) {
    const journal = generationResult && generationResult.journal;
    const endMessage = generationResult && generationResult.rangeEndMessage;
    const expectedMessageIds = generationResult && generationResult.rangeMessageIds;
    const expectedMessageSignature = generationResult && generationResult.rangeMessageSignature;
    if (!journal || !endMessage || !endMessage.id) {
        throw new Error('自动总结缺少有效的范围边界，未写入总结。');
    }

    const liveEndMessage = (chat.history || []).find(message => message.id === endMessage.id);
    if (!liveEndMessage) {
        throw new Error('总结期间消息范围发生了变化，请重试该范围。');
    }

    if (Array.isArray(expectedMessageIds) && expectedMessageIds.length > 0) {
        const liveStartIndex = (chat.history || []).findIndex(message => message.id === expectedMessageIds[0]);
        const liveEndIndex = (chat.history || []).findIndex(message => message.id === expectedMessageIds[expectedMessageIds.length - 1]);
        const liveMessageIds = liveStartIndex !== -1 && liveEndIndex >= liveStartIndex
            ? chat.history.slice(liveStartIndex, liveEndIndex + 1).map(message => message && message.id).filter(Boolean)
            : [];
        if (liveMessageIds.length !== expectedMessageIds.length
            || liveMessageIds.some((messageId, index) => messageId !== expectedMessageIds[index])) {
            throw new Error('总结期间消息范围发生了变化，请重试该范围。');
        }
        if (expectedMessageSignature) {
            const liveMessageSignature = JSON.stringify(chat.history.slice(liveStartIndex, liveEndIndex + 1).map(message => ({
                id: message && message.id,
                role: message && message.role,
                content: message && message.content,
                parts: message && message.parts,
                timestamp: message && message.timestamp
            })));
            if (liveMessageSignature !== expectedMessageSignature) {
                throw new Error('总结期间消息内容发生了变化，请重试该范围。');
            }
        }
    }

    if (!Array.isArray(chat.memoryJournals)) chat.memoryJournals = [];
    const jobKey = `${chat.id}:${journal.range.startMessageId || journal.range.start}:${journal.range.endMessageId || journal.range.end}`;
    const existing = chat.memoryJournals.find(item => item.autoJournalJobKey === jobKey);
    if (existing) {
        const duplicateSnapshot = {
            lastSummarizedMsgId: chat.lastSummarizedMsgId,
            lastSummarizedMsgTimestamp: chat.lastSummarizedMsgTimestamp,
            lastAutoJournalIndex: chat.lastAutoJournalIndex,
            autoJournalState: chat.autoJournalState,
            autoJournalPending: chat.autoJournalPending
        };
        setAutoJournalCursorByMessage(chat, liveEndMessage);
        chat.lastAutoJournalIndex = (chat.history || []).findIndex(message => message.id === liveEndMessage.id) + 1;
        chat.autoJournalPending = false;
        try {
            await saveAutoJournalChatStrict(chat, chatType);
            return existing;
        } catch (error) {
            Object.assign(chat, duplicateSnapshot);
            throw error;
        }
    }

    const snapshot = {
        lastSummarizedMsgId: chat.lastSummarizedMsgId,
        lastSummarizedMsgTimestamp: chat.lastSummarizedMsgTimestamp,
        lastAutoJournalIndex: chat.lastAutoJournalIndex,
        autoJournalState: chat.autoJournalState,
        autoJournalPending: chat.autoJournalPending
    };

    journal.autoJournalJobKey = jobKey;
    chat.memoryJournals.push(journal);
    setAutoJournalCursorByMessage(chat, liveEndMessage);
    chat.lastAutoJournalIndex = (chat.history || []).findIndex(message => message.id === liveEndMessage.id) + 1;
    chat.autoJournalPending = false;

    try {
        await saveAutoJournalChatStrict(chat, chatType);
        return journal;
    } catch (error) {
        chat.memoryJournals = chat.memoryJournals.filter(item => item !== journal);
        Object.assign(chat, snapshot);
        throw error;
    }
}

function schedulePendingAutoJournal(chat) {
    if (!chat || !chat.id) return;

    clearTimeout(autoJournalRetryTimers[chat.id]);
    autoJournalRetryTimers[chat.id] = setTimeout(() => {
        flushPendingAutoJournal(chat.id);
    }, 1200);
}

async function flushPendingAutoJournal(chatId) {
    const chat = db.characters.find(character => character.id === chatId) || db.groups.find(group => group.id === chatId);
    if (!chat) return;

    ensureAutoJournalState(chat);
    if (!chat.autoJournalPending) {
        return;
    }

    if (typeof isGenerating !== 'undefined' && isGenerating) {
        schedulePendingAutoJournal(chat);
        return;
    }

    await processAutoJournal(chat, {
        force: true,
        processAllAvailable: true,
        showNoPendingToast: false
    });
}

async function processAutoJournal(chat, options = {}) {
    if (!chat) return { status: 'noop', generatedCount: 0 };

    ensureAutoJournalState(chat);

    if (typeof autoJournalActiveTasks !== 'undefined' && autoJournalActiveTasks.has(chat.id)) {
        return { status: 'running', generatedCount: 0 };
    }

    if (!options.force && !chat.autoJournalEnabled) {
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'disabled', generatedCount: 0 };
    }

    if (chat.autoJournalState === 'running') {
        return { status: 'running', generatedCount: 0 };
    }

    if (typeof isGenerating !== 'undefined' && isGenerating) {
        chat.autoJournalPending = true;
        schedulePendingAutoJournal(chat);
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'queued', generatedCount: 0 };
    }

    const nextRange = getNextAutoJournalRange(chat);
    if (!nextRange) {
        chat.autoJournalPending = false;
        chat.autoJournalState = 'idle';
        refreshAutoJournalButton(chat, options.chatType);
        if (!options.showNoPendingToast) {
            showToast('当前没有可补的自动总结范围');
        }
        return { status: 'noop', generatedCount: 0 };
    }

    const targetChatType = options.chatType || getAutoJournalChatType(chat);
    let generatedCount = 0;
    const taskToken = Symbol(chat.id);

    autoJournalActiveTasks.set(chat.id, taskToken);

    chat.autoJournalState = 'running';
    chat.autoJournalPending = false;
    refreshAutoJournalButton(chat, targetChatType);

    try {
        do {
            const currentRange = getNextAutoJournalRange(chat);
            if (!currentRange) break;

            const generationResult = await generateJournal(
                currentRange.start,
                currentRange.end,
                !!chat.journalIncludeFavorited,
                true,
                null,
                {
                    isAutoJournal: true,
                    propagateError: true,
                    suppressSuccessToast: true,
                    deferCommit: true,
                    targetChatId: chat.id,
                    targetChatType
                }
            );

            await commitAutoJournalBatch(chat, targetChatType, generationResult);
            generatedCount++;
            if (!options.force && !chat.autoJournalEnabled) break;
        } while (options.processAllAvailable && getNextAutoJournalRange(chat));

        chat.autoJournalState = 'idle';
        chat.autoJournalPending = false;
        await saveAutoJournalChatStrict(chat, targetChatType);
        refreshAutoJournalButton(chat, targetChatType);

        if (currentChatId === chat.id && currentChatType === targetChatType && typeof renderJournalList === 'function') {
            renderJournalList();
        }

        if (options.showSuccessToast && generatedCount > 0) {
            showToast(generatedCount > 1 ? `已补生成 ${generatedCount} 篇自动总结` : '自动总结已补生成');
        }

        return { status: 'success', generatedCount };
    } catch (error) {
        console.error('自动总结失败:', error);
        chat.autoJournalState = 'failed';
        chat.autoJournalPending = false;
        try {
            await saveAutoJournalChatStrict(chat, targetChatType);
        } catch (saveError) {
            console.error('保存自动总结失败状态时出错:', saveError);
        }
        refreshAutoJournalButton(chat, targetChatType);
        
        // 高调报错：弹窗显示失败原因
        const errorMsg = error ? (error.message || String(error)) : '未知错误';
        if (typeof showAppConfirmDialog === 'function') {
            showAppConfirmDialog({
                title: '自动总结失败',
                message: `自动总结未完成：\n${errorMsg}\n\n失败范围没有被标记为已总结。下次聊天回复完成后系统会重试；您也可以随时在设置中手动触发。`,
                confirmText: '确定',
                cancelText: '' // 隐藏取消按钮
            }).catch(() => {});
        } else {
            window.alert(`自动总结失败：\n${errorMsg}`);
        }
        
        return { status: 'failed', generatedCount, error };
    } finally {
        if (autoJournalActiveTasks.get(chat.id) === taskToken) {
            autoJournalActiveTasks.delete(chat.id);
        }
    }
}

async function applyAutoJournalToggleDecision(chat, enabled, options = {}) {
    if (!chat) return { status: 'noop' };

    ensureAutoJournalState(chat);
    chat.autoJournalEnabled = enabled;

    if (!enabled) {
        chat.autoJournalPending = false;
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'disabled' };
    }

    chat.autoJournalState = 'idle';

    const info = getAutoJournalCursorInfo(chat);
    if (info.unsummarizedCount <= 0) {
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'enabled' };
    }

    const batchCount = info.completedBatchCount;
    const message = batchCount > 0
        ? `检测到当前聊天已有 ${info.unsummarizedCount} 条未纳入自动总结的消息。\n\n是否立即补总结已满 ${info.interval} 条的部分？这将生成 ${batchCount} 篇自动总结。`
        : `检测到当前聊天已有 ${info.unsummarizedCount} 条未纳入自动总结的消息。\n\n是否从这些现有消息继续累计自动总结？选择“取消”将从当前最新消息重新开始计数。`;

    let decision = 'confirm';
    if (typeof showAppConfirmDialog === 'function') {
        decision = await showAppConfirmDialog({
            title: '检测到未总结消息',
            message,
            confirmText: batchCount > 0 ? '立即补总结' : '继续累计',
            cancelText: '从最新开始',
            dismissText: '稍后再说'
        });
    } else if (!window.confirm(message)) {
        decision = 'cancel';
    }

    if (decision === 'dismiss') {
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'dismissed_keep_backlog' };
    }

    if (decision !== 'confirm') {
        resetAutoJournalCursorToLatest(chat);
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'baseline_reset' };
    }

    if (batchCount <= 0) {
        refreshAutoJournalButton(chat, options.chatType);
        return { status: 'enabled_keep_backlog' };
    }

    return processAutoJournal(chat, {
        force: true,
        processAllAvailable: true,
        showNoPendingToast: true,
        showSuccessToast: true,
        chatType: options.chatType
    });
}

async function retryAutoJournalForChat(chat, options = {}) {
    if (!chat) return { status: 'noop' };

    ensureAutoJournalState(chat);
    if (typeof autoJournalActiveTasks !== 'undefined' && autoJournalActiveTasks.has(chat.id)) {
        return { status: 'running', generatedCount: 0 };
    }
    chat.autoJournalState = 'idle';

    return processAutoJournal(chat, {
        force: true,
        processAllAvailable: true,
        showNoPendingToast: false,
        showSuccessToast: true,
        ignoreFailedState: true,
        chatType: options.chatType || getAutoJournalChatType(chat)
    });
}

async function summarizeUntilLatest(chat, options = {}) {
    if (!chat) return { status: 'noop', generatedCount: 0 };

    ensureAutoJournalState(chat);

    if (chat.autoJournalState === 'running'
        || (typeof autoJournalActiveTasks !== 'undefined' && autoJournalActiveTasks.has(chat.id))
        || (typeof isGenerating !== 'undefined' && isGenerating)) {
        showToast('正在总结中，请稍候...');
        return { status: 'running', generatedCount: 0 };
    }

    const info = getAutoJournalCursorInfo(chat);
    if (info.unsummarizedCount <= 0) {
        showToast('当前没有新增消息需要总结');
        return { status: 'noop', generatedCount: 0 };
    }

    const start = info.nextStartIndex + 1;
    const end = info.history.length;
    const interval = info.interval;
    const mode = options.mode === 'split' ? 'split' : 'single';
    const splitSize = Math.max(1, parseInt(options.splitSize, 10) || interval);
    const completedBatchCount = Math.floor(info.unsummarizedCount / splitSize);
    const remainderCount = Math.max(0, info.unsummarizedCount - (completedBatchCount * splitSize));
    const includeRemainder = remainderCount > 0 ? options.includeRemainder !== false : true;
    const targetChatType = options.chatType || getAutoJournalChatType(chat);
    let generatedCount = 0;
    let finalCursorEnd = null;
    const taskToken = Symbol(chat.id);

    autoJournalActiveTasks.set(chat.id, taskToken);

    chat.autoJournalState = 'running';
    chat.autoJournalPending = false;
    refreshAutoJournalButton(chat, targetChatType);

    try {
        if (mode === 'split') {
            const fullBatchEnd = start - 1 + (completedBatchCount * splitSize);
            const limit = includeRemainder ? end : fullBatchEnd;

            if (limit < start) {
                chat.autoJournalState = 'idle';
                refreshAutoJournalButton(chat, targetChatType);
                showToast(`当前未满 ${splitSize} 条，暂无可拆分的完整批次`);
                return { status: 'noop', generatedCount: 0 };
            }

            let cursor = start;
            while (cursor <= limit) {
                const batchEnd = Math.min(cursor + splitSize - 1, limit);
                const generationResult = await generateJournal(
                    cursor,
                    batchEnd,
                    !!chat.journalIncludeFavorited,
                    true,
                    null,
                    {
                        isAutoJournal: true,
                        propagateError: true,
                        suppressSuccessToast: true,
                        deferCommit: true,
                        targetChatId: chat.id,
                        targetChatType
                    }
                );

                await commitAutoJournalBatch(chat, targetChatType, generationResult);
                finalCursorEnd = batchEnd;
                generatedCount++;
                cursor = batchEnd + 1;
            }
        } else {
            const generationResult = await generateJournal(
                start,
                end,
                !!chat.journalIncludeFavorited,
                true,
                null,
                {
                    isAutoJournal: true,
                    propagateError: true,
                    suppressSuccessToast: true,
                    deferCommit: true,
                    targetChatId: chat.id,
                    targetChatType
                }
            );

            await commitAutoJournalBatch(chat, targetChatType, generationResult);
            finalCursorEnd = end;
            generatedCount = 1;
        }

        chat.autoJournalState = 'idle';
        chat.autoJournalPending = false;
        await saveAutoJournalChatStrict(chat, targetChatType);
        refreshAutoJournalButton(chat, targetChatType);

        if (currentChatId === chat.id && currentChatType === targetChatType && typeof renderJournalList === 'function') {
            renderJournalList();
        }

        if (mode === 'split') {
            const remainingCount = Math.max(0, end - (finalCursorEnd || 0));
            if (remainingCount > 0) {
                showToast(`已按每 ${splitSize} 条生成 ${generatedCount} 篇总结，剩余 ${remainingCount} 条消息待下次处理`);
            } else {
                showToast(generatedCount > 1 ? `已按每 ${splitSize} 条生成 ${generatedCount} 篇总结` : `已按每 ${splitSize} 条生成 1 篇总结`);
            }
        } else {
            showToast(`已总结到最新 (第${start}-${end}条)`);
        }

        return { status: 'success', generatedCount, endIndex: finalCursorEnd };
    } catch (error) {
        console.error('总结到最新失败:', error);
        chat.autoJournalState = 'idle';
        chat.autoJournalPending = false;
        try {
            await saveAutoJournalChatStrict(chat, targetChatType);
        } catch (saveError) {
            console.error('保存总结到最新失败状态时出错:', saveError);
        }
        refreshAutoJournalButton(chat, targetChatType);
        showApiError(error);
        return { status: 'failed', generatedCount, error };
    } finally {
        if (autoJournalActiveTasks.get(chat.id) === taskToken) {
            autoJournalActiveTasks.delete(chat.id);
        }
    }
}

/**
 * 在 AI 回复完成后调用：若开启自动总结且达到间隔，则按消息 ID 游标补齐下一个完整区间。
 * @param {Object} chat - 当前聊天对象（character 或 group）
 */
async function checkAndTriggerAutoJournal(chat) {
    if (!chat || !chat.autoJournalEnabled) return;

    ensureAutoJournalState(chat);

    await processAutoJournal(chat, {
        force: false,
        processAllAvailable: true,
        showNoPendingToast: true
    });
}
