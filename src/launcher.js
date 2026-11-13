// launcher.js

const GITHUB_REPO = 'Lumingtianze/DoL-PWA';
const API_URL = `/api/proxy?url=${encodeURIComponent(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`)}`;
const PROXY_URL_TEMPLATE = '/api/proxy?url={encoded_target_url}';

const GAME_CACHE_NAME = 'game-cache';
const LAUNCHER_CACHE_NAME = 'launcher-cache';
const HTML_KEY = 'game.html';
const IMG_ZIP_KEY = 'img.zip';
const META_KEY = 'meta.json';

// 定义游戏的作用域，所有此路径下的请求都将被 sw-game.js 拦截
const GAME_SCOPE = '/play/';

// 配置 zip.js
zip.configure({
    useWebWorkers: false // 不启用 Web Worker
});

const networkBadge = document.getElementById('network-badge');
const statusBanner = document.getElementById('status-banner');
const statusText = document.getElementById('status-text');
const localVersionEl = document.getElementById('local-version');
const localModEl = document.getElementById('local-mod');
const remoteVersionEl = document.getElementById('remote-version');
const remotePrereleaseBadge = document.getElementById('remote-prerelease-badge');
const prereleaseToggle = document.getElementById('prerelease-toggle');
const modSelector = document.getElementById('mod-selector');
const progressContainer = document.getElementById('progress-container');
const progressLabel = document.getElementById('progress-label');
const progressStats = document.getElementById('progress-stats');
const progressBar = document.getElementById('progress-bar');
const actionBtn = document.getElementById('action-btn');
const refreshBtn = document.getElementById('refresh-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');

let localMeta = null;
let allReleases = [];
let targetReleaseData = null;
// 远程版本状态: 'idle' | 'checking' | 'ready' | 'error'
let remoteStatus = 'idle';
let isBusy = false;
let currentAction = 'idle';

document.addEventListener('DOMContentLoaded', main);

async function main() {
    if ('serviceWorker' in navigator) {
        // 注册启动器自身的 Service Worker
        await navigator.serviceWorker.register('/sw.js');
    }

    // 默认开启预发行版本检查，用户可自行切回仅正式版
    const savedPrerelease = localStorage.getItem('includePrerelease');
    prereleaseToggle.checked = savedPrerelease === null ? true : savedPrerelease === 'true';

    updateNetworkBadge();
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);

    actionBtn.addEventListener('click', handleAction);
    refreshBtn.addEventListener('click', handleRefresh);
    clearCacheBtn.addEventListener('click', clearCache);

    modSelector.addEventListener('change', () => {
        localStorage.setItem('selectedMod', modSelector.value);
        updateUI();
    });

    prereleaseToggle.addEventListener('change', () => {
        localStorage.setItem('includePrerelease', String(prereleaseToggle.checked));
        if (allReleases.length > 0) {
            applyTargetReleaseSelection();
            updateUI();
        }
    });

    // 先检查本地缓存以实现快速离线启动
    await checkLocalCache();

    // 在线时标记为查询中，离线时不主动发请求也不展示错误状态
    remoteStatus = navigator.onLine ? 'checking' : 'idle';
    updateUI();

    if (navigator.onLine) {
        await checkRemoteVersions();
        updateUI();
    }
}

function updateNetworkBadge() {
    const isOnline = navigator.onLine;
    networkBadge.textContent = isOnline ? '在线' : '离线';
    networkBadge.dataset.online = String(isOnline);
}

async function handleNetworkChange() {
    updateNetworkBadge();
    if (isBusy) return;

    if (!navigator.onLine) {
        if (remoteStatus !== 'ready') {
            remoteStatus = 'idle';
            updateUI();
        }
        return;
    }

    if (allReleases.length === 0) {
        await handleRefresh();
    }
}

async function handleRefresh() {
    if (isBusy || remoteStatus === 'checking') return;
    remoteStatus = 'checking';
    updateUI();
    await checkRemoteVersions();
    updateUI();
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0MB';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
}

function getValidZipAssets(release) {
    if (!release || !Array.isArray(release.assets)) return [];
    return release.assets.filter(a => a.name.endsWith('.zip') && !a.name.includes('polyfill'));
}

// 检查本地缓存，验证 .html、img.zip 和 meta.json 是否都存在
async function checkLocalCache() {
    try {
        const cache = await caches.open(GAME_CACHE_NAME);
        const [metaResponse, htmlResponse, imgResponse] = await Promise.all([
            cache.match(META_KEY),
            cache.match(HTML_KEY),
            cache.match(IMG_ZIP_KEY)
        ]);

        if (metaResponse && htmlResponse && imgResponse) {
            localMeta = await metaResponse.json();
            localVersionEl.textContent = localMeta.tag;
            localModEl.textContent = localMeta.shortName;
            clearCacheBtn.hidden = false;

            // 离线或尚未取得远程列表时，在选择器中显示当前已安装的版本
            if (allReleases.length === 0) {
                populateModSelectorWithLocal();
            }
        } else {
            localVersionEl.textContent = '无';
            localModEl.textContent = '';
            localMeta = null;
            clearCacheBtn.hidden = true;
            // 清理不完整的缓存
            await caches.delete(GAME_CACHE_NAME);
        }
    } catch (error) {
        console.error('检查本地缓存失败:', error);
        localVersionEl.textContent = '读取错误';
        localModEl.textContent = '';
        localMeta = null;
        clearCacheBtn.hidden = true;
    }
}

// 清理功能会删除游戏缓存、启动器缓存，并注销所有 Service Worker
async function clearCache() {
    if (!confirm('确定要清除本地游戏文件与启动器缓存吗？此操作不会删除游戏存档，清除后页面将刷新并重新加载启动器。')) return;

    isBusy = true;
    setBannerState('warning', '正在清除所有缓存和服务...');
    actionBtn.disabled = true;
    refreshBtn.disabled = true;
    clearCacheBtn.disabled = true;
    modSelector.disabled = true;

    try {
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
                await registration.unregister();
            }
        }

        await caches.delete(GAME_CACHE_NAME);
        await caches.delete(LAUNCHER_CACHE_NAME);
    } catch (error) {
        console.error('清除缓存失败:', error);
    }

    window.location.reload();
}

async function handleAction() {
    if (isBusy) return;

    if (currentAction === 'download' || currentAction === 'update' || currentAction === 'switch') {
        await downloadAndCacheZip();
    } else if (currentAction === 'launch') {
        await launchGame();
    } else if (currentAction === 'retry') {
        await handleRefresh();
    }
}

// 下载和缓存的核心逻辑
async function downloadAndCacheZip() {
    const selectedOption = modSelector.options[modSelector.selectedIndex];
    if (!selectedOption || !selectedOption.dataset.url || !targetReleaseData) return;

    isBusy = true;
    currentAction = 'busy';
    actionBtn.disabled = true;
    refreshBtn.disabled = true;
    clearCacheBtn.disabled = true;
    modSelector.disabled = true;
    prereleaseToggle.disabled = true;
    progressContainer.classList.remove('is-processing');
    progressContainer.hidden = false;
    progressBar.value = 0;
    progressLabel.textContent = '正在连接下载节点...';
    progressStats.textContent = '0%';

    const assetToDownload = {
        name: selectedOption.value,
        size: Number(selectedOption.dataset.size),
        shortName: selectedOption.textContent,
        targetUrl: selectedOption.dataset.url
    };

    const hadExistingCache = Boolean(localMeta);
    let writeStarted = false;
    let zipReader = null;

    try {
        setBannerState('info', `正在获取${assetToDownload.shortName}(${targetReleaseData.tag_name})...`);
        const proxyUrl = PROXY_URL_TEMPLATE.replace('{encoded_target_url}', encodeURIComponent(assetToDownload.targetUrl));
        const startTime = performance.now();

        const outerZipResponse = await fetchWithProgress(proxyUrl, assetToDownload.size, (loaded, total) => {
            const elapsedSec = Math.max((performance.now() - startTime) / 1000, 0.1);
            const speedMBps = (loaded / (1024 * 1024) / elapsedSec).toFixed(1);

            if (total > 0) {
                const progress = Math.min(100, Math.round((loaded / total) * 100));
                progressBar.value = progress;
                progressLabel.textContent = '正在下载资源包...';
                progressStats.textContent = `${formatBytes(loaded)} / ${formatBytes(total)} · ${speedMBps}MB/s (${progress}%)`;
            } else {
                progressLabel.textContent = '正在下载资源包...';
                progressStats.textContent = `${formatBytes(loaded)} · ${speedMBps}MB/s`;
            }
        });

        const outerZipBlob = await outerZipResponse.blob();

        // 保持进度条满值并开启脉冲样式，避免无 value 属性时深色槽渲染为空条
        progressBar.value = 100;
        progressContainer.classList.add('is-processing');
        progressLabel.textContent = '正在解压资源包...';
        progressStats.textContent = '校验结构中';

        // 使用 zip.js 解开外层 ZIP
        zipReader = new zip.ZipReader(new zip.BlobReader(outerZipBlob));
        const entries = await zipReader.getEntries();
        const htmlEntry = entries.find(e => !e.directory && e.filename.endsWith('.html'));
        const imgZipEntry = entries.find(e => !e.directory && (e.filename === 'img.zip' || e.filename.endsWith('/img.zip')));

        if (!htmlEntry || !imgZipEntry) {
            throw new Error('资源包内容不符合预期，缺少HTML或img.zip');
        }

        const htmlBlob = await htmlEntry.getData(new zip.BlobWriter('text/html; charset=utf-8'));
        const imgZipBlob = await imgZipEntry.getData(new zip.BlobWriter('application/zip'));

        progressLabel.textContent = '正在写入本地缓存...';
        progressStats.textContent = '即将完成';

        writeStarted = true;
        const cache = await caches.open(GAME_CACHE_NAME);

        const newMeta = {
            tag: targetReleaseData.tag_name,
            assetName: assetToDownload.name,
            shortName: assetToDownload.shortName
        };

        await Promise.all([
            cache.put(HTML_KEY, new Response(htmlBlob, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
            cache.put(IMG_ZIP_KEY, new Response(imgZipBlob, { headers: { 'Content-Type': 'application/zip' } })),
            cache.put(META_KEY, new Response(JSON.stringify(newMeta), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
        ]);

        // 通知已激活的游戏 SW 释放旧版 img.zip 读取句柄
        await notifyGameServiceWorkerReset();
        await checkLocalCache();
    } catch (error) {
        console.error('下载或缓存失败:', error);
        setBannerState('error', `操作失败: ${error.message}`);

        // 仅在首次安装或已开始覆盖写入缓存的阶段出错时清理残缺缓存，保留更新前的原有版本
        if (!hadExistingCache || writeStarted) {
            await caches.delete(GAME_CACHE_NAME);
        }
        await checkLocalCache();
    } finally {
        if (zipReader) {
            await zipReader.close().catch(() => {});
        }
        isBusy = false;
        progressContainer.classList.remove('is-processing');
        progressBar.value = 0;
        progressContainer.hidden = true;
        refreshBtn.disabled = false;
        clearCacheBtn.disabled = false;
        prereleaseToggle.disabled = false;
        updateUI();
    }
}

// 通知运行于 /play/ 作用域的 Service Worker 重置 ZipReader 索引
async function notifyGameServiceWorkerReset() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const registration = await navigator.serviceWorker.getRegistration(GAME_SCOPE);
        if (registration && registration.active) {
            registration.active.postMessage({ type: 'RESET_ZIP_CACHE' });
        }
    } catch (error) {
        console.error('通知游戏 Service Worker 重置缓存时出错:', error);
    }
}

// 等待目标作用域的 Service Worker 完成安装并进入激活状态
async function waitForServiceWorkerActive(registration) {
    const pendingWorker = registration.installing || registration.waiting;
    const targetWorker = pendingWorker || registration.active;

    if (!targetWorker) {
        throw new Error('未能获取有效的游戏Service Worker实例。');
    }

    if (targetWorker.state === 'activated') {
        return;
    }

    await new Promise((resolve, reject) => {
        const onStateChange = () => {
            if (targetWorker.state === 'activated') {
                targetWorker.removeEventListener('statechange', onStateChange);
                resolve();
            } else if (targetWorker.state === 'redundant') {
                targetWorker.removeEventListener('statechange', onStateChange);
                reject(new Error('游戏Service Worker激活中断。'));
            }
        };
        targetWorker.addEventListener('statechange', onStateChange);
    });
}

async function launchGame() {
    isBusy = true;
    actionBtn.disabled = true;
    setBannerState('info', '正在准备游戏环境...');

    try {
        if (!('serviceWorker' in navigator)) {
            throw new Error('当前浏览器不支持Service Worker，无法运行离线容器。');
        }

        // 使用精确的作用域注册游戏 Service Worker 并等待其激活完成
        const registration = await navigator.serviceWorker.register('/sw-game.js', { scope: GAME_SCOPE });
        await waitForServiceWorkerActive(registration);

        setBannerState('ready', '启动游戏中，请稍候...');
        // 导航到游戏的作用域根目录，后续请求将由 sw-game.js 处理
        window.location.href = GAME_SCOPE;
    } catch (error) {
        console.error('启动游戏失败:', error);
        setBannerState('error', `启动失败: ${error.message}`);
        isBusy = false;
        actionBtn.disabled = false;
    }
}

async function fetchWithProgress(url, totalSize, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`请求失败 (${response.status} ${response.statusText})`);
    if (!response.body) throw new Error('响应中没有可读的 body 内容。');

    const size = totalSize || Number(response.headers.get('content-length') || 0);
    const reader = response.body.getReader();
    let loaded = 0;
    let lastUpdateTime = 0;

    // 单通道流式读取并按时间间隔节流更新进度，避免使用 tee() 带来额外内存队列开销
    const stream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    onProgress(loaded, size);
                    controller.close();
                    return;
                }
                loaded += value.byteLength;
                const now = performance.now();
                if (now - lastUpdateTime >= 100) {
                    lastUpdateTime = now;
                    onProgress(loaded, size);
                }
                controller.enqueue(value);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        }
    });

    return new Response(stream, { headers: response.headers });
}

async function checkRemoteVersions() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error(`API 代理请求失败 (${response.status})`);

        const releases = await response.json();
        if (!Array.isArray(releases)) {
            throw new Error('接口返回格式异常');
        }

        // 过滤掉草稿与尚未上传有效压缩包的发布
        allReleases = releases.filter(release => !release.draft && getValidZipAssets(release).length > 0);
        if (allReleases.length === 0) {
            throw new Error('未在仓库中找到任何游戏ZIP文件');
        }

        remoteStatus = 'ready';
        applyTargetReleaseSelection();
    } catch (error) {
        console.error('检查远程版本失败:', error);
        allReleases = [];
        targetReleaseData = null;
        // 断网中断时不置为失败态，待恢复连接后自动重试
        remoteStatus = navigator.onLine ? 'error' : 'idle';
    }
}

function applyTargetReleaseSelection() {
    const includePrerelease = prereleaseToggle.checked;
    targetReleaseData = includePrerelease
        ? allReleases[0]
        : allReleases.find(release => !release.prerelease) || null;

    if (!targetReleaseData) {
        remoteVersionEl.textContent = '暂无正式版';
        remotePrereleaseBadge.hidden = true;
        if (localMeta) {
            populateModSelectorWithLocal();
        } else {
            modSelector.innerHTML = '<option value="">请开启预发行版本</option>';
            modSelector.disabled = true;
        }
        return;
    }

    remoteVersionEl.textContent = targetReleaseData.tag_name;
    remotePrereleaseBadge.hidden = !targetReleaseData.prerelease;

    const availableAssets = getValidZipAssets(targetReleaseData);
    populateModSelectorWithRemote(availableAssets);
}

function populateModSelectorWithLocal() {
    if (!localMeta) return;
    modSelector.innerHTML = '';
    const option = document.createElement('option');
    option.value = localMeta.assetName;
    option.textContent = localMeta.shortName;
    modSelector.appendChild(option);
    modSelector.disabled = true; // 离线时只用于显示，禁止切换
}

function populateModSelectorWithRemote(assets) {
    modSelector.innerHTML = '';
    assets.forEach(asset => {
        const option = document.createElement('option');
        // 尝试从文件名中提取更友好的简称，未匹配时回退上游原始文件名
        const match = asset.name.match(/Lyra-[^-]+-(?:(.+)-)?\d{4}(?:\.\d+)?\.zip$/);
const shortName = match ? (match[1] || '基础版') : asset.name;
        option.value = asset.name;
        option.textContent = shortName;
        option.dataset.size = asset.size;
        option.dataset.url = asset.browser_download_url;
        modSelector.appendChild(option);
    });

    const lastSelected = localStorage.getItem('selectedMod');
    if (lastSelected && Array.from(modSelector.options).some(opt => opt.value === lastSelected)) {
        modSelector.value = lastSelected;
    }
    modSelector.disabled = false;
}

function setBannerState(state, message) {
    statusBanner.dataset.state = state;
    statusText.textContent = message;
}

function updateActionButtonLabel(text, actionType, disabled = false) {
    currentAction = actionType;
    actionBtn.textContent = text;
    actionBtn.dataset.action = actionType;
    actionBtn.disabled = disabled;
}

// UI 更新逻辑，依据本地缓存与远程状态集中控制界面表现
function updateUI() {
    if (isBusy) return;

    refreshBtn.disabled = remoteStatus === 'checking';

    if (remoteStatus === 'checking') {
        remoteVersionEl.textContent = '查询中...';
        remotePrereleaseBadge.hidden = true;
    } else if (remoteStatus === 'idle') {
        remoteVersionEl.textContent = navigator.onLine ? '未检查' : '未连接';
        remotePrereleaseBadge.hidden = true;
    } else if (remoteStatus === 'error') {
        remoteVersionEl.textContent = localMeta ? '暂不可用' : '获取失败';
        remotePrereleaseBadge.hidden = true;
    }

    const selectedOption = modSelector.options[modSelector.selectedIndex];

    // 优先级 1: 处理有本地缓存的情况 (核心离线能力)
    if (localMeta) {
        if (remoteStatus === 'ready' && targetReleaseData && selectedOption && selectedOption.dataset.url) {
            if (localMeta.tag !== targetReleaseData.tag_name && localMeta.shortName === selectedOption.textContent) {
                updateActionButtonLabel('更新游戏', 'update');
                setBannerState('info', `发现新版本${targetReleaseData.tag_name}，可进行更新。`);
            } else if (localMeta.assetName !== selectedOption.value) {
                updateActionButtonLabel('切换并下载', 'switch');
                setBannerState('warning', '选择的模组与本地缓存不一致，下载后将替换本地文件。');
            } else {
                updateActionButtonLabel('启动游戏', 'launch');
                setBannerState('ready', '游戏已是最新版本，可以启动。');
            }
        } else {
            updateActionButtonLabel('启动游戏', 'launch');
            if (remoteStatus === 'ready' && !prereleaseToggle.checked && !targetReleaseData) {
                setBannerState('info', '远程暂无正式版，已保留本地启动；如需获取新版可打开预发行开关。');
            } else {
                setBannerState('ready', '本地资源已就绪，可以启动游戏。');
            }
        }
        return;
    }

    // 优先级 2: 处理无本地缓存的情况
    if (remoteStatus === 'checking') {
        modSelector.disabled = true;
        updateActionButtonLabel('正在获取版本...', 'idle', true);
        setBannerState('info', '正在获取可用版本列表...');
    } else if (remoteStatus === 'idle') {
        modSelector.innerHTML = '<option value="">等待网络连接...</option>';
        modSelector.disabled = true;
        updateActionButtonLabel('等待网络连接', 'idle', true);
        setBannerState('info', '当前网络未就绪，联网后将自动获取版本。');
    } else if (remoteStatus === 'ready') {
        if (targetReleaseData && selectedOption && selectedOption.dataset.url) {
            updateActionButtonLabel('下载游戏', 'download');
            setBannerState('info', '尚未下载游戏，请选择一个模组进行下载。');
        } else {
            updateActionButtonLabel('需要开启预发行版', 'idle', true);
            setBannerState('warning', '近期版本均标记为预发行版，请开启上方“包含预发行版本”开关后再下载。');
        }
    } else {
        modSelector.innerHTML = '<option value="">获取列表失败</option>';
        modSelector.disabled = true;
        updateActionButtonLabel('重试', 'retry');
        setBannerState('error', '获取版本列表失败，请确认网络后重试。');
    }
}