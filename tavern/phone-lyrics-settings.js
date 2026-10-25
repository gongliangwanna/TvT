// 小手机联网歌词设置：只管理当前角色开关，查询和回复处理由独立外挂负责。
(function () {
    'use strict';
    if (window.PhoneLyricsSettings) return;

    const reported = new Set();
    const pendingSaves = new Set();
    const settingsRevisions = new WeakMap();
    const unverifiedSettings = new WeakSet();
    const field = 'lyricsSearchEnabled';
    let editingCharacter = null;
    let cardVersion = 0;

    function report(message) {
        if (reported.has(message)) return;
        reported.add(message);
        const text = '联网查询歌词：' + message;
        if (window.TavernSync && typeof window.TavernSync.reportIssue === 'function') window.TavernSync.reportIssue(text);
        else console.error(text);
    }

    function getEnabled(chat) {
        return !!chat && chat[field] === true;
    }

    function currentCharacter() {
        if (typeof db === 'undefined' || typeof currentChatId === 'undefined') return null;
        if (typeof currentChatType !== 'undefined' && currentChatType !== 'private') return null;
        return (db.characters || []).find(character => character.id === currentChatId) || null;
    }

    function control() {
        return document.getElementById('setting-phone-lyrics-search-enabled');
    }

    function loadCard() {
        const chat = currentCharacter(), enabled = control();
        cardVersion++;
        editingCharacter = chat && enabled ? chat : null;
        if (enabled) enabled.checked = getEnabled(editingCharacter);
    }

    function hookLoad() {
        const original = window.loadSettingsToSidebar;
        if (typeof original !== 'function') return report('找不到聊天设置读取入口 loadSettingsToSidebar');
        if (original.__phoneLyricsSettings) return;
        const wrapped = function () {
            const result = original.apply(this, arguments);
            loadCard();
            return result;
        };
        wrapped.__phoneLyricsSettings = true;
        window.loadSettingsToSidebar = wrapped;
    }

    function hookSave() {
        const original = window.saveSettingsFromSidebar;
        if (typeof original !== 'function') return report('找不到聊天设置保存入口 saveSettingsFromSidebar');
        if (original.__phoneLyricsSettings) return;
        const wrapped = async function () {
            const chat = currentCharacter(), enabled = control();
            if (!chat || !editingCharacter || editingCharacter.id !== chat.id || !enabled) return original.apply(this, arguments);
            if (pendingSaves.has(chat.id)) {
                if (typeof showToast === 'function') showToast('正在保存，请稍候再试');
                return;
            }
            // 同 ID 的读档对象不能被尚未重载的旧表单覆盖。
            if (editingCharacter !== chat) {
                loadCard();
                return original.apply(this, arguments);
            }
            if (!enabled.checked && !Object.prototype.hasOwnProperty.call(chat, field) && !unverifiedSettings.has(chat)) {
                return original.apply(this, arguments);
            }

            const previous = chat[field], hadPrevious = Object.prototype.hasOwnProperty.call(chat, field);
            const expected = enabled.checked === true, formVersion = cardVersion;
            pendingSaves.add(chat.id);
            chat[field] = expected;
            const revision = (settingsRevisions.get(chat) || 0) + 1;
            settingsRevisions.set(chat, revision);
            const ownsSettings = () => settingsRevisions.get(chat) === revision && chat[field] === expected;
            const restore = record => {
                const hasValue = record ? Object.prototype.hasOwnProperty.call(record, field) : hadPrevious;
                if (hasValue) chat[field] = record ? record[field] : previous;
                else delete chat[field];
            };
            try {
                let result, saveError, savedRecord, saveFailed = false;
                try { result = await original.apply(this, arguments); }
                catch (error) { saveFailed = true; saveError = error; }
                // 原保存器的校验早退和部分存储失败都只返回 undefined，必须读取入库结果。
                let saved = !saveFailed && result !== false;
                if (typeof dexieDB !== 'undefined' && dexieDB.characters && typeof dexieDB.characters.get === 'function') {
                    try {
                        savedRecord = await dexieDB.characters.get(chat.id);
                        saved = !!savedRecord && getEnabled(savedRecord) === expected;
                        if (ownsSettings()) unverifiedSettings.delete(chat);
                    } catch (error) {
                        saved = null;
                        if (ownsSettings()) unverifiedSettings.add(chat);
                        report('设置保存结果无法核对：' + (error && error.message || String(error)));
                        if (typeof showToast === 'function') showToast('歌词设置保存结果无法核对，请重新打开小手机确认');
                    }
                }
                if (saved === false && ownsSettings()) {
                    restore(savedRecord);
                    // 失败结果不能抹掉保存期间继续修改的草稿或另一个角色的表单。
                    if (editingCharacter === chat && currentCharacter() === chat
                        && cardVersion === formVersion && enabled.checked === expected) loadCard();
                    if (!saveFailed && typeof showToast === 'function') showToast('歌词设置未保存，请检查其他设置或存储空间后重试');
                }
                if (saveFailed) throw saveError;
                return result;
            } finally {
                pendingSaves.delete(chat.id);
            }
        };
        wrapped.__phoneLyricsSettings = true;
        window.saveSettingsFromSidebar = wrapped;
    }

    function init() {
        const anchor = document.getElementById('setting-char-web-search-enabled');
        const searchCard = anchor && anchor.closest('.kkt-group');
        if (!searchCard || !searchCard.parentNode) return report('找不到聊天设置里的「联网搜索」卡片');
        let created = false;
        if (!document.getElementById('phone-lyrics-settings-card')) {
            const card = document.createElement('div');
            card.id = 'phone-lyrics-settings-card';
            card.className = 'kkt-group';
            card.innerHTML = `
                <div class="kkt-item">
                    <label class="kkt-item-label" for="setting-phone-lyrics-search-enabled">联网查询歌词</label>
                    <div class="kkt-item-control">
                        <label class="kkt-switch"><input type="checkbox" id="setting-phone-lyrics-search-enabled"><span class="kkt-slider"></span></label>
                    </div>
                </div>`;
            searchCard.parentNode.insertBefore(card, searchCard.nextSibling);
            control().addEventListener('change', () => { cardVersion++; });
            created = true;
        }
        hookLoad();
        hookSave();
        if (created || editingCharacter !== currentCharacter()) loadCard();
    }

    window.PhoneLyricsSettings = { getEnabled, init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
