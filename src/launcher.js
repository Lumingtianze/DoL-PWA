// launcher.js

const GITHUB_REPO = 'Lumingtianze/DoL-PWA';
const API_URL = `/api/proxy?url=${encodeURIComponent(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)}`;
const PROXY_URL_TEMPLATE = '/api/proxy?url={encoded_target_url}';

const GAME_CACHE_NAME = 'game-cache';
const LAUNCHER_CACHE_NAME = 'launcher-cache';
const HTML_KEY = 'game.html';
const IMG_ZIP_KEY = 'img.zip';
const META_KEY = 'meta.json';

// 配置 zip.js
zip.configure({
  useWebWorkers: false // 不启用  Web Worker
});

// 定义游戏的作用域，所有此路径下的请求都将被 sw-game.js 拦截
const GAME_SCOPE = '/play/';

const statusText = document.getElementById('status-text');
const localVersionSpan = document.getElementById('local-version');
const remoteVersionSpan = document.getElementById('remote-version');
const modSelector = document.getElementById('mod-selector');
const progressContainer = document.getElementById('progress-container');
const progressLabel = document.getElementById('progress-label');
const progressBar = document.getElementById('progress-bar');
const actionBtn = document.getElementById('action-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');

let localMeta = null;
let latestReleaseData = null;

document.addEventListener('DOMContentLoaded', main);

async function main() {
    if ('serviceWorker' in navigator) {
        // 注册启动器自身的 Service Worker
        await navigator.serviceWorker.register('sw.js');
    }
    actionBtn.addEventListener('click', handleAction);
    clearCacheBtn.addEventListener('click', clearCache);
    modSelector.addEventListener('change', () => {
        localStorage.setItem('selectedMod', modSelector.value);
        updateUI();
    });

    // 先检查本地缓存以实现快速离线启动
    await checkLocalCache();
    updateUI(); // 基于本地缓存状态，立刻更新一次UI

    // 异步执行远程检查，完成后再次更新UI，不阻塞初始加载
    checkRemoteVersions().then(() => {
        updateUI();
    });
}

// 检查本地缓存，验证 .html 和 img.zip 是否都存在
async function checkLocalCache() {
    statusText.textContent = '检查本地游戏版本...';
    try {
        const cache = await caches.open(GAME_CACHE_NAME);
        const [metaResponse, htmlResponse, imgResponse] = await Promise.all([
            cache.match(META_KEY),
            cache.match(HTML_KEY),
            cache.match(IMG_ZIP_KEY)
        ]);

        if (metaResponse && htmlResponse && imgResponse) {
            localMeta = await metaResponse.json();
            localVersionSpan.textContent = `${localMeta.tag} (${localMeta.shortName})`;
            clearCacheBtn.style.display = 'block';

            // 离线时，在MOD选择器中显示当前已安装的版本
            populateModSelectorWithLocal();

        } else {
            localVersionSpan.textContent = '无';
            localMeta = null;
            // 清理不完整的缓存
            await caches.delete(GAME_CACHE_NAME);
        }
    } catch (error) {
        console.error('检查本地缓存失败:', error);
        localVersionSpan.textContent = '读取错误';
        localMeta = null;
    }
}

// 清理功能会删除游戏缓存、启动器缓存，并注销所有 Service Worker
async function clearCache() {
    if (!confirm('确定要清除所有本地数据和启动器缓存吗？此操作将强制更新启动器本身。')) return;
    statusText.textContent = '正在清除所有缓存和服务...';
    actionBtn.disabled = true;
    clearCacheBtn.disabled = true;

    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
            await registration.unregister();
        }
    }

    await caches.delete(GAME_CACHE_NAME);
    await caches.delete(LAUNCHER_CACHE_NAME);
    window.location.reload();
}

async function handleAction() {
    const action = actionBtn.textContent;
    if (action === '下载游戏' || action === '更新游戏' || action === '切换并下载') {
        await downloadAndCacheZip();
    } else if (action === '启动游戏') {
        await launchGame();
    } else if (action === '重试') {
        // 重试逻辑
        actionBtn.disabled = true;
        statusText.textContent = '正在重新尝试获取版本信息...';
        remoteVersionSpan.textContent = '查询中...';
        await checkRemoteVersions();
        updateUI();
    }
}

// 下载和缓存的核心逻辑
async function downloadAndCacheZip() {
    actionBtn.disabled = true; clearCacheBtn.disabled = true; modSelector.disabled = true;
    progressContainer.style.display = 'block';

    const selectedOption = modSelector.options[modSelector.selectedIndex];
    const assetToDownload = { name: selectedOption.value, size: Number(selectedOption.dataset.size), shortName: selectedOption.textContent, targetUrl: selectedOption.dataset.url };

    try {
        // 下载包含 html 和 img.zip 的外层 ZIP
        const proxyUrl = PROXY_URL_TEMPLATE.replace('{encoded_target_url}', encodeURIComponent(assetToDownload.targetUrl));
        const outerZipResponse = await fetchWithProgress(proxyUrl, assetToDownload.size);
        const outerZipBlob = await outerZipResponse.blob();

        progressLabel.textContent = '下载完成，正在处理资源包...';

        // 使用 zip.js 解开外层 ZIP
        const zipReader = new zip.ZipReader(new zip.BlobReader(outerZipBlob));
        const entries = await zipReader.getEntries();
        const htmlEntry = entries.find(e => e.filename.endsWith('.html'));
        const imgZipEntry = entries.find(e => e.filename === 'img.zip');

        if (!htmlEntry || !imgZipEntry) throw new Error('资源包内容不符合预期 (缺少 .html 或 img.zip)');

        // 将解压出的文件Blob存入缓存
        const htmlBlob = await htmlEntry.getData(new zip.BlobWriter('text/html'));
        const imgZipBlob = await imgZipEntry.getData(new zip.BlobWriter('application/zip'));

        const cache = await caches.open(GAME_CACHE_NAME);
        await cache.put(HTML_KEY, new Response(htmlBlob));
        await cache.put(IMG_ZIP_KEY, new Response(imgZipBlob));

        // 写入元数据
        const newMeta = { tag: latestReleaseData.tag_name, assetName: assetToDownload.name, shortName: assetToDownload.shortName };
        const metaResponse = new Response(JSON.stringify(newMeta), { headers: { 'Content-Type': 'application/json' } });
        await cache.put(META_KEY, metaResponse);

        await zipReader.close();

        statusText.textContent = '游戏资源缓存成功！';
        await checkLocalCache();

    } catch (error) {
        console.error('下载或缓存失败:', error);
        statusText.textContent = `操作失败: ${error.message}`;
        await caches.delete(GAME_CACHE_NAME);
        await checkLocalCache();
    } finally {
        progressContainer.style.display = 'none';
        actionBtn.disabled = false; clearCacheBtn.disabled = false; modSelector.disabled = false;
        updateUI();
    }
}

async function launchGame() {
    statusText.textContent = '正在准备游戏环境...';
    actionBtn.disabled = true;
    try {
        // 使用精确的作用域注册游戏 Service Worker
        await navigator.serviceWorker.register('/sw-game.js', { scope: GAME_SCOPE });

        // 等待 Service Worker 完全激活并准备就绪
        await navigator.serviceWorker.ready;
        statusText.textContent = '启动游戏中，请稍候...';

        // 导航到游戏的作用域根目录，后续请求将由 sw-game.js 处理
        window.location.href = GAME_SCOPE;

    } catch (error) {
        console.error('启动游戏失败:', error);
        statusText.textContent = `启动失败: ${error.message}`;
        actionBtn.disabled = false;
    }
}

async function fetchWithProgress(url, totalSize) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`请求失败: ${response.statusText}`);
    if (!response.body) throw new Error('响应中没有可读的 body 内容。');

    const size = totalSize || Number(response.headers.get('content-length') || 0);
    let loaded = 0;

    // 使用 tee() 克隆响应流，一个用于计算进度，另一个用于缓存，避免将整个文件读入内存
    const [progressStream, streamForCache] = response.body.tee();

    // 异步处理进度流的读取，不阻塞主流程
    (async () => {
        const reader = progressStream.getReader();
        while (true) {
            try {
                const { done, value } = await reader.read();
                if (done) break;

                loaded += value.length;
                if (size > 0) {
                    const progress = Math.round((loaded / size) * 100);
                    progressBar.value = progress;
                    const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                    const totalMB = (size / 1024 / 1024).toFixed(1);
                    progressLabel.textContent = `下载中... ${loadedMB}MB / ${totalMB}MB (${progress}%)`;
                } else {
                    progressLabel.textContent = `下载中... ${(loaded / 1024 / 1024).toFixed(1)}MB`;
                }
            } catch (error) {
                console.error('读取进度流时出错:', error);
                break;
            }
        }
    })();

    // 返回一个新的Response，其主体是专用于缓存的流
    return new Response(streamForCache, { headers: response.headers });
}

async function checkRemoteVersions() {
    // 在此函数开始时不修改UI，让调用者(main/handleAction)负责初始UI状态
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error(`API 代理请求失败: ${response.statusText}`);
        latestReleaseData = await response.json();
        const availableAssets = latestReleaseData.assets.filter(a => a.name.endsWith('.zip') && !a.name.includes('polyfill'));
        if (availableAssets.length === 0) throw new Error('在最新的 Release 中未找到任何游戏ZIP文件');

        populateModSelectorWithRemote(availableAssets);
        remoteVersionSpan.textContent = `${latestReleaseData.tag_name}`;
    } catch (error) {
        console.error('检查远程版本失败:', error);
        statusText.textContent = '获取版本列表失败，请检查网络并重试。';
        remoteVersionSpan.textContent = '获取失败';
        // 失败时将远程数据设为null，以便UI状态机正确处理
        latestReleaseData = null;
    }
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
        // 尝试从文件名中提取更友好的简称
        const match = asset.name.match(/Lyra-.*?-(.*)-\d{4}\.zip$/);
        const shortName = match ? match[1] : asset.name;
        option.value = asset.name;
        option.textContent = shortName;
        option.dataset.size = asset.size;
        option.dataset.url = asset.browser_download_url;
        modSelector.appendChild(option);
    });
    const lastSelected = localStorage.getItem('selectedMod');
    if (lastSelected && modSelector.querySelector(`option[value="${lastSelected}"]`)) {
        modSelector.value = lastSelected;
    }
    modSelector.disabled = false;
}

// UI更新逻辑，增加重试机制，使其行为更可预测
function updateUI() {
    // 如果正在进行下载等操作，则不更新UI，防止状态被覆盖
    if (progressContainer.style.display === 'block') {
        return;
    }

    const selectedOption = modSelector.options[modSelector.selectedIndex];

    // 优先级 1: 处理有本地缓存的情况 (核心离线能力)
    if (localMeta) {
        actionBtn.disabled = false;
        // 如果在线，则提供更新和切换选项
        if (latestReleaseData) {
            const selectedAssetName = selectedOption ? selectedOption.value : null;
            if (localMeta.assetName !== selectedAssetName) {
                actionBtn.textContent = '切换并下载';
                statusText.textContent = '选择的模组与本地缓存不一致。';
            } else if (localMeta.tag !== latestReleaseData.tag_name) {
                actionBtn.textContent = '更新游戏';
                statusText.textContent = `发现新版本 ${latestReleaseData.tag_name}，可进行更新。`;
            } else {
                actionBtn.textContent = '启动游戏';
                statusText.textContent = '游戏已是最新版本，可以启动。';
            }
        } else {
            // 离线但有缓存，始终显示启动
            actionBtn.textContent = '启动游戏';
            statusText.textContent = '可离线启动游戏。';
        }
        // 优先级 2: 处理无本地缓存的情况
    } else {
        // 能获取到远程信息，则提供下载
        if (latestReleaseData) {
            actionBtn.textContent = '下载游戏';
            actionBtn.disabled = false;
            statusText.textContent = '尚未下载游戏，请选择一个模组进行下载。';
        } else {
            // 既无本地也无远程，提供重试选项
            actionBtn.textContent = '重试';
            actionBtn.disabled = false; // 确保重试按钮是可点击的
            statusText.textContent = '获取版本列表失败，请检查网络并重试。';
        }
    }
}
