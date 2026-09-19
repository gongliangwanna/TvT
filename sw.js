// Service Worker - 应用壳离线恢复与系统推送通知
try {
    importScripts('./sw-assets.js');
} catch (error) {
    console.warn('Service worker asset manifest unavailable:', error);
}

const OVO_SW_MANIFEST = self.__OVO_SW_MANIFEST || { version: 'fallback', assets: ['index.html', 'manifest.json'] };
const OVO_CACHE_NAME = `ovo-app-shell-${OVO_SW_MANIFEST.version}`;
const OVO_ASSET_PATHS = new Set(OVO_SW_MANIFEST.assets.map(asset => new URL(asset, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
    console.log('Service worker installing...');
    event.waitUntil(
        caches.open(OVO_CACHE_NAME).then(cache => {
            const shellEntry = OVO_SW_MANIFEST.assets.includes('index.html') ? 'index.html' : './';
            const remainingAssets = OVO_SW_MANIFEST.assets.filter(asset => asset !== shellEntry);
            return cache.add(new Request(shellEntry, { cache: 'reload' })).then(() => Promise.allSettled(
                remainingAssets.map(asset => cache.add(new Request(asset, { cache: 'reload' })))
            ));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(Promise.all([
        caches.keys().then(names => Promise.all(names
            .filter(name => name.startsWith('ovo-app-shell-') && name !== OVO_CACHE_NAME)
            .map(name => caches.delete(name)))),
        clients.claim()
    ]));
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).then(response => {
                if (response && response.ok) {
                    const copy = response.clone();
                    return caches.open(OVO_CACHE_NAME).then(cache => cache.put('index.html', copy)).then(() => response);
                }
                return response;
            }).catch(async () => (await caches.match('index.html')) || Response.error())
        );
        return;
    }

    if (!OVO_ASSET_PATHS.has(url.pathname)) return;
    event.respondWith(
        caches.match(request, { ignoreSearch: true }).then(cached => {
            if (cached) return cached;
            return fetch(request).then(response => {
                if (response && response.ok) {
                    const copy = response.clone();
                    return caches.open(OVO_CACHE_NAME).then(cache => cache.put(request, copy)).then(() => response);
                }
                return response;
            }).catch(() => Response.error());
        })
    );
});

// 接收来自页面的消息，直接显示系统通知（无需服务器，应用在前/后台时使用）
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, body, icon, badge, tag } = event.data.payload;
        event.waitUntil(
            self.registration.showNotification(title, {
                body: body || '',
                icon: icon || undefined,
                badge: badge || undefined,
                tag: tag || 'ovo-message',
                renotify: true,
                vibrate: [200, 100, 200],
            })
        );
    }
});

// 接收服务器 Web Push（用户配置了自定义推送服务器时由服务器推送过来）
self.addEventListener('push', (event) => {
    if (!event.data) return;
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: 'OVO', body: event.data.text() };
    }
    event.waitUntil(
        self.registration.showNotification(data.title || 'OVO', {
            body: data.body || '',
            icon: data.icon || undefined,
            badge: data.badge || undefined,
            tag: 'ovo-push',
            renotify: true,
            vibrate: [200, 100, 200],
        })
    );
});

// 点击通知后将应用窗口聚焦到前台
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./');
        })
    );
});
