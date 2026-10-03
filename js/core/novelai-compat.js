(function () {
    'use strict';
    const hints = { none: 0, standard: 1, heavy: 2, light: 3, humanFocus: 4, furryFocus: 5 };
    const legacyUC = ['heavy', 'light', 'humanFocus', 'none', 'furryFocus'];
    // Presets checked against the official NovelAI image frontend on 2026-10-01.
    const catalog = {
        "nai-diffusion-3": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "best quality, amazing quality, very aesthetic, absurdres"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing"
                },
                {
                    "id": "humanFocus",
                    "name": "humanFocus",
                    "category": "human",
                    "prefix": "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none",
                    "prefix": "lowres"
                }
            ]
        },
        "nai-diffusion-furry-3": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "{best quality}, {amazing quality}"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none",
                    "prefix": "lowres"
                }
            ]
        },
        "nai-diffusion-4-curated-preview": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "rating:general, best quality, very aesthetic, absurdres"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        },
        "nai-diffusion-4-full": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "no text, best quality, very aesthetic, absurdres"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        },
        "nai-diffusion-4-5-curated": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "very aesthetic, masterpiece, no text, -0.8::feet::, rating:general"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page"
                },
                {
                    "id": "humanFocus",
                    "name": "humanFocus",
                    "category": "human",
                    "prefix": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        },
        "nai-diffusion-4-5-full": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "very aesthetic, masterpiece, no text"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page"
                },
                {
                    "id": "furryFocus",
                    "name": "furryFocus",
                    "category": "furry",
                    "prefix": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic"
                },
                {
                    "id": "humanFocus",
                    "name": "humanFocus",
                    "category": "human",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        },
        "nai-diffusion-5-curated": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "very aesthetic, masterpiece, no text"
                },
                {
                    "id": "light",
                    "name": "light",
                    "suffix": "very aesthetic, amazing quality, no text"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::"
                },
                {
                    "id": "furryFocus",
                    "name": "furryFocus",
                    "category": "furry",
                    "prefix": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic"
                },
                {
                    "id": "humanFocus",
                    "name": "humanFocus",
                    "category": "human",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        },
        "nai-diffusion-5-full": {
            "quality": [
                {
                    "id": "standard",
                    "name": "standard",
                    "suffix": "very aesthetic, masterpiece, no text"
                },
                {
                    "id": "light",
                    "name": "light",
                    "suffix": "very aesthetic, amazing quality, no text"
                },
                {
                    "id": "none",
                    "name": "none"
                }
            ],
            "negative": [
                {
                    "id": "heavy",
                    "name": "heavy",
                    "category": "heavy",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"
                },
                {
                    "id": "light",
                    "name": "light",
                    "category": "light",
                    "prefix": "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::"
                },
                {
                    "id": "furryFocus",
                    "name": "furryFocus",
                    "category": "furry",
                    "prefix": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic"
                },
                {
                    "id": "humanFocus",
                    "name": "humanFocus",
                    "category": "human",
                    "prefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"
                },
                {
                    "id": "none",
                    "name": "none",
                    "category": "none"
                }
            ]
        }
    };

    function family(model) {
        return /nai-diffusion-5/.test(model) ? 'v5' : /nai-diffusion-4/.test(model) ? 'v4' : 'v3';
    }
    function presetIds(settings) {
        return {
            quality: settings.qualityToggle === false ? 'none' : (settings.qualityPresetId || 'standard'),
            negative: (settings.ucPresetId || legacyUC[Number(settings.ucPreset) || 0] || 'heavy').replace('human_focus', 'humanFocus').replace('furry_focus', 'furryFocus')
        };
    }
    function appendBeforeText(prompt, suffix) {
        if (!suffix) return prompt;
        const index = prompt.search(/\bText\s*:/i);
        if (index < 0) return [prompt, suffix].filter(Boolean).join(', ');
        return [prompt.slice(0, index).trim().replace(/,\s*$/, ''), suffix].filter(Boolean).join(', ') + ' ' + prompt.slice(index);
    }
    function prompts(prompt, negative, model, settings) {
        const ids = presetIds(settings);
        const presets = catalog[model];
        const quality = presets?.quality.find(item => item.id === ids.quality);
        const uc = presets?.negative.find(item => item.id === ids.negative);
        let positive = appendBeforeText(prompt, quality?.suffix);
        if (quality?.prefix) positive = [quality.prefix, positive].filter(Boolean).join(', ');
        if (settings.transparentBackground && family(model) === 'v5') positive = appendBeforeText(positive, 'transparent background');
        // Already-expanded imported presets remain editable and are not duplicated.
        let unwanted = negative || '';
        if (uc?.prefix && !unwanted.startsWith(uc.prefix)) unwanted = [uc.prefix, unwanted].filter(Boolean).join(', ');
        return { prompt: positive, negativePrompt: unwanted, quality: ids.quality, uc: ids.negative };
    }
    function correlationId() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = new Uint8Array(12);
        let result = '';
        while (result.length < 6) {
            if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
            else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
            for (const value of bytes) if (value < 248 && result.length < 6) result += alphabet[value % 62];
        }
        return result;
    }
    function headers(settings, accept) {
        const result = { 'Content-Type': 'application/json', Accept: accept };
        const token = String(settings.token || '').trim().replace(/[\r\n]/g, '');
        const mode = settings.authMode || 'bearer';
        if (mode === 'bearer' && token) result.Authorization = `Bearer ${token}`;
        if (mode === 'header' && token) result[settings.authHeaderName || 'Authorization'] = token;
        for (const [name, value] of Object.entries(settings.extraHeaders || {})) {
            const existing = Object.keys(result).find(key => key.toLowerCase() === name.toLowerCase());
            if (existing) delete result[existing];
            result[name] = value;
        }
        const key = Object.keys(result).find(name => name.toLowerCase() === 'x-correlation-id');
        const value = key ? String(result[key]) : correlationId();
        if (!/^[A-Za-z0-9]{6}$/.test(value)) throw new Error('额外请求头的 x-correlation-id 必须是 6 位英文字母或数字');
        if (key) delete result[key];
        result['x-correlation-id'] = value;
        return result;
    }
    function endpoint(settings, kind) {
        const path = kind === 'encode' ? (settings.encodeVibePath || '/ai/encode-vibe') : kind === 'upscale' ? '/ai/upscale' : kind === 'stream' ? (settings.streamPath || '/ai/generate-image-stream') : (settings.generatePath || '/ai/generate-image');
        const custom = settings.customUrlEnabled && String(settings.customUrl || '').trim();
        let url;
        if (!custom) url = new URL(path, 'https://image.novelai.net');
        else if (/^https?:\/\//i.test(path)) url = new URL(path);
        else {
            url = new URL(custom);
            const full = (settings.endpointMode || 'auto') === 'full' || /\/ai\/generate-image(?:-stream)?\/?$/.test(url.pathname);
            if (full && (kind === 'generate' || kind === 'stream')) { /* Preserve explicit generation endpoint. */ }
            else if (full) url.pathname = path;
            else url.pathname = url.pathname.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
        }
        if ((settings.authMode || 'bearer') === 'query' && settings.token) url.searchParams.set(settings.authQueryName || 'key', String(settings.token).trim());
        return url.toString();
    }
    function fitSize(width, height, targets = [[1024, 1536], [1472, 1472], [1536, 1024]]) {
        return targets.reduce((best, size) => Math.abs(Math.log(width / height / (size[0] / size[1]))) < Math.abs(Math.log(width / height / (best[0] / best[1]))) ? size : best);
    }
    async function fitImage(data, width, height, background = 'black', signal) {
        const img = new Image();
        img.src = String(data).startsWith('data:') ? data : `data:image/png;base64,${data}`;
        await img.decode();
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
        if (!width) [width, height] = fitSize(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
        const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        ctx.drawImage(img, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
        return canvas.toDataURL('image/png').split(',')[1];
    }
    async function readSSE(response, onProgress, signal) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('NovelAI 流式响应没有内容');
        const abort = () => reader.cancel().catch(() => {});
        signal?.addEventListener('abort', abort, { once: true });
        const decoder = new TextDecoder();
        let buffer = '', final = new Map(), error = '';
        const ndjson = (response.headers.get('content-type') || '').includes('ndjson');
        const parse = async block => {
            let event = '', parts = [];
            if (ndjson) parts.push(block.trim());
            for (const line of ndjson ? [] : block.split(/\r?\n/)) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                if (line.startsWith('data:')) parts.push(line.slice(5).trimStart());
            }
            if (!parts.length || parts.join('') === '[DONE]') return;
            const obj = JSON.parse(parts.join('\n'));
            const type = obj.event_type || obj.type || event;
            const index = obj.samp_ix ?? obj.index ?? 0;
            if (type === 'error' || obj.error) { error = String(obj.error?.message || obj.message || obj.error || '生成失败'); return; }
            if (type === 'final') { const image = await _image_extractFromJson(obj); if (image) final.set(index, { imageUrl: image, seed: obj.seed, index }); }
            if (type === 'intermediate') onProgress?.({ step: obj.step_ix, index, image: obj.image });
        };
        try {
            while (true) {
                if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                let match;
                while ((match = (ndjson ? /\r?\n/ : /\r?\n\r?\n/).exec(buffer))) { const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); await parse(block); }
                if (done) break;
            }
            if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
            if (buffer.trim()) await parse(buffer);
            if (error) throw new Error(`NovelAI 流式生成失败：${error.slice(0, 300)}`);
            if (!final.size) throw new Error('NovelAI 流式响应未收到最终图片，请勿把中间预览作为成品');
            return [...final.values()].sort((a, b) => a.index - b.index);
        } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    async function upscale(image, settings, signal) {
        if (!settings.token && (settings.authMode || 'bearer') !== 'none') throw new Error('NovelAI Token 未配置');
        const requestHeaders = headers(settings, 'application/json');
        const response = await fetch(endpoint(settings, 'upscale'), {
            method: 'POST', headers: requestHeaders, signal,
            body: JSON.stringify({ image: image.split(',').pop(), model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 })
        });
        if (!response.ok) { const error = await _imageReadError(response, 'NovelAI 放大'); error.message += `；请求 ID：${requestHeaders['x-correlation-id']}`; throw error; }
        let images = [];
        if ((response.headers.get('content-type') || '').includes('json')) {
            const data = await response.json();
            const candidates = Array.isArray(data.images) ? data.images : Array.isArray(data.data) ? data.data : [data];
            for (const [index, item] of candidates.entries()) {
                const url = await _image_extractFromJson(typeof item === 'string' ? { image: item } : item);
                if (url) images.push({ imageUrl: url, index });
            }
        } else {
            const blob = await response.blob();
            const urls = blob.type.startsWith('image/') ? [await _nai_blobToDataUrl(blob)] : await _nai_extractPngFromZipBlob(blob, true);
            images = urls.map((imageUrl, index) => ({ imageUrl, index }));
        }
        if (!images.length) throw new Error('放大接口未返回图片');
        for (const item of images) {
            if (!/^https?:\/\//.test(item.imageUrl)) continue;
            try {
                const original = await fetch(item.imageUrl, { signal });
                if (!original.ok) throw new Error('原图下载失败');
                item.imageUrl = await _nai_blobToDataUrl(await original.blob());
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.warn('[NovelAI] 放大原图持久化失败，保留原链接');
            }
        }
        return { imageUrl: images[0].imageUrl, images, model: 'NovelAI Upscale', correlationId: requestHeaders['x-correlation-id'], requestSnapshot: { action: 'upscale', parameters: { declared_blur_sigma: 0 } } };
    }
    window.NovelAiCompat = { catalog, hints, family, presetIds, prompts, correlationId, headers, endpoint, fitSize, fitImage, readSSE, upscale };
})();
