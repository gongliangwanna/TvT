import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const manifestSource = fs.readFileSync(path.join(root, 'sw-assets.js'), 'utf8');
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const context = { self: {} };
vm.createContext(context);
vm.runInContext(manifestSource, context, { filename: 'sw-assets.js' });

const manifest = context.self.__OVO_SW_MANIFEST;
assert.ok(manifest, 'service worker asset manifest should be generated');
assert.match(manifest.version, /^[a-f0-9]{16}$/);
assert.ok(manifest.assets.includes('index.html'));
assert.ok(manifest.assets.includes('js/modules/chat-ai/reply-resilience.js'));
assert.ok(manifest.assets.includes('js/modules/keep_alive.js'));
assert.equal(new Set(manifest.assets).size, manifest.assets.length, 'asset list should not contain duplicates');
assert.equal(manifest.assets.some(asset => asset.startsWith('src/')), false);
assert.equal(manifest.assets.some(asset => asset.startsWith('node_modules/')), false);

assert.match(swSource, /request\.method !== 'GET'/);
assert.match(swSource, /url\.origin !== self\.location\.origin/);
assert.match(swSource, /self\.addEventListener\('push'/, 'existing push capability must remain');
assert.match(swSource, /self\.addEventListener\('notificationclick'/, 'existing notification capability must remain');

console.log(`Service worker tests passed (${manifest.assets.length} cached runtime assets).`);
