// api/proxy.js

// 定义唯一允许代理的 GitHub 仓库
const ALLOWED_REPO = 'Lumingtianze/DoL-PWA';
// 允许的 GitHub 主机名
const ALLOWED_HOSTS = ['api.github.com', 'github.com'];

// [Vercel 配置] 导出此配置以确保函数在 Edge Runtime 中运行
export const config = {
    runtime: 'edge',
};

/**
 * Vercel Edge Function, 作为一个带缓存的代理。
 * 此函数仅在 Vercel 边缘缓存未命中时执行。
 * 它的核心职责是向上游请求数据，并返回一个带有正确 Cache-Control 头的响应，
 * 以便 Vercel 的边缘网络能够正确地缓存它。
 */
export default async function handler(request) {
    const url = new URL(request.url);
    const targetUrlString = url.searchParams.get('url');

    if (!targetUrlString) {
        return new Response('Missing "url" query parameter', { status: 400 });
    }

    // --- 安全校验 ---
    let targetUrl;
    try {
        targetUrl = new URL(targetUrlString);
        
        if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
            throw new Error('Hostname not allowed');
        }

        const path = targetUrl.pathname;
        const isApiRequest = targetUrl.hostname === 'api.github.com' && path === `/repos/${ALLOWED_REPO}/releases/latest`;
        const isDownloadRequest = targetUrl.hostname === 'github.com' && path.startsWith(`/${ALLOWED_REPO}/releases/download/`);

        if (!isApiRequest && !isDownloadRequest) {
            throw new Error('Path is not allowed');
        }
    } catch (error) {
        return new Response(`Forbidden: ${error.message}`, { status: 403 });
    }

    // --- 执行代理 (此代码块只在缓存未命中时运行) ---
    
    // 在 fetch 前准备好所有请求头
    const requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
    };
    
    // 如果环境变量中存在 GITHUB_TOKEN，则将其添加到请求头中以解决速率限制或403问题
    if (process.env.GITHUB_TOKEN) {
        requestHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    // 使用构建好的请求头来发起请求
    const targetResponse = await fetch(targetUrlString, {
        headers: requestHeaders
    });

    if (!targetResponse.ok) {
        // GitHub 返回 403 Forbidden 是常见情况，直接透传状态
        return new Response(`Failed to fetch from remote: ${targetResponse.statusText}`, { status: targetResponse.status });
    }

    // 复制原始响应以修改 headers
    const response = new Response(targetResponse.body, targetResponse);

    // --- 设置响应头以控制 Vercel Edge 缓存 ---
    response.headers.set('Access-Control-Allow-Origin', '*');

    // 设置差异化的缓存策略
    if (targetUrl.hostname === 'api.github.com') {
        // API 请求：缓存10分钟, 过期后允许提供旧缓存并在后台更新
        response.headers.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    } else {
        // 下载请求（不可变资源）：缓存1年, 且标记为不可变
        response.headers.set('Cache-Control', 'public, s-maxage=31536000, immutable');
    }

    // 返回最终构造的响应。Vercel 将会捕获此响应并根据其头部进行缓存。
    return response;
}