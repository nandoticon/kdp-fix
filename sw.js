const CACHE_NAME = 'kdp-fix-v2';
const APP_BASE = new URL('.', self.registration.scope);
const LOCAL_ASSETS = [
    '',
    'index.html',
    'styles.css',
    'script.js',
    'js/constants.js',
    'js/utils.js',
    'js/epub-engine.js',
    'manifest.json'
].map(path => new URL(path, APP_BASE).href);
const EXTERNAL_ASSETS = [
    'https://unpkg.com/@zip.js/zip.js@2.6.12/dist/zip.min.js',
    'https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js',
    'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(LOCAL_ASSETS);
        await Promise.allSettled(EXTERNAL_ASSETS.map(async url => {
            const response = await fetch(url, { mode: 'cors' });
            if (response.ok && response.type !== 'opaque') await cache.put(url, response);
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(key => key.startsWith('kdp-fix-') && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith((async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        try {
            const response = await fetch(event.request);
            if (response.ok && response.type !== 'opaque') {
                const cache = await caches.open(CACHE_NAME);
                event.waitUntil(cache.put(event.request, response.clone()).catch(error => {
                    console.warn('Unable to cache response:', event.request.url, error);
                }));
            }
            return response;
        } catch (error) {
            if (event.request.mode === 'navigate') {
                const offlinePage = await caches.match(new URL('index.html', APP_BASE).href);
                if (offlinePage) return offlinePage;
            }
            throw error;
        }
    })());
});
