function escapeJournalHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parseJournalResponse(rawContent) {
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
        throw new Error('总结 API 返回了空内容。');
    }

    const cleaned = rawContent.trim()
        .replace(/^```(?:xml|json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const titleMatch = cleaned.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    const contentMatch = cleaned.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i);
    let title = titleMatch ? titleMatch[1].trim() : '';
    let content = contentMatch ? contentMatch[1].trim() : '';

    if (!title || !content) {
        try {
            const parsed = JSON.parse(cleaned);
            const candidate = parsed && typeof parsed.journal === 'object' ? parsed.journal : parsed;
            title = typeof candidate.title === 'string' ? candidate.title.trim() : title;
            content = typeof candidate.content === 'string' ? candidate.content.trim() : content;
        } catch (_) {
            // XML and JSON are both accepted; invalid output is handled below.
        }
    }

    if (!title || !content) {
        throw new Error('总结 API 返回格式不正确：缺少有效的标题或正文，原消息范围未标记为已总结。');
    }

    return { title, content };
}

async function requestJournalSummary(apiConfig, summaryPrompt) {
    let { url, key, model, provider } = apiConfig || {};
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiConfig) : (!url || !key || !model)) {
        throw new Error('API设置不完整。');
    }

    url = url.replace(/\/+$/, '');
    const selectedKey = typeof getRandomValue === 'function' ? getRandomValue(key) : key;
    let requestBody;
    let endpoint;
    let headers;

    if (provider === 'gemini') {
        requestBody = {
            contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
            generationConfig: { temperature: 0.7 }
        };
        endpoint = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(selectedKey)}`;
        headers = { 'Content-Type': 'application/json' };
    } else {
        requestBody = {
            model,
            messages: [{ role: 'user', content: summaryPrompt }],
            temperature: 0.7
        };
        endpoint = `${url}/v1/chat/completions`;
        headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${selectedKey}` };
    }

    return fetchAiResponse(apiConfig, requestBody, headers, endpoint);
}

function renderJournalList(searchQuery = '') {
    const container = document.getElementById('journal-list-container');
    const placeholder = document.getElementById('no-journals-placeholder');
    container.innerHTML = '';

    const chat = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    let journals = chat ? chat.memoryJournals : [];

    if (searchQuery && journals) {
        const lowerQuery = searchQuery.toLowerCase();
        journals = journals.filter(j => j.title && j.title.toLowerCase().includes(lowerQuery));
    }

    // 更新标题和按钮显示
    const bindBtn = document.getElementById('bind-journal-worldbook-btn');
    const title = document.querySelector('#memory-journal-screen .title');
    
    if (currentChatType === 'group') {
        if (bindBtn) bindBtn.style.display = 'none';
        if (title) title.textContent = '智能总结';
        if (placeholder) {
            placeholder.innerHTML = '<p>还没有总结哦~</p><p>点击右上角的“+号”来生成第一篇吧！</p>';
        }
    } else {
        if (bindBtn) bindBtn.style.display = 'flex';
        if (title) title.textContent = '回忆日记';
        if (placeholder) {
            placeholder.innerHTML = '<p>还没有日记哦~</p><p>点击右上角的“+号”来创建第一篇吧！</p>';
        }
    }

    let isShowingLoading = false;
    // 恢复生成状态卡片
    if (typeof isGenerating !== 'undefined' && isGenerating && generatingChatId === currentChatId) {
        const loadingCard = document.createElement('li');
        loadingCard.className = 'journal-card generating';
        loadingCard.id = 'journal-generating-card';
        loadingCard.innerHTML = `
            <div class="spinner"></div>
            <div class="text">正在${currentChatType === 'group' ? '总结群聊' : '编织回忆'}...</div>
        `;
        container.appendChild(loadingCard);
        isShowingLoading = true;
    }

    if ((!journals || journals.length === 0) && !isShowingLoading) {
        if (placeholder) placeholder.style.display = 'block';
        return;
    }

    if (placeholder) placeholder.style.display = 'none';

    const chatInstance = (currentChatType === 'private') ? db.characters.find(c => c.id === currentChatId) : db.groups.find(g => g.id === currentChatId);
    const favoriteTop = chatInstance ? (chatInstance.journalFavoriteTop !== false) : true; // 默认开启

    const sortedJournals = [...journals].sort((a, b) => {
        if (favoriteTop) {
            if (a.isFavorited && !b.isFavorited) return -1;
            if (!a.isFavorited && b.isFavorited) return 1;
        }
        return a.createdAt - b.createdAt;
    });

    sortedJournals.forEach(journal => {
        const card = document.createElement('li');
        card.className = 'journal-card';
        card.dataset.id = journal.id;

        const date = new Date(journal.createdAt);
        const formattedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

        let nodeTagHtml = '';
        if (journal.isNodeSummary) {
            nodeTagHtml = `<span style="font-size: 10px; background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; color: #888; margin-left: 8px;">节点总结</span>`;
        }

        card.innerHTML = `
            <div class="journal-checkbox"></div>
            <div class="journal-card-header">
                <div class="journal-card-title">${escapeJournalHtml(journal.title)}</div>
            </div>
            <div class="journal-card-actions">
                <button class="action-icon-btn favorite-journal-btn" title="收藏">
                    <svg viewBox="0 0 24 24">
                        <path class="star-outline" d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z" fill="currentColor"/>
                        <path class="star-solid" d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z"/>
                    </svg>
                </button>
                <button class="action-icon-btn delete-journal-btn" title="删除">
                    <svg viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" /></svg>
                </button>
            </div>
            <div class="journal-card-footer" style="justify-content: space-between; height: auto; opacity: 1; margin-top: 10px; align-items: center;">
                <span class="journal-card-date">${formattedDate}${nodeTagHtml}</span>
                <span class="journal-card-range">范围: ${journal.range ? `${journal.range.start}-${journal.range.end}` : '节点'}</span>
            </div>
        `;

        if (journal.isFavorited) {
            card.querySelector('.favorite-journal-btn').classList.add('favorited');
        }

        container.appendChild(card);
    });
}

async function generateJournal(start, end, includeFavorited = false, silent = false, nodeInfo = null, options = {}) {
    if (!silent) {
        showToast('正在生成日记，请稍候...');
    }

    const targetChatId = options.targetChatId || currentChatId;
    const targetChatType = options.targetChatType || currentChatType;
    const isBackgroundAutoJournal = !!options.isAutoJournal;

    // 显示列表占位卡片（后台自动总结不操作当前页面）
    const container = document.getElementById('journal-list-container');
    const placeholder = document.getElementById('no-journals-placeholder');
    if (!isBackgroundAutoJournal && container) {
        if (placeholder) placeholder.style.display = 'none';
        const loadingCard = document.createElement('li');
        loadingCard.className = 'journal-card generating';
        loadingCard.id = 'journal-generating-card';
        loadingCard.innerHTML = `
            <div class="spinner"></div>
            <div class="text">正在${targetChatType === 'group' ? '总结群聊' : '编织回忆'}...</div>
        `;
        if (container.firstChild) {
            container.insertBefore(loadingCard, container.firstChild);
        } else {
            container.appendChild(loadingCard);
        }
        container.scrollTop = 0;
    }

    if (!isBackgroundAutoJournal) {
        isGenerating = true;
        generatingChatId = targetChatId;
    }

    try {
        const chat = (targetChatType === 'private') ? db.characters.find(c => c.id === targetChatId) : db.groups.find(g => g.id === targetChatId);
        if (!chat) {
            throw new Error("未找到当前聊天。");
        }
        ensureAutoJournalState(chat);

        const startIndex = start - 1;
        const endIndex = end;

        if (startIndex < 0 || endIndex > chat.history.length || startIndex >= endIndex) {
            throw new Error("无效的消息范围。");
        }

        const rangeSnapshot = chat.history.slice(startIndex, endIndex);
        const rangeMessageIds = rangeSnapshot.map(message => message && message.id).filter(Boolean);
        const rangeMessageSignature = JSON.stringify(rangeSnapshot.map(message => ({
            id: message && message.id,
            role: message && message.role,
            content: message && message.content,
            parts: message && message.parts,
            timestamp: message && message.timestamp
        })));
        const rangeStartMessage = rangeSnapshot[0] || null;
        const rangeEndMessage = rangeSnapshot[rangeSnapshot.length - 1] || null;

        // ...
        let messagesToSummarize = rangeSnapshot;
        
        // 1. 保持原样：第三个参数设为 true，确保你想要的“高权重”隐藏消息能被读进来
        messagesToSummarize = filterHistoryForAI(chat, messagesToSummarize, true);

        // 2. 【新增】精准剔除 thinking 消息
        // 你的 chat_ai.js 中生成的思考消息带有 isThinking: true 属性
        // 即使它们包含在上下文里，我们也在生成日记前把它们扔掉
        messagesToSummarize = messagesToSummarize.filter(m => !m.isThinking);

        if (messagesToSummarize.length === 0) {
            throw new Error('所选范围内没有可用于总结的消息。');
        }

        // 3. 【可选保险】防止只有标签没有属性的情况（针对旧历史记录）
        // 如果你担心以前的历史记录里有 thinking 标签但没有 isThinking 属性，可以加一步正则清洗
        messagesToSummarize.forEach(m => {
            if (m.content && typeof m.content === 'string') {
               m.content = m.content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
            }
        });

        let worldBooksContent = '';
        let summaryPrompt = '';
        let favoritedJournalsPrompt = '';

        // 新增：读取已收藏的日记 (通用逻辑)
        if (includeFavorited) {
            const favoritedJournals = (chat.memoryJournals || [])
                .filter(j => j.isFavorited)
                .map(j => `标题：${j.title}\n内容：${j.content}`)
                .join('\n\n---\n\n');
            
            if (favoritedJournals) {
                favoritedJournalsPrompt = `【过往回顾】\n这是你之前已经写下的内容，请参考它们，以确保新内容的连续性，并避免重复记录已经记录过的事件。\n\n${favoritedJournals}\n\n`;
            }
        }

        if (targetChatType === 'group') {
            // 群聊逻辑
            // 收集关联的 + 全局的世界书（去重）
            const associatedIds = chat.worldBookIds || [];
            const globalBooks = db.worldBooks.filter(wb => wb.isGlobal && !wb.disabled);
            const globalIds = globalBooks.map(wb => wb.id);
            const allBookIds = [...new Set([...associatedIds, ...globalIds])];
            const groupWorldBooks = allBookIds.map(id => db.worldBooks.find(wb => wb.id === id)).filter(wb => wb && !wb.disabled);
            worldBooksContent = groupWorldBooks.map(wb => wb.content).join('\n\n');

            summaryPrompt = `你是一个群聊记录总结助手。请以完全客观的第三视角，对以下群聊记录进行精简总结。\n\n`;
            
            if (favoritedJournalsPrompt) {
                summaryPrompt += favoritedJournalsPrompt;
            }

            // 注入群聊基础信息
            summaryPrompt += `群聊名称: ${chat.name}\n`;
            summaryPrompt += `群成员列表: ${chat.members.map(m => `${m.groupNickname}(${m.realName})`).join(', ')}\n\n`;

            // 注入群聊关联的世界书
            if (worldBooksContent) {
                summaryPrompt += `背景设定参考:\n${worldBooksContent}\n\n`;
            }

            summaryPrompt += `总结要求：\n`;
            summaryPrompt += `1. **客观中立**：使用第三人称视角，不带个人情感色彩，不使用强烈的情绪词汇。\n`;
            summaryPrompt += `2. **精简准确**：只陈述事实，概括主要话题和事件，去除无关的闲聊细节。\n`;
            summaryPrompt += `3. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。\n\n`;

            summaryPrompt += `请严格使用以下 XML 标签格式输出你的结果，不要输出任何其他多余的解释：\n`;
            summaryPrompt += `<journal>\n`;
            summaryPrompt += `    <title>格式为“日期·核心事件”，例如“1月20日·讨论周末计划”</title>\n`;
            summaryPrompt += `    <content>总结正文。分条列出主要讨论点或事件。</content>\n`;
            summaryPrompt += `</journal>\n\n`;
            summaryPrompt += `聊天记录如下：\n\n---\n${(() => {
                let lastTime = 0;
                return messagesToSummarize.map(m => {
                    let prefix = '';
                    const currentTime = m.timestamp;
                    const timeDiff = currentTime - lastTime;
                    const isSameDay = new Date(currentTime).toDateString() === new Date(lastTime).toDateString();
                    
                    if (lastTime === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                        const d = new Date(currentTime);
                        const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                        prefix = `\n[系统时间: ${timeStr}]\n`;
                    }
                    lastTime = currentTime;
                    return `${prefix}${m.content}`;
                }).join('\n');
            })()}\n---`;

        } else {
            // 私聊逻辑
            // 0. 确保迁移
            migrateJournalSettings(chat);

            // 1. 自动获取通用世界书 (Context) + 全局世界书
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
            let associatedIds = chat.worldBookIds || [];
            if (isOfflineNode) {
                associatedIds = (chat.offlineWorldBookIds && chat.offlineWorldBookIds.length > 0) ? chat.offlineWorldBookIds : (chat.worldBookIds || []);
            }
            const globalBooks = db.worldBooks.filter(wb => wb.isGlobal && !wb.disabled);
            const globalIds = globalBooks.map(wb => wb.id);
            const allBookIds = [...new Set([...associatedIds, ...globalIds])];
            const commonWorldBooks = allBookIds.map(id => db.worldBooks.find(wb => wb.id === id)).filter(wb => wb && !wb.disabled);
            worldBooksContent = commonWorldBooks.map(wb => wb.content).join('\n\n');

            // 2. 获取风格设置
            const styleSettings = chat.journalStyleSettings || { mode: 'default', customWorldBookIds: [] };
            
            // 3. 构建 Prompt
            if (styleSettings.mode === 'summary') {
                // 摘要总结风格
                summaryPrompt = `你是一个专业的对话记录总结助手。请根据提供的聊天记录，生成一份精简的摘要总结。\n\n`;
                
                if (favoritedJournalsPrompt) {
                    summaryPrompt += favoritedJournalsPrompt;
                }

                summaryPrompt += `要求：
1. **体现时间进程**：正文内容必须按时间顺序组织，并明确指出时间点。**格式规范：**请严格按照“x年x月x日，发生了[事件]”的格式进行叙述，确保时间线清晰。
2. **客观平实**：使用第三人称视角，客观陈述事实。**绝对禁止使用强烈的情绪词汇**（如“极度愤怒”、“痛彻心扉”、“欣喜若狂”等），保持冷静、克制的叙述风格。
3. **抓取重点**：识别对话中的核心事件、重要话题转折、关键决策或信息。忽略无关的闲聊和琐碎细节。
4. **关键原话摘录（重要）**：
    - 仅当出现具有**极高情感价值**（如表白、郑重承诺、极具感染力的情感宣泄）或**重大剧情价值**（如揭示核心秘密、决定性瞬间）的对话时，请**直接引用角色的原话**。
    - **引用格式**：使用引号包裹原话，例如：${chat.realName}说：“我永远不会离开你。”
    - **严格控制数量**：只摘录最闪光、最不可替代的那几句。如果聊天记录平淡无奇或全是日常琐事，**请不要摘录任何原话**，以免破坏摘要的精简性。
5. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。

请严格使用以下 XML 标签格式输出你的结果，不要输出任何其他多余的解释：
<journal>
    <title>格式为“日期范围·核心事件”，例如“1月20日-1月22日·关于旅行计划的讨论”</title>
    <content>总结正文</content>
</journal>

聊天记录如下：\n\n---\n${(() => {
                let lastTime = 0;
                return messagesToSummarize.map(m => {
                    let prefix = '';
                    const currentTime = m.timestamp;
                    const timeDiff = currentTime - lastTime;
                    const isSameDay = new Date(currentTime).toDateString() === new Date(lastTime).toDateString();
                    
                    if (lastTime === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                        const d = new Date(currentTime);
                        const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                        prefix = `\n[系统时间: ${timeStr}]\n`;
                    }
                    lastTime = currentTime;
                    return `${prefix}${m.content}`;
                }).join('\n');
            })()}\n---`;

            } else {
                // 默认风格 (流水账) 或 自定义风格
                // 基础 Prompt (第一人称)
                summaryPrompt = `你是一个日记整理助手。请以角色 "${chat.remarkName || chat.name}" 的第一人称视角，总结以下聊天记录。请专注于重要的情绪、事件和细节。\n\n`;
                
                if (favoritedJournalsPrompt) {
                    summaryPrompt += favoritedJournalsPrompt;
                }

                summaryPrompt += "为了更好地理解角色和背景，请参考以下信息：\n";
                summaryPrompt += "=====\n";

                if (worldBooksContent) {
                    summaryPrompt += `世界观设定:\n${worldBooksContent}\n\n`;
                }

                summaryPrompt += `你的角色设定:\n- 角色名: ${chat.realName}\n- 人设: ${chat.persona || "一个友好、乐于助人的伙伴。"}\n\n`;
                summaryPrompt += `我的角色设定:\n- 我的称呼: ${chat.myName}\n- 我的人设: ${chat.myPersona || "无特定人设。"}\n\n`;
                summaryPrompt += "=====\n";

                // 如果是自定义风格，注入额外要求
                if (styleSettings.mode === 'custom') {
                    const customWorldBooks = (styleSettings.customWorldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id)).filter(wb => wb && !wb.disabled);
                    const customStyleContent = customWorldBooks.map(wb => wb.content).join('\n\n');
                    
                    if (customStyleContent) {
                        summaryPrompt += `\n**特别日记格式/风格要求**：\n请优先严格遵循以下风格指南或格式要求来撰写日记：\n${customStyleContent}\n\n`;
                    }
                }

                summaryPrompt += `请基于以上所有背景信息，总结以下聊天记录。请严格使用以下 XML 标签格式输出你的结果，不要输出任何其他多余的解释：\n<journal>\n    <title>年月日·一个简洁的标题</title>\n    <content>完整的日记正文</content>\n</journal>\n\n聊天记录如下：\n\n---\n${(() => {
                let lastTime = 0;
                return messagesToSummarize.map(m => {
                    let prefix = '';
                    const currentTime = m.timestamp;
                    const timeDiff = currentTime - lastTime;
                    const isSameDay = new Date(currentTime).toDateString() === new Date(lastTime).toDateString();
                    
                    if (lastTime === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                        const d = new Date(currentTime);
                        const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                        prefix = `\n[系统时间: ${timeStr}]\n`;
                    }
                    lastTime = currentTime;
                    return `${prefix}${m.content}`;
                }).join('\n');
            })()}\n---`;
            }
        }

        // === 使用总结API（如果已配置）===
        let apiConfig;
        if (db.summaryApiSettings && db.summaryApiSettings.url && db.summaryApiSettings.key && db.summaryApiSettings.model) {
            apiConfig = db.summaryApiSettings;
        } else {
            apiConfig = db.apiSettings;
        }
        apiConfig = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature('journal', apiConfig) : apiConfig;
        
        const rawContent = await requestJournalSummary(apiConfig, summaryPrompt);
        const journalData = parseJournalResponse(rawContent);

        const newJournal = {
            id: `journal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            range: { start, end },
            title: journalData.title,
            content: journalData.content,
            createdAt: Date.now(),
            chatId: targetChatId,
            chatType: targetChatType,
            isFavorited: false 
        };

        newJournal.range.startMessageId = rangeStartMessage ? rangeStartMessage.id : null;
        newJournal.range.endMessageId = rangeEndMessage ? rangeEndMessage.id : null;

        if (options.deferCommit) {
            return { journal: newJournal, rangeStartMessage, rangeEndMessage, rangeMessageIds, rangeMessageSignature };
        }

        // 如果是节点总结，附加节点信息
        if (nodeInfo && nodeInfo.isNodeSummary) {
            newJournal.isNodeSummary = true;
            newJournal.nodeId = nodeInfo.nodeId;
            if (nodeInfo.nodeName) {
                newJournal.title = `节点总结：${nodeInfo.nodeName}`;
            }
        }

        if (!chat.memoryJournals) {
            chat.memoryJournals = [];
        }

        // 如果是重新总结，查找并替换旧的总结
        if (nodeInfo && nodeInfo.isResummarize) {
            const existingIndex = chat.memoryJournals.findIndex(j => j.isNodeSummary && j.nodeId === nodeInfo.nodeId);
            if (existingIndex !== -1) {
                // 保留原有的 id 和 createdAt，只更新内容和标题
                chat.memoryJournals[existingIndex].content = newJournal.content;
                chat.memoryJournals[existingIndex].title = newJournal.title;
                chat.memoryJournals[existingIndex].range = newJournal.range;
            } else {
                chat.memoryJournals.push(newJournal);
            }
        } else {
            chat.memoryJournals.push(newJournal);
        }

        // 如果是节点总结，同时更新节点对象中的 summaryContent
        if (nodeInfo && nodeInfo.nodeId && chat.nodes) {
            const node = chat.nodes.find(n => n.id === nodeInfo.nodeId);
            if (node) {
                node.summaryContent = newJournal.content;
            }
        }

        if (!options.isAutoJournal && (!nodeInfo || !nodeInfo.isNodeSummary)) {
            syncAutoJournalCursorAfterManualSummary(chat, start, end);
        }

        await saveData();
        refreshAutoJournalButton(chat, targetChatType);

        if (currentChatId === targetChatId && currentChatType === targetChatType) {
            renderJournalList();
        }
        
        // 如果是重新总结且在节点大厅，刷新列表
        if (nodeInfo && nodeInfo.isResummarize && document.getElementById('node-system-screen').classList.contains('active')) {
            if (typeof NodeSystem !== 'undefined' && typeof NodeSystem.renderArchiveList === 'function') {
                NodeSystem.renderArchiveList();
            }
        }

        if (!options.suppressSuccessToast) {
            showToast(silent ? `日记总结已生成 (第${start}-${end}条)` : '新日记已生成！');
        }

    } catch (error) {
        // 移除生成卡片
        const card = document.getElementById('journal-generating-card');
        if(card) card.remove();
        
        // 如果列表为空，恢复显示 placeholder
        const chat = (targetChatType === 'private') ? db.characters.find(c => c.id === targetChatId) : db.groups.find(g => g.id === targetChatId);
        if (!chat || !chat.memoryJournals || chat.memoryJournals.length === 0) {
             const placeholder = document.getElementById('no-journals-placeholder');
             if (placeholder) placeholder.style.display = 'block';
        }

        if (options.propagateError) {
            throw error;
        }

        showApiError(error);
    } finally {
        if (!isBackgroundAutoJournal) {
            isGenerating = false;
            generatingChatId = null;
        }
    }
}
