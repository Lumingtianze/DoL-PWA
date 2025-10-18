// sw-game.js (游戏运行时 Service Worker)
// 这是一个为 PWA 游戏设计的、具备自适应和预热机制的高性能 Service Worker。
// 它采用 ARC (Adaptive Replacement Cache) 算法，结合了基于 SW 启动的预热机制和防抖持久化，
// 旨在实现极致且稳定的资源加载性能。

importScripts('/libs/zip-core.min.js');

// --- 配置常量 ---
const GAME_CACHE_NAME = 'game-cache';
const HTML_KEY = 'game.html';
const IMG_ZIP_KEY = 'img.zip';
// 使用一个专门的键来存储 ARC 缓存的元数据，以便与游戏资源区分开
const CACHE_META_KEY = 'arc-cache-meta.json';

// 缓存和并发节流的配置
const CACHE_SIZE = 1500; // ARC 缓存的总容量
const DECOMPRESSION_CONCURRENCY = 16; // 同时进行解压操作的最大数量
const METADATA_SAVE_DEBOUNCE = 5000; // 缓存操作停止 5 秒后，自动保存元数据

// --- zip.js 配置 ---
zip.configure({
  useWebWorkers: false // 不启用 Web Worker，因为 zip.js 的 getData 是异步非阻塞的，且我们有自己的并发控制
});

// --- 缓存与并发控制类 ---

/**
 * ARC (Adaptive Replacement Cache) 算法的标准实现
 * @description 结合了 LRU 和 LFU 的优点，并能根据工作负载自适应调整。
 * T1 (Recency): 存放新条目和近期访问过的条目，类似 LRU。
 * T2 (Frequency): 存放被证明是热门（至少访问两次）的条目，类似 LFU。
 * B1/B2 (Ghost Lists): 幽灵列表。它们记录了近期从 T1/T2 淘汰的键，
 *      用于判断一个刚被淘汰的条目是否被再次需要，从而动态调整 T1 和 T2 的分区大小 p。
 * p (Partition): T1 的目标大小，算法会根据 B1 和 B2 的命中情况动态调整 p，使缓存自适应。
 */
class ARCache {
    constructor(maxSize = 1500) {
        this.maxSize = maxSize;
        this.p = 0; // T1 的目标大小，初始为0
        
        this.t1 = new Map(); // (key, value) - Recency Cache
        this.t2 = new Map(); // (key, value) - Frequency Cache
        this.b1 = new Set(); // (key) - Recency Ghost List
        this.b2 = new Set(); // (key) - Frequency Ghost List

        // 使用防抖确保在一连串的缓存操作结束后仅执行一次保存，减少不必要的磁盘写入
        this.debouncedSaveMetadata = this._debounce(this.saveMetadata.bind(this), METADATA_SAVE_DEBOUNCE);
    }

    get(key) {
        // 如果在 T1 (recency) 中命中，说明它变得更热门了，将其提升到 T2 (frequency)
        if (this.t1.has(key)) {
            const value = this.t1.get(key);
            this.t1.delete(key);
            this.t2.set(key, value); // 移动到 T2 的MRU (Most Recently Used) 位置
            return value;
        }
        // 如果在 T2 (frequency) 中命中，更新其热度（移动到MRU位置）
        if (this.t2.has(key)) {
            const value = this.t2.get(key);
            this.t2.delete(key); // 先删除
            this.t2.set(key, value); // 再设置，以移动到 Map 的末尾
            return value;
        }
        return null; // 缓存未命中
    }

    put(key, value) {
        // Case 1: key 已存在于缓存中 (T1 或 T2)，通常是更新操作
        if (this.t1.has(key) || this.t2.has(key)) {
            this.get(key); // 调用 get 来处理移动到 T2 的逻辑
            this.t2.set(key, value); // 确保值被更新
            this.debouncedSaveMetadata();
            return;
        }

        // Case 2: key 在 B1 (recency ghost) 中被发现
        // 这说明一个刚被淘汰的“近期”条目又被需要了，表明 T1 的目标大小(p)可能太小，需要增加
        if (this.b1.has(key)) {
            // 增加 p，权重基于 B2/B1 的大小比例，保证至少增加1
            this.p = Math.min(this.maxSize, this.p + Math.max(this.b2.size / this.b1.size, 1) || 1);
            this._replace(key); // 为新条目腾出空间
            this.b1.delete(key);
            this.t2.set(key, value); // 该条目足够热门，直接放入 T2
            this.debouncedSaveMetadata();
            return;
        }

        // Case 3: key 在 B2 (frequency ghost) 中被发现
        // 这说明一个刚被淘汰的“高频”条目又被需要了，表明 T2 的空间不足，需要减小 T1 的目标大小(p)
        if (this.b2.has(key)) {
            // 减小 p，权重基于 B1/B2 的大小比例，保证至少减小1
            this.p = Math.max(0, this.p - Math.max(this.b1.size / this.b2.size, 1) || 1);
            this._replace(key); // 为新条目腾出空间
            this.b2.delete(key);
            this.t2.set(key, value); // 该条目足够热门，直接放入 T2
            this.debouncedSaveMetadata();
            return;
        }

        // Case 4: 这是一个全新的条目
        const totalSize = this.t1.size + this.t2.size;
        if (totalSize >= this.maxSize) {
            // 如果 T1 的当前大小超过其自适应目标 p，则优先从 T1 淘汰
            if (this.t1.size > this.p) {
                this._evict(this.t1, this.b1);
            } else {
                this._evict(this.t2, this.b2);
            }
        }
        // 新条目总是先放入 T1 进行“观察”
        this.t1.set(key, value);
        this.debouncedSaveMetadata();
    }
    
    // ARC 内部的替换逻辑，在幽灵命中时调用，为新条目腾出空间
    _replace(key) {
        if (this.t1.size > 0 && (this.t1.size > this.p || (this.b2.has(key) && this.t1.size === this.p))) {
            this._evict(this.t1, this.b1);
        } else {
            this._evict(this.t2, this.b2);
        }
    }

    // 从指定缓存列表淘汰一个条目到其对应的幽灵列表
    _evict(targetCache, ghostCache) {
        if(targetCache.size === 0) return;
        const oldestKey = targetCache.keys().next().value;
        targetCache.delete(oldestKey);
        ghostCache.add(oldestKey);
    }
    
    // --- 元数据持久化与恢复 ---
    
    // 将当前缓存的“智能”状态序列化为可存储的 JSON 对象
    serialize() {
        // 只持久化 T2 (高频) 列表和自适应分区大小 p，这是预热所需的最少且最有效的数据
        return {
            t2: [...this.t2.keys()],
            p: this.p,
        };
    }
    
    // 从持久化的元数据中恢复状态，并返回需要预热的 keys 列表
    hydrate(metadata) {
        if (!metadata || !metadata.t2) return [];
        this.p = metadata.p || 0;
        // 恢复 ARC 缓存的 T2 结构，将 t2 的键列表加载到实例中
        // 值暂时设为 null，后续预热过程会填充真实数据 (Blob)
        metadata.t2.forEach(key => this.t2.set(key, null));
        
        console.log(`SW: ARC 缓存已从元数据恢复。T2 结构: ${this.t2.size}, p: ${this.p.toFixed(2)}`);
        return metadata.t2; // 仅返回 T2 键用于预热
    }

    // 为预热设计的内部方法，用于安全地填充已存在条目的值
    // 这避免了在预热时触发完整的 put() 逻辑（如状态调整和元数据保存），同时保证了类的封装性
    _fillPreheatedEntry(key, value) {
        // 预热时，仅当键存在于 T2 且其值为占位的 null 时才填充
        if (this.t2.has(key) && this.t2.get(key) === null) {
            this.t2.set(key, value);
        }
    }
    
    // 将元数据异步保存到 Cache API
    async saveMetadata() {
        try {
            const cache = await caches.open(GAME_CACHE_NAME);
            const metadata = this.serialize();
            // 仅当有高频数据时才保存，避免用空数据覆盖有价值的旧元数据
            if (metadata.t2.length > 0) {
                const response = new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' }});
                await cache.put(CACHE_META_KEY, response);
                console.log(`SW: ARC 缓存元数据已保存。T2: ${this.t2.size}, p: ${this.p.toFixed(2)}`);
            }
        } catch (error) {
            console.error('SW: 保存缓存元数据失败:', error);
        }
    }
    
    // 一个标准的防抖函数实现
    _debounce(func, wait) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    }
}


// 请求节流器，用于控制并发解压数量，防止 CPU 过载
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

// --- Service Worker 全局状态与初始化 ---

const decompressedCache = new ARCache(CACHE_SIZE);
const decompressionInProgress = new Map();
const throttler = new RequestThrottler(DECOMPRESSION_CONCURRENCY);

// 使用一个 Promise 来管理 SW 的初始化状态，包括预热。
// 它就像一个“大门”，确保任何 fetch 请求都会等待初始化完成后再执行，
let readyPromise = null; 

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

// 索引 img.zip 内的所有文件条目，并存入Map以便快速查找
function getImgEntriesMap() {
    if (imgEntriesMapPromise) return imgEntriesMapPromise;
    imgEntriesMapPromise = (async () => {
        try {
            const zipReader = await getImgZipReader();
            const entries = await zipReader.getEntries();
            const entriesMap = new Map();
            for (const entry of entries) {
                entriesMap.set(entry.filename, entry);
            }
            console.log(`SW: 游戏图片包已索引 ${entriesMap.size} 个文件。`);
            return entriesMap;
        } catch (error) {
            imgEntriesMapPromise = null; // 失败时重置
            throw error;
        }
    })();
    return imgEntriesMapPromise;
}

/**
 * 核心函数：获取解压后的文件Blob。
 * @param {string} relativePath - 文件在zip包内的相对路径
 * @param {boolean} [forPreheating=false] - 标记此调用是否用于预热
 * @returns {Promise<Blob>} - 解压后的文件Blob
 */
async function getDecompressedBlob(relativePath, forPreheating = false) {
    // 1. 优先从内存 ARC 缓存获取
    const cachedEntry = decompressedCache.get(relativePath);
    if (cachedEntry) return cachedEntry; // 如果值不为 null，直接返回

    // 2. 检查是否有其他请求正在解压同一个文件，若有则等待该操作完成（请求合并）
    let pendingDecompression = decompressionInProgress.get(relativePath);
    if (pendingDecompression) return pendingDecompression;

    // 3. 创建一个新的解压任务Promise，此过程受节流器控制
    const decompressionPromise = throttler.execute(async () => {
        const imgEntriesMap = await getImgEntriesMap();
        const fileEntry = imgEntriesMap.get(relativePath);
        if (!fileEntry) throw new Error(`File not found: ${relativePath}`);
        return fileEntry.getData(new zip.BlobWriter(self.zip.getMimeType(relativePath)));
    });
    
    // 4. 立即将这个Promise存起来作为并发“锁”
    decompressionInProgress.set(relativePath, decompressionPromise);
    
    try {
        const newBlob = await decompressionPromise;
        // 5. 根据调用类型决定如何处理缓存
        if (forPreheating) {
            // 如果是预热，调用专用的内部方法来填充数据，不影响 ARC 算法的状态
            decompressedCache._fillPreheatedEntry(relativePath, newBlob);
        } else {
            // 如果是用户实际请求，则通过 put 方法让 ARC 算法“学习”这次访问
            decompressedCache.put(relativePath, newBlob);
        }
        return newBlob;
    } finally {
        // 6. 无论成功与否，解压完成后都必须从此Map中移除，以释放“锁”
        decompressionInProgress.delete(relativePath);
    }
}

// --- 预热与初始化 ---
/**
 * 从 Cache API 读取元数据并预热 ARC 缓存的高频（T2）部分。
 * 这是实现“秒开”体验的关键，它在用户请求资源之前就将其准备好。
 */
async function preheatCacheFromMetadata() {
    try {
        const cache = await caches.open(GAME_CACHE_NAME);
        const metaResponse = await cache.match(CACHE_META_KEY);
        if (!metaResponse) {
            console.log("SW: 未找到缓存元数据，跳过预热。");
            return;
        }

        const metadata = await metaResponse.json();
        // 恢复 ARC 状态并获取高频（T2）列表进行预热
        const keysToPreheat = decompressedCache.hydrate(metadata);

        if (keysToPreheat.length === 0) return;
        
        console.log(`SW: 开始预热 ${keysToPreheat.length} 个高频项目...`);
        const preheatPromises = keysToPreheat.map(key => 
            getDecompressedBlob(key, true).catch(err => {
                // 预热失败是可接受的，比如zip包更新后文件不存在了，或者其他错误
            })
        );
        
        await Promise.allSettled(preheatPromises);
        // 统计真实填充成功的数量
        // 遍历 T2 列表，计算值不为 null 的条目数。
        const filledCount = Array.from(decompressedCache.t2.values()).filter(v => v !== null).length;
        console.log(`SW: 预热完成。成功填充: ${filledCount}/${keysToPreheat.length}`);

    } catch (error) {
        console.error('SW: 预热缓存时出错:', error);
    }
}

// SW 的总初始化函数，它会在 SW 进程启动时被调用一次
async function initialize() {
    console.log("SW: 正在初始化...");
    // 确保 zip 索引和预热都完成后，SW 才进入“就绪”状态
    await getImgEntriesMap();
    await preheatCacheFromMetadata();
    console.log("SW: 初始化完成，已准备好处理请求。");
}

// 惰性初始化函数，确保初始化逻辑只运行一次
function ensureReady() {
    // 如果 readyPromise 尚未被创建，说明这是 SW 启动后的第一次需要初始化的操作
    if (!readyPromise) {
        // 调用初始化函数，并将返回的 Promise 存起来
        readyPromise = initialize();
    }
    // 返回这个 Promise，后续所有调用都将得到同一个 Promise
    return readyPromise;
}

// --- Service Worker 事件监听器 ---

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });

self.addEventListener('activate', (event) => {
    // activate 事件现在只负责 clients.claim()，确保 SW 立即生效。
    // 所有耗时的初始化操作都已移出，以保证 SW 能够尽快激活。
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const scopeUrl = new URL(self.registration.scope);
    if (!url.pathname.startsWith(scopeUrl.pathname)) return;

    // 在处理任何 fetch 之前，必须等待 SW 初始化完成。
    // 这是保证在响应请求时，预热缓存已经就位的关键。
    event.respondWith(
        (async () => {
            await ensureReady(); // 等待初始化和预热完成
            return handleFetch(event.request, url, scopeUrl);
        })()
    );
});

// 主 fetch 请求处理器
async function handleFetch(request, url, scopeUrl) {
    const relativePath = decodeURIComponent(url.pathname.substring(scopeUrl.pathname.length));
    try {        
        // 路由逻辑：如果是根路径或HTML文件，则提供缓存的主页面
        if (relativePath === '' || relativePath.endsWith('.html')) {
            const cache = await caches.open(GAME_CACHE_NAME);
            return await cache.match(HTML_KEY) || new Response('游戏HTML文件未找到。', { status: 404 });
        }
        
        // 对于所有其他资源，调用封装好的函数获取Blob（这是真实用户请求）
        const blob = await getDecompressedBlob(relativePath, false);
        const mimeType = self.zip.getMimeType(relativePath);
        return new Response(blob, { headers: { 'Content-Type': mimeType } });

    } catch (error) {
        // 统一处理错误
        if (error.message.includes('File not found')) {
            console.error(`SW: 文件 '${relativePath}' 未在 img.zip 中找到`);
            return new Response('在游戏图片包中未找到文件', { status: 404 });
        }
        console.error(`SW: 处理文件 ${relativePath} 时出错:`, error);
        return new Response(`处理文件时出错: ${error.message}`, { status: 500 });
    }
}