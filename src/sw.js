// sw.js (启动器 Service Worker)

const CACHE_NAME = 'launcher-cache';

// 启动器核心文件采用网络优先策略，确保界面脚本及游戏运行时 SW 能及时获得更新
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/launcher.js',
    '/manifest.json',
    '/sw-game.js',
];

// 静态库与图标资源采用缓存优先策略
const STATIC_ASSETS = [
    '/libs/zip-core.min.js',
    '/icon.avif',
    '/icon.png',
];

const urlsToCache = [...CORE_ASSETS, ...STATIC_ASSETS];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    // activate 事件现在只负责 claim 客户端，清理逻辑已移至 launcher.js 的 clearCache 函数
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    // 跳过代理接口和游戏作用域路径，避免干扰实时请求或游戏运行时 SW
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/play/')) {
        return;
    }

    // 核心外壳资源采用网络优先并在成功后更新缓存，离线时回退本地缓存
    if (CORE_ASSETS.includes(url.pathname) || event.request.mode === 'navigate') {
        event.respondWith(networkFirst(event.request, url.pathname));
        return;
    }

    // 优先从缓存提供服务，如果缓存未命中，则从网络获取
    // 这是标准的 "Cache First" 策略，适用于启动器本身的静态依赖文件
    event.respondWith(cacheFirst(event.request));
});

async function networkFirst(request, pathname) {
    const cache = await caches.open(CACHE_NAME);
    try {
        // 使用 request.url 发起普通请求，避开 mode 为 navigate 时的构造异常并跳过浏览器强缓存
        const networkResponse = await fetch(request.url, { cache: 'no-cache' });
        if (networkResponse && networkResponse.ok) {
            await cache.put(request.url, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        const cached = await cache.match(request.url);
        if (cached) return cached;
        if (pathname === '/' || request.mode === 'navigate') {
            const indexFallback = await cache.match('/index.html');
            if (indexFallback) return indexFallback;
        }
        throw error;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
        await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
}