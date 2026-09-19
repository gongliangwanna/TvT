function initDatabase() {
    dexieDB = new Dexie('章鱼喷墨机DB_ee');
    dexieDB.version(1).stores({
        storage: 'key, value'
    });
    dexieDB.version(2).stores({
        characters: '&id',
        groups: '&id',
        worldBooks: '&id',
        myStickers: '&id',
        globalSettings: 'key'
    }).upgrade(async tx => {
        console.log("Upgrading database to version 2...");
        const oldData = await tx.table('storage').get('章鱼喷墨机');
        if (oldData && oldData.value) {
            console.log("Old data found, starting migration.");
            const data = JSON.parse(oldData.value);
            if (data.characters) await tx.table('characters').bulkPut(data.characters);
            if (data.groups) await tx.table('groups').bulkPut(data.groups);
            if (data.worldBooks) await tx.table('worldBooks').bulkPut(data.worldBooks);
            if (data.myStickers) await tx.table('myStickers').bulkPut(data.myStickers);
            
            const settingsToMigrate = {
                apiSettings: data.apiSettings || {},
                summaryApiSettings: data.summaryApiSettings || {},
                backgroundApiSettings: data.backgroundApiSettings || {},
                vectorApiSettings: data.vectorApiSettings || {},
                apiNodes: data.apiNodes || [],
                apiNodeRoutes: data.apiNodeRoutes || {},
                wallpaper: data.wallpaper || 'https://i.postimg.cc/W4Z9R9x4/ins-1.jpg',
                globalChatWallpaper: data.globalChatWallpaper || '',
            homeScreenMode: data.homeScreenMode || 'night',
            fontUrl: data.fontUrl || '',
            localFontName: data.localFontName || '',
            fontBuffer: data.fontBuffer || null,
                customIcons: data.customIcons || {},
                apiPresets: data.apiPresets || [],
                summaryApiPresets: data.summaryApiPresets || [],
                backgroundApiPresets: data.backgroundApiPresets || [],
                vectorApiPresets: data.vectorApiPresets || [],
                bubbleCssPresets: data.bubbleCssPresets || [],
                myPersonaPresets: data.myPersonaPresets || [],
                globalCss: data.globalCss || '',
                globalCssPresets: data.globalCssPresets || [],
                homeSignature: data.homeSignature || '编辑个性签名...',
                forumPosts: data.forumPosts || [],
                forumBindings: data.forumBindings || { worldBookIds: [], charIds: [], userPersonaIds: [] },
                pomodoroTasks: data.pomodoroTasks || [],
                pomodoroSettings: data.pomodoroSettings || { boundCharId: null, userPersona: '', focusBackground: '', taskCardBackground: '', encouragementMinutes: 25, pokeLimit: 5, globalWorldBookIds: [] },
                insWidgetSettings: data.insWidgetSettings || { avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg', bubble1: 'love u.', avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bubble2: 'miss u.' },
                homeWidgetSettings: data.homeWidgetSettings || defaultWidgetSettings,
                memoryTableTemplates: data.memoryTableTemplates || [],
                vectorMemoryTemplates: data.vectorMemoryTemplates || [],
            moreProfileCardBg: data.moreProfileCardBg || 'https://i.postimg.cc/XvFDdTKY/Smart-Select-20251013-023208.jpg',
            cotSettings: data.cotSettings || { enabled: false, activePresetId: 'default' },
            cotPresets: data.cotPresets || JSON.parse(JSON.stringify(DEFAULT_COT_PRESETS)),
            stickerCategories: data.stickerCategories || [],
            gptImageSettings: data.gptImageSettings || {},
            gptImagePresets: data.gptImagePresets || [],
            novelAiSettings: data.novelAiSettings || {},
            novelAiPresets: data.novelAiPresets || [],
            googleImageSettings: data.googleImageSettings || {},
            stabilityImageSettings: data.stabilityImageSettings || {},
            activeImageProvider: data.activeImageProvider || '',
            imageAtmosphereGroups: data.imageAtmosphereGroups || [],
            activeImageAtmosphereId: data.activeImageAtmosphereId || '',
            magicRoom: Object.assign({
                customPromptEnabled: false,
                customPromptTemplate: '',
                promptEditMode: '',
                customPromptItems: [],
                presets: [],
                sysNotifEnabled: false,
                sysNotifSenderName: '',
                sysNotifShowAvatar: true,
                sysNotifShowContent: true,
                sysNotifCustomServer: false,
                sysNotifServerUrl: '',
                sysNotifServerKey: '',
            }, data.magicRoom || {})
            };

            const settingsPromises = Object.entries(settingsToMigrate).map(([key, value]) =>
                tx.table('globalSettings').put({ key, value })
            );
            await Promise.all(settingsPromises);
            
            await tx.table('storage').delete('章鱼喷墨机');
            console.log("Migration complete. Old data removed.");
        } else {
            console.log("No old data found to migrate.");
        }
    });
    dexieDB.version(3).stores({
        characters: '&id',
        groups: '&id',
        worldBooks: '&id',
        myStickers: '&id',
        globalSettings: 'key',
        archives: '&id,characterId,timestamp'
    });
    dexieDB.version(4).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,enabled,status,updatedAt', mcpActivities: '&id,connectionId,status,createdAt', mcpSettings: '&id'
    });
    dexieDB.version(5).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,type,enabled,status,updatedAt',
        mcpActivities: '&id,connectionId,status,chatId,createdAt',
        mcpSettings: '&id',
        mcpSecrets: '&id',
        mcpSessions: '&id,connectionId,updatedAt',
        mcpCapabilities: '&id,connectionId,kind,updatedAt',
        mcpSubscriptions: '&id,connectionId,uri,status',
        mcpTasks: '&id,connectionId,status,updatedAt',
        mcpOAuthStates: '&id,connectionId,createdAt'
    }).upgrade(async transaction => {
        const connections = transaction.table('mcpConnections');
        const secrets = transaction.table('mcpSecrets');
        const records = await connections.toArray();
        const secureRecords = [];
        records.forEach(connection => {
            const secure = {
                id: connection.id,
                secret: connection.secret || '',
                pairingCode: connection.pairingCode || '',
                deviceId: connection.deviceId || '',
                updatedAt: Date.now()
            };
            if (secure.secret || secure.pairingCode || secure.deviceId) secureRecords.push(secure);
            delete connection.secret;
            delete connection.pairingCode;
            delete connection.deviceId;
        });
        if (records.length) await connections.bulkPut(records);
        if (secureRecords.length) await secrets.bulkPut(secureRecords);
    });
    // 大数据导入暂存表：文件完整写入并校验后，再在单个事务中替换正式数据。
    dexieDB.version(6).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,type,enabled,status,updatedAt',
        mcpActivities: '&id,connectionId,status,chatId,createdAt',
        mcpSettings: '&id',
        mcpSecrets: '&id',
        mcpSessions: '&id,connectionId,updatedAt',
        mcpCapabilities: '&id,connectionId,kind,updatedAt',
        mcpSubscriptions: '&id,connectionId,uri,status',
        mcpTasks: '&id,connectionId,status,updatedAt',
        mcpOAuthStates: '&id,connectionId,createdAt',
        importCharacters: '&id',
        importGroups: '&id',
        importWorldBooks: '&id',
        importMyStickers: '&id',
        importArchives: '&id,characterId,timestamp',
        importGlobalSettings: 'key'
    });
    // NovelAI VIBE 使用独立表保存原图、模型编码和组；避免大体积二进制挤入全局设置。
    dexieDB.version(7).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,type,enabled,status,updatedAt',
        mcpActivities: '&id,connectionId,status,chatId,createdAt',
        mcpSettings: '&id', mcpSecrets: '&id', mcpSessions: '&id,connectionId,updatedAt',
        mcpCapabilities: '&id,connectionId,kind,updatedAt', mcpSubscriptions: '&id,connectionId,uri,status',
        mcpTasks: '&id,connectionId,status,updatedAt', mcpOAuthStates: '&id,connectionId,createdAt',
        importCharacters: '&id', importGroups: '&id', importWorldBooks: '&id', importMyStickers: '&id',
        importArchives: '&id,characterId,timestamp', importGlobalSettings: 'key',
        naiVibeAssets: '&id,sourceHash,createdAt',
        naiVibeEncodings: '&id,assetId,model,modelKey,createdAt',
        naiVibeGroups: '&id,name,updatedAt'
    });
    dexieDB.version(8).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,type,enabled,status,updatedAt', mcpActivities: '&id,connectionId,status,chatId,createdAt',
        mcpSettings: '&id', mcpSecrets: '&id', mcpSessions: '&id,connectionId,updatedAt',
        mcpCapabilities: '&id,connectionId,kind,updatedAt', mcpSubscriptions: '&id,connectionId,uri,status',
        mcpTasks: '&id,connectionId,status,updatedAt', mcpOAuthStates: '&id,connectionId,createdAt',
        importCharacters: '&id', importGroups: '&id', importWorldBooks: '&id', importMyStickers: '&id',
        importArchives: '&id,characterId,timestamp', importGlobalSettings: 'key',
        naiVibeAssets: '&id,sourceHash,createdAt', naiVibeEncodings: '&id,assetId,model,modelKey,createdAt', naiVibeGroups: '&id,name,updatedAt',
        importNaiVibeAssets: '&id,sourceHash,createdAt', importNaiVibeEncodings: '&id,assetId,model,modelKey,createdAt', importNaiVibeGroups: '&id,name,updatedAt'
    });
    // 进行中的 AI 回复使用独立轻量表保存。它不属于用户聊天配置，也不进入备份导入，
    // 仅用于移动端页面冻结、丢弃或重新加载后的本地恢复。
    dexieDB.version(9).stores({
        characters: '&id', groups: '&id', worldBooks: '&id', myStickers: '&id', globalSettings: 'key', archives: '&id,characterId,timestamp',
        mcpConnections: '&id,type,enabled,status,updatedAt', mcpActivities: '&id,connectionId,status,chatId,createdAt',
        mcpSettings: '&id', mcpSecrets: '&id', mcpSessions: '&id,connectionId,updatedAt',
        mcpCapabilities: '&id,connectionId,kind,updatedAt', mcpSubscriptions: '&id,connectionId,uri,status',
        mcpTasks: '&id,connectionId,status,updatedAt', mcpOAuthStates: '&id,connectionId,createdAt',
        importCharacters: '&id', importGroups: '&id', importWorldBooks: '&id', importMyStickers: '&id',
        importArchives: '&id,characterId,timestamp', importGlobalSettings: 'key',
        naiVibeAssets: '&id,sourceHash,createdAt', naiVibeEncodings: '&id,assetId,model,modelKey,createdAt', naiVibeGroups: '&id,name,updatedAt',
        importNaiVibeAssets: '&id,sourceHash,createdAt', importNaiVibeEncodings: '&id,assetId,model,modelKey,createdAt', importNaiVibeGroups: '&id,name,updatedAt',
        pendingReplies: '&id,chatId,chatType,state,updatedAt'
    });
}

// 数据保存与加载。旧调用入口保持不变；并发触发时合并为同一个有序写入队列，
// 防止大数据下多个全量 bulkPut 同时排队、重复结构化克隆整库。
let saveDataPromise = null;
let saveDataRequestedWhileRunning = false;

const performFullSave = async () => {
    // 存储配额预检
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const { usage, quota } = await navigator.storage.estimate();
            const pct = (usage / quota) * 100;
            if (pct > 95) {
                if (typeof showToast === 'function') {
                    showToast(`⚠️ 存储空间已使用 ${pct.toFixed(0)}%，请立即导出备份！`, 6000);
                }
            }
        } catch (_) { /* 不阻断主流程 */ }
    }

    try {
        await dexieDB.characters.bulkPut(db.characters);
        await dexieDB.groups.bulkPut(db.groups);
        await dexieDB.worldBooks.bulkPut(db.worldBooks);
        await dexieDB.myStickers.bulkPut(db.myStickers);
        if (dexieDB.archives) await dexieDB.archives.bulkPut(db.archives || []);

        const allSettingKeys = [...globalSettingKeys, 'worldBookCategoryOrder'];
        const settingsPromises = allSettingKeys.map(key => {
            if (db[key] !== undefined) {
                return dexieDB.globalSettings.put({ key: key, value: db[key] });
            }
            return null;
        }).filter(p => p);
        await Promise.all(settingsPromises);
    } catch (e) {
        console.error("saveData failed:", e);
        if (typeof showToast === 'function') {
            // 根据错误类型给用户有意义的提示
            const isQuota = e.name === 'QuotaExceededError'
                || (e.message && (e.message.includes('quota') || e.message.includes('delete record')));
            const msg = isQuota
                ? '存储空间不足，保存失败！请到「存储管理」导出备份后清理数据。'
                : '保存数据失败: ' + e.message;
            showToast(msg, 6000);
        }
    }
};

const saveData = async () => {
    if (saveDataPromise) {
        saveDataRequestedWhileRunning = true;
        return saveDataPromise;
    }

    saveDataPromise = (async () => {
        do {
            saveDataRequestedWhileRunning = false;
            await performFullSave();
        } while (saveDataRequestedWhileRunning);
    })();

    try {
        await saveDataPromise;
    } finally {
        saveDataPromise = null;
    }
};

/**
 * 只保存单个角色到 IndexedDB（聊天消息写入、角色配置修改时使用），
 * 同一角色的并发保存会按顺序合并。
 */
const characterSaveQueues = new Map();
const groupSaveQueues = new Map();

const saveSingleChatRecord = async (table, collection, id, queueMap, label) => {
    const existing = queueMap.get(id);
    if (existing) {
        existing.requested = true;
        return existing.promise;
    }
    const state = { requested: false, promise: null };
    state.promise = (async () => {
        try {
            do {
                state.requested = false;
                const record = collection.find(item => item.id === id);
                if (!record) return;
                await table.put(record);
            } while (state.requested);
        } catch (error) {
            console.error(`${label} failed:`, error);
            if (typeof showToast === 'function') showToast('保存聊天数据失败: ' + error.message, 6000);
        } finally {
            queueMap.delete(id);
        }
    })();
    queueMap.set(id, state);
    return state.promise;
};

const saveCharacter = async (characterId) => {
    return saveSingleChatRecord(dexieDB.characters, db.characters, characterId, characterSaveQueues, 'saveCharacter');
};

/**
 * 只保存单个群组到 IndexedDB（群消息写入、群配置修改时使用），
 * 同一群组的并发保存会按顺序合并。
 */
const saveGroup = async (groupId) => {
    return saveSingleChatRecord(dexieDB.groups, db.groups, groupId, groupSaveQueues, 'saveGroup');
};

/**
 * 只保存全局设置（apiSettings、壁纸、主题等），不写角色/群
 */
const saveGlobalSettings = async (keys) => {
    try {
        const allSettingKeys = Array.isArray(keys) && keys.length
            ? Array.from(new Set(keys))
            : [...globalSettingKeys, 'worldBookCategoryOrder'];
        const promises = allSettingKeys
            .filter(key => db[key] !== undefined)
            .map(key => dexieDB.globalSettings.put({ key, value: db[key] }));
        await Promise.all(promises);
        return true;
    } catch (e) {
        console.error("saveGlobalSettings failed:", e);
        if (typeof showToast === 'function') showToast("保存设置失败: " + e.message);
        return false;
    }
};

window.saveCharacter = saveCharacter;
window.saveGroup = saveGroup;
window.saveGlobalSettings = saveGlobalSettings;

const loadData = async () => {
    const tables = [
        dexieDB.characters.toArray(),
        dexieDB.groups.toArray(),
        dexieDB.worldBooks.toArray(),
        dexieDB.myStickers.toArray(),
        dexieDB.globalSettings.toArray()
    ];
    if (dexieDB.archives) tables.push(dexieDB.archives.toArray());
    const results = await Promise.all(tables);
    const characters = results[0];
    const groups = results[1];
    const worldBooks = results[2];
    const myStickers = results[3];
    const settingsArray = results[4];
    const archives = results[5];

    db.characters = characters;
    db.groups = groups;
    db.worldBooks = worldBooks;
    db.myStickers = myStickers;
    db.archives = archives || [];

    const settings = settingsArray.reduce((acc, { key, value }) => {
        acc[key] = value;
        return acc;
    }, {});

    db.worldBookCategoryOrder = settings.worldBookCategoryOrder || null;

    globalSettingKeys.forEach(key => {
        const defaultValue = {
            apiSettings: {},
            summaryApiSettings: {},
            backgroundApiSettings: {},
            supplementPersonaApiSettings: {},
            peekApiSettings: {},
            vectorApiSettings: {},
            apiNodes: [],
            apiNodeRoutes: {},
            imageRecognitionEnabled: false,
            imageRecognitionApiSettings: {},
            stickerRecognitionApiSettings: {},
            wallpaper: 'https://i.postimg.cc/W4Z9R9x4/ins-1.jpg',
            globalChatWallpaper: '',
            globalCallWallpaper: '',
            homeScreenMode: 'night',
            fontUrl: '',
            localFontName: '',
            fontBuffer: null,
            customIcons: {},
            customAppNames: {},
            apiPresets: [],
            summaryApiPresets: [],
            backgroundApiPresets: [],
            supplementPersonaApiPresets: [],
            peekApiPresets: [],
            vectorApiPresets: [],
            imageRecognitionApiPresets: [],
            stickerRecognitionApiPresets: [],
            bubbleCssPresets: [],
            myPersonaPresets: [],
            fontPresets: [],
            globalCss: '',
            globalCssPresets: [],
            homeSignature: '编辑个性签名...',
            forumPosts: [],
            forumBindings: { worldBookIds: [], charIds: [], userPersonaIds: [] },
            forumUserProfile: { username: '', avatar: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bio: '', joinDate: 0 },
            forumSettings: { postsPerGeneration: 8, commentsPerPost: { min: 4, max: 8 }, generateDetailedStranger: false },
            forumApiSettings: { useForumApi: false, url: '', key: '', model: '', temperature: 0.9 },
            forumMessages: [],
            forumStrangerProfiles: {},
            forumFriendRequests: [],
            forumPendingRequestFromUser: {},
            forumAccountStates: {},
            forumRelationships: {},
            forumKnowledge: [],
            forumSocialEdges: [],
            forumStoryThreads: [],
            forumEvents: [],
            forumNotifications: [],
            forumDrafts: [],
            forumSchemaVersion: 2,
            pomodoroTasks: [],
            pomodoroSettings: { boundCharId: null, userPersona: '', focusBackground: '', taskCardBackground: '', encouragementMinutes: 25, pokeLimit: 5, globalWorldBookIds: [] },
            insWidgetSettings: { avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg', bubble1: 'love u.', avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bubble2: 'miss u.' },
            homeWidgetSettings: defaultWidgetSettings,
            memoryTableTemplates: [],
            vectorMemoryTemplates: [],
            activePersonaId: null,
            moreProfileCardBg: 'https://i.postimg.cc/XvFDdTKY/Smart-Select-20251013-023208.jpg',
            globalSendSound: '',
            globalReceiveSound: '',
            globalMessageSentSound: '',
            globalIncomingCallSound: '',
            multiMsgSoundEnabled: false,
            soundPresets: [],
            galleryPresets: [],
            iconPresets: [],
            homeWidgetPresets: [],
            widgetWallpaperPresets: [],
            cotSettings: { enabled: false, activePresetId: 'default' },
            cotPresets: JSON.parse(JSON.stringify(DEFAULT_COT_PRESETS)),
            hasSeenVideoCallDisclaimer: false,
            hasSeenVideoCallAvatarHint: false,
            favorites: [],
            piggyBank: { balance: 520, transactions: [], familyCards: [], receivedFamilyCards: [], orders: [], events: [], familyCardNarrationMode: 'detailed', schemaVersion: 2 },
            theaterScenarios: [],
            theaterPromptPresets: [],
            theaterHtmlScenarios: [],
            theaterHtmlPromptPresets: [],
            theaterMode: 'text',
            theaterApiSettings: { useTheaterApi: false, url: '', key: '', model: '' },
            theaterFontSize: 15,
        theaterFontPreset: null,
        avatarRecognitionDetailLevel: 'detailed',
        autoCompressImage: true,
        gptImageSettings: {},
        gptImagePresets: [],
        novelAiSettings: {},
        novelAiPresets: [],
        googleImageSettings: {},
        stabilityImageSettings: {},
        activeImageProvider: '',
        imageAtmosphereGroups: [],
        activeImageAtmosphereId: '',
        nodeTemplates: [],
        nodeSummaryText: '摘要',
        stickerCategories: [],
        magicRoom: {
            customPromptEnabled: false,
            customPromptTemplate: '',
            promptEditMode: '',
            customPromptItems: [],
            presets: [],
            sysNotifEnabled: false,
            sysNotifSenderName: '',
            sysNotifShowAvatar: true,
            sysNotifInChatEnabled: false,
            sysNotifShowContent: true,
            sysNotifCustomServer: false,
            sysNotifServerUrl: '',
            sysNotifServerKey: '',
        },
        keepAliveCodeEnabled: false,
        keepAliveAutoWakeEnabled: true,
        keepAliveAudioEnabled: false,
        keepAliveAudioSrc: '',
        keepAliveAudioName: '',
        keepAliveAudioLibrary: []
    };
    db[key] = settings[key] !== undefined ? settings[key] : (defaultValue[key] !== undefined ? JSON.parse(JSON.stringify(defaultValue[key])) : undefined);
});

    if (!Array.isArray(db.stickerCategories)) db.stickerCategories = [];
    if (!Array.isArray(db.vectorMemoryTemplates)) db.vectorMemoryTemplates = [];
    if (!Array.isArray(db.vectorApiPresets)) db.vectorApiPresets = [];
    if (!db.piggyBank) db.piggyBank = { balance: 520, transactions: [], familyCards: [], receivedFamilyCards: [] };
    if (typeof db.piggyBank.balance !== 'number') db.piggyBank.balance = 520;
    if (!Array.isArray(db.piggyBank.transactions)) db.piggyBank.transactions = [];
    if (!Array.isArray(db.piggyBank.familyCards)) db.piggyBank.familyCards = [];
    if (!Array.isArray(db.piggyBank.receivedFamilyCards)) db.piggyBank.receivedFamilyCards = [];
    if (!Array.isArray(db.piggyBank.orders)) db.piggyBank.orders = [];
    if (!Array.isArray(db.piggyBank.events)) db.piggyBank.events = [];
    if (!db.piggyBank.familyCardNarrationMode) db.piggyBank.familyCardNarrationMode = 'detailed';
    db.piggyBank.schemaVersion = Math.max(2, Number(db.piggyBank.schemaVersion) || 0);
    if (!db.forumStrangerProfiles || typeof db.forumStrangerProfiles !== 'object') db.forumStrangerProfiles = {};
    if (!Array.isArray(db.forumFriendRequests)) db.forumFriendRequests = [];
    if (!db.forumPendingRequestFromUser || typeof db.forumPendingRequestFromUser !== 'object') db.forumPendingRequestFromUser = {};
    if (db.forumSettings && db.forumSettings.generateDetailedStranger === undefined) db.forumSettings.generateDetailedStranger = false;
    if (db.forumSettings && db.forumSettings.enableCharAltDm === undefined) db.forumSettings.enableCharAltDm = false;
    if (db.forumSettings && !Array.isArray(db.forumSettings.charAltCharIds)) db.forumSettings.charAltCharIds = [];
    if (db.forumSettings && db.forumSettings.charAltProbability === undefined) db.forumSettings.charAltProbability = 25;
    if (db.forumSettings && (db.forumSettings.charAltNames === undefined || typeof db.forumSettings.charAltNames !== 'object')) db.forumSettings.charAltNames = {};
    if (typeof forumEnsureData === 'function') forumEnsureData();

    // Data integrity checks
    db.characters.forEach(c => {
        if (!c.peekData) c.peekData = {}; 
        if (c.isPinned === undefined) c.isPinned = false;
        if (c.status === undefined) c.status = '在线';
        if (!c.worldBookIds) c.worldBookIds = [];
        if (c.callWallpaper === undefined) c.callWallpaper = '';
        if (c.customBubbleCss === undefined) c.customBubbleCss = '';
        if (c.useCustomBubbleCss === undefined) c.useCustomBubbleCss = false;
        if (c.allowCharSwitchBubbleCss === undefined) c.allowCharSwitchBubbleCss = false;
        if (!Array.isArray(c.bubbleCssThemeBindings)) c.bubbleCssThemeBindings = [];
        if (c.currentBubbleCssPresetName === undefined) c.currentBubbleCssPresetName = '';
        if (c.themeJustChangedByUser === undefined) c.themeJustChangedByUser = '';
        if (c.showTimestamp === undefined) c.showTimestamp = false;
        if (c.timestampPosition === undefined) c.timestampPosition = 'below_avatar';
        if (!c.statusPanel) {
            c.statusPanel = {
                enabled: false,
                promptSuffix: '',
                regexPattern: '',
                replacePattern: '',
                historyLimit: 3,
                currentStatusRaw: '',
                currentStatusHtml: '',
                history: []
            };
        }
        if (!['journal', 'table', 'vector'].includes(c.memoryMode)) c.memoryMode = 'journal';
        if (!c.memoryTables || typeof c.memoryTables !== 'object') {
            c.memoryTables = {
                enabled: true,
                boundTemplateIds: [],
                data: {},
                lockedFields: {},
                history: [],
                lastChangedFieldPaths: []
            };
        }
        if (!Array.isArray(c.memoryTables.boundTemplateIds)) c.memoryTables.boundTemplateIds = [];
        if (!c.memoryTables.data || typeof c.memoryTables.data !== 'object') c.memoryTables.data = {};
        if (!c.memoryTables.lockedFields || typeof c.memoryTables.lockedFields !== 'object') c.memoryTables.lockedFields = {};
        if (!Array.isArray(c.memoryTables.history)) c.memoryTables.history = [];
        if (!Array.isArray(c.memoryTables.lastChangedFieldPaths)) c.memoryTables.lastChangedFieldPaths = [];
        if (!c.vectorMemory || typeof c.vectorMemory !== 'object') {
            c.vectorMemory = {
                enabled: true,
                boundTemplateId: null,
                entries: [],
                history: [],
                topK: 5,
                threshold: 0.28,
                autoSummaryEnabled: false,
                autoSummaryInterval: 200,
                autoSummaryState: 'idle',
                autoSummaryPending: false,
                lastSummarizedMsgId: null,
                lastSummarizedMsgTimestamp: null,
                lastContextBlock: '',
                lastRetrievedEntryIds: [],
                lastQueryText: '',
                lastPreparedAt: null
            };
        }
        if (!Array.isArray(c.vectorMemory.entries)) c.vectorMemory.entries = [];
        if (!Array.isArray(c.vectorMemory.history)) c.vectorMemory.history = [];
        if (c.vectorMemory.topK === undefined) c.vectorMemory.topK = 5;
        if (c.vectorMemory.threshold === undefined) c.vectorMemory.threshold = 0.28;
        if (c.vectorMemory.autoSummaryEnabled === undefined) c.vectorMemory.autoSummaryEnabled = false;
        if (!Number.isFinite(parseInt(c.vectorMemory.autoSummaryInterval, 10))) c.vectorMemory.autoSummaryInterval = 200;
        if (!c.vectorMemory.autoSummaryState) c.vectorMemory.autoSummaryState = 'idle';
        if (c.vectorMemory.autoSummaryPending === undefined) c.vectorMemory.autoSummaryPending = false;
        if (!Array.isArray(c.vectorMemory.lastRetrievedEntryIds)) c.vectorMemory.lastRetrievedEntryIds = [];
        if (!c.regexFilter) {
            c.regexFilter = {
                enabled: false,
                rules: []
            };
        }
        if (!c.autoReply) {
            c.autoReply = {
                enabled: false,
                interval: 60,
                lastTriggerTime: 0
            };
        }
        if (!c.followUpReply || typeof c.followUpReply !== 'object') {
            c.followUpReply = {
                enabled: false,
                delayMode: 'random',
                fixedDelayMinutes: 120,
                minDelayMinutes: 60,
                maxDelayMinutes: 180,
                probability: 35,
                maxFollowUps: 1,
                pending: null,
                lastSuccessAt: 0,
                lastDecision: null
            };
        }
        if (!c.gallery) c.gallery = [];
        if (c.useRealGallery === undefined) c.useRealGallery = false;
        if (!c.callHistory) c.callHistory = [];
        if (!c.userAvatarLibrary || !Array.isArray(c.userAvatarLibrary)) c.userAvatarLibrary = [];
        if (!c.charAvatarLibrary || !Array.isArray(c.charAvatarLibrary)) c.charAvatarLibrary = [];
        if (!c.coupleAvatarLibrary || !Array.isArray(c.coupleAvatarLibrary)) c.coupleAvatarLibrary = [];
        if (!c.avatarRelationshipHistory || !Array.isArray(c.avatarRelationshipHistory)) c.avatarRelationshipHistory = [];
        if (c.activeCoupleAvatarId === undefined) c.activeCoupleAvatarId = null;
        if (c.activeCoupleAvatarId && !c.coupleAvatarLibrary.some(function (item) { return item && item.id === c.activeCoupleAvatarId; })) {
            c.activeCoupleAvatarId = null;
        }
        if (c.avatarSystemEnabled === undefined) c.avatarSystemEnabled = false;
        if (c.charSenseAvatarChangeEnabled === undefined) c.charSenseAvatarChangeEnabled = false;
        if (c.charCanSwitchAvatarEnabled === undefined) c.charCanSwitchAvatarEnabled = false;
        if (c.charCollectImageAsAvatarEnabled === undefined) c.charCollectImageAsAvatarEnabled = false;
        if (c.charCollectCoupleAvatarEnabled === undefined) c.charCollectCoupleAvatarEnabled = false;
        if (c.charSenseCoupleAvatarEnabled === undefined) c.charSenseCoupleAvatarEnabled = false;
        if (c.showAvatarActionMsg === undefined) c.showAvatarActionMsg = false;
        if (c.charTimezone === undefined) c.charTimezone = '';
        if (c.myTimezone === undefined) c.myTimezone = '';
        if (c.enableDynamicTimezone === undefined) c.enableDynamicTimezone = false;
        if (c.myEnableDynamicTimezone === undefined) c.myEnableDynamicTimezone = false;
        // 拉黑与好友申请
        if (c.isBlocked === undefined) c.isBlocked = false;
        if (!c.blockHistory || !Array.isArray(c.blockHistory)) c.blockHistory = [];
        if (!c.friendRequests || !Array.isArray(c.friendRequests)) c.friendRequests = [];
        if (!c.blockReapply || typeof c.blockReapply !== 'object') {
            c.blockReapply = { mode: 'fixed', fixedInterval: 30, lastRequestTime: null, nextCheckTime: null, pendingRequestId: null };
        }
        // 角色拉黑用户（角色主动拉黑）
        if (c.canBlockUser === undefined) c.canBlockUser = true;
        // 角色掌控模式：允许角色查看并操控用户手机
        if (c.phoneControlEnabled === undefined) c.phoneControlEnabled = false;
        if (c.phoneControlViewLimit === undefined) c.phoneControlViewLimit = 10;
        if (!Array.isArray(c.phoneControlHistory)) c.phoneControlHistory = [];
        if (c.familyCardEnabled === undefined) c.familyCardEnabled = false;
        if (c.autonomousShoppingEnabled === undefined) c.autonomousShoppingEnabled = false;
        if (c.characterOwnWalletShoppingEnabled === undefined) c.characterOwnWalletShoppingEnabled = true;
        if (c.characterFamilyCardSpendingEnabled === undefined) c.characterFamilyCardSpendingEnabled = false;
        if (c.characterSelfShoppingEnabled === undefined) c.characterSelfShoppingEnabled = true;
        if (c.characterGiftShoppingEnabled === undefined) c.characterGiftShoppingEnabled = true;
        if (c.characterPayRequestEnabled === undefined) c.characterPayRequestEnabled = true;
        if (c.characterShoppingSingleLimit === undefined) c.characterShoppingSingleLimit = 200;
        if (c.characterShoppingPeriodBudget === undefined) c.characterShoppingPeriodBudget = 1000;
        if (c.characterShoppingFrequency === undefined) c.characterShoppingFrequency = 'rare';
        if (c.characterShoppingAllowedCategories === undefined) c.characterShoppingAllowedCategories = '';
        if (c.isBlockedByChar === undefined) c.isBlockedByChar = false;
        if (c.blockedByCharAt === undefined) c.blockedByCharAt = null;
        if (c.blockedByCharReason === undefined) c.blockedByCharReason = '';
        if (!c.charBlockHistory || !Array.isArray(c.charBlockHistory)) c.charBlockHistory = [];
        if (!c.userFriendRequests || !Array.isArray(c.userFriendRequests)) c.userFriendRequests = [];
        // 节点系统
        if (!c.nodes) c.nodes = [];
        if (c.activeNodeId === undefined) c.activeNodeId = null;

        // 用户头像库迁移：旧数据只有 name（实为描述），拆分为 name（简短名称）+ description（描述）
        c.userAvatarLibrary.forEach(function (item) {
            if (item.description === undefined && item.name) {
                item.description = item.name;
                item.name = item.name.length > 12 ? item.name.slice(0, 12) + '…' : item.name;
            }
            if (item.name === undefined) item.name = (item.description && item.description.length > 12) ? item.description.slice(0, 12) + '…' : (item.description || '未命名');
        });
    });
    if (db.userAvatarLibrary && Array.isArray(db.userAvatarLibrary) && db.userAvatarLibrary.length > 0) {
        db.characters.forEach(c => {
            if (!c.userAvatarLibrary) c.userAvatarLibrary = [];
            c.userAvatarLibrary.push(...db.userAvatarLibrary);
        });
        delete db.userAvatarLibrary;
        if (typeof saveData === 'function') saveData();
    }
    db.groups.forEach(g => {
        if (g.isPinned === undefined) g.isPinned = false;
        if (!g.worldBookIds) g.worldBookIds = [];
        if (g.customBubbleCss === undefined) g.customBubbleCss = '';
        if (g.useCustomBubbleCss === undefined) g.useCustomBubbleCss = false;
        if (g.showTimestamp === undefined) g.showTimestamp = false;
        if (g.timestampPosition === undefined) g.timestampPosition = 'below_avatar';
        if (!g.callHistory) g.callHistory = [];
    });
    
    // Handle old localStorage data if it exists
    const oldLocalStorageData = localStorage.getItem('gemini-chat-app-db');
    if(oldLocalStorageData) {
        console.log("Found old localStorage data, migrating...");
        const data = JSON.parse(oldLocalStorageData);
        await dexieDB.transaction('rw', dexieDB.tables, async () => {
            if (data.characters) await dexieDB.characters.bulkPut(data.characters);
            if (data.groups) await dexieDB.groups.bulkPut(data.groups);
        });
        localStorage.removeItem('gemini-chat-app-db');
        await loadData();
    }
};

// 存储分析工具
const dataStorage = {
    getStorageInfo: async function() {
        const measure = async (root) => {
            const stack = [root];
            const seen = new Set();
            let size = 0;
            let visited = 0;
            while (stack.length) {
                const value = stack.pop();
                if (value == null) {
                    size += 4;
                } else if (typeof value === 'string') {
                    size += value.length + 2;
                } else if (typeof value === 'number' || typeof value === 'boolean') {
                    size += String(value).length;
                } else if (typeof value === 'object') {
                    if (seen.has(value)) continue;
                    seen.add(value);
                    size += 2;
                    if (Array.isArray(value)) {
                        size += Math.max(0, value.length - 1);
                        for (let i = 0; i < value.length; i++) stack.push(value[i]);
                    } else {
                        const entries = Object.entries(value);
                        size += Math.max(0, entries.length - 1);
                        entries.forEach(([key, child]) => {
                            size += key.length + 3;
                            stack.push(child);
                        });
                    }
                }
                visited++;
                if (visited % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            return size;
        };

        let categorizedSizes = {
            messages: 0,
            charactersAndGroups: 0,
            worldAndForum: 0,
            personalization: 0,
            apiAndCore: 0,
            other: 0
        };

        if (!db || !db.characters) {
            await loadData();
        }

        // 1. Messages (History)
        for (const char of (db.characters || [])) categorizedSizes.messages += await measure(char.history);
        for (const group of (db.groups || [])) categorizedSizes.messages += await measure(group.history);

        // 2. Characters and Groups (metadata)
        for (const char of (db.characters || [])) {
            const charWithoutHistory = { ...char, history: undefined };
            categorizedSizes.charactersAndGroups += await measure(charWithoutHistory);
        }
        for (const group of (db.groups || [])) {
            const groupWithoutHistory = { ...group, history: undefined };
            categorizedSizes.charactersAndGroups += await measure(groupWithoutHistory);
        }

        // 3. World and Forum
        categorizedSizes.worldAndForum += await measure(db.worldBooks);
        categorizedSizes.worldAndForum += await measure(db.forumPosts);
        categorizedSizes.worldAndForum += await measure(db.forumBindings);
        categorizedSizes.worldAndForum += await measure(db.forumMessages);
        categorizedSizes.worldAndForum += await measure(db.forumStrangerProfiles);
        categorizedSizes.worldAndForum += await measure(db.forumRelationships);
        categorizedSizes.worldAndForum += await measure(db.forumKnowledge);
        categorizedSizes.worldAndForum += await measure(db.forumEvents);

        // 4. Personalization
        categorizedSizes.personalization += await measure(db.myStickers);
        categorizedSizes.personalization += await measure(db.wallpaper);
        categorizedSizes.personalization += await measure(db.globalChatWallpaper);
        categorizedSizes.personalization += await measure(db.globalCallWallpaper);
        categorizedSizes.personalization += await measure(db.homeScreenMode);
        categorizedSizes.personalization += await measure(db.fontUrl);
        categorizedSizes.personalization += await measure(db.localFontName);
        categorizedSizes.personalization += await measure(db.fontBuffer);
        categorizedSizes.personalization += await measure(db.customIcons);
        categorizedSizes.personalization += await measure(db.bubbleCssPresets);
        categorizedSizes.personalization += await measure(db.myPersonaPresets);
        categorizedSizes.personalization += await measure(db.globalCss);
        categorizedSizes.personalization += await measure(db.globalCssPresets);
        categorizedSizes.personalization += await measure(db.homeSignature);
        categorizedSizes.personalization += await measure(db.pomodoroTasks);
        categorizedSizes.personalization += await measure(db.pomodoroSettings);
        categorizedSizes.personalization += await measure(db.insWidgetSettings);
        categorizedSizes.personalization += await measure(db.homeWidgetSettings);
        categorizedSizes.personalization += await measure(db.moreProfileCardBg);
        categorizedSizes.personalization += await measure(db.soundPresets);
        categorizedSizes.personalization += await measure(db.iconPresets);

        // 5. API and Core
        categorizedSizes.apiAndCore += await measure(db.apiSettings);
        categorizedSizes.apiAndCore += await measure(db.apiPresets);
        categorizedSizes.apiAndCore += await measure(db.cotSettings);
        categorizedSizes.apiAndCore += await measure(db.cotPresets);
        categorizedSizes.apiAndCore += await measure(db.keepAliveAudioSrc);
        categorizedSizes.apiAndCore += await measure(db.keepAliveAudioLibrary);

        const totalSize = Object.values(categorizedSizes).reduce((sum, size) => sum + size, 0);

        return {
            totalSize,
            categorizedSizes
        };
    }
};
