async function getAiReply(chatId, chatType, isBackground = false, isSummary = false, isCharBlockedMonologue = false, isPhoneControlRevokeAttempt = false, replyOptions = {}) {
    if (isGenerating && !isBackground && !replyOptions.recoveryTaskId) return;

    // 拉黑检查：被拉黑的角色不回复（角色拉黑用户后的「让TA说说」不在此列）
    if (chatType === 'private' && !isCharBlockedMonologue) {
        const char = db.characters.find(c => c.id === chatId);
        if (char && char.isBlocked) return;
    }

    // 免打扰时段检查：后台消息在免打扰时段内直接跳过
    if (isBackground && isInQuietHours(chatId)) return;

    if (!isBackground && !replyOptions.recoveryTaskId) {
        if (db.globalSendSound) {
            playSound(db.globalSendSound);
        } else {
            AudioManager.unlock();
        }
    }

    // === API选择逻辑：根据场景选择不同API ===
    let apiConfig;
    
    if (isSummary && db.summaryApiSettings && db.summaryApiSettings.url && db.summaryApiSettings.key && db.summaryApiSettings.model) {
        // 总结功能且已配置总结API：使用总结专用API
        apiConfig = db.summaryApiSettings;
    } else if (isBackground && db.backgroundApiSettings && db.backgroundApiSettings.url && db.backgroundApiSettings.key && db.backgroundApiSettings.model) {
        // 后台活动且已配置后台API：使用后台活动专用API
        apiConfig = db.backgroundApiSettings;
    } else {
        // 默认使用主API
        apiConfig = db.apiSettings;
    }
    const routeChat = chatType === 'private' ? db.characters.find(item => item.id === chatId) : db.groups.find(item => item.id === chatId);
    const apiFeature = isSummary ? 'summary' : isBackground ? 'background' : (!isSummary && !isBackground && chatType === 'private' && routeChat?.webSearchEnabled ? 'webSearch' : (chatType === 'group' ? 'groupChat' : 'chat'));
    apiConfig = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature(apiFeature, apiConfig) : apiConfig;
    
    let {url, key, model, provider} = apiConfig;
    let streamEnabled = apiConfig.streamEnabled !== undefined ? apiConfig.streamEnabled : db.apiSettings.streamEnabled;
    
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiConfig) : (!url || !key || !model)) {
        if (!isBackground) {
            showToast('请先在“api”应用中完成设置！');
            switchScreen('api-settings-screen');
        }
        return;
    }

    // 确保 BLOCKED_API_DOMAINS 存在
    const blockedDomains = (typeof BLOCKED_API_DOMAINS !== 'undefined') ? BLOCKED_API_DOMAINS : [];
    if (blockedDomains.some(domain => url.includes(domain))) {
        if (!isBackground) showToast('当前 API 站点已被屏蔽，无法发送消息！');
        return;
    }

    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return;
    const backgroundReason = replyOptions.backgroundReason || 'inactivity';
    const backgroundInstruction = backgroundReason === 'followUp'
        ? `[系统通知：你刚刚已经回复过用户，但用户暂时还没有接话。请以${chat.realName}的身份，根据最近对话、人设、关系与当前时间，自然地追加一轮较简短的表达。可以补充刚想到的内容、延续上一话题、分享情绪或轻微追问；不要解释为何再次发送，不要提及系统、概率或等待规则，不要重复上一轮，也不要责怪或催促用户回复。]`
        : `[系统通知：距离上次互动已有一段时间。请以${chat.realName}的身份主动发起新话题，或自然地延续之前的对话。]`;
    const latestTurnProtectionEnabled = !isBackground && !isSummary && !!db.apiSettings?.latestTurnProtectionEnabled;
    let latestTurnIds = [];
    const recordLatestTurnProtectionCheck = check => {
        try {
            const entries = JSON.parse(localStorage.getItem('ovo_latest_turn_protection_log_v1') || '[]');
            entries.push({ at: Date.now(), chatId, requestId: replyTask?.id || '', latestTurnIds, valid: check.valid, protectedCount: check.protectedCount, missingIds: check.missingIds, roles: check.roles });
            localStorage.setItem('ovo_latest_turn_protection_log_v1', JSON.stringify(entries.slice(-50)));
        } catch (_) { /* diagnostics must not affect chat */ }
    };
    let replyTask = null;
    const resilienceEnabled = !isSummary && window.ReplyResilience;
    let requestAbortController = null;
    const persistTargetChat = async () => {
        if (chatType === 'group' && typeof saveGroup === 'function') return saveGroup(chatId);
        if (chatType === 'private' && typeof saveCharacter === 'function') return saveCharacter(chatId);
        if (typeof saveCurrentChat === 'function' && currentChatId === chatId && currentChatType === chatType) return saveCurrentChat();
    };
    const finalizeReply = async (fullResponse) => {
        if (!String(fullResponse || '').trim()) {
            const emptyError = new Error('接口未返回可用的回复内容');
            emptyError.name = 'EmptyReplyError';
            throw emptyError;
        }
        if (backgroundReason === 'followUp' && window.FollowUpReply) {
            const canFinalize = await window.FollowUpReply.confirmBeforeFinalize(chatId, replyOptions.followUpTaskId || '');
            if (!canFinalize) {
                const cancelledError = new Error('追发任务已因用户新消息或对话状态变化取消');
                cancelledError.name = 'FollowUpCancelledError';
                throw cancelledError;
            }
        }
        if (replyTask) await window.ReplyResilience.markFinalizing(replyTask, fullResponse);
        const historyLengthBefore = Array.isArray(chat.history) ? chat.history.length : 0;
        await handleAiReplyContent(fullResponse, chat, chatId, chatType, isBackground, isCharBlockedMonologue, replyOptions);
        if (replyTask && Array.isArray(chat.history)) {
            chat.history.slice(historyLengthBefore).forEach(message => {
                if (message && !message.replyRequestId) message.replyRequestId = replyTask.id;
            });
            await persistTargetChat();
            await window.ReplyResilience.complete(replyTask);
        }
        if (!isBackground && !isSummary && chatType === 'private' && window.FollowUpReply) {
            try {
                await window.FollowUpReply.scheduleAfterReply(chatId, chat.history.slice(historyLengthBefore));
            } catch (followUpScheduleError) {
                // 追发任务属于附加能力，保存失败不能把已经成功展示的正常回复判为失败。
                console.warn('[FollowUpReply] could not schedule follow-up:', followUpScheduleError);
            }
        }
    };

    if (!isBackground) {
        currentReplyAbortController = new AbortController();
        requestAbortController = currentReplyAbortController;
        isGenerating = true;
        getReplyBtn.disabled = true;
        regenerateBtn.disabled = true;
        const typingName = chatType === 'private' ? chat.remarkName : chat.name;
        typingIndicator.textContent = `“${typingName}”正在输入中...`;
        typingIndicator.style.display = 'block';
        messageArea.scrollTop = messageArea.scrollHeight;
    } else {
        // 后台请求使用独立 controller，避免前台中止或其他角色请求串线。
        requestAbortController = new AbortController();
    }

    if (resilienceEnabled) {
        try {
            const latestUserMessage = [...(chat.history || [])].reverse().find(message => message && message.role === 'user' && !message.excludeFromContext);
            replyTask = await window.ReplyResilience.begin({
                chatId,
                chatType,
                userMessageId: latestUserMessage ? latestUserMessage.id : '',
                provider,
                model,
                streamEnabled,
                isBackground: !!isBackground,
                recoveryTaskId: replyOptions.recoveryTaskId || '',
                initialState: 'preparing'
            });
        } catch (resilienceError) {
            console.warn('[ReplyResilience] could not persist request start:', resilienceError);
        }
    }

    try {
        let requestBody;
        let historySlice = chat.history.slice(-chat.maxMemory);
        
        // 节点系统：上下文截断与记忆隔离
        if (chatType === 'private' && chat.activeNodeId && chat.nodes) {
            const activeNode = chat.nodes.find(n => n.id === chat.activeNodeId);
            if (activeNode) {
                let startIndex = -1;
                for (let i = chat.history.length - 1; i >= 0; i--) {
                    const m = chat.history[i];
                    if (m.isNodeBoundary && m.nodeAction === 'start' && m.nodeId === chat.activeNodeId) {
                        startIndex = i;
                        break;
                    }
                }
                if (startIndex !== -1) {
                    // 无论是否开启 readMemory，当前对话视口严格只保留节点内的消息
                    const nodeMsgs = chat.history.slice(startIndex + 1);
                    historySlice = nodeMsgs.slice(-chat.maxMemory);
                    
                    // 上下文截断 (保留摘要)
                    if (activeNode.enableSummary) {
                        const summaryFloor = db.nodeSummaryFloor || 10;
                        const nodeMsgsInSlice = historySlice.filter(m => !m.isNodeBoundary);
                        if (nodeMsgsInSlice.length > summaryFloor) {
                            const msgsToSummarize = nodeMsgsInSlice.slice(0, nodeMsgsInSlice.length - summaryFloor);
                            historySlice = historySlice.map(m => {
                                if (msgsToSummarize.includes(m)) {
                                    if (m.isNodeSummaryMsg) {
                                        return { ...m, content: `[过往剧情摘要：${m.content}]`, parts: [{type: 'text', text: `[过往剧情摘要：${m.content}]`}] };
                                    } else if (m.nodeSummary) {
                                        // 替换为摘要消息
                                        return { ...m, content: `[过往剧情摘要：${m.nodeSummary}]`, parts: [{type: 'text', text: `[过往剧情摘要：${m.nodeSummary}]`}] };
                                    } else {
                                        // 没有摘要的旧消息直接丢弃
                                        return { ...m, isContextDisabled: true };
                                    }
                                }
                                return m;
                            });
                            
                            // 去重连续的相同摘要
                            let lastSummary = null;
                            historySlice = historySlice.filter(m => {
                                if (m.content && typeof m.content === 'string' && m.content.startsWith('[过往剧情摘要：')) {
                                    if (m.content === lastSummary) return false;
                                    lastSummary = m.content;
                                    return true;
                                }
                                lastSummary = null;
                                return true;
                            });
                        }
                    }
                }
            }
        }

        // 节点系统：过滤掉已收纳节点的消息
        if (chatType === 'private' && chat.nodes) {
            const archivedNodeIds = chat.nodes.filter(n => n.status === 'archived').map(n => n.id);
            if (archivedNodeIds.length > 0) {
                let currentArchivedNodeId = null;
                historySlice = historySlice.filter(m => {
                    if (m.isNodeBoundary) {
                        if (m.nodeAction === 'start' && archivedNodeIds.includes(m.nodeId)) {
                            currentArchivedNodeId = m.nodeId;
                            return false;
                        }
                        if (m.nodeAction === 'end' && m.nodeId === currentArchivedNodeId) {
                            currentArchivedNodeId = null;
                            return false;
                        }
                    }
                    if (currentArchivedNodeId) return false;
                    return true;
                });
            }
        }
        
        // 使用工具函数进行过滤（包含深度克隆、屏蔽过滤、双语修正、状态栏剔除）
        historySlice = filterHistoryForAI(chat, historySlice);
        // MCP 状态卡只供用户查看，所有模型供应商都不得把它当作聊天上下文。
        historySlice = historySlice.filter(m => !m.excludeFromContext && m.type !== 'mcp_activity');
        // 【新增】过滤掉不应进入上下文的消息（如思考过程、被撤回的消息标记等）
        historySlice = historySlice.filter(m => !m.isContextDisabled);
        
        // 【双重保险】再次过滤掉内容匹配 <thinking> 的消息，防止 isContextDisabled 属性丢失
        historySlice = historySlice.filter(m => {
            if (m.isThinking) return false;
            if (m.content && typeof m.content === 'string' && m.content.trim().startsWith('<thinking>')) return false;
            return true;
        });
        if (latestTurnProtectionEnabled) latestTurnIds = getLatestConversationTurnIds(historySlice);

        let weatherText = '';
        if (chatType === 'private' && window.WeatherService) {
            const charWeather = await window.WeatherService.getCharacterWeatherPrompt(chat);
            const userWeather = await window.WeatherService.getUserWeatherPrompt(chat);
            if (charWeather || userWeather) {
                weatherText = `\n<environment>\n${charWeather ? charWeather + '\n' : ''}${userWeather ? userWeather + '\n' : ''}</environment>\n`;
            }
        }

        let systemPrompt;
        if (chatType === 'private') {
            if (chat.memoryMode === 'vector' && typeof prepareVectorMemoryContext === 'function') {
                try {
                    await prepareVectorMemoryContext(chat);
                } catch (error) {
                    console.warn('[VectorMemory] failed to prepare prompt context:', error);
                }
            }
            systemPrompt = generatePrivateSystemPrompt(chat, { isPhoneControlRevokeAttempt, weatherText });
        } else {
            if (typeof generateGroupSystemPrompt === 'function') {
                systemPrompt = generateGroupSystemPrompt(chat);
            } else {
                systemPrompt = "Group chat system prompt not available.";
            }
        }

        // 检查是否开启了后台自动识图
        if (db.imageRecognitionEnabled) {
            let descApiConfig = (db.imageRecognitionApiSettings && db.imageRecognitionApiSettings.url && db.imageRecognitionApiSettings.key && db.imageRecognitionApiSettings.model) ? db.imageRecognitionApiSettings : db.apiSettings;
            descApiConfig = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature('imageChat', descApiConfig) : descApiConfig;
            
            // 从后往前找，只看开启之后的轮数（只找最新的一条用户消息）
            let lastUserMsg = null;
            for (let i = historySlice.length - 1; i >= 0; i--) {
                if (historySlice[i].role === 'user') {
                    lastUserMsg = historySlice[i];
                    break;
                }
            }

            if (lastUserMsg && lastUserMsg.parts) {
                const hasUnprocessedImage = lastUserMsg.parts.some(p => p.type === 'image' && !p.description);
                // 只有当有未处理图片且本消息还未触发过识图时才执行
                if (hasUnprocessedImage && !lastUserMsg.isImageRecognitionTriggered) {
                    const originalMsg = chat.history.find(m => m.id === lastUserMsg.id) || lastUserMsg;
                    // 打上标记，无论成功失败都只触发一次，避免死循环扣费
                    originalMsg.isImageRecognitionTriggered = true;
                    lastUserMsg.isImageRecognitionTriggered = true; 
                    
                    if (typeof saveCurrentChat === 'function') await saveCurrentChat(); // 先保存一下标记
                    
                    // 同步调用识图，等待结果后再继续，以便本轮主模型能看到图片描述
                    await generateImageDescription(originalMsg, chat, descApiConfig);
                    
                    // 同步描述到 historySlice 的 lastUserMsg 中
                    lastUserMsg.parts.forEach((p, idx) => {
                        if (p.type === 'image' && originalMsg.parts[idx] && originalMsg.parts[idx].description) {
                            p.description = originalMsg.parts[idx].description;
                        }
                    });
                }
            }
        }

        if (provider === 'gemini') {
            let lastMsgTimeForAI = 0;
            const contents = historySlice.map(msg => {
                const role = (msg.role === 'assistant' || msg.role === 'char') ? 'model' : 'user';
                let prefix = '';
                const currentMsgTime = msg.timestamp;
                const timeDiff = currentMsgTime - lastMsgTimeForAI;
                const isSameDay = new Date(currentMsgTime).toDateString() === new Date(lastMsgTimeForAI).toDateString();
               
               if (lastMsgTimeForAI === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                   const dateObj = new Date(currentMsgTime);
                   const timeStr = `${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                   
                   prefix = `[system: ${timeStr}]`;
                   
                   if (db.apiSettings && db.apiSettings.timePerceptionEnabled && timeDiff > 30 * 60 * 1000 && lastMsgTimeForAI !== 0) {
                       prefix += `\n[system: 距离上次互动已过去 ${formatTimeGap(timeDiff)}。话题可能已中断，请自然地开启新话题或对时间流逝做出反应。]`;
                   }
                   
                   prefix += '\n';
               }
                lastMsgTimeForAI = currentMsgTime;

                let parts;
                if (msg.role === 'user' && msg.quote) {
                    const replyTextMatch = msg.content.match(/\[.*?的消息：([\s\S]+?)\]/);
                    const replyText = replyTextMatch ? replyTextMatch[1] : msg.content;
                    let content = `[${chat.myName}引用“${msg.quote.content}”并回复：${replyText}]`;
                    parts = [{text: content}];
                } else if (msg.parts && msg.parts.length > 0) {
                    parts = msg.parts.map(p => {
                        if (p.type === 'text' || p.type === 'html') {
                            return {text: p.text};
                        } else if (p.type === 'image') {
                            if (apiConfig.imageMode === 'reject') return {text: '[图片未发送：当前节点被用户设为不接收图片]'};
                            if (apiConfig.imageMode === 'description') return {text: p.description ? `[图片描述：${p.description}]` : '[图片：尚无可用描述]'};
                            if (p.description) {
                                return {text: `[图片描述：${p.description}]`};
                            } else {
                                const match = p.data.match(/^data:(image\/(.+));base64,(.*)$/);
                                if (match) {
                                    if (match[1] === 'image/gif') {
                                        return {text: `[动态图片(GIF)]`};
                                    }
                                    return {inline_data: {mime_type: match[1], data: match[3]}};
                                }
                            }
                        } else if (p.type === 'sticker') {
                            if (p.description) {
                                return {text: `[表情包画面：${p.description}]`};
                            } else {
                                return {text: `[一个表情包]`}; // 兜底，不再尝试发送表情包的原图数据给API
                            }
                        }
                        return null;
                    }).filter(p => p);
                } else {
                    let content = msg.content || '';
                    // 展开小剧场分享卡片
                    const theaterShareMatch = content.match(/\[小剧场分享[：:](.+?)\]/);
                    if (theaterShareMatch) {
                        const scenarioId = theaterShareMatch[1];
                        let scenario = null;
                        if (typeof db !== 'undefined' && db) {
                            if (Array.isArray(db.theaterScenarios)) {
                                scenario = db.theaterScenarios.find(s => s.id === scenarioId);
                            }
                            if (!scenario && Array.isArray(db.theaterHtmlScenarios)) {
                                scenario = db.theaterHtmlScenarios.find(s => s.id === scenarioId);
                            }
                        }
                        if (scenario) {
                            let readableContent = scenario.content || '';
                            if (scenario.mode === 'html' || /<[^>]+>/.test(readableContent)) {
                                readableContent = readableContent
                                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                    .replace(/<[^>]+>/g, ' ')
                                    .replace(/\s{2,}/g, ' ')
                                    .trim();
                            }
                            const title = scenario.title || '小剧场';
                            const excerpt = readableContent;
                            content = content.replace(
                                /\[小剧场分享[：:].+?\]/,
                                `（我刚刚写了一篇小剧场，标题是「${title}」。以下是我写的内容：\n${excerpt}）`
                            );
                        }
                    }
                    parts = [{text: content}];
                }

                if (prefix) {
                    if (parts.length > 0 && parts[0].text) {
                        parts[0].text = prefix + parts[0].text;
                    } else {
                        parts.unshift({text: prefix});
                    }
                }
                
                if (msg.role === 'user' && chatType === 'private' && chat.characterAutoFavoriteEnabled && parts.length > 0 && parts[0].text) {
                    parts[0].text = '[id:' + msg.id + ']\n' + parts[0].text;
                }

                return { role, parts, ...(latestTurnProtectionEnabled && msg.id ? { __ovoMessageId: msg.id } : {}) };
            });

            if (contents.length > 0 && contents[contents.length - 1].role === 'model' && !isBackground && !isCharBlockedMonologue) {
                contents.push({
                    role: 'user',
                    parts: [{ text: '[继续对话。]' }]
                });
            }

            if (isBackground) {
                contents.push({
                    role: 'user',
                    parts: [{ text: backgroundInstruction }]
                });
            }
            if (isCharBlockedMonologue) {
                contents.push({
                    role: 'user',
                    parts: [{ text: '[用户正在查看对话框，你可以主动说些什么。]' }]
                });
            }

            requestBody = {
                contents: contents,
                system_instruction: {parts: [{text: systemPrompt}]},
                generationConfig: {
                    temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
                }
            };
            
            // --- Gemini 联网搜索支持 ---
            if (!isBackground && !isSummary && chatType === 'private' && chat.webSearchEnabled) {
                let customPayload = null;
                if (chat.webSearchPayload && chat.webSearchPayload.trim()) {
                    try {
                        customPayload = JSON.parse(chat.webSearchPayload.trim());
                    } catch (e) {
                        console.error("解析自定义联网参数 JSON 失败:", e);
                    }
                }
                if (customPayload && typeof customPayload === 'object') {
                    Object.assign(requestBody, customPayload);
                } else {
                    requestBody.tools = [{ googleSearch: {} }];
                }
            }
        } else {
            let messages = [{role: 'system', content: systemPrompt}];
            
            let lastMsgTimeForAI = 0;
            
            historySlice.forEach(msg => {
               let content;
               let prefix = '';
               
               const currentMsgTime = msg.timestamp;
               const timeDiff = currentMsgTime - lastMsgTimeForAI;
               const isSameDay = new Date(currentMsgTime).toDateString() === new Date(lastMsgTimeForAI).toDateString();
               
               if (lastMsgTimeForAI === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                   const dateObj = new Date(currentMsgTime);
                   const timeStr = `${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                   prefix = `[system: ${timeStr}]\n`;
               }
               lastMsgTimeForAI = currentMsgTime;

               if (msg.role === 'user' && msg.quote) {
                   const replyTextMatch = msg.content.match(/\[.*?的消息：([\s\S]+?)\]/);
                   const replyText = replyTextMatch ? replyTextMatch[1] : msg.content;
                   
                   let textContent = `${prefix}[${chat.myName}引用“${msg.quote.content}”并回复：${replyText}]`;
                   if (chatType === 'private' && chat.characterAutoFavoriteEnabled) {
                       textContent = '[id:' + msg.id + ']\n' + textContent;
                   }
                   content = [{type: 'text', text: textContent}];

               } else {
                   if (msg.parts && msg.parts.length > 0) {
                       let prefixAdded = false;
                       content = msg.parts.map(p => {
                           if (p.type === 'text' || p.type === 'html') {
                               const textContent = (!prefixAdded) ? (prefix + p.text) : p.text;
                               prefixAdded = true;
                               return {type: 'text', text: textContent};
                           } else if (p.type === 'image') {
                               const imageMode = apiConfig.imageMode || '';
                               if (imageMode === 'reject') {
                                   const textContent = (!prefixAdded ? prefix : '') + '[图片未发送：当前节点被用户设为不接收图片]';
                                   prefixAdded = true;
                                   return {type: 'text', text: textContent};
                               }
                               if (imageMode === 'description') {
                                   const textContent = (!prefixAdded ? prefix : '') + (p.description ? `[图片描述：${p.description}]` : '[图片：尚无可用描述]');
                                   prefixAdded = true;
                                   return {type: 'text', text: textContent};
                               }
                               if (p.description) {
                                   // 即便有描述，也同时把原图发给模型（如果模型支持的话）
                                   const textContent = (!prefixAdded) ? (prefix + `[图片描述：${p.description}]`) : `[图片描述：${p.description}]`;
                                   prefixAdded = true;
                                   return [
                                        {type: 'text', text: textContent},
                                        {type: 'image_url', image_url: {url: p.data}}
                                   ];
                               } else {
                                   return {type: 'image_url', image_url: {url: p.data}};
                               }
                           } else if (p.type === 'sticker') {
                               if (p.description) {
                                   const textContent = (!prefixAdded) ? (prefix + `[表情包画面：${p.description}]`) : `[表情包画面：${p.description}]`;
                                   prefixAdded = true;
                                   return {type: 'text', text: textContent};
                               } else {
                                   const textContent = (!prefixAdded) ? (prefix + `[一个表情包]`) : `[一个表情包]`;
                                   prefixAdded = true;
                                   return {type: 'text', text: textContent};
                               }
                           }
                           return null;
                       }).flat().filter(p => p);
                   } else {
                       content = prefix + msg.content;
                       const theaterShareMatch = content.match(/\[小剧场分享[：:](.+?)\]/);
                       if (theaterShareMatch) {
                           const scenarioId = theaterShareMatch[1];
                           let scenario = null;
                           if (typeof db !== 'undefined' && db) {
                               if (Array.isArray(db.theaterScenarios)) {
                                   scenario = db.theaterScenarios.find(s => s.id === scenarioId);
                               }
                               if (!scenario && Array.isArray(db.theaterHtmlScenarios)) {
                                   scenario = db.theaterHtmlScenarios.find(s => s.id === scenarioId);
                               }
                           }
                           if (scenario) {
                               let readableContent = scenario.content || '';
                               if (scenario.mode === 'html' || /<[^>]+>/.test(readableContent)) {
                                   readableContent = readableContent
                                       .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                       .replace(/<[^>]+>/g, ' ')
                                       .replace(/\s{2,}/g, ' ')
                                       .trim();
                               }
                               const title = scenario.title || '小剧场';
                               const excerpt = readableContent;
                               content = content.replace(
                                   /\[小剧场分享[：:].+?\]/,
                                   `（我刚刚写了一篇小剧场，标题是「${title}」。以下是我写的内容：\n${excerpt}）`
                               );
                           }
                       }
                   }
                   if (msg.role === 'user' && chatType === 'private' && chat.characterAutoFavoriteEnabled) {
                       if (typeof content === 'string') {
                           content = '[id:' + msg.id + ']\n' + content;
                       } else if (Array.isArray(content) && content[0] && content[0].text) {
                           content[0].text = '[id:' + msg.id + ']\n' + content[0].text;
                       }
                   }
                   
                   if (typeof content === 'string') {
                       content = [{type: 'text', text: content}];
                   }
               }
               
               const role = (msg.role === 'assistant' || msg.role === 'char') ? 'assistant' : 'user';
               
               if (Array.isArray(content) && content.every(c => c.type === 'text')) {
                    messages.push({ role: role, content: content.map(c => c.text).join(''), ...(latestTurnProtectionEnabled && msg.id ? { __ovoMessageId: msg.id } : {}) });
                } else {
                    messages.push({ role: role, content: content, ...(latestTurnProtectionEnabled && msg.id ? { __ovoMessageId: msg.id } : {}) });
               }
            });

            if (messages.length > 1 && messages[messages.length - 1].role === 'assistant' && !isBackground && !isCharBlockedMonologue) {
                messages.push({
                    role: 'user',
                    content: '[继续对话。]'
                });
            }

            // === 【第三步：处理后台通知与 CoT 序列】 ===
            
            // 1. 如果是后台消息，先插入系统通知（作为任务输入）
            if (isBackground) {
                messages.push({
                    role: 'user',
                    content: backgroundInstruction
                });
            }
            if (isCharBlockedMonologue) {
                messages.push({
                    role: 'user',
                    content: '[用户正在查看对话框，你可以主动说些什么。]'
                });
            }

            // 2. 插入 CoT 序列（无论前台后台，只要开启就插入）
            let cotEnabled = false;
            let activePresetId = 'default';
            
            // 检查是否处于线下模式节点
            let isOfflineNode = false;
            if (chatType === 'private' && chat.activeNodeId && chat.nodes) {
                const activeNode = chat.nodes.find(n => n.id === chat.activeNodeId);
                if (activeNode) {
                    let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                                   (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
                    if (baseMode === 'offline') {
                        isOfflineNode = true;
                    }
                }
            }

            // 判断单人 CoT 设置
            let useCharCot = false;
            if (chatType === 'private' && chat.cotSettings && chat.cotSettings.enabled) {
                useCharCot = true;
            }

            if (isOfflineNode) {
                if (useCharCot) {
                    cotEnabled = chat.cotSettings.offlineEnabled;
                    activePresetId = chat.cotSettings.activeOfflinePresetId || 'default_offline';
                } else {
                    cotEnabled = db.cotSettings && db.cotSettings.offlineEnabled;
                    activePresetId = (db.cotSettings && db.cotSettings.activeOfflinePresetId) || 'default_offline';
                }
            } else {
                if (useCharCot) {
                    cotEnabled = chat.cotSettings.chatEnabled;
                    activePresetId = chat.cotSettings.activePresetId || 'default';
                } else {
                    cotEnabled = db.cotSettings && db.cotSettings.enabled;
                    activePresetId = (db.cotSettings && db.cotSettings.activePresetId) || 'default';
                }
            }
            
            const cotPolicyMode = isOfflineNode ? 'offline' : 'chat';
            const hasExplicitCotPolicy = !!db.cotSettings?.modePolicies?.[cotPolicyMode]?.runMode;
            if (cotEnabled && !hasExplicitCotPolicy) {
                let cotInstruction = '';
                const preset = (db.cotPresets || []).find(p => p.id === activePresetId);
                
                if (preset && preset.items) {
                    cotInstruction = preset.items
                        .filter(item => item.enabled)
                        .map(item => item.content)
                        .join('\n\n');
                }

                if (cotInstruction) {
                    // 1. 插入后置指令
                    messages.push({
                        role: 'system', // 或者 'user'
                        content: cotInstruction
                    });

                    // 2. 插入触发器
                    messages.push({
                        role: 'user',
                        content: '[incipere]'
                    });

                    // 3. 插入 Prefill (预填/强塞)
                    const quickReply = db.apiSettings && db.apiSettings.quickReplyEnabled;
                    messages.push({
                        role: 'assistant',
                        content: quickReply
                            ? '<thinking>\n跳过cot，专注回复\n</thinking>\n[finire]'
                            : '<thinking>'
                    });
                }
            }

        if (typeof applyConfiguredCotPolicy === 'function') {
            const configured = await applyConfiguredCotPolicy(messages, {
                mode: isOfflineNode ? 'offline' : 'chat', provider, model, nodeId: apiConfig._nodeId || '',
                presetId: activePresetId, cotEnabled, quickReply: !!db.apiSettings?.quickReplyEnabled,
                scope: isBackground ? 'background' : (chatType === 'group' ? 'group' : 'chat')
            });
            messages = configured.messages;
            var activeCotRuntime = configured;
            chat._cotDisplayMode = configured.displayMode || '';
            chat._cotTagStart = configured.tagMode === 'on' ? configured.tagStart : '';
            chat._cotTagEnd = configured.tagMode === 'on' ? configured.tagEnd : '';
        }
        if (latestTurnProtectionEnabled && latestTurnIds.length) {
            const protectedTurn = protectLatestConversationTurn(messages, latestTurnIds);
            messages = protectedTurn.messages;
            if (protectedTurn.protectedCount !== latestTurnIds.length) throw new Error('最新轮次保护失败：当前用户消息在请求组装阶段缺失');
        }
        const outgoingMessages = normalizeMessagesForProvider(messages, provider);
        requestBody = {
            model: model, 
            messages: outgoingMessages, 
            stream: streamEnabled,
            temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
        };
        if (activeCotRuntime?.nativeThinking) requestBody.__ovoThinking = activeCotRuntime.nativeThinking;
        
        // --- 联网搜索支持 (仅为主聊天 API 请求启用) ---
        if (!isBackground && !isSummary && chatType === 'private' && chat.webSearchEnabled) {
            let customPayload = null;
            if (chat.webSearchPayload && chat.webSearchPayload.trim()) {
                try {
                    customPayload = JSON.parse(chat.webSearchPayload.trim());
                } catch (e) {
                    console.error("解析自定义联网参数 JSON 失败:", e);
                }
            }

            if (customPayload && typeof customPayload === 'object') {
                // 如果用户提供了自定义参数，将其合并进 requestBody
                Object.assign(requestBody, customPayload);
            } else {
                // 如果没有自定义参数，使用原生兼容方案
                if (provider === 'gemini') {
                    requestBody.tools = [{ googleSearch: {} }];
                } else {
                    requestBody.tools = [{ type: 'web_search' }];
                }
            }
        }
        }
        if (provider === 'gemini' && db.cotSettings?.modePolicies) {
            let geminiCotMode = 'chat';
            if (chatType === 'private' && chat.activeNodeId && chat.nodes) {
                const activeNode = chat.nodes.find(node => node.id === chat.activeNodeId);
                const baseMode = activeNode?.customConfig?.baseMode || (activeNode?.type === 'offline' || (activeNode?.type === 'spinoff' && activeNode?.spinoffMode === 'offline') ? 'offline' : 'online');
                if (baseMode === 'offline') geminiCotMode = 'offline';
            }
            const geminiPolicy = db.cotSettings.modePolicies[geminiCotMode];
            if (geminiPolicy?.runMode) {
                const charCot = chatType === 'private' && chat.cotSettings?.enabled ? chat.cotSettings : null;
                const geminiCotEnabled = geminiCotMode === 'offline' ? (charCot ? charCot.offlineEnabled : db.cotSettings.offlineEnabled) : (charCot ? charCot.chatEnabled : db.cotSettings.enabled);
                const presetId = geminiCotMode === 'offline' ? (charCot?.activeOfflinePresetId || db.cotSettings.activeOfflinePresetId || 'default_offline') : (charCot?.activePresetId || db.cotSettings.activePresetId || 'default');
                const systemText = requestBody.system_instruction?.parts?.map(part => part.text || '').join('\n') || requestBody.systemInstruction?.parts?.map(part => part.text || '').join('\n') || '';
                const pseudoMessages = systemText ? [{ role: 'system', content: systemText }] : [];
                (requestBody.contents || []).forEach(content => {
                    pseudoMessages.push({ role: content.role === 'model' ? 'assistant' : 'user', ...(content.__ovoMessageId ? { __ovoMessageId: content.__ovoMessageId } : {}), content: (content.parts || []).map(part => {
                        if (part.text !== undefined) return { type: 'text', text: part.text };
                        const inline = part.inline_data || part.inlineData;
                        if (inline) return { type: 'image_url', image_url: { url: `data:${inline.mime_type || inline.mimeType};base64,${inline.data}` } };
                        return { type: 'text', text: '' };
                    }) });
                });
                activeCotRuntime = await applyConfiguredCotPolicy(pseudoMessages, { mode: geminiCotMode, scope: isBackground ? 'background' : (chatType === 'group' ? 'group' : 'chat'), provider, model, nodeId: apiConfig._nodeId || '', presetId, cotEnabled: geminiCotEnabled, quickReply: !!db.apiSettings?.quickReplyEnabled });
                if (latestTurnProtectionEnabled && latestTurnIds.length) {
                    const protectedTurn = protectLatestConversationTurn(activeCotRuntime.messages, latestTurnIds);
                    activeCotRuntime.messages = protectedTurn.messages;
                    if (protectedTurn.protectedCount !== latestTurnIds.length) throw new Error('最新轮次保护失败：Gemini 请求组装阶段缺少当前用户消息');
                }
                chat._cotDisplayMode = activeCotRuntime.displayMode || '';
                chat._cotTagStart = activeCotRuntime.tagMode === 'on' ? activeCotRuntime.tagStart : '';
                chat._cotTagEnd = activeCotRuntime.tagMode === 'on' ? activeCotRuntime.tagEnd : '';
                const converted = toGeminiContents(activeCotRuntime.messages);
                requestBody.contents = converted.contents;
                if (converted.systemInstruction) requestBody.systemInstruction = converted.systemInstruction;
                delete requestBody.system_instruction;
                if (activeCotRuntime.nativeThinking) requestBody.__ovoThinking = activeCotRuntime.nativeThinking;
            }
        }
        if (replyTask) {
            replyTask.state = replyOptions.recoveryTaskId ? 'recovering' : 'requesting';
            replyTask.provider = provider;
            replyTask.model = model;
            replyTask.streamEnabled = !!streamEnabled;
            await window.ReplyResilience.flush(replyTask);
        }
        if (!isBackground && !isSummary && window.McpChatOrchestrator && window.mcpManager) {
            const latestMcpUserMessage = [...(chat.history || [])].reverse().find(message => message && message.role === 'user' && !message.excludeFromContext);
            const mcpCatalog = window.McpChatOrchestrator.createCatalog(chat, latestMcpUserMessage);
            if (mcpCatalog.length) {
                const signal = requestAbortController ? requestAbortController.signal : undefined;
                const initialMessages = provider === 'gemini' ? [...(requestBody.contents || [])] : [...(requestBody.messages || [])];
                if (latestTurnProtectionEnabled && latestTurnIds.length) {
                    const check = validateAndStripLatestTurnProtection(
                        provider === 'gemini' ? { contents: initialMessages } : { messages: initialMessages },
                        provider === 'gemini' ? 'gemini' : 'openai_chat',
                        latestTurnIds
                    );
                    recordLatestTurnProtectionCheck(check);
                    if (!check.valid) throw new Error('最新轮次保护校验失败：MCP 请求未以本轮用户消息作为对话触发点');
                }
                const sendToolAwareRequest = async input => {
                    let toolRequestBody;
                    let toolEndpoint;
                    if (provider === 'gemini') {
                        const contents = input.messages.map(message => {
                            if (message && Array.isArray(message.parts)) return message;
                            if (message && message.role === 'tool') {
                                let responseValue;
                                try { responseValue = JSON.parse(message.content || '{}'); } catch (error) { responseValue = { result: String(message.content || '') }; }
                                return { role: 'user', parts: [{ functionResponse: { name: message.name, response: responseValue } }] };
                            }
                            return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '') }] };
                        });
                        const functionDeclarations = (input.tools || []).map(tool => tool.function).filter(Boolean).map(fn => ({ name: fn.name, description: fn.description, parameters: fn.parameters }));
                        const nativeTools = (requestBody.tools || []).filter(tool => !tool.functionDeclarations);
                        toolRequestBody = {
                            ...requestBody,
                            contents,
                            tools: functionDeclarations.length ? [...nativeTools, { functionDeclarations }] : nativeTools,
                            generationConfig: { ...(requestBody.generationConfig || {}) },
                            ...(input.requireTool && functionDeclarations.length ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: functionDeclarations.map(item => item.name) } } } : {})
                        };
                        toolEndpoint = `${url}/v1beta/models/${model}:generateContent?key=${getRandomValue(key)}`;
                    } else {
                        toolRequestBody = {
                            ...requestBody,
                            messages: input.messages,
                            stream: false,
                            ...(input.tools && input.tools.length ? { tools: input.tools, tool_choice: input.forceFinal ? 'none' : input.requireTool ? 'required' : 'auto' } : { tools: undefined, tool_choice: undefined })
                        };
                        toolEndpoint = `${url}/v1/chat/completions`;
                    }
                    const toolResponse = await fetch(toolEndpoint, {
                        method: 'POST',
                        headers: provider === 'gemini' ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                        body: JSON.stringify(toolRequestBody),
                        signal
                    });
                    if (!toolResponse.ok) throw new Error(`MCP 工具回合 API 错误：${toolResponse.status} ${(await toolResponse.text()).slice(0, 300)}`);
                    const payload = await toolResponse.json();
                    if (provider === 'gemini') {
                        const assistantMessage = payload.candidates?.[0]?.content || { role: 'model', parts: [] };
                        const parts = assistantMessage.parts || [];
                        return {
                            text: parts.filter(part => part && part.text).map(part => part.text).join(''),
                            assistantMessage,
                            toolCalls: parts.filter(part => part && part.functionCall).map((part, index) => ({ id: `gemini_${Date.now()}_${index}`, name: part.functionCall.name, arguments: part.functionCall.args || {} }))
                        };
                    }
                    const assistantMessage = payload.choices?.[0]?.message || {};
                    return {
                        text: typeof assistantMessage.content === 'string' ? assistantMessage.content : '',
                        assistantMessage,
                        toolCalls: (assistantMessage.tool_calls || []).map(call => ({ id: call.id, name: call.function && call.function.name, arguments: call.function && call.function.arguments }))
                    };
                };
                const mcpResponse = await window.McpChatOrchestrator.run({ chat, messages: initialMessages, signal, send: sendToolAwareRequest });
                if (replyTask) window.ReplyResilience.checkpoint(replyTask, mcpResponse || '', '', { state: 'finalizing' });
                await finalizeReply(mcpResponse || '');
                return true;
            }
        }
        console.log('[DEBUG] AutoReply Request Body:', JSON.stringify(requestBody));
        let endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:streamGenerateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
        let headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        };
        const unpreparedRequestBody = JSON.parse(JSON.stringify(requestBody));
        const preparedRequest = prepareAiProviderRequest(apiConfig, requestBody, headers, endpoint, streamEnabled);
        requestBody = preparedRequest.body; headers = preparedRequest.headers; endpoint = preparedRequest.endpoint; provider = preparedRequest.provider;
        if (latestTurnProtectionEnabled && latestTurnIds.length) {
            const check = validateAndStripLatestTurnProtection(requestBody, preparedRequest.protocol, latestTurnIds);
            stripLatestTurnProtectionMetadata(unpreparedRequestBody);
            recordLatestTurnProtectionCheck(check);
            if (!check.valid) throw new Error('最新轮次保护校验失败：最终请求未以本轮用户消息作为对话触发点');
        }
        const sendPrepared = (targetEndpoint, targetHeaders, targetBody) => fetch(targetEndpoint, {
            method: 'POST',
            headers: targetHeaders,
            body: JSON.stringify(targetBody),
            signal: requestAbortController ? requestAbortController.signal : undefined
        });
        let response = await sendPrepared(endpoint, headers, requestBody);
        if (!response.ok) {
            const firstErrorText = await response.text();
            let failureMode = activeCotRuntime?.prefillFailure;
            if (response.status === 400 && failureMode === 'ask') {
                failureMode = await resolveCotPerRequestChoice('预填不兼容处理', ['retry_without', 'retry_simulated', 'error']);
            }
            if (response.status === 400 && (failureMode === 'retry_without' || failureMode === 'retry_simulated')) {
                const retryBody = JSON.parse(JSON.stringify(unpreparedRequestBody));
                const last = retryBody.messages?.[retryBody.messages.length - 1];
                if (last?.role === 'assistant') retryBody.messages.pop();
                if (failureMode === 'retry_simulated') retryBody.messages.push({ role: 'user', content: activeCotRuntime.simulatedPrefillContent || '请遵循已配置的回复开头与格式要求。' });
                const retryPrepared = prepareAiProviderRequest(apiConfig, retryBody, headers, endpoint, streamEnabled);
                requestBody = retryPrepared.body; headers = retryPrepared.headers; endpoint = retryPrepared.endpoint; provider = retryPrepared.provider;
                response = await sendPrepared(endpoint, headers, requestBody);
            }
            if (!response.ok) {
                const fallbacks = typeof getApiFallbackConfigsForFeature === 'function' ? getApiFallbackConfigsForFeature(apiFeature, apiConfig._nodeId || '') : [];
                for (const fallbackConfig of fallbacks) {
                    const fallbackEndpoint = getApiConfigEndpoint(fallbackConfig, streamEnabled);
                    const fallbackHeaders = getApiConfigHeaders(fallbackConfig);
                    const fallbackPrepared = prepareAiProviderRequest(fallbackConfig, unpreparedRequestBody, fallbackHeaders, fallbackEndpoint, streamEnabled);
                    response = await sendPrepared(fallbackPrepared.endpoint, fallbackPrepared.headers, fallbackPrepared.body);
                    if (response.ok) { provider = fallbackPrepared.provider; break; }
                }
            }
            if (!response.ok) {
                const errorText = response.bodyUsed ? firstErrorText : await response.text();
                const error = new Error(`API Error: ${response.status} ${errorText}`);
                error.response = response;
                throw error;
            }
        }
        
        if (streamEnabled) {
            const streamedResponse = await processStream(response, chat, provider, chatId, chatType, isBackground, isCharBlockedMonologue, replyTask);
            await finalizeReply(streamedResponse);
        } else {
            let result;
            try {
                result = await response.json();
                console.log('【API完整响应数据】:', result);
            } catch (e) {
                const text = await response.text();
                console.error("Failed to parse JSON:", text);
                throw new Error(`API返回了非JSON格式数据 (可能是网页HTML)。请检查API地址是否正确。原始内容开头: ${text.substring(0, 50)}...`);
            }

            let fullResponse = "";
            const extracted = extractAiProviderResponse(result, provider);
            fullResponse = extracted.content;
            if (extracted.reasoning) {
                chat._lastNativeReasoning = extracted.reasoning;
                fullResponse = `<thinking>${extracted.reasoning}</thinking>\n${fullResponse}`;
            }
            
            // === 【补丁：把被吃掉的开头补回来】 ===
            // 仅在 CoT 开启且检测到闭合标签时补全
            let isOfflineNode = false;
            if (chatType === 'private' && chat.activeNodeId && chat.nodes) {
                const activeNode = chat.nodes.find(n => n.id === chat.activeNodeId);
                if (activeNode) {
                    let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                                   (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
                    if (baseMode === 'offline') {
                        isOfflineNode = true;
                    }
                }
            }
            
            let useCharCot = false;
            if (chatType === 'private' && chat.cotSettings && chat.cotSettings.enabled) {
                useCharCot = true;
            }
            
            let cotEnabled = false;
            if (isOfflineNode) {
                cotEnabled = useCharCot ? chat.cotSettings.offlineEnabled : (db.cotSettings && db.cotSettings.offlineEnabled);
            } else {
                cotEnabled = useCharCot ? chat.cotSettings.chatEnabled : (db.cotSettings && db.cotSettings.enabled);
            }
            // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
            if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
                 if (fullResponse.includes('</thinking>')) {
                     fullResponse = '<thinking>' + fullResponse;
                 }
            }
            // ===================================
            
            
            if (replyTask) window.ReplyResilience.checkpoint(replyTask, fullResponse, extracted.reasoning || '', { state: 'finalizing' });
            await finalizeReply(fullResponse);
        }

        return true;

    } catch (error) {
        if (replyTask && window.ReplyResilience) {
            try {
                await window.ReplyResilience.fail(
                    replyTask,
                    error,
                    error.name === 'AbortError' || error.name === 'FollowUpCancelledError'
                );
            } catch (_) { /* preserve original error handling */ }
        }
        if (error.name === 'AbortError') {
            if (!isBackground && typeof showToast === 'function') showToast('已暂停调用');
        } else if (error.name !== 'FollowUpCancelledError') {
            if (!isBackground) showApiError(error);
            else console.error("Background Auto-Reply Error:", error);
        }
        return false;
    } finally {
        if (replyTask && window.ReplyResilience) {
            try { await window.ReplyResilience.flush(replyTask); } catch (_) { /* best effort lifecycle checkpoint */ }
        }
        if (!isBackground) {
            currentReplyAbortController = null;
            isGenerating = false;
            getReplyBtn.disabled = false;
            regenerateBtn.disabled = false;
            // 如果正在生成小剧场，不隐藏提示（让小剧场生成过程显示提示）
            if (!typingIndicator || typingIndicator.getAttribute('data-theater-generating') !== 'true') {
                typingIndicator.style.display = 'none';
            }
        }
    }
}

async function processStream(response, chat, apiType, targetChatId, targetChatType, isBackground = false, isCharBlockedMonologue = false, replyTask = null) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let fullResponse = "", fullReasoning = "", accumulatedChunk = "";
    const processSseBlock = block => {
        const data = block.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data.trim() === '[DONE]') return;
        try {
            const extracted = extractAiProviderResponse(JSON.parse(data), apiType, true);
            fullResponse += extracted.content;
            fullReasoning += extracted.reasoning || '';
        } catch (error) {
            console.warn('[ReplyStream] ignored malformed SSE event:', error);
        }
    };
    for (; ;) {
        const {done, value} = await reader.read();
        if (done) break;
        accumulatedChunk += decoder.decode(value, {stream: true});
        if (apiType !== "gemini") {
            const parts = accumulatedChunk.split(/\r?\n\r?\n/);
            accumulatedChunk = parts.pop();
            parts.forEach(processSseBlock);
        }
        if (replyTask && window.ReplyResilience) {
            window.ReplyResilience.checkpoint(replyTask, fullResponse, fullReasoning, {
                transportBytes: (replyTask.transportBytes || 0) + (value ? value.byteLength : 0)
            });
        }
    }
    accumulatedChunk += decoder.decode();
    if (apiType !== "gemini" && accumulatedChunk.trim()) processSseBlock(accumulatedChunk);
    if (apiType === "gemini") {
        try {
            const parsedStream = JSON.parse(accumulatedChunk);
            fullResponse = parsedStream.map(item => {
                const extracted = extractAiProviderResponse(item, apiType, true);
                fullReasoning += extracted.reasoning || '';
                return extracted.content;
            }).join('');
        } catch (e) {
            console.error("Error parsing Gemini stream:", e, "Chunk:", accumulatedChunk);
            if (!isBackground) showToast("解析Gemini响应失败");
            throw e;
        }
    }
    if (replyTask && window.ReplyResilience) window.ReplyResilience.checkpoint(replyTask, fullResponse, fullReasoning);
    if (fullReasoning) {
        chat._lastNativeReasoning = fullReasoning;
        fullResponse = `<thinking>${fullReasoning}</thinking>\n${fullResponse}`;
    }
    // === 【补丁：补全流式输出时丢失的开头标签】 ===
    // 无论前台后台，只要是CoT开启且被预填吃掉了开头，都要补回来
    let isOfflineNode = false;
    if (targetChatType === 'private' && chat.activeNodeId && chat.nodes) {
        const activeNode = chat.nodes.find(n => n.id === chat.activeNodeId);
        if (activeNode) {
            let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                           (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
            if (baseMode === 'offline') {
                isOfflineNode = true;
            }
        }
    }
    
    let useCharCot = false;
    if (targetChatType === 'private' && chat.cotSettings && chat.cotSettings.enabled) {
        useCharCot = true;
    }
    
    let cotEnabled = false;
    if (isOfflineNode) {
        cotEnabled = useCharCot ? chat.cotSettings.offlineEnabled : (db.cotSettings && db.cotSettings.offlineEnabled);
    } else {
        cotEnabled = useCharCot ? chat.cotSettings.chatEnabled : (db.cotSettings && db.cotSettings.enabled);
    }
    // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
    if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
         // 这里判断：如果内容里有闭合的 </thinking> 但开头没有 <thinking>，说明开头被 Prefill 吃掉了
         if (fullResponse.includes('</thinking>')) {
             fullResponse = '<thinking>' + fullResponse;
         }
    }

    // ===================
    return fullResponse;
}

/** 返回该角色在手机掌控下可见的角色与群聊（未开启角色过滤则返回全部，开启则只返回指定的角色及所在群聊） */
