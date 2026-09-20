import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const order = [];
const toasts = [];
const documentListeners = new Map();
const elementListeners = new Map();
const audioSwitch = {
    checked: false,
    addEventListener(name, handler) { elementListeners.set(`switch:${name}`, handler); }
};
const autoWakeSwitch = {
    checked: true,
    addEventListener(name, handler) { elementListeners.set(`auto-wake:${name}`, handler); }
};
const wakeStatus = { textContent: '' };
const pageStatus = { textContent: '' };
const taskStatus = { textContent: '' };
const windowListeners = new Map();
let wakeLockRequests = 0;
const wakeLockSentinel = {
    released: false,
    addEventListener(name, handler) { this.releaseHandler = handler; },
    async release() { this.released = true; if (this.releaseHandler) this.releaseHandler(); }
};
const statusIndicator = {
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener(name, handler) { elementListeners.set(`status:${name}`, handler); }
};
const playIcon = { style: {} };
const pauseIcon = { style: {} };

class FakeAudio {
    constructor() {
        this.src = 'data:audio/mp3;base64,AA==';
        this.paused = true;
        this.ended = false;
        this.listeners = new Map();
    }
    setAttribute() {}
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    load() {}
    async play() { order.push('play'); this.paused = false; }
    pause() { order.push('pause'); this.paused = true; const handler = this.listeners.get('pause'); if (handler) handler(); }
}

const context = vm.createContext({
    console: { ...console, error() {} },
    Audio: FakeAudio,
    confirm: () => true,
    db: {
        keepAliveAudioEnabled: true,
        keepAliveAutoWakeEnabled: true,
        keepAliveAudioSrc: 'data:audio/mp3;base64,AA==',
        keepAliveAudioName: 'test.mp3',
        keepAliveAudioLibrary: []
    },
    saveGlobalSettings: async () => { order.push('save'); return true; },
    saveData: async () => true,
    showToast: message => toasts.push(message),
    navigator: {
        wakeLock: {
            async request(type) {
                assert.equal(type, 'screen');
                wakeLockRequests++;
                wakeLockSentinel.released = false;
                return wakeLockSentinel;
            }
        }
    },
    document: {
        visibilityState: 'visible',
        getElementById(id) {
            if (id === 'keep-alive-audio-enabled') return audioSwitch;
            if (id === 'keep-alive-auto-wake-enabled') return autoWakeSwitch;
            if (id === 'keep-alive-status-indicator') return statusIndicator;
            if (id === 'keep-alive-icon-play') return playIcon;
            if (id === 'keep-alive-icon-pause') return pauseIcon;
            if (id === 'keep-alive-wake-status') return wakeStatus;
            if (id === 'keep-alive-page-status') return pageStatus;
            if (id === 'keep-alive-task-status') return taskStatus;
            return null;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(name, handler) { documentListeners.set(name, handler); },
        removeEventListener(name, handler) { if (documentListeners.get(name) === handler) documentListeners.delete(name); }
    },
    window: {
        addEventListener(name, handler) { windowListeners.set(name, handler); }
    }
});
vm.runInContext(fs.readFileSync(new URL('../js/modules/keep_alive.js', import.meta.url), 'utf8'), context);
const player = context.window.KeepAliveModule;
player.initAudioElement();
player.bindEvents();

order.length = 0;
audioSwitch.checked = true;
await elementListeners.get('switch:change')({ target: audioSwitch });
assert.deepEqual(order.slice(0, 2), ['play', 'save'], 'trusted switch interaction must call play before awaiting persistence');

player.installInitialPlayHandler();
assert.ok(documentListeners.has('click'));
await elementListeners.get('status:click')();
assert.equal(player.audioElement.paused, true, 'pause control must leave audio paused');
assert.equal(documentListeners.has('click'), false, 'pause control must remove the global first-click replay handler');

player.audioElement.play = async () => {
    const error = new Error('unsupported');
    error.name = 'NotSupportedError';
    throw error;
};
await player.playAudio({ userInitiated: true });
assert.match(toasts.at(-1), /格式或链接不受支持/);
assert.doesNotMatch(toasts.at(-1), /自动播放/);

player.notifyTaskStart('reply-1');
await player.wakeLockRequest;
assert.equal(wakeLockRequests, 1, 'active reply task should request a screen wake lock');
assert.equal(taskStatus.textContent, '1 个任务进行中');
player.notifyTaskEnd('reply-1');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(wakeLockSentinel.released, true, 'finishing the last task should release automatic wake lock');
assert.equal(taskStatus.textContent, '无进行中任务');

console.log('Keep-alive tests passed: playback activation, error classification, task-aware wake lock, and release lifecycle.');
