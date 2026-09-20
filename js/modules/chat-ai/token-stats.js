function estimateTokenFromText(text) {
    if (!text || typeof text !== 'string') return 0;
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const other = text.length - chinese;
    return Math.ceil(chinese * 1.2 + other * 0.4);
}

// 估算当前对话上下文的 Token 数
function estimateChatTokens(chatId, chatType = 'private') {
    const breakdown = getChatTokenBreakdown(chatId, chatType);
    return breakdown ? breakdown.total : 0;
}

// 获取 Token 分布（细分：系统规则、世界书、角色人设、用户人设、表情包、长期记忆、窥屏、对话主题、记忆互通、群聊记忆、短期记忆等），用于饼图与详情展示
function getChatTokenBreakdown(chatId, chatType = 'private') {
    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return null;

    let useCustomPrompt = false;
    const customPromptReference = chat.customPromptPresetId || chat.customPromptPreset;
    if (chatType === 'private' && customPromptReference && db.magicRoom && db.magicRoom.presets) {
        const preset = db.magicRoom.presets.find(p => p.id === customPromptReference || p.name === customPromptReference);
        if (preset) useCustomPrompt = true;
    }
    
    // 如果开启了自定义底层提示词或者是群聊，走旧逻辑（整体 systemPrompt 拆分）
    if (chatType !== 'private' || (db.magicRoom && db.magicRoom.customPromptEnabled) || useCustomPrompt) {
        return _getChatTokenBreakdownGroup(chat, chatType);
    }

    // --- 私聊：逐项独立计算各模块 Token ---
    const character = chat;
    const linkedChar = (character.source === 'forum' && character.linkedCharId && db.characters)
        ? db.characters.find(c => c.id === character.linkedCharId) : null;
    const effectiveChar = linkedChar || character;

    let activeNode = null;
    let isOfflineNode = false;
    if (character.activeNodeId && character.nodes) {
        activeNode = character.nodes.find(n => n.id === character.activeNodeId);
        if (activeNode) {
            let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                           (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
            if (baseMode === 'offline') {
                isOfflineNode = true;
            }
        }
    }

    // 1) 世界书
    const { before: worldBooksBefore, middle: worldBooksMiddle, after: worldBooksAfter } = getActiveWorldBooksContents(character);
    const worldBookText = [worldBooksBefore, worldBooksMiddle, worldBooksAfter].filter(Boolean).join('\n');
    const worldBookTokens = estimateTokenFromText(worldBookText);

    // 2) 角色人设
    const personaText = getEffectivePersona(linkedChar || character);
    const charPersonaTokens = estimateTokenFromText(personaText);

    // 3) 用户人设
    const userPersonaText = character.myPersona || '';
    const userPersonaTokens = estimateTokenFromText(userPersonaText);

    // 4) 表情包
    let stickerText = '';
    const stickerGroups = (character.stickerGroups || '').split(/[,，]/).map(s => s.trim()).filter(s => s && s !== '未分类');
    if (stickerGroups.length > 0 && db.myStickers) {
        const availableStickers = db.myStickers.filter(s => stickerGroups.includes(s.group));
        if (availableStickers.length > 0) {
            stickerText = availableStickers.map(s => s.name).join(', ');
        }
    }
    const stickerTokens = estimateTokenFromText(stickerText);

    // 5) 长期记忆（共同回忆 / 收藏日记）
    const favoritedJournals = (character.memoryJournals || [])
        .filter(j => j.isFavorited)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');
    const memoirTokens = estimateTokenFromText(favoritedJournals);

    // 6) 窥屏知晓 + 代发消息（冒充）知晓
    let peekText = '';
    if (character.peekScreenSettings?.charAwarePeek && character.peekViewedByUser && character.peekViewedByUser.length > 0) {
        peekText = character.peekViewedByUser.map(entry => {
            if (typeof formatPeekContentForPrompt === 'function') return formatPeekContentForPrompt(entry);
            return '';
        }).filter(Boolean).join('\n');
    }
    if (character.peekScreenSettings?.charAwarePeek && character.peekScreenSettings?.impersonateEnabled && character.peekData?.messages?.conversations && Array.isArray(character.peekData.messages.conversations)) {
        character.peekData.messages.conversations.forEach(cv => {
            const impersonated = (cv.history || []).filter(m => m.sender === 'char' && m.isImpersonated);
            if (impersonated.length > 0) peekText += '\n冒充' + (cv.partnerName || '某人') + '：' + impersonated.map(m => (m.content || '').slice(0, 60)).join('; ');
        });
    }
    const peekTokens = estimateTokenFromText(peekText);

    // 7) 对话主题
    let themeText = '';
    if (character.allowCharSwitchBubbleCss && Array.isArray(character.bubbleCssThemeBindings) && character.bubbleCssThemeBindings.length > 0) {
        themeText = character.bubbleCssThemeBindings.map(b => {
            const desc = (b.description && b.description.trim()) ? `：${b.description.trim()}` : '';
            return `- ${b.presetName}${desc}`;
        }).join('\n');
    }
    const themeTokens = estimateTokenFromText(themeText);

    // 8) 小号/主号记忆互通
    let altMemoryText = '';
    const enableCharAltDm = !!(db.forumSettings && db.forumSettings.enableCharAltDm);
    const syncLimit = Math.max(1, (character.maxMemory != null ? parseInt(character.maxMemory, 10) : 20) || 20);
    if (enableCharAltDm && !linkedChar) {
        const altChars = (db.characters || []).filter(c => c.source === 'forum' && c.linkedCharId === character.id);
        const altForumUserIds = [];
        altChars.forEach(c => { if (c.forumUserId) altForumUserIds.push(c.forumUserId); });
        if (db.forumStrangerProfiles) {
            Object.keys(db.forumStrangerProfiles).forEach(uid => {
                if (db.forumStrangerProfiles[uid].linkedCharId === character.id && altForumUserIds.indexOf(uid) === -1) altForumUserIds.push(uid);
            });
        }
        altForumUserIds.forEach(forumUserId => {
            const forumMsgs = (db.forumMessages || []).filter(m =>
                (m.fromUserId === 'user' && m.toUserId === forumUserId) || (m.fromUserId === forumUserId && m.toUserId === 'user')
            ).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-syncLimit);
            forumMsgs.forEach(m => { altMemoryText += (m.content || '').trim().slice(0, 200) + '\n'; });
            const altChar = altChars.find(c => c.forumUserId === forumUserId);
            if (altChar && altChar.history && altChar.history.length > 0) {
                altChar.history.filter(m => !m.isContextDisabled).slice(-syncLimit).forEach(m => {
                    altMemoryText += (m.content || '').trim().slice(0, 200) + '\n';
                });
            }
        });
    } else if (enableCharAltDm && linkedChar && linkedChar.history && linkedChar.history.length > 0) {
        const mainSyncLimit = Math.max(1, (linkedChar.maxMemory != null ? parseInt(linkedChar.maxMemory, 10) : 20) || 20);
        linkedChar.history.filter(m => !m.isContextDisabled).slice(-mainSyncLimit).forEach(m => {
            altMemoryText += (m.content || '').trim().slice(0, 200) + '\n';
        });
    }
    const altMemoryTokens = estimateTokenFromText(altMemoryText);

    // 9) 群聊记忆互通
    let groupMemoryText = '';
    if (character.syncGroupMemory) {
        let groupsWithCharacter = (db.groups || []).filter(group =>
            group.members && group.members.some(member => member.originalCharId === character.id)
        );
        if (character.syncGroupIds && Array.isArray(character.syncGroupIds) && character.syncGroupIds.length > 0) {
            groupsWithCharacter = groupsWithCharacter.filter(group => character.syncGroupIds.includes(group.id));
        }
        groupsWithCharacter.forEach(group => {
            let gJournals = (group.memoryJournals || []).filter(j => j.isFavorited);
            const summaryCount = character.groupMemorySummaryCount || 0;
            if (summaryCount > 0 && gJournals.length > summaryCount) {
                gJournals = gJournals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, summaryCount);
            }
            gJournals.forEach(j => { groupMemoryText += j.title + '\n' + j.content + '\n'; });
            const maxGroupHistory = character.groupMemoryHistoryCount || 20;
            let recentGroupHistory = (group.history || []).slice(-maxGroupHistory).filter(m => !m.isContextDisabled);
            recentGroupHistory.forEach(m => { groupMemoryText += (m.content || '') + '\n'; });
        });
    }
    const groupMemoryTokens = estimateTokenFromText(groupMemoryText);

    // 10) 活人运转
    let humanRunTokens = 0;
    if (db.cotSettings && db.cotSettings.humanRunEnabled && typeof HUMAN_RUN_PROMPT !== 'undefined') {
        humanRunTokens = estimateTokenFromText(HUMAN_RUN_PROMPT);
    }

    // 10.5) 提醒事项
    let reminderTokens = 0;
    if (character.charReminderEnabled && typeof generateReminderPrompt === 'function') {
        reminderTokens = estimateTokenFromText(generateReminderPrompt(character));
    }

    // 11) 系统规则（固定提示词框架：核心规则 + logic_rules + output_formats + chatting guidelines 等）
    //     用完整 systemPrompt 减去上面所有已拆出的部分来得到
    let fullSystemPrompt = '';
    if (typeof generatePrivateSystemPrompt === 'function') {
        fullSystemPrompt = generatePrivateSystemPrompt(character);
    }
    const fullSystemTokens = estimateTokenFromText(fullSystemPrompt);
    const identifiedPromptTokens = worldBookTokens + charPersonaTokens + userPersonaTokens + stickerTokens + memoirTokens + peekTokens + themeTokens + altMemoryTokens + groupMemoryTokens + humanRunTokens + reminderTokens;
    const systemRulesTokens = Math.max(0, fullSystemTokens - identifiedPromptTokens);

    // 12) 短期记忆（对话历史）
    let historySlice = (chat.history || []).slice(-(chat.maxMemory || 20));
    historySlice = historySlice.filter(m => !m.isContextDisabled);
    
    let lastAiIndex = -1;
    for (let i = historySlice.length - 1; i >= 0; i--) {
        if (historySlice[i].role === 'assistant' || historySlice[i].role === 'char') {
            lastAiIndex = i;
            break;
        }
    }
    
    let historyForText = [];
    let triggerMessages = [];
    
    if (lastAiIndex === -1) {
        triggerMessages = historySlice;
    } else {
        historyForText = historySlice.slice(0, lastAiIndex + 1);
        triggerMessages = historySlice.slice(lastAiIndex + 1);
    }
    
    let shortTermText = '';
    if (historyForText.length > 0) {
        const historyLines = historyForText.map(m => {
            let content = m.content || '';
            if (m.parts && m.parts.length > 0) {
                content = m.parts.map(p => p.text || '[图片]').join('');
            }
            const senderName = m.role === 'user' ? chat.myName : chat.realName;
            return `${senderName}: ${content}`;
        });
        shortTermText += `<chat_history>\n【近期聊天记录】\n这是我们刚刚的聊天记录，请作为背景参考：\n${historyLines.join('\n')}\n</chat_history>\n\n`;
    }
    
    triggerMessages.forEach(msg => {
        shortTermText += msg.content || '';
        if (msg.parts) {
            msg.parts.forEach(p => {
                if (p.type === 'text') shortTermText += p.text || '';
            });
        }
    });
    const shortTermTokens = estimateTokenFromText(shortTermText);

    // 汇总
    const total = fullSystemTokens + shortTermTokens;

    const details = [
        { key: 'systemRules',    name: '系统规则',     value: systemRulesTokens,  desc: '核心规则、输出格式、对话节奏等发送给 AI 的固定指令框架。' },
        { key: 'worldBook',      name: '世界书',       value: worldBookTokens,    desc: '关联的世界书和全局世界书内容，用于构建世界观背景。' },
        { key: 'charPersona',    name: '角色人设',     value: charPersonaTokens,  desc: '角色的性格、背景、说话风格等设定文本。' },
        { key: 'userPersona',    name: '用户人设',     value: userPersonaTokens,  desc: '你自己的人设描述，让角色了解你是谁。' },
        { key: 'sticker',        name: '表情包',       value: stickerTokens,      desc: '已绑定的表情包名称列表，角色可从中选择发送。' },
        { key: 'memoir',         name: '共同回忆',     value: memoirTokens,       desc: '已收藏的日记摘要，作为长期记忆保留在上下文中。' },
        { key: 'peek',           name: '窥屏知晓',     value: peekTokens,         desc: '用户偷看手机后注入的应用内容摘要。' },
        { key: 'theme',          name: '对话主题',     value: themeTokens,        desc: '聊天界面主题列表，角色可主动切换。' },
        { key: 'altMemory',      name: '记忆互通',     value: altMemoryTokens,    desc: '大号/小号之间的聊天记忆同步内容。' },
        { key: 'groupMemory',    name: '群聊记忆',     value: groupMemoryTokens,  desc: '角色所在群聊的总结和最近聊天记录。' },
        { key: 'humanRun',       name: '活人运转',     value: humanRunTokens,     desc: '角色活人运转心理模型指令（HEXACO 等）。' },
        { key: 'reminder',       name: '提醒事项',     value: reminderTokens,     desc: '提醒事项/待办功能提示词，让角色可以创建和管理提醒。' },
        { key: 'shortTermMemory',name: '对话历史',     value: shortTermTokens,    desc: '最近的对话消息，随轮次滑动窗口更新。' }
    ].filter(d => d.value > 0);

    return { total, details };
}

// 群聊 Token 分布（保持兼容，从完整 systemPrompt 拆分）
function _getChatTokenBreakdownGroup(chat, chatType = 'group') {
    let systemPrompt = '';
    let structuredPrompt = null;
    if (chatType === 'private') {
        if (window.PromptStudio && typeof window.PromptStudio.compile === 'function') {
            structuredPrompt = window.PromptStudio.compile(chat, { preview: true });
        }
        if (structuredPrompt) {
            systemPrompt = structuredPrompt.prompt;
        } else if (typeof generatePrivateSystemPrompt === 'function') {
            systemPrompt = generatePrivateSystemPrompt(chat);
        }
    } else {
        if (typeof generateGroupSystemPrompt === 'function') {
            systemPrompt = generateGroupSystemPrompt(chat);
        }
    }
    const memoirMatch = systemPrompt.match(/<memoir>([\s\S]*?)<\/memoir>/);
    const memoirText = memoirMatch ? memoirMatch[1].trim() : '';
    const personaPrompt = systemPrompt.replace(/<memoir>[\s\S]*?<\/memoir>/g, '').trim();

    let historySlice = (chat.history || []).slice(-(chat.maxMemory || 20));
    historySlice = historySlice.filter(m => !m.isContextDisabled);
    let shortTermText = '';
    historySlice.forEach(msg => {
        shortTermText += msg.content || '';
        if (msg.parts) {
            msg.parts.forEach(p => {
                if (p.type === 'text') shortTermText += p.text || '';
            });
        }
    });

    const promptPersonaTokens = estimateTokenFromText(personaPrompt);
    const longTermTokens = estimateTokenFromText(memoirText);
    const shortTermTokens = estimateTokenFromText(shortTermText);
    const total = promptPersonaTokens + longTermTokens + shortTermTokens;

    const details = structuredPrompt
        ? structuredPrompt.details.filter(entry => entry.text).map(entry => ({
            key: `promptItem:${entry.id}`,
            name: entry.name,
            value: estimateTokenFromText(entry.text),
            desc: '条目化系统提示词中的独立条目。'
        })).concat([{ key: 'shortTermMemory', name: '短期记忆', value: shortTermTokens, desc: '最近对话消息，随轮次滑动窗口更新。' }]).filter(d => d.value > 0)
        : [
            { key: 'promptPersona', name: '提示词人设', value: promptPersonaTokens, desc: '系统规则、角色设定、输出格式等发送给 AI 的固定提示词。' },
            { key: 'longTermMemory', name: '长期记忆', value: longTermTokens, desc: '已收藏的共同回忆（日记摘要），会长期保留在上下文中。' },
            { key: 'shortTermMemory', name: '短期记忆', value: shortTermTokens, desc: '最近对话消息，随轮次滑动窗口更新。' }
        ].filter(d => d.value > 0);

    return { total, details };
}

// --- 视频/语音通话专用 AI 逻辑 ---
