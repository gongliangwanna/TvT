import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const toPlain = value => JSON.parse(JSON.stringify(value));
class TestFileReader {
    readAsText(file) { this.result = file.text; this.finished = this.onload(); }
    async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload();
    }
}
const context = vm.createContext({
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; } },
    db: {}, Blob, FileReader: TestFileReader,
    defaultWidgetSettings: { centralCircleImage: 'default-circle', polaroidImage: 'default-photo' },
    DEFAULT_WALLPAPER_URL: 'default-wallpaper',
    homeScreen: { classList: { toggle() {} } },
    saveData() {}, saveGlobalSettings: async () => true, showToast() {},
    renderCustomizeForm() {}, applyWallpaper() {}, confirm: () => false,
    console, setTimeout, clearTimeout,
});
for (const file of ['js/modules/custom-widgets.js', 'js/modules/free-home.js', 'js/settings/widget-presets.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
}
const run = code => vm.runInContext(code, context);
context.freeHomeOpenDesktopPresets = () => {};
context.freeHomeOpenWidgetPicker = () => {};

const fixture = {
    name: '分享桌面', layoutMode: 'free', wallpaper: 'data:image/png;base64,AAAA',
    customIcons: { 'chat-list-screen': 'https://example.com/icon' },
    customAppNames: { 'chat-list-screen': '聊天' }, peekCustomIcons: { album: 'peek-image' },
    homeWidgetSettings: { centralCircleImage: 'circle-image', polaroidImage: 'photo-image', topLeft: { text: 'hello' } },
    insWidgetSettings: { avatar1: 'avatar-one', avatar2: 'avatar-two', bubble1: 'love', bubble2: 'miss' },
    freeHomeLayout: { pages: [{ id: 'page', items: [
        { id: 'photo', type: 'widget', widget: 'photo', row: 0, col: 0, settings: { image: 'https://example.com/photo.jpg' } },
        { id: 'custom', type: 'widget', widget: 'custom', row: 0, col: 2, settings: { html: '<button>点我</button>', css: '', js: '', state: { secret: 'private', photo: 'data:image/png;base64,PRIVATE', count: 5 } } },
    ] }], dock: ['day-mode-btn'] },
};
context.fixture = fixture;
const before = JSON.stringify(fixture);
const counts = toPlain(run('customWidgetImageCounts(fixture)'));
assert.deepEqual(counts, { wallpaper: 1, icons: 2, photos: 3, avatars: 2 });
assert.equal(JSON.stringify(fixture), before, 'scanning must not mutate source');

const omitted = toPlain(run('customWidgetShare(fixture)'));
assert.equal(omitted.wallpaper, '');
assert.deepEqual(omitted.customIcons, {});
assert.equal(omitted.freeHomeLayout.pages[0].items[0].settings.image, '');
assert.deepEqual(omitted.freeHomeLayout.pages[0].items[1].settings.state, {});
assert.equal(run('freeHomeValidLayout(customWidgetShare(fixture).freeHomeLayout)'), true);

const partial = toPlain(run('customWidgetShare(fixture, "", new Set(["wallpaper", "photos"]))'));
assert.equal(partial.wallpaper, fixture.wallpaper);
assert.equal(partial.homeWidgetSettings.polaroidImage, 'photo-image');
assert.equal(partial.freeHomeLayout.pages[0].items[0].settings.image, 'https://example.com/photo.jpg');
assert.deepEqual(partial.customIcons, {});
assert.equal(partial.insWidgetSettings.avatar1, '');
assert.deepEqual(partial.freeHomeLayout.pages[0].items[1].settings.state, {});
const all = toPlain(run('customWidgetShare(fixture, "", new Set(Object.keys(CUSTOM_WIDGET_IMAGE_GROUPS)))'));
assert.deepEqual(all.customIcons, fixture.customIcons);
assert.equal(all.insWidgetSettings.avatar2, fixture.insWidgetSettings.avatar2);
assert.deepEqual(all.freeHomeLayout.pages[0].items[1].settings.state, {});
assert.equal(JSON.stringify(fixture), before, 'sharing must not mutate local data');

for (const code of [
    { html: '<img src="https://example.com/private">' },
    { html: '<img src="/private/photo">' },
    { html: '<img src="data:image/png;base64,PRIVATE">' },
    { css: 'main{background:url(/private/photo)}' },
    { js: 'image.src="https://example.com/private";' },
    { customCss: '.home{background:url(https://example.com/private)}' },
]) {
    context.code = code;
    assert.throws(() => run('customWidgetShare(code)'), /明确勾选/);
    assert.deepEqual(toPlain(run('customWidgetShare(code, "", new Set(["code"]))')), code);
    assert.deepEqual(toPlain(run('customWidgetImageCounts(code)')), { code: 1 });
}
assert.equal(run('customWidgetCodeHasImages(CUSTOM_WIDGET_EXAMPLES.photo.html)'), false, 'empty image picker template is not an embedded image');
assert.equal(run('customWidgetShare({thumbnail:"https://example.com/cover.png"}).thumbnail'), '');
assert.equal(run('customWidgetShare({fontBuffer:{font:"private-font"}}, "", new Set(Object.keys(CUSTOM_WIDGET_IMAGE_GROUPS))).fontBuffer.font'), undefined);
assert.equal(run('Object.hasOwn(customWidgetShare(JSON.parse("{\\"__proto__\\":{\\"polluted\\":true}}")), "__proto__")'), false);

context.fetch = async () => ({ ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) });
const resolved = await run('customWidgetResolveImages({image:"blob:temporary"})');
assert.equal(resolved.image, 'data:image/png;base64,aW1hZ2UtYnl0ZXM=');
await assert.rejects(run('customWidgetResolveImages')({ html: '<img src="blob:temporary">' }), /临时图片/);
context.fetch = async () => ({ ok: false });
await assert.rejects(run('customWidgetResolveImages({image:"blob:expired"})'), /失效/);

const resetReceiver = () => run(`
    db.wallpaper = 'receiver-wallpaper'; db.customIcons = {'chat-list-screen':'receiver-icon'};
    db.homeWidgetSettings = {centralCircleImage:'receiver-circle',polaroidImage:'receiver-photo'};
    db.insWidgetSettings = {avatar1:'receiver-one',avatar2:'receiver-two'};
    db.characters = [{id:'char',peekScreenSettings:{customIcons:{album:'receiver-peek'}}}];
    currentChatId = 'char';
`);
const apply = preset => {
    context.preset = preset;
    run('db.widgetWallpaperPresets = [preset]; applyWidgetWallpaperPreset(preset.name)');
};
resetReceiver();
apply({ ...omitted, imageSharing: { included: [] } });
assert.equal(run('db.wallpaper'), 'receiver-wallpaper');
assert.equal(run('db.customIcons["chat-list-screen"]'), 'receiver-icon');
assert.equal(run('db.homeWidgetSettings.polaroidImage'), 'receiver-photo');
assert.equal(run('db.insWidgetSettings.avatar1'), 'receiver-one');
assert.equal(run('db.characters[0].peekScreenSettings.customIcons.album'), 'receiver-peek');
assert.equal(run('db.freeHomeLayout.pages[0].items[0].settings.image'), '', 'new omitted widget image must not inherit receiver private photos');
assert.equal(run('db.customAppNames["chat-list-screen"]'), '聊天');

resetReceiver();
apply({ ...partial, imageSharing: { included: ['wallpaper', 'photos'] } });
assert.equal(run('db.wallpaper'), fixture.wallpaper);
assert.equal(run('db.customIcons["chat-list-screen"]'), 'receiver-icon');
assert.equal(run('db.homeWidgetSettings.polaroidImage'), 'photo-image');
assert.equal(run('db.insWidgetSettings.avatar1'), 'receiver-one');
resetReceiver();
apply({ ...all, imageSharing: { included: ['wallpaper', 'photos', 'icons', 'avatars'] } });
assert.equal(run('db.customIcons["chat-list-screen"]'), fixture.customIcons['chat-list-screen']);
assert.equal(run('db.insWidgetSettings.avatar1'), 'avatar-one');

// Local presets without a sharing marker retain their previous reset semantics.
resetReceiver();
apply({ ...fixture, customIcons: {} });
assert.deepEqual(toPlain(run('db.customIcons')), {});

// Both single-file and bundle imports preserve the omission marker; old exports migrate locally.
let lastReader;
context.FileReader = class extends TestFileReader { constructor() { super(); lastReader = this; } };
for (const input of [omitted, { ...partial, imageSharing: { included: ['wallpaper', 'photos'] } }]) {
    context.file = { size: 1000, text: JSON.stringify({ type: 'widget-wallpaper-scheme', preset: input }) };
    run('db.widgetWallpaperPresets = []; importWidgetWallpaperScheme(file)');
    await lastReader.finished;
    assert.deepEqual(toPlain(run('db.widgetWallpaperPresets[0].imageSharing')), input.imageSharing || { included: [] });
    resetReceiver();
    run('applyWidgetWallpaperPreset(db.widgetWallpaperPresets[0].name)');
    assert.equal(run('db.customIcons["chat-list-screen"]'), 'receiver-icon');
    context.bundle = { type: 'free-home-desktop-bundle', presets: [input] };
    run('db.widgetWallpaperPresets = []');
    await run('freeHomeImportBundle(bundle, "desktop")');
    assert.deepEqual(toPlain(run('db.widgetWallpaperPresets[0].imageSharing')), input.imageSharing || { included: [] });
}
console.log('Preset image consent, selective sharing, privacy, image resolution and compatible imports passed.');
