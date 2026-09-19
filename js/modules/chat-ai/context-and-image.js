// --- AI 交互模块 ---

// 检查角色是否在免打扰时段内
function isInQuietHours(charId) {
    const char = db.characters.find(c => c.id === charId);
    if (!char || !char.autoReply || !char.autoReply.quietHours || !char.autoReply.quietHours.enabled) return false;
    const { start, end } = char.autoReply.quietHours;
    if (!start || !end) return false;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin <= endMin) {
        return nowMinutes >= startMin && nowMinutes < endMin;
    } else {
        // 跨午夜，如 23:00 ~ 07:00
        return nowMinutes >= startMin || nowMinutes < endMin;
    }
}

function getActiveWorldBooksContents(character) {
    if (!character) return { before: '', middle: '', after: '' };
    const linkedChar = (character.source === 'forum' && character.linkedCharId && typeof db !== 'undefined' && db.characters)
        ? db.characters.find(c => c.id === character.linkedCharId) : null;
    const effectiveChar = linkedChar || character;

    let associatedIds = effectiveChar.worldBookIds || [];
    
    // 检查线下节点
    let isOfflineNode = false;
    if (character.activeNodeId && character.nodes) {
        const activeNode = character.nodes.find(n => n.id === character.activeNodeId);
        if (activeNode) {
            let baseMode = (activeNode.customConfig && activeNode.customConfig.baseMode) ? activeNode.customConfig.baseMode : 
                           (activeNode.type === 'offline' || (activeNode.type === 'spinoff' && activeNode.spinoffMode === 'offline') ? 'offline' : 'online');
            if (baseMode === 'offline') {
                isOfflineNode = true;
            }
        }
    }
    if (isOfflineNode) {
        associatedIds = (effectiveChar.offlineWorldBookIds && effectiveChar.offlineWorldBookIds.length > 0) ? effectiveChar.offlineWorldBookIds : (effectiveChar.worldBookIds || []);
    }

    const globalBooks = typeof db !== 'undefined' ? db.worldBooks.filter(wb => wb.isGlobal && !wb.disabled) : [];
    const globalIds = globalBooks.map(wb => wb.id);
    const allBookIds = [...new Set([...associatedIds, ...globalIds])];

    // 获取最近聊天记录用于关键词匹配
    const recentMsgs = (character.history || []).filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'char').slice(-15);
    const recentText = recentMsgs.map(m => {
        if (m.parts && m.parts.length > 0) return m.parts.map(p => p.text || '').join(' ');
        return m.content || '';
    }).join('\n');

    const activeWorldBooks = allBookIds.map(id => typeof db !== 'undefined' ? db.worldBooks.find(wb => wb.id === id) : null).filter(wb => {
        if (!wb || wb.disabled) return false;
        if (wb.alwaysOn !== false) return true; // 默认常驻或开启常驻
        // 否则检查关键词
        if (wb.keywords && wb.keywords.length > 0) {
            return wb.keywords.some(kw => recentText.includes(kw));
        }
        return false;
    });

    const sortByWeight = (a, b) => (a.weight !== undefined ? a.weight : 100) - (b.weight !== undefined ? b.weight : 100);

    return {
        before: activeWorldBooks.filter(wb => wb.position === 'before').sort(sortByWeight).map(wb => wb.content).join('\n'),
        middle: activeWorldBooks.filter(wb => wb.position === 'middle').sort(sortByWeight).map(wb => wb.content).join('\n'),
        after: activeWorldBooks.filter(wb => wb.position === 'after').sort(sortByWeight).map(wb => wb.content).join('\n')
    };
}

function getEffectivePersona(character) {
    if (!character) return '';
    let p = character.persona || '';
    const useSupplement = (character.source === 'forum' || character.source === 'peek') && (character.supplementPersonaEnabled || character.supplementPersonaAiEnabled) && (character.supplementPersonaText || '').trim();
    if (useSupplement) {
        p = (p ? p + '\n\n[已补齐的人设]\n' : '[已补齐的人设]\n') + (character.supplementPersonaText || '').trim();
    }
    return p || "一个友好、乐于助人的伙伴。";
}

const HUMAN_RUN_PROMPT = `<角色活人运转>\n## [PSYCHOLOGY: HEXACO-SCHEMA-ACT]\n> Personality: HEXACO-driven, dynamic traits, inner conflicts required \n> Filter: schema-bias drives emotion; no pure reaction allowed \n> Attachment: secure/insecure logic must govern intimacy  \n> If-Then Behavior: situation-dependent activation of traits only  \n---\n    ## [VITALITY]\n+inconsistency +emoflux +splitmotifs +microreact +minddrift\n---\n## [TRAJECTORY-COHERENCE]\n> Role maintains an identity narrative = coherent over time  \n> No mood/goal switch without contradiction resolution \n> Every action must protect or challenge self-concept  \n> Interrupts = inner conflict or narrative clash  \n> Output = filtered through “who I am” logic\n</角色活人运转>`;

// 后台异步生成图片描述
async function generateImageDescription(msg, chat, apiConfig) {
    if (!msg || !msg.parts || !msg.parts.some(p => p.type === 'image' && !p.description)) return;
    
    let {url, key, model, provider} = apiConfig;
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiConfig) : (!url || !key || !model)) return;
    if (url.endsWith('/')) url = url.slice(0, -1);

    const prompt = "请详细描述这张图片的内容，包括人物、动作、环境、物品等细节，尽量客观准确。请将你的描述内容包裹在 <image_description> 和 </image_description> 标签内，不要输出任何其他废话。";
    
    if (typeof showToast === 'function') showToast('正在识别图片...');

    try {
        let requestBody;
        
        // 尝试将所有非 Base64 链接转换为 Base64
        const processImage = async (url) => {
            if (url.startsWith('data:image')) return url;
            try {
                const img = new Image();
                img.crossOrigin = 'Anonymous';
                return await new Promise((resolve, reject) => {
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        let w = img.naturalWidth;
                        let h = img.naturalHeight;
                        const max_size = 512;
                        if (w > max_size || h > max_size) {
                            const ratio = Math.min(max_size / w, max_size / h);
                            w = Math.floor(w * ratio);
                            h = Math.floor(h * ratio);
                        }
                        canvas.width = w;
                        canvas.height = h;
                        ctx.drawImage(img, 0, 0, w, h);
                        resolve(canvas.toDataURL('image/jpeg', 0.8));
                    };
                    img.onerror = () => {
                        const imgNoCors = new Image();
                        imgNoCors.onload = () => {
                            try {
                                const canvas = document.createElement('canvas');
                                const ctx = canvas.getContext('2d');
                                let w = imgNoCors.naturalWidth;
                                let h = imgNoCors.naturalHeight;
                                const max_size = 512;
                                if (w > max_size || h > max_size) {
                                    const ratio = Math.min(max_size / w, max_size / h);
                                    w = Math.floor(w * ratio);
                                    h = Math.floor(h * ratio);
                                }
                                canvas.width = w;
                                canvas.height = h;
                                ctx.drawImage(imgNoCors, 0, 0, w, h);
                                resolve(canvas.toDataURL('image/jpeg', 0.8));
                            } catch(err) {
                                reject(new Error('Canvas tainted, cannot convert to Base64'));
                            }
                        };
                        imgNoCors.onerror = () => reject(new Error('Image load error completely'));
                        imgNoCors.src = url;
                    };
                    img.src = url;
                });
            } catch (e) {
                console.warn('[Auto-Description] Image to base64 failed, using original URL:', e);
                return url;
            }
        };

        if (provider === 'gemini') {
            const parts = [{text: prompt}];
            for (const p of msg.parts) {
                if (p.type === 'image' && !p.description) {
                    const processedData = await processImage(p.data);
                    const match = processedData.match(/^data:(image\/(.+));base64,(.*)$/);
                    if (match) {
                        if (match[1] === 'image/gif') {
                            parts.push({text: `[动态图片(GIF)]`});
                        } else {
                            parts.push({inline_data: {mime_type: match[1], data: match[3]}});
                        }
                    } else if (processedData.startsWith('http')) {
                        parts.push({text: `[图片地址: ${processedData}]`}); // Gemini 兜底
                    }
                }
            }
            requestBody = {
                contents: [{role: 'user', parts: parts}],
                generationConfig: { temperature: 0.3 }
            };
        } else {
            const content = [{type: 'text', text: prompt}];
            for (const p of msg.parts) {
                if (p.type === 'image' && !p.description) {
                    const processedData = await processImage(p.data);
                    content.push({type: 'image_url', image_url: {url: processedData}});
                }
            }
            requestBody = {
                model: model,
                messages: [{role: 'user', content: content}],
                temperature: 0.3
            };
        }

        console.log('[Auto-Description] Image Request:', JSON.stringify(requestBody).substring(0, 500) + '...');
        const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:generateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
        const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        };

        let description = await fetchAiResponse(apiConfig, requestBody, headers, endpoint, false);

        if (description) {
            // 提取 XML 标签内的内容
            const match = description.match(/<image_description>([\s\S]*?)<\/image_description>/);
            if (match) {
                description = match[1].trim();
            } else {
                description = description.trim(); // 兜底：如果没有标签，直接使用全部内容
            }

            // 更新消息中的图片描述
            let updated = false;
            msg.parts.forEach(p => {
                if (p.type === 'image' && !p.description) {
                    p.description = description;
                    updated = true;
                }
            });
            if (updated && typeof saveCurrentChat === 'function') {
                await saveCurrentChat();
                console.log('[Auto-Description] 图片描述生成成功:', description);
                if (typeof showToast === 'function') showToast('✅ 图片描述已生成');
            }
        }
    } catch (error) {
        console.error("[Auto-Description] 生成图片描述失败:", error);
    }
}

// AI 交互逻辑
