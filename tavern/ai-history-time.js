// 小手机 AI 上文时间外挂：只处理序列化后的请求，不改消息存储、界面时间或酒馆推送。
(function () {
    if (window.TavernAIHistoryTime) return;

    const reported = new Set();
    const pendingSaves = new Set();
    const settingsRevisions = new WeakMap();
    const unverifiedSettings = new WeakSet();
    const padNumber = value => String(value).padStart(2, '0');
    const formatYear = year => year >= 0 && year <= 9999 ? String(year).padStart(4, '0')
        : (year < 0 ? '-' : '+') + String(Math.abs(year)).padStart(6, '0');
    const validInterval = value => Number.isSafeInteger(value) && value >= 1;
    // 与小手机内置 getLocalTimeInTimezone 的旧预设兼容格式一致。
    const legacyTimezones = {
        '北京/UTC+8': 'Asia/Shanghai', '东京/UTC+9': 'Asia/Tokyo', '首尔/UTC+9': 'Asia/Seoul',
        '伦敦/UTC+0': 'Europe/London', '纽约/UTC-5': 'America/New_York',
        '悉尼/UTC+10': 'Australia/Sydney', '巴黎/UTC+1': 'Europe/Paris'
    };
    let editingCharacterId = null;
    let editingCharacter = null;
    let cardVersion = 0;

    function report(message) {
        if (reported.has(message)) return;
        reported.add(message);
        const text = 'AI 上文时间：' + message;
        if (window.TavernSync && typeof window.TavernSync.reportIssue === 'function') window.TavernSync.reportIssue(text);
        else console.error(text);
    }

    function getSettings(chat) {
        const stored = chat && chat.aiHistoryTime;
        const enabled = !!stored && stored.enabled === true;
        return { enabled, intervalMinutes: enabled && validInterval(stored.intervalMinutes) ? stored.intervalMinutes : 1 };
    }

    function setSettings(chat, settings) {
        if (!chat) return;
        if (!settings || settings.enabled !== true) {
            delete chat.aiHistoryTime;
            settingsRevisions.set(chat, (settingsRevisions.get(chat) || 0) + 1);
            return;
        }
        const intervalMinutes = settings.intervalMinutes ?? 1;
        if (!validInterval(intervalMinutes)) throw new RangeError('标记间隔必须是大于 0 的整数');
        chat.aiHistoryTime = { enabled: true, intervalMinutes };
        settingsRevisions.set(chat, (settingsRevisions.get(chat) || 0) + 1);
    }

    function timestampOf(message) {
        const value = message && message.timestamp;
        let time;
        if (typeof value === 'number') time = value;
        else if (typeof value === 'string' && value.trim()) {
            time = Number(value);
            if (!Number.isFinite(time)) time = new Date(value).getTime();
        } else if (value && typeof value === 'object') {
            // Date 可由 IndexedDB 保留；不接受 null、布尔值或任意对象的隐式数值转换。
            try { time = Date.prototype.getTime.call(value); }
            catch (_) { return NaN; }
        } else return NaN;
        return Number.isFinite(time) ? new Date(time).getTime() : NaN;
    }

    function timeFormatter(chat) {
        if (chat.enableDynamicTimezone && chat.charTimezone) {
            try {
                return new Intl.DateTimeFormat('en-GB', {
                    timeZone: legacyTimezones[chat.charTimezone] || chat.charTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', era: 'short'
                });
            } catch (_) { /* 无效时区与内置当前时间一样，回退到本地时间。 */ }
        }
        return null;
    }

    function dateParts(time, formatter) {
        if (formatter) {
            const values = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
            const year = values.era === 'BC' ? 1 - Number(values.year) : Number(values.year);
            // 公历每 400 年重复一次；映射到安全年份，避免极限时间戳的当地时间越出 Date 范围。
            const cycles = Math.floor((year - 2000) / 400);
            const wallSecond = Date.UTC(year - cycles * 400, Number(values.month) - 1, Number(values.day),
                Number(values.hour), Number(values.minute), Number(values.second)) / 1000 + cycles * 146097 * 86400;
            return {
                day: `${formatYear(year)}-${values.month}-${values.day}`, clock: `${values.hour}:${values.minute}`,
                offset: wallSecond - Math.floor(time / 1000)
            };
        }
        const date = new Date(time);
        return {
            day: `${formatYear(date.getFullYear())}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`,
            clock: `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`, offset: -date.getTimezoneOffset() * 60
        };
    }

    // 只移除原序列化器本次确实会生成的前缀，不扫描、改写正文中的时间文字。
    function nativeTimePrefix(message, lastRawTime) {
        const rawTime = message.timestamp;
        const date = new Date(rawTime);
        if (lastRawTime === 0 || rawTime - lastRawTime > 20 * 60 * 1000
            || date.toDateString() !== new Date(lastRawTime).toDateString()) {
            return `[system: ${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}]\n`;
        }
        return '';
    }

    function rewriteText(text, nativePrefix, marker, idPrefix) {
        const id = idPrefix && text.startsWith(idPrefix) ? idPrefix : '';
        let body = text.slice(id.length);
        if (nativePrefix && body.startsWith(nativePrefix)) body = body.slice(nativePrefix.length);
        return id + marker + body;
    }

    function rewritePayload(payload, gemini, nativePrefix, marker, idPrefix) {
        if (typeof payload === 'string') return rewriteText(payload, nativePrefix, marker, idPrefix);
        if (!Array.isArray(payload)) return payload;
        const parts = payload.slice();
        const firstText = parts.findIndex(part => gemini ? typeof part.text === 'string' : part.type === 'text' && typeof part.text === 'string');
        if (firstText >= 0) {
            const part = parts[firstText];
            const text = rewriteText(part.text, nativePrefix, marker, idPrefix);
            if (text !== part.text) {
                if (!text) parts.splice(firstText, 1);
                else parts[firstText] = { ...part, text };
            }
        } else if (marker) {
            parts.unshift(gemini ? { text: marker } : { type: 'text', text: marker });
        }
        return parts;
    }

    function hasPayload(payload, gemini) {
        if (typeof payload === 'string') return !!payload.trim();
        if (!Array.isArray(payload)) return true;
        return payload.some(part => {
            if (!part) return false;
            const isText = gemini ? Object.prototype.hasOwnProperty.call(part, 'text') : part.type === 'text';
            return !isText || typeof part.text === 'string' && !!part.text.trim();
        });
    }

    function addTimes(serialized, chat, chatType, history, gemini, intervalMinutes) {
        if (!Array.isArray(serialized) || !Array.isArray(history) || serialized.length !== history.length) {
            throw new Error('小手机消息格式已改变，需要调整 tavern/ai-history-time.js');
        }
        const formatter = timeFormatter(chat);
        let lastRawTime = 0, lastMarkedMinute = null, lastSeenMinute = null, lastOffset = null, lastDay = '';
        return serialized.map((entry, index) => {
            const message = history[index];
            const nativePrefix = nativeTimePrefix(message, lastRawTime);
            lastRawTime = message.timestamp;
            const time = timestampOf(message);
            if (message.fromTavern || !Number.isFinite(time)) {
                // 酒馆楼层保持原样；其后的手机消息重新给日期，避免继承酒馆的时间背景。
                lastMarkedMinute = lastSeenMinute = null;
                lastOffset = null;
                lastDay = '';
                return entry;
            }
            const parts = dateParts(time, formatter), minute = Math.floor(time / 60000);
            // 夏令时结束时，时间戳递增但当地时钟会回拨；即使两条消息显示同一分钟，也需重给日期。
            const first = lastMarkedMinute === null || parts.day !== lastDay || minute < lastSeenMinute || parts.offset < lastOffset;
            const needsTime = first || minute - lastMarkedMinute >= intervalMinutes;
            const marker = needsTime ? `[system: ${first ? parts.day + ' ' : ''}${parts.clock}]\n` : '';
            if (needsTime) lastMarkedMinute = minute;
            lastSeenMinute = minute;
            lastOffset = parts.offset;
            lastDay = parts.day;
            const idPrefix = message.role === 'user' && chatType === 'private' && chat.characterAutoFavoriteEnabled
                ? `[id:${message.id}]\n` : '';
            const key = gemini ? 'parts' : 'content';
            const payload = rewritePayload(entry[key], gemini, nativePrefix, marker, idPrefix);
            // 正文可能被宿主清空；去掉唯一的原生时间后会生成空请求，需保留原输出。
            if (hasPayload(payload, gemini)) return { ...entry, [key]: payload };
            // 原生标签使用浏览器当地时间；后续消息不能继承它的日期或时区。
            lastMarkedMinute = lastSeenMinute = null;
            lastOffset = null;
            lastDay = '';
            return entry;
        });
    }

    function hookSerializer(name, gemini) {
        const original = window[name];
        if (typeof original !== 'function') return report('找不到消息处理入口 ' + name);
        if (original.__tavernAIHistoryTime) return;
        const wrapped = function (chat, chatType, history) {
            const serialized = original.apply(this, arguments);
            const settings = getSettings(chat);
            // 关闭时直接返回原函数的原始结果，连时间前缀去重也不执行。
            if (!settings.enabled) return serialized;
            try { return addTimes(serialized, chat, chatType, history, gemini, settings.intervalMinutes); }
            catch (error) { report(error.message); return serialized; }
        };
        wrapped.__tavernAIHistoryTime = true;
        window[name] = wrapped;
    }

    function currentCharacter() {
        if (typeof db === 'undefined' || typeof currentChatId === 'undefined') return null;
        return (db.characters || []).find(character => character.id === currentChatId) || null;
    }

    function cardControls() {
        return {
            enabled: document.getElementById('setting-ai-history-time-enabled'),
            interval: document.getElementById('setting-ai-history-time-interval'),
            row: document.getElementById('setting-ai-history-time-interval-row')
        };
    }

    function showInterval(controls) {
        controls.row.style.display = controls.enabled.checked ? '' : 'none';
        controls.interval.disabled = !controls.enabled.checked;
        if (!controls.enabled.checked) controls.interval.value = '1';
    }

    function loadCard() {
        const chat = currentCharacter(), controls = cardControls();
        cardVersion++;
        if (!chat || !controls.enabled) { editingCharacterId = null; editingCharacter = null; return; }
        editingCharacterId = chat.id;
        editingCharacter = chat;
        const settings = getSettings(chat);
        controls.enabled.checked = settings.enabled;
        controls.interval.value = String(settings.intervalMinutes);
        showInterval(controls);
    }

    function installCard() {
        const anchor = document.getElementById('block-character-btn');
        if (!anchor || !anchor.parentNode) return report('找不到聊天设置里的「拉黑角色」按钮');
        if (!document.getElementById('tavern-ai-history-time-card')) {
            const card = document.createElement('div');
            card.id = 'tavern-ai-history-time-card';
            card.className = 'kkt-group';
            card.innerHTML = `
                <div class="kkt-item">
                    <label class="kkt-item-label" for="setting-ai-history-time-enabled">为 AI 标注消息时间</label>
                    <div class="kkt-item-control">
                        <label class="kkt-switch"><input type="checkbox" id="setting-ai-history-time-enabled"><span class="kkt-slider"></span></label>
                    </div>
                </div>
                <div class="kkt-item" id="setting-ai-history-time-interval-row" style="display:none;">
                    <label class="kkt-item-label" for="setting-ai-history-time-interval">标记间隔</label>
                    <div class="kkt-item-control">
                        <input type="number" id="setting-ai-history-time-interval" value="1" min="1" step="1" disabled style="width:50px; text-align:right; border:none; background:transparent; color:inherit; font:inherit;">
                        <span>分钟</span>
                    </div>
                </div>`;
            anchor.parentNode.insertBefore(card, anchor);
            const controls = cardControls();
            controls.enabled.addEventListener('change', () => { cardVersion++; showInterval(controls); });
            controls.interval.addEventListener('input', () => { cardVersion++; });
            controls.interval.addEventListener('change', () => { cardVersion++; });
        }
        const originalLoad = window.loadSettingsToSidebar;
        if (typeof originalLoad !== 'function') report('找不到聊天设置读取入口 loadSettingsToSidebar');
        else if (!originalLoad.__tavernAIHistoryTime) {
            const wrapped = function () { const result = originalLoad.apply(this, arguments); loadCard(); return result; };
            wrapped.__tavernAIHistoryTime = true;
            window.loadSettingsToSidebar = wrapped;
        }
        const originalSave = window.saveSettingsFromSidebar;
        if (typeof originalSave !== 'function') report('找不到聊天设置保存入口 saveSettingsFromSidebar');
        else if (!originalSave.__tavernAIHistoryTime) {
            const wrapped = async function () {
                const chat = currentCharacter(), controls = cardControls();
                if (!chat || editingCharacterId !== chat.id || !controls.enabled) return originalSave.apply(this, arguments);
                if (pendingSaves.has(chat.id)) {
                    if (typeof showToast === 'function') showToast('正在保存，请稍候再试');
                    return;
                }
                // 读档会用同 ID 的新对象替换角色，却不重新加载表单；旧卡片不能覆盖新设置。
                if (editingCharacter !== chat) {
                    loadCard();
                    return originalSave.apply(this, arguments);
                }
                // 默认关闭且没有自定义配置时，设置保存也完全沿用原来的流程。
                if (!controls.enabled.checked && !Object.prototype.hasOwnProperty.call(chat, 'aiHistoryTime') && !unverifiedSettings.has(chat)) {
                    return originalSave.apply(this, arguments);
                }
                const intervalMinutes = Number(controls.interval.value);
                if (controls.enabled.checked && !validInterval(intervalMinutes)) {
                    if (typeof showToast === 'function') showToast('标记间隔请输入大于 0 的整数');
                    controls.interval.focus();
                    return;
                }
                const previous = chat.aiHistoryTime;
                const hadPrevious = Object.prototype.hasOwnProperty.call(chat, 'aiHistoryTime');
                const formEnabled = controls.enabled.checked, formInterval = controls.interval.value;
                const formVersion = cardVersion;
                pendingSaves.add(chat.id);
                setSettings(chat, { enabled: controls.enabled.checked, intervalMinutes });
                const expected = chat.aiHistoryTime;
                const revision = settingsRevisions.get(chat);
                const ownsSettings = () => settingsRevisions.get(chat) === revision && chat.aiHistoryTime === expected;
                const restore = record => {
                    // 核对到旧值时以数据库为准；previous 可能来自上次尚未确认的保存。
                    const hasValue = record ? Object.prototype.hasOwnProperty.call(record, 'aiHistoryTime') : hadPrevious;
                    if (hasValue) chat.aiHistoryTime = record ? record.aiHistoryTime : previous;
                    else delete chat.aiHistoryTime;
                };
                try {
                    let result, saveError, savedRecord, saveFailed = false;
                    try { result = await originalSave.apply(this, arguments); }
                    catch (error) { saveError = error; saveFailed = true; }
                    // 原保存器成功与校验中止都返回 undefined；入库失败也可能被它捕获。
                    // 入库后的调度或界面更新也可能抛错，仍需核对，不能把已保存的设置误回滚。
                    let saved = !saveFailed && result !== false;
                    if (typeof dexieDB !== 'undefined' && dexieDB.characters && typeof dexieDB.characters.get === 'function') {
                        try {
                            const record = await dexieDB.characters.get(chat.id);
                            savedRecord = record;
                            const stored = record && record.aiHistoryTime;
                            saved = !!record && (expected
                                ? !!stored && stored.enabled === true && stored.intervalMinutes === expected.intervalMinutes
                                : !Object.prototype.hasOwnProperty.call(record, 'aiHistoryTime'));
                            if (ownsSettings()) unverifiedSettings.delete(chat);
                        } catch (error) {
                            // 读取失败只说明无法核对，不能据此认定写入失败，也不能覆盖原保存异常。
                            saved = null;
                            if (ownsSettings()) unverifiedSettings.add(chat);
                            report('消息时间设置保存结果无法核对：' + (error && error.message || String(error)));
                            if (typeof showToast === 'function') showToast('消息时间设置保存结果无法核对，请重新打开小手机确认');
                        }
                    }
                    if (saved === false && ownsSettings()) {
                        restore(savedRecord);
                        // 保存期间仍可继续编辑；旧请求失败不能清掉后来输入的草稿。
                        if (editingCharacterId === chat.id && currentCharacter() === chat
                            && cardVersion === formVersion
                            && controls.enabled.checked === formEnabled && controls.interval.value === formInterval) loadCard();
                        if (!saveFailed && typeof showToast === 'function') showToast('消息时间设置未保存，请检查其他设置或存储空间后重试');
                    }
                    if (saveFailed) throw saveError;
                    return result;
                }
                finally { pendingSaves.delete(chat.id); }
            };
            wrapped.__tavernAIHistoryTime = true;
            window.saveSettingsFromSidebar = wrapped;
        }
    }

    function install() {
        hookSerializer('serializeChatHistoryMessages', false);
        hookSerializer('serializeChatHistoryForGemini', true);
        installCard();
    }

    window.TavernAIHistoryTime = { getSettings, setSettings, install };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
})();
