// sw-game.js (游戏运行时 Service Worker)
// 按需从本地缓存中的无压缩 img.zip 提取单个文件

importScripts('/libs/zip-core.min.js');

// --- 配置常量 ---
const GAME_CACHE_NAME = 'game-cache';
const HTML_KEY = 'game.html';
const IMG_ZIP_KEY = 'img.zip';

// 并发节流的配置
const DECOMPRESSION_CONCURRENCY = 16; // 同时进行提取操作的最大数量

// --- zip.js 配置 ---
zip.configure({
    useWebWorkers: false // 不启用 Web Worker，因为 img.zip 为无压缩存储，且由节流器控制并发数量
});

// 请求节流器，用于控制并发读取数量，防止 CPU 或 IO 过载
class RequestThrottler {
    constructor(concurrencyLimit = 16) {
        this.concurrencyLimit = concurrencyLimit;
        this.activeCount = 0;
        this.waitingQueue = [];
    }
    async execute(task) {
        return new Promise((resolve, reject) => {
            this.waitingQueue.push({ task, resolve, reject });
            this._processQueue();
        });
    }
    _processQueue() {
        while (this.activeCount < this.concurrencyLimit && this.waitingQueue.length > 0) {
            this.activeCount++;
            const { task, resolve, reject } = this.waitingQueue.shift();
            task().then(resolve).catch(reject).finally(() => {
                this.activeCount--;
                this._processQueue();
            });
        }
    }
}

// --- Service Worker 全局状态 ---

const decompressionInProgress = new Map();
const throttler = new RequestThrottler(DECOMPRESSION_CONCURRENCY);

let imgZipReaderPromise = null;
let imgEntriesMapPromise = null;

// 获取并初始化 img.zip 的 ZipReader 实例
function getImgZipReader() {
    if (imgZipReaderPromise) return imgZipReaderPromise;
    imgZipReaderPromise = (async () => {
        try {
            const cache = await caches.open(GAME_CACHE_NAME);
            const response = await cache.match(IMG_ZIP_KEY);
            if (!response) throw new Error('游戏图片包 (img.zip) 未在缓存中找到。');
            const zipBlob = await response.blob();
            return new self.zip.ZipReader(new self.zip.BlobReader(zipBlob));
        } catch (error) {
            imgZipReaderPromise = null; // 失败时重置，以便下次可以重试
            throw error;
        }
    })();
    return imgZipReaderPromise;
}

// 索引 img.zip 内的所有文件条目，并存入 Map 以便快速查找
function getImgEntriesMap() {
    if (imgEntriesMapPromise) return imgEntriesMapPromise;
    imgEntriesMapPromise = (async () => {
        try {
            const zipReader = await getImgZipReader();
            const entries = await zipReader.getEntries();
            const entriesMap = new Map();
            for (const entry of entries) {
                if (entry.directory) continue;
                const normalizedName = entry.filename.replace(/^\.?\//, '');
                entriesMap.set(normalizedName, entry);
            }
            console.log(`游戏运行时 SW: 游戏图片包已索引 ${entriesMap.size} 个文件。`);
            return entriesMap;
        } catch (error) {
            imgEntriesMapPromise = null; // 失败时重置
            throw error;
        }
    })();
    return imgEntriesMapPromise;
}

// 释放旧的 ZipReader 与文件索引，确保游戏版本更新或切换后读取到新资源包
async function resetZipCache() {
    const readerPromise = imgZipReaderPromise;
    imgZipReaderPromise = null;
    imgEntriesMapPromise = null;
    decompressionInProgress.clear();

    if (readerPromise) {
        try {
            const reader = await readerPromise;
            await reader.close();
        } catch (error) {
            console.error('游戏运行时 SW: 关闭旧资源包读取器时出错:', error);
        }
    }
    console.log('游戏运行时 SW: 已重置图片包读取索引。');
}

/**
 * 核心函数：获取提取后的文件 Blob。
 * @param {string} relativePath - 文件在 zip 包内的相对路径
 * @returns {Promise<Blob>} - 提取后的文件 Blob
 */
async function getDecompressedBlob(relativePath) {
    // 检查是否有其他请求正在读取同一个文件，若有则等待该操作完成
    const pendingDecompression = decompressionInProgress.get(relativePath);
    if (pendingDecompression) return pendingDecompression;

    // 创建一个新的读取任务 Promise，此过程受节流器控制
    const decompressionPromise = throttler.execute(async () => {
        const imgEntriesMap = await getImgEntriesMap();
        const fileEntry = imgEntriesMap.get(relativePath);
        if (!fileEntry) {
            const error = new Error(`未在 img.zip 中找到文件: ${relativePath}`);
            error.code = 'FILE_NOT_FOUND';
            throw error;
        }
        const mimeType = self.zip.getMimeType(relativePath);
        // img.zip 采用无压缩存储，读取时跳过 CRC32 校验以减少 CPU 开销
        return fileEntry.getData(new self.zip.BlobWriter(mimeType), { checkCrc32: false });
    });

    // 立即将这个 Promise 存起来作为并发锁
    decompressionInProgress.set(relativePath, decompressionPromise);

    try {
        return await decompressionPromise;
    } finally {
        // 无论成功与否，任务完成后都必须从此 Map 中移除，以释放锁
        decompressionInProgress.delete(relativePath);
    }
}

// --- Service Worker 事件监听器 ---

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    // activate 事件现在只负责 clients.claim()，确保 SW 立即生效。
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'RESET_ZIP_CACHE') {
        event.waitUntil(resetZipCache());
    }
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const scopeUrl = new URL(self.registration.scope);
    if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return;

    event.respondWith(handleFetch(url, scopeUrl));
});

/**
 * 针对不同后缀的文件生成安全的 404 响应。
 */
function createSafeErrorResponse(relativePath, status = 404) {
    const isJson = relativePath.toLowerCase().endsWith('.json');
    return new Response(isJson ? '{}' : null, {
        status: status,
        headers: isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}
    });
}

// 主 fetch 请求处理器
async function handleFetch(url, scopeUrl) {
    const relativePath = decodeURIComponent(url.pathname.substring(scopeUrl.pathname.length)).replace(/^\.?\//, '');
    try {
        // 路由逻辑：如果是根路径或 HTML 文件，直接返回缓存的主页面，不等待 img.zip 初始化
        if (relativePath === '' || relativePath.endsWith('.html')) {
            const cache = await caches.open(GAME_CACHE_NAME);
            const htmlResponse = await cache.match(HTML_KEY);
            if (!htmlResponse) {
                return new Response('游戏主页面尚未缓存，请返回启动器重新下载。', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }
            return htmlResponse;
        }

        // 对于所有其他资源，按需从 img.zip 提取 Blob
        const blob = await getDecompressedBlob(relativePath);
        const mimeType = self.zip.getMimeType(relativePath) || 'application/octet-stream';
        return new Response(blob, { headers: { 'Content-Type': mimeType } });

    } catch (error) {
        // 统一处理错误逻辑，错误详情通过 console.error 输出到控制台用于调试
        if (error && error.code === 'FILE_NOT_FOUND') {
            console.error(`游戏运行时 SW: 文件 '${relativePath}' 未在 img.zip 中找到`);
            return createSafeErrorResponse(relativePath, 404);
        }
        console.error(`游戏运行时 SW: 处理文件 ${relativePath} 时出错:`, error);
        return new Response(null, { status: 500 });
    }
}