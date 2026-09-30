import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/core/bilingual-content.js', import.meta.url), 'utf8');
const character = { id: 'foreign-1', bilingualModeEnabled: true, bilingualLanguage: '法语' };
const requests = [];
const db = {
    characters: [character], apiSettings: { url: 'https://example.test', key: 'key', model: 'model' },
    bilingualSettings: { display: 'click', scopes: { moments: true, peek: false } }, bilingualTranslations: {}
};
const listeners = {};
const context = {
    db, console, Math, Date, structuredClone,
    document: { readyState: 'loading', documentElement: {}, querySelectorAll: () => [], addEventListener(type, callback) { listeners[type] = callback; } },
    MutationObserver: class { observe() {} },
    getApiConfigForFeature(feature, fallback) { assert.equal(feature, 'moments'); return fallback; },
    isApiConfigReady(config) { return !!config.url && !!config.model && !!config.key; },
    fetchAiResponse: async (_config, body) => { requests.push(body); return '你好，朋友。'; },
    saveGlobalSettings: async keys => { assert.deepEqual(Array.from(keys), ['bilingualTranslations']); return true; }
};
context.window = context;
vm.runInNewContext(source, context, { filename: 'bilingual-content.js' });
const bilingual = context.BilingualContent;

assert.equal(bilingual.enabled(character, 'moments'), true);
assert.equal(bilingual.enabled(character, 'peek'), false);
assert.equal(bilingual.enabled(character, 'friendRequest'), true);
assert.match(bilingual.prompt(character, 'moments'), /法语/);
assert.match(bilingual.prompt(character, 'friendRequest'), /法语/);
assert.match(bilingual.html('Bonjour, ami.', character, 'moments'), /查看翻译/);
assert.doesNotMatch(bilingual.html('Bonjour, ami.', character, 'peek'), /查看翻译/);
assert.doesNotMatch(bilingual.html('这是一句中文。', character, 'moments'), /查看翻译/);

assert.equal(await bilingual.translate(character, 'moments', 'Bonjour, ami.', 'moments'), '你好，朋友。');
assert.equal(await bilingual.translate(character, 'moments', 'Bonjour, ami.', 'moments'), '你好，朋友。');
assert.equal(requests.length, 1, 'cached translations must not repeat API calls');
assert.match(bilingual.html('Bonjour, ami.', character, 'moments'), /你好，朋友。/);
assert.doesNotMatch(bilingual.html('<img src=x>', character, 'moments'), /<img src=x>/);

character.bilingualModeEnabled = false;
assert.equal(bilingual.enabled(character, 'moments'), false);
assert.equal(bilingual.prompt(character, 'moments'), '');
console.log('Bilingual content policy and translation cache tests passed.');
