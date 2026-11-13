// functions/api/proxy.js

// 定义唯一允许代理的 GitHub 仓库
const ALLOWED_REPO = 'Lumingtianze/DoL-PWA';
// 允许的 GitHub 主机名
const ALLOWED_HOSTS = ['api.github.com', 'github.com'];

/**
 * Cloudflare Pages Edge Function, 作为一个带缓存的代理。
 * 此函数仅在 Cloudflare CDN 缓存未命中时执行。
 * 它的核心职责是向上游请求数据，并返回一个带有正确 Cache-Control 头的响应，
 * 以便 Cloudflare 的 CDN 能够正确地缓存它。
 */
export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const targetUrlString = url.searchParams.get('url');

    if (!targetUrlString) {
        return new Response('缺少 "url" 查询参数', { status: 400 });
    }

    // --- 安全校验 ---
    let targetUrl;
    try {
        targetUrl = new URL(targetUrlString);

        if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
            throw new Error('不允许请求该主机名');
        }

        const path = targetUrl.pathname;
        // 仅放行发布列表（含预发行版）及资源包下载路径，限制查询参数保证缓存一致
        const isApiRequest = targetUrl.hostname === 'api.github.com'
            && path === `/repos/${ALLOWED_REPO}/releases`
            && (targetUrl.search === '' || targetUrl.search === '?per_page=10');
        const isDownloadRequest = targetUrl.hostname === 'github.com' && path.startsWith(`/${ALLOWED_REPO}/releases/download/`);

        if (!isApiRequest && !isDownloadRequest) {
            throw new Error('不允许请求该路径');
        }
    } catch (error) {
        return new Response(`禁止访问: ${error.message}`, { status: 403 });
    }

    // --- 执行代理 (此代码块只在 CDN 缓存未命中时运行) ---

    // 在 fetch 前准备好所有请求头
    const requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Accept': 'application/vnd.github+json'
    };

    // 如果环境变量中存在 GITHUB_TOKEN，则将其添加到请求头中以解决速率限制或403问题
    if (context.env.GITHUB_TOKEN) {
        requestHeaders['Authorization'] = `token ${context.env.GITHUB_TOKEN}`;
    }

    // 使用构建好的请求头来发起请求
    const targetResponse = await fetch(targetUrlString, {
        headers: requestHeaders
    });

    if (!targetResponse.ok) {
        return new Response(`远程请求失败: ${targetResponse.statusText}`, { status: targetResponse.status });
    }

    // 仅透传必要响应头，剥离上游 Vary 与 Set-Cookie 以免影响 CDN 缓存命中
    const headers = new Headers();
    const passthroughHeaders = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified'];
    for (const key of passthroughHeaders) {
        const value = targetResponse.headers.get(key);
        if (value) headers.set(key, value);
    }

    // --- 设置响应头以控制 Cloudflare CDN 缓存 ---
    headers.set('Access-Control-Allow-Origin', '*');

    // 设置差异化的缓存策略，交由 Cloudflare CDN 自动处理
    if (targetUrl.hostname === 'api.github.com') {
        // API 请求：指示 CDN 缓存10分钟, 过期后允许提供旧缓存并在后台更新
        headers.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    } else {
        // 下载请求（不可变资源）：指示 CDN 缓存1年, 且标记为不可变
        headers.set('Cache-Control', 'public, s-maxage=31536000, immutable');
    }

    return new Response(targetResponse.body, {
        status: targetResponse.status,
        headers
    });
}