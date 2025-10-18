// sw.js (启动器 Service Worker)

const CACHE_NAME = 'launcher-cache';
const urlsToCache = [
    '/',
    '/index.html',
    '/style.css',
    '/launcher.js',
    '/manifest.json',
    '/icon.avif',
    '/icon.png',
    '/libs/zip-core.min.js',
    '/sw-game.js',
];

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
    // 优先从缓存提供服务，如果缓存未命中，则从网络获取
    // 这是标准的 "Cache First" 策略，适用于启动器本身的核心文件
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});