import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let workerCalls = 0;
class LocalWorker {
    constructor() {
        this.context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, console });
        this.context.self = this.context;
        this.context.importScripts = file => vm.runInContext(read(path.posix.normalize('js/modules/chat-ai/' + file)), this.context);
        this.context.postMessage = data => queueMicrotask(() => this.onmessage?.({ data }));
        vm.runInContext(read('js/modules/chat-ai/token-counter-worker.js'), this.context);
    }
    postMessage(data) { workerCalls++; queueMicrotask(() => this.context.onmessage({ data })); }
    terminate() {}
}
const image = 'data:image/png;base64,' + 'A'.repeat(100000);
const message = (id, content, extra = {}) => ({ id, role:'user', content, timestamp:1780000000000, ...extra });
const character = { id:'c', realName:'她', myName:'我', persona:'角色独特人设', myPersona:'用户独特设定', maxMemory:20,
    history:[message('u','你好')], worldBookIds:[], memoryJournals:[], nodes:[], themeJustChangedByUser:'新的主题' };
const db = { characters:[character], groups:[], worldBooks:[], apiSettings:{ model:'gpt-4o', provider:'openai', url:'https://example.test', key:'private-key' },
    magicRoom:{ customPromptEnabled:false }, cotSettings:{}, cotPresets:[], favorites:[], myStickers:[], bubbleCssPresets:[], piggyBank:{}, forumSettings:{} };
let saveResult = true, saves = 0;
const context = vm.createContext({
    db, window:{}, document:{getElementById:()=>null}, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, AbortController, Worker:LocalWorker,
    showErrorModal:()=>{}, showToast:()=>{}, showAppConfirmDialog:async()=>true,
    normalizeMessagesForProvider:messages=>messages,
    writeOvoPngMetadata:v=>v, readOvoPngMetadata:()=>null,
    pad:value => String(value).padStart(2,'0'), getRandomValue:value => value,
    filterHistoryForAI:(_,list) => clone(list), getLocalTimeInTimezone:() => '', formatTimeGap:() => '',
    getOnlineLogicRules:() => '在线逻辑规则', getOnlineOutputFormats:() => '在线输出格式', getOfflineOutputFormats:() => '线下输出格式',
    getAvailablePrivateStickers:() => [], getMemoryTableContextBlock:() => '<table_memory>表格专属内容</table_memory>',
    getVectorMemoryContextBlock:() => '<vector_memory>向量专属内容</vector_memory>',
    saveCharacter:async () => { saves++; return saveResult; }, saveGroup:async () => { saves++; return saveResult; }
});
for (const file of ['js/core/api-and-image-utils.js','js/modules/chat-ai/context-and-image.js','js/modules/chat-ai/private-prompt.js',
    'js/modules/chat-ai/request-and-stream.js','js/modules/chat-ai/token-stats.js']) vm.runInContext(read(file),context,{ filename:file });
const engine = context.window.ChatTokenStats;
const preview = () => context.getChatTokenBreakdown('c','private');
const category = (data,key) => data.details.find(d => d.key === key)?.value || 0;
const sum = data => assert.equal(data.details.reduce((n,d) => n + d.value,0),data.total);

// Real default prompt: no worldbooks, no custom prompt, and preview must be read-only.
const before = clone(character), initial = preview();
assert.equal(category(initial,'worldBook'),0); assert.equal(initial.worldBookCount,0); sum(initial);
assert.deepEqual(character,before); assert.ok(initial.total > 0);
const baseCalls = workerCalls;
await Promise.all([engine.refine(initial),engine.refine(initial)]);
assert.equal(workerCalls,baseCalls + 1,'identical previews share one worker job');
const exact = preview(); assert.equal(exact.textExact,true); sum(exact);
assert.equal(character.themeJustChangedByUser,'新的主题');
for (const enc of ['o200k_base','cl100k_base']) {
    const w = new LocalWorker(), text = '你好🙂 hello 世界，e\u0301 <|endoftext|>';
    const result = await new Promise(resolve => { w.onmessage = e => resolve(e.data); w.postMessage({ id:1,encoding:enc,docs:[{ text,spans:[{start:0,end:1},{start:1,end:8},{start:8,end:text.length}] }] }); });
    assert.equal(result.error,undefined);
    const expected = w.context.OVOTokenizer.default.encode(text,{ disallowedSpecial:new Set() }).length;
    assert.equal(result.counts[0].reduce((a,b) => a + b,0),expected,'BPE attribution must sum to whole-text token count');
}

// The 100k symptom: messages before the active node are excluded by the SAME sender helper.
character.nodes = [{ id:'n',type:'online' }]; character.activeNodeId = 'n';
character.history = [message('huge','旧消息'.repeat(30000)),{ id:'boundary',isNodeBoundary:true,nodeAction:'start',nodeId:'n' },message('current','你好')];
let data = preview(); assert.deepEqual(Array.from(data.historyIds),['current']); assert.ok(data.historyTokens < 100); sum(data);
assert.equal(engine.selfTest().passed,true);
db.nodeSummaryFloor = 1; character.nodes[0].enableSummary = true;
character.history.push(message('second','原文'.repeat(10000),{ nodeSummary:'只保留摘要' }),message('third','最后一句'));
data = preview(); assert.ok(data.historyTokens < 150); assert.ok(data._context.selected.some(m => m.content.includes('只保留摘要')));
assert.ok(character.history.find(m => m.id === 'second').content.length > 10000,'preview cannot overwrite original history');
character.nodes = []; delete character.activeNodeId; character.history = [message('a','正文'),message('b','思考',{isThinking:true}),message('d','禁用',{isContextDisabled:true}),message('e','工具状态',{type:'mcp_activity'}),message('f','动态',{isMomentsActivity:true})];
assert.deepEqual(Array.from(preview().historyIds),['a']);
character.maxMemory = 'invalid'; character.history = Array.from({length:25},(_,i) => message(String(i),'短句'));
assert.equal(preview().messageCount,20); character.maxMemory = 20; character.history = [message('u','你好')];

// Activation and binding removal; legacy empty offline bindings still inherit until explicitly saved.
db.worldBooks = [{id:'w',name:'世界书',position:'middle',content:'世界书独特内容',alwaysOn:true},{id:'keyword',position:'after',content:'关键词专属内容',alwaysOn:false,keywords:['触发词']}];
character.worldBookIds = ['w','keyword']; data = preview(); assert.ok(category(data,'worldBook') > 0); assert.equal(data.worldBookCount,1);
character.history = [message('trigger','触发词')]; assert.equal(preview().worldBookCount,2);
const simulated = context.getChatTokenBreakdown('c','private',{overrides:{worldBookIds:[]}}); assert.equal(category(simulated,'worldBook'),0); assert.equal(character.worldBookIds.length,2);
character.worldBookIds = []; assert.equal(category(preview(),'worldBook'),0);
character.worldBookIds = ['w']; character.nodes = [{id:'offline',type:'spinoff',spinoffMode:'offline'}]; character.activeNodeId = 'offline'; character.offlineWorldBookIds = [];
assert.ok(context.getActiveWorldBooksContents(character).middle);
character.offlineWorldBookSelectionExplicit = true; assert.equal(context.getActiveWorldBooksContents(character).middle,'');
character.nodes=[]; delete character.activeNodeId;
for (const mode of ['table','vector']) { character.memoryMode=mode; data=preview(); assert.ok(category(data,mode === 'table' ? 'tableMemory':'vectorMemory') > 0); assert.equal(category(data,'memoir'),0); sum(data); }
character.vectorMemory={lastContextBlock:'发送时的检索缓存',entries:[{id:'entry',title:'原条目'}]};
character.memoryMode='vector'; const memoryBefore=clone(character.vectorMemory), vectorGetter=context.getVectorMemoryContextBlock;
context.getVectorMemoryContextBlock=chat=>{chat.vectorMemory.lastContextBlock='预览缓存';chat.vectorMemory.entries[0].title='预览条目';return '<vector_memory>向量专属内容</vector_memory>';};
preview(); assert.deepEqual(character.vectorMemory,memoryBefore,'preview must not mutate nested live memory caches'); context.getVectorMemoryContextBlock=vectorGetter;
delete character.memoryMode;
character.memoryJournals=[{title:'往事',content:'共同回忆专属内容',isFavorited:true}]; assert.ok(category(preview(),'memoir') > 0);

// Typed image transport is not text. Encoded data really sent as text must be counted and diagnosed.
character.worldBookIds=[]; character.history=[message('img',image,{parts:[{type:'text',text:'看图'},{type:'image',data:image}]})];
data=preview(); assert.equal(data.mediaCount,1); assert.ok(data.total < 10000); assert.equal(data.encodedMediaText,0);
character.history=[message('html','<img src="'+image+'">',{parts:[{type:'html',text:'<img src="'+image+'">'}]})];
data=preview(); assert.ok(data.encodedMediaText > 100000); assert.ok(data.historyTokens > 40000);
character.history=[message('quote','回复',{quote:{content:'引用的原文'}}),message('theater','[小剧场分享:s]')];
db.theaterScenarios=[{id:'s',title:'故事',mode:'html',content:'<style>hidden</style><p>剧场正文</p>'}];
for (const provider of ['openai','gemini']) { db.apiSettings.provider=provider; data=preview(); const texts=data.docs.map(d=>d.text).join('\n'); assert.ok(texts.includes('引用的原文')); assert.ok(texts.includes('剧场正文')); assert.ok(!texts.includes('<style>hidden')); }
db.apiSettings.provider='openai'; character.history=[message('u','你好')];

// Per-request usage, partial streaming events, retries, cache semantics and group working copies.
const body={model:'gpt-4o',messages:[{role:'system',content:'规则'},{role:'user',content:'你好'}]};
const rec=engine.record(character,'private',body,db.apiSettings,{history:character.history,systemPrompt:'规则'});
engine.usage(character,{usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:40}}},rec);
engine.usage(character,{usage:{completion_tokens:20,completion_tokens_details:{reasoning_tokens:5}}},rec);
engine.usage(character,{usage:{completion_tokens:20}},rec); assert.equal(rec.usage.input,100); assert.equal(rec.usage.output,20); assert.equal(rec.usage.cached,40);
const retry=engine.record(character,'private',body,db.apiSettings); assert.notEqual(retry.id,rec.id); assert.equal(retry.usage,null);
engine.usage(character,{usage:{completion_tokens:7}},retry); assert.equal(retry.usage.input,undefined,'new output-only usage must not borrow last request input');
const claude=engine.record(character,'private',body,{apiProtocol:'anthropic'});
engine.usage(character,{message:{usage:{input_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:5}}},claude);
engine.usage(character,{usage:{output_tokens:8}},claude); assert.equal(claude.usage.input,45); assert.equal(claude.usage.output,8);
const gemini=engine.record(character,'private',body,{apiProtocol:'gemini'});
engine.usage(character,{usageMetadata:{promptTokenCount:20,candidatesTokenCount:4,thoughtsTokenCount:6,cachedContentTokenCount:8}},gemini);
assert.equal(gemini.usage.input,20); assert.equal(gemini.usage.thinking,6);
const group={id:'g',history:[],members:[],me:{persona:''},worldBookIds:[]}; db.groups.push(group);
const groupRec=engine.record({...group},'group',body,db.apiSettings); engine.usage(null,{usage:{prompt_tokens:9}},groupRec); assert.equal(group._lastTokenUsage.input,9);
for(let i=0;i<32;i++) engine.record(character,'private',body,{}); assert.equal(character._tokenRequests.length,30);

// Only deterministic duplicate REFERENCES can be repaired; persistence, undo and failure rollback.
character.worldBookIds=['w','w']; const originalHistory=clone(character.history);
let results=await engine.detect('c'); assert.equal(results[0].corrected,1); assert.deepEqual(Array.from(character.worldBookIds),['w']); assert.ok(character._tokenRepairs.length);
const savedCount=saves; results=await engine.detect('c'); assert.equal(results[0].corrected,0); assert.equal(saves,savedCount,'repair is idempotent');
await engine.undo('c'); assert.deepEqual(Array.from(character.worldBookIds),['w','w']);
saveResult=false; results=await engine.detect('c'); assert.equal(results[0].corrected,0); assert.deepEqual(Array.from(character.worldBookIds),['w','w']); saveResult=true;
assert.deepEqual(character.history,originalHistory);
character.worldBookIds=['missing']; results=await engine.detect('c'); assert.ok(results[0].issues.some(i=>i.code==='missing-binding')); assert.deepEqual(character.worldBookIds,['missing']); character.worldBookIds=[];
const diagnostic=JSON.stringify(engine.diagnostics('c')); assert.ok(!diagnostic.includes('private-key')); assert.ok(!diagnostic.includes('角色独特人设')); assert.ok(!diagnostic.includes('用户独特设定'));

// Official adapters keep prepared system/tools and don't double-convert Anthropic messages.
let fetched;
context.fetch=async(url,opts)=>{fetched={url,body:JSON.parse(opts.body)};return {ok:true,json:async()=>({input_tokens:123,totalTokens:123})};};
db.apiSettings={model:'claude-sonnet-4',url:'https://example.test',key:'private-key',provider:'claude',apiProtocol:'anthropic'};
data=preview(); const expectedSystem=clone(data._context.body.system);
assert.equal((await engine.official(data)).input,123); assert.ok(fetched.url.endsWith('/v1/messages/count_tokens')); assert.deepEqual(fetched.body.system,expectedSystem);
db.apiSettings={model:'gemini-2.5-flash',url:'https://example.test',key:'private-key',provider:'gemini',apiProtocol:'gemini'};
data=preview(); await engine.official(data); assert.ok(fetched.url.includes(':countTokens')); assert.ok(fetched.body.generateContentRequest.systemInstruction);
db.apiSettings={model:'gpt-4o',url:'https://example.test',key:'private-key',provider:'openai'}; await assert.rejects(engine.official(preview()),/没有已适配/);
await pause(80);

// Non-regression: extracted serializers retain the exact previous behavior for both protocols.
const baseline=path.join(os.tmpdir(),'ovo-token-task-baseline','js/modules/chat-ai/request-and-stream.js');
if(fs.existsSync(baseline)) {
    const old=fs.readFileSync(baseline,'utf8');
    const geminiStart=old.indexOf('let lastMsgTimeForAI = 0;');
    const geminiBody=old.slice(geminiStart,old.indexOf('if (contents.length',geminiStart));
    const openStart=old.indexOf('let lastMsgTimeForAI = 0;',geminiStart+1);
    // End at the history loop, before the continuation/system/CoT additions.
    const tail=old.indexOf("if (messages.length",openStart);
    const end=old.lastIndexOf('});',tail)+3;
    vm.runInContext(`function oldGemini(chat,chatType,historySlice,apiConfig={},replyOptions={},latestTurnProtectionEnabled=false){${geminiBody};return contents;}`,context);
    vm.runInContext(`function oldOpen(chat,chatType,historySlice,apiConfig={},replyOptions={},latestTurnProtectionEnabled=false){const messages=[];${old.slice(openStart,end)};return messages;}`,context);
    const fixtures=[message('q','回复',{quote:{content:'引用'}}),message('i',image,{parts:[{type:'text',text:'图片说明'},{type:'image',data:image,description:'画面'}]}),message('t','[小剧场分享:s]'),message('a','回复',{role:'assistant'})];
    for(const mode of ['','reject','description']) for(const member of [undefined,{id:'member'}]) {
        const args=[character,'private',clone(fixtures),{imageMode:mode},{member},true];
        assert.deepEqual(clone(context.serializeChatHistoryForGemini(...args)),clone(context.oldGemini(...args)));
        assert.deepEqual(clone(context.serializeChatHistoryMessages(...args)),clone(context.oldOpen(...args)));
    }
}

// Real DOM interaction with the existing renderer and worldbook confirmation handler.
let JSDOM;
try { ({JSDOM}=await import('jsdom')); } catch (_) { console.log('Optional DOM interaction check skipped: jsdom unavailable.'); }
if(JSDOM) {
    const dom=new JSDOM(read('src/html/screens/chat-dialogs.html')+'<div id="world-book-selection-modal" class="visible"><div id="world-book-selection-list"><input class="item-checkbox" type="checkbox" value="w" checked></div><button id="save-world-book-selection-btn"></button></div><button id="pc-message-btn" data-char-id="c"></button><span id="pc-stat-memory"></span>',{url:'https://example.test',runScripts:'outside-only'});
    let fallbackSaves=0;
    const ui=dom.getInternalVMContext(); Object.assign(ui,{db,showToast:()=>{},currentChatId:'c',currentChatType:'private',saveCharacter:async()=>saveResult,saveGroup:async()=>saveResult,saveData:async()=>{fallbackSaves++;},filterHistoryForAI:(_,list)=>clone(list),getRandomValue:v=>v});
    ui.generatePrivateSystemPrompt=chat=>'规则\n'+context.getActiveWorldBooksContents(chat).middle;
    ui.generateGroupSystemPrompt=chat=>'群聊规则\n'+(chat.worldBookIds||[]).map(id=>db.worldBooks.find(w=>w.id===id)?.content||'').join('\n');
    ui.getActiveWorldBooksContents=context.getActiveWorldBooksContents; ui.getEffectivePersona=context.getEffectivePersona;
    vm.runInContext(read('js/modules/chat-ai/request-and-stream.js'),ui); ui.pad=context.pad; ui.collapseStickerPartsForAI=context.collapseStickerPartsForAI;
    vm.runInContext(read('js/modules/chat-ai/token-stats.js'),ui); vm.runInContext(read('js/contacts.js'),ui); vm.runInContext(read('js/modules/chat-ai/token-ui.js'),ui);
    const contacts=read('js/contacts.js'); vm.runInContext(contacts.slice(contacts.indexOf('const tokenDistCloseBtn'),contacts.indexOf('document.getElementById(\'token-storage-link\')')),ui);
    const setup=read('src/js/settings/chat-settings/setup.jsfrag'),start=setup.indexOf('// Selection is a draft'),end=setup.indexOf('const statusPanelSwitch',start);
    vm.runInContext('let currentWorldBookMode="online";'+setup.slice(start,end),ui);
    character.worldBookIds=['w']; ui.openTokenDistributionModal('c');
    const worldValue=()=>[...ui.document.querySelectorAll('.token-detail-item')].find(el=>el.querySelector('.token-detail-name')?.textContent==='世界书')?.querySelector('.token-detail-value')?.textContent;
    assert.notEqual(worldValue(),'0 Token');
    ui.document.querySelector('.item-checkbox').checked=false;
    ui.document.querySelector('.item-checkbox').dispatchEvent(new ui.Event('change',{bubbles:true}));
    assert.deepEqual(character.worldBookIds,['w'],'draft selection must not change saved configuration');
    ui.document.getElementById('save-world-book-selection-btn').click(); await pause(120);
    assert.equal(worldValue(),'0 Token','unbind must update visible stats without refresh'); assert.equal(ui.document.getElementById('world-book-selection-modal').classList.contains('visible'),false);
    saveResult=false; ui.document.getElementById('world-book-selection-modal').classList.add('visible'); ui.document.querySelector('.item-checkbox').checked=true; ui.document.getElementById('save-world-book-selection-btn').click(); await pause(10);
    assert.equal(character.worldBookIds.length,0); assert.equal(ui.document.getElementById('world-book-selection-modal').classList.contains('visible'),true); saveResult=true;
    ui.document.querySelector('[data-token-action="selftest"]').click(); await pause(10); assert.match(ui.document.getElementById('token-status').textContent,/自检通过/);
    ui.document.getElementById('token-sim-limit').value='1'; ui.document.querySelector('[data-token-action="simulate"]').click(); await pause(10); assert.match(ui.document.getElementById('token-sim-result').textContent,/未修改聊天设置/);
    ui.document.querySelector('[data-token-action="copy"]').click(); await pause(10); assert.ok(ui.document.getElementById('token-diagnostic-copy').value.includes('prepared-context')); assert.ok(!ui.document.getElementById('token-diagnostic-copy').value.includes('private-key'));
    const modal=ui.document.getElementById('token-distribution-modal'); assert.ok(modal.querySelector('.token-actions')); assert.ok(modal.querySelector('.token-more')); assert.ok(modal.querySelector('#token-distribution-close-btn'));
    ui.document.getElementById('token-distribution-close-btn').click(); assert.equal(modal.classList.contains('visible'),false);
    ui.currentChatId='g'; ui.currentChatType='group'; group.worldBookIds=['w']; ui.openTokenDistributionModal('g','group'); assert.notEqual(worldValue(),'0 Token');
    ui.document.querySelector('.item-checkbox').checked=false; ui.document.getElementById('save-world-book-selection-btn').click(); await pause(100); assert.equal(worldValue(),'0 Token');
    ui.currentChatType='legacy-other'; ui.document.getElementById('save-world-book-selection-btn').click(); await pause(10); assert.equal(fallbackSaves,1,'preserve existing non-chat save fallback');
    dom.window.close();
    console.log('Token DOM user flow passed: draft, save, unbind, failed save, self-test, simulation, diagnostic copy.');
}
console.log('Token accounting tests passed: real prompt/history, both BPE encodings, media, activation, usage, repair, official adapters and serializer non-regression.');
