import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parse } from 'parse5';
import {
    bodyHtmlChunks,
    loaderInitScript,
    loaderMountScript,
    phoneHtmlChunks,
    renderChunkScript,
} from './html-chunks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
    failures.push(message);
}

function collectFiles(directory, extension = '.js') {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...collectFiles(target, extension));
        else if (entry.name.endsWith(extension)) result.push(target);
    }
    return result;
}

function expandTemplate(template) {
    return template.replace(
        /^[ \t]*<!-- @include (.+?) -->\r?\n/gm,
        (_, includePath) => read(path.join('src', includePath)),
    );
}

function collectDocumentInfo(document) {
    const ids = [];
    const scripts = [];
    const styles = [];
    function walk(node) {
        if (node.attrs) {
            const id = node.attrs.find(attr => attr.name === 'id')?.value;
            if (id) ids.push(id);
            if (node.tagName === 'script') {
                const src = node.attrs.find(attr => attr.name === 'src')?.value;
                if (src) scripts.push(src);
            }
            if (node.tagName === 'link') {
                const rel = node.attrs.find(attr => attr.name === 'rel')?.value;
                const href = node.attrs.find(attr => attr.name === 'href')?.value;
                if (rel === 'stylesheet' && href) styles.push(href);
            }
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(document);
    return { ids, scripts, styles };
}

function findNodeById(document, targetId) {
    let result = null;
    function walk(node) {
        if (result) return;
        const id = node.attrs?.find(attr => attr.name === 'id')?.value;
        if (id === targetId) {
            result = node;
            return;
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(document);
    return result;
}

function nearestScreenId(node) {
    let current = node;
    while (current) {
        if (current.attrs?.some(attr => attr.name === 'class' && attr.value.split(/\s+/).includes('screen'))) {
            return current.attrs.find(attr => attr.name === 'id')?.value || '';
        }
        current = current.parentNode;
    }
    return '';
}

function getNonScriptDomSignature(document) {
    const entries = [];
    function walk(node) {
        if (node.tagName === 'script') return;
        if (node.nodeName === '#text') {
            const text = node.value.replace(/\s+/g, ' ').trim();
            if (text) entries.push(`#text:${text}`);
        } else if (node.tagName) {
            const attrs = [...(node.attrs || [])]
                .sort((left, right) => left.name.localeCompare(right.name))
                .map(attr => `${attr.name}=${attr.value}`)
                .join('|');
            entries.push(`${node.tagName}[${attrs}]`);
        }
        for (const child of node.childNodes || []) walk(child);
    }
    walk(document);
    return createHash('sha256').update(entries.join('\n')).digest('hex');
}

const html = read('index.html');
const expectedHtml = expandTemplate(read('src/index.template.html'));
if (html !== expectedHtml) fail('index.html is stale; run npm run build');
const manifest = JSON.parse(read('manifest.json'));
if (manifest.display !== 'standalone') fail(`Expected standalone PWA display mode, found ${manifest.display}`);
if (Buffer.byteLength(html, 'utf8') >= 50 * 1024) {
    fail(`Compact index.html must stay below 50 KB; found ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB`);
}

const phoneMarkup = phoneHtmlChunks
    .flatMap(([, sources]) => sources)
    .map(source => read(path.join('src', source)))
    .join('');
const bodyMarkup = bodyHtmlChunks
    .flatMap(([, sources]) => sources)
    .map(source => read(path.join('src', source)))
    .join('');

const loaderTagPattern = /^[ \t]*<script data-ovo-html-loader src="[^"]+"><\/script>\r?\n/gm;
let logicalHtml = html.replace(loaderTagPattern, '');
logicalHtml = logicalHtml.replace(
    '<div class="phone-screen"></div>',
    `<div class="phone-screen">${phoneMarkup}</div>`,
);
if (!logicalHtml.includes('</body>')) {
    fail('Could not locate </body> in compact index.html');
} else {
    logicalHtml = logicalHtml.replace('</body>', bodyMarkup + '</body>');
}

const parseErrors = [];
const logicalDocument = parse(logicalHtml, {
    sourceCodeLocationInfo: true,
    onParseError: error => parseErrors.push(error),
});
// The legacy page contains one known literal "<" in visible text. Retain it
// during this structural-only change, but do not allow additional occurrences.
const seriousParseErrors = parseErrors.filter(error => ![
    'missing-doctype',
    'non-void-html-element-start-tag-with-trailing-solidus',
    'invalid-first-character-of-tag-name',
].includes(error.code));
if (seriousParseErrors.length) {
    fail(`Logical HTML parser reported ${seriousParseErrors.length} error(s): ${seriousParseErrors.slice(0, 5).map(e => e.code).join(', ')}`);
}
const retainedLegacyTagErrors = parseErrors.filter(error => error.code === 'invalid-first-character-of-tag-name');
if (retainedLegacyTagErrors.length > 1) {
    fail(`Expected at most one retained legacy text parsing issue, found ${retainedLegacyTagErrors.length}`);
}

const logicalInfo = collectDocumentInfo(logicalDocument);
const protectedDomSignature = 'a32b8f8838c0baa4d0acf851c07a1f4a3cfb11d784a18ec4aacf7e9f7a15de17';
const actualDomSignature = getNonScriptDomSignature(logicalDocument);
if (actualDomSignature !== protectedDomSignature) {
    fail(`Assembled non-script DOM differs from the protected pre-split structure: ${actualDomSignature}`);
}
const textualIds = [...logicalHtml.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
const duplicateIds = [...new Set(textualIds.filter((id, index) => textualIds.indexOf(id) !== index))];
if (textualIds.length !== 2396) fail(`Expected 2396 assembled IDs, found ${textualIds.length}`);
if (duplicateIds.length) fail(`Duplicate assembled IDs: ${duplicateIds.join(', ')}`);

const requiredIds = [
    'home-screen', 'chat-list-screen', 'contacts-screen', 'chat-room-screen',
    'api-settings-screen', 'api-generation-params', 'api-generation-reset-values',
    'api-node-editor-screen', 'api-node-edit-form', 'api-node-generation-mode', 'api-node-generation-params',
    'chat-settings-screen', 'group-settings-screen',
    'memory-table-screen', 'forum-screen', 'peek-screen', 'node-system-screen',
    'storage-screen', 'mcp-screen', 'mcp-panel', 'mcp-sheet', 'mcp-import-input',
    'keep-alive-auto-wake-enabled', 'keep-alive-use-builtin-btn', 'keep-alive-playback-status',
    'keep-alive-page-status', 'keep-alive-wake-status', 'keep-alive-task-status',
    'setting-follow-up-enabled', 'setting-follow-up-options', 'setting-follow-up-probability',
    'setting-poke-enabled', 'setting-poke-options', 'setting-poke-char-suffix',
    'setting-group-poke-enabled', 'setting-group-poke-options', 'setting-group-poke-member-btn',
];
for (const id of requiredIds) {
    if (!logicalInfo.ids.includes(id)) fail(`Required assembled UI element is missing: #${id}`);
}
if (logicalInfo.ids.includes('api-node-edit-modal')) {
    fail('The API node editor must not regress to the nested modal structure');
}
const apiNodeEditor = findNodeById(logicalDocument, 'api-node-editor-screen');
const apiNodeForm = findNodeById(logicalDocument, 'api-node-edit-form');
if (apiNodeEditor && nearestScreenId(apiNodeEditor.parentNode)) {
    fail('#api-node-editor-screen must be a top-level screen, not nested inside another screen');
}
if (apiNodeForm && nearestScreenId(apiNodeForm) !== 'api-node-editor-screen') {
    fail('#api-node-edit-form must belong to #api-node-editor-screen');
}

const compactDocument = parse(html);
const compactInfo = collectDocumentInfo(compactDocument);
for (const resource of [...compactInfo.scripts, ...compactInfo.styles]) {
    if (/^(?:https?:)?\/\//.test(resource)) continue;
    const clean = resource.split(/[?#]/, 1)[0];
    if (!fs.existsSync(path.join(root, clean))) fail(`Missing local resource: ${resource}`);
}

const expectedLoaderSources = [
    'js/generated/html/00-init.js',
    ...phoneHtmlChunks.map(([name]) => `js/generated/html/${name}.js`),
    ...bodyHtmlChunks.map(([name]) => `js/generated/html/${name}.js`),
    'js/generated/html/99-mount.js',
];
const actualLoaderSources = compactInfo.scripts.filter(source => source.startsWith('js/generated/html/'));
if (JSON.stringify(actualLoaderSources) !== JSON.stringify(expectedLoaderSources)) {
    fail('HTML loader script order does not match the source fragment order');
}

if (read('js/generated/html/00-init.js') !== loaderInitScript) fail('Generated HTML init loader is stale');
for (const [name, sources] of phoneHtmlChunks) {
    const sourceHtml = sources.map(source => read(path.join('src', source))).join('');
    if (read(`js/generated/html/${name}.js`) !== renderChunkScript('phone', sourceHtml)) {
        fail(`Generated phone HTML loader is stale: ${name}.js`);
    }
}
for (const [name, sources] of bodyHtmlChunks) {
    const sourceHtml = sources.map(source => read(path.join('src', source))).join('');
    if (read(`js/generated/html/${name}.js`) !== renderChunkScript('body', sourceHtml)) {
        fail(`Generated body HTML loader is stale: ${name}.js`);
    }
}
if (read('js/generated/html/99-mount.js') !== loaderMountScript) fail('Generated HTML mount loader is stale');

// Execute the exact generated classic scripts against a minimal DOM contract.
// This validates file://-compatible synchronous ordering without a web server.
const mounted = { phone: '', body: '' };
const sandbox = {
    window: {},
    document: {
        querySelector: selector => selector === '.phone-screen' ? {
            insertAdjacentHTML: (_, value) => { mounted.phone += value; },
        } : null,
        body: {
            insertAdjacentHTML: (_, value) => { mounted.body += value; },
        },
        querySelectorAll: () => [],
    },
};
vm.createContext(sandbox);
for (const source of expectedLoaderSources) {
    vm.runInContext(read(source), sandbox, { filename: source });
}
if (mounted.phone !== phoneMarkup) fail('Synchronous loader did not mount the complete phone HTML in order');
if (mounted.body !== bodyMarkup) fail('Synchronous loader did not mount the complete body HTML in order');
if ('__OVO_HTML_CHUNKS__' in sandbox.window) fail('Synchronous loader did not release its temporary HTML store');

const forbiddenAuthMarkers = [
    'ephone_auth', 'puppy-subscription-api', 'renderLoginOverlay',
    'tryLogin', 'login-overlay',
];
const searchableFiles = [path.join(root, 'index.html'), ...collectFiles(path.join(root, 'js'))];
for (const marker of forbiddenAuthMarkers) {
    if (searchableFiles.some(file => fs.readFileSync(file, 'utf8').includes(marker))) {
        fail(`Removed authentication marker still exists: ${marker}`);
    }
}

for (const file of collectFiles(path.join(root, 'js'))) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) fail(`JavaScript syntax error in ${path.relative(root, file)}: ${check.stderr.trim()}`);
}

const generatedBundles = [
    ['js/settings/chat-settings.js', [
        'src/js/settings/chat-settings/setup.jsfrag',
        'src/js/settings/chat-settings/theater-helpers.jsfrag',
        'src/js/settings/chat-settings/load.jsfrag',
        'src/js/settings/chat-settings/save.jsfrag',
    ]],
    ['js/modules/memory_table.js', [
        'src/js/modules/memory-table/core.jsfrag',
        'src/js/modules/memory-table/rendering.jsfrag',
        'src/js/modules/memory-table/ai-update.jsfrag',
        'src/js/modules/memory-table/import-export.jsfrag',
        'src/js/modules/memory-table/events-and-api.jsfrag',
    ]],
    ['js/modules/avatar_recognition.js', [
        'src/js/modules/avatar-recognition/part-01.jsfrag',
        'src/js/modules/avatar-recognition/part-02.jsfrag',
        'src/js/modules/avatar-recognition/part-03.jsfrag',
    ]],
    ['js/modules/video_call.js', [
        'src/js/modules/video-call/part-01.jsfrag',
        'src/js/modules/video-call/part-02.jsfrag',
        'src/js/modules/video-call/part-03.jsfrag',
    ]],
];
for (const [output, parts] of generatedBundles) {
    if (parts.map(read).join('') !== read(output)) {
        fail(`Generated ${output} does not match its source fragments`);
    }
}

if (failures.length) {
    console.error('\nVerification failed:');
    for (const message of failures) console.error(`- ${message}`);
    process.exit(1);
}

console.log(
    `Verification passed: ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB index, `
    + `${textualIds.length} assembled IDs, ${actualLoaderSources.length} ordered HTML loaders, `
    + `${compactInfo.scripts.length} scripts, ${compactInfo.styles.length} stylesheets.`,
);
