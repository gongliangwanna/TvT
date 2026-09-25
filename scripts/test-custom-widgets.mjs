import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const handlers = {};
let tokenCounter = 0;
const context = vm.createContext({
    window: { addEventListener(type, callback) { handlers[type] = callback; } },
    document: { addEventListener() {}, createElement() { return { setAttribute() {}, isConnected: true }; } },
    crypto: { randomUUID: () => `test-token-${++tokenCounter}` },
    db: {}, defaultWidgetSettings: {}, saveGlobalSettings: async () => true,
    showToast() {}, setTimeout, clearTimeout, console,
});
for (const path of ['js/modules/custom-widgets.js', 'js/modules/free-home.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), context);
}
const run = code => vm.runInContext(code, context);
assert.equal(run('customWidgetValid({...CUSTOM_WIDGET_EXAMPLES.counter,state:{}})'), true);
assert.equal(run('customWidgetValid({html:"",css:"",js:42})'), false);
assert.equal(run('customWidgetValid({html:"",css:"",js:"",state:[]})'), false);
run('db.freeHomeLayout = {pages:[{id:"page",items:[{id:"one",type:"widget",widget:"custom",row:0,col:0,settings:{...CUSTOM_WIDGET_EXAMPLES.counter,state:{count:3}}},{id:"two",type:"widget",widget:"custom",row:0,col:2,settings:{...CUSTOM_WIDGET_EXAMPLES.counter,state:{count:8}}}]}],dock:FREE_HOME_DOCK.slice()}');
assert.equal(run('freeHomeValidLayout(db.freeHomeLayout)'), true);
const exported = run('customWidgetShare({freeHomeLayout:db.freeHomeLayout,wallpaper:"https://example.com/photo.jpg",customIcons:{a:"data:image/png;base64,AAA"},homeWidgetSettings:{polaroidImage:"photo",topLeft:{text:"hello"}}})');
assert.equal(exported.wallpaper, '');
assert.deepEqual(Object.keys(exported.customIcons), []);
assert.equal(exported.homeWidgetSettings.polaroidImage, '');
assert.equal(exported.homeWidgetSettings.topLeft.text, 'hello');
assert.equal(exported.freeHomeLayout.pages[0].items[0].settings.js, run('CUSTOM_WIDGET_EXAMPLES.counter.js'));
assert.deepEqual(Object.keys(exported.freeHomeLayout.pages[0].items[0].settings.state), []);
assert.equal(run('db.freeHomeLayout.pages[0].items[0].settings.state.count'), 3, 'export must not mutate local data');
assert.throws(() => run('customWidgetShare({html:"<img src=\\"data:image/png;base64,AAA\\">"})'), /图片/);
context.exported = exported;
assert.equal(run('freeHomeValidLayout(exported.freeHomeLayout)'), true);
run('exported.freeHomeLayout.pages[0].items[0].settings.js=42');
assert.equal(run('freeHomeValidLayout(exported.freeHomeLayout)'), false);

const frame = run('customWidgetFrame(db.freeHomeLayout.pages[0].items[0])');
frame.isConnected = false;
const secondFrame = run('customWidgetFrame(db.freeHomeLayout.pages[0].items[1])');
frame.isConnected = true;
assert.equal(run('customWidgetFrames.size'), 2, 'frames constructed in one render must both keep their bridge');
assert.match(frame.srcdoc, /Content-Security-Policy/);
assert.match(frame.srcdoc, /connect-src 'none'/);
const scripts = [...frame.srcdoc.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2);
scripts.forEach(([, code]) => new vm.Script(code));
const replies = [];
frame.contentWindow = { postMessage(message) { replies.push(message); } };
await handlers.message({ source: {}, data: { channel: 'ovo-widget', token: 'test-token-1', id: 1, action: 'save', value: { count: 99 } } });
assert.equal(replies.length, 0, 'unrelated frames must not access storage');
await handlers.message({ source: frame.contentWindow, data: { channel: 'ovo-widget', token: 'test-token-1', id: 2, action: 'save', value: { count: 4 } } });
assert.equal(run('db.freeHomeLayout.pages[0].items[0].settings.state.count'), 4);
assert.equal(run('db.freeHomeLayout.pages[0].items[1].settings.state.count'), 8, 'instances must remain independent');
context.saveGlobalSettings = async () => false;
await handlers.message({ source: frame.contentWindow, data: { channel: 'ovo-widget', token: 'test-token-1', id: 3, action: 'save', value: { count: 5 } } });
assert.equal(run('db.freeHomeLayout.pages[0].items[0].settings.state.count'), 4);
assert.match(replies.at(-1).error, /保存失败/);
context.document.getElementById = () => null;
context.DEFAULT_WALLPAPER_URL = 'default-wallpaper';
context.prompt = () => '分享桌面';
run('db.homeLayoutMode="free"; db.wallpaper="private-image"; db.customIcons={app:"private-icon"}');
vm.runInContext(fs.readFileSync(new URL('../js/settings/widget-presets.js', import.meta.url), 'utf8'), context);
context.customWidgetDownload = payload => { context.screenExport = run('customWidgetShare')(payload); };
run('exportWidgetWallpaperScheme()');
assert.equal(context.screenExport.preset.wallpaper, '');
assert.equal(context.screenExport.preset.freeHomeLayout.pages.length, 1);
assert.equal(context.screenExport.preset.freeHomeLayout.pages[0].items[1].col, 2);
assert.deepEqual(Object.keys(context.screenExport.preset.freeHomeLayout.pages[0].items[0].settings.state), []);
assert.equal(run('db.wallpaper'), 'private-image');
const aiPrompt = run('customWidgetAIPrompt("做一个抽签组件", {html:"<button>抽签</button>",css:"",js:"",state:{secret:"private"}})');
assert.match(aiPrompt, /做一个抽签组件/);
assert.match(aiPrompt, /ovo\.pickImage/);
assert.match(aiPrompt, /<button>抽签<\/button>/);
assert.doesNotMatch(aiPrompt, /private/);
let selected = false;
context.navigator = {};
const copyOutput = { focus() {}, select() { selected = true; } };
const feedback = {};
await run('customWidgetCopyAI')('说明', copyOutput, feedback);
assert.equal(selected, true);
assert.equal(copyOutput.hidden, false);
assert.equal(copyOutput.value, '说明');
assert.match(feedback.textContent, /长按复制/);
context.navigator.clipboard = { async writeText(text) { assert.equal(text, '说明'); } };
await run('customWidgetCopyAI')('说明', copyOutput, feedback);
assert.match(feedback.textContent, /已复制/);
context.saveGlobalSettings = async () => true;
context.freeHomeOpenWidgetPicker = () => {};
context.freeHomeOpenDesktopPresets = () => {};
context.populateWidgetWallpaperPresetSelect = () => {};
const bundle = { type: 'free-home-widget-bundle', presets: [
    { name: '同名', widget: 'custom', settings: { html: '', css: '', js: '' } },
    { name: '同名', widget: 'photo', settings: { image: '' } },
] };
await run('freeHomeImportBundle')(bundle, 'widget');
assert.equal(run('db.freeHomeWidgetPresets.length'), 2);
assert.notEqual(run('db.freeHomeWidgetPresets[0].name'), run('db.freeHomeWidgetPresets[1].name'));
assert.notEqual(run('db.freeHomeWidgetPresets[0].id'), run('db.freeHomeWidgetPresets[1].id'));
await assert.rejects(run('freeHomeImportBundle')({ type: bundle.type, presets: [...bundle.presets, { name: '损坏', widget: 'missing' }] }, 'widget'));
assert.equal(run('db.freeHomeWidgetPresets.length'), 2, 'invalid batch must not partly import');
context.saveGlobalSettings = async () => false;
await assert.rejects(run('freeHomeImportBundle')(bundle, 'widget'), /保存失败/);
assert.equal(run('db.freeHomeWidgetPresets.length'), 2);
context.saveGlobalSettings = async () => true;
await run('freeHomeImportBundle')({ type: 'free-home-desktop-bundle', presets: [context.screenExport.preset] }, 'desktop');
assert.equal(run('db.widgetWallpaperPresets.length'), 1);
let pageTarget = null;
context.freeHomeSetPage = index => { pageTarget = index; };
context.freeHomePreviewFromPointer = () => {};
run('freeHomePage=0; freeHomePointer={placing:true,x:200,y:200,page:0}');
run('freeHomeDragEnd')({ type: 'pointerup', clientX: 100, clientY: 205 });
assert.equal(pageTarget, 1, 'horizontal placement swipe must switch page');
pageTarget = null;
run('freeHomePointer={placing:true,x:200,y:200,page:0}');
run('freeHomeDragEnd')({ type: 'pointercancel', clientX: 100, clientY: 205 });
assert.equal(pageTarget, null, 'cancel must not switch page');
const actions = new Map();
context.freeHomeOpenSheet = (title, build) => build({ append() {} });
context.freeHomeElement = () => ({});
context.freeHomeSheetButton = (sheet, label, callback) => actions.set(label, callback);
context.freeHomeCloseSheet = () => {};
context.renderFreeHomeScreen = () => {};
run('freeHomeResetLayout()');
const beforeReset = run('JSON.stringify(db.freeHomeLayout)');
await actions.get('确认重置布局')();
assert.equal(run('db.freeHomeLayout.pages.length'), 2);
assert.equal(run('db.wallpaper'), 'private-image');
assert.equal(run('db.freeHomeWidgetPresets.length'), 2);
assert.equal(run('freeHomeHistory.at(-1)'), beforeReset);
console.log('Custom widget sharing, sandbox bridge, independent state and layout compatibility passed.');
