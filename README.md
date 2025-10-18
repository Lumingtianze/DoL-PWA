# DoL Lyra PWA Launcher

这是一个为 [Degrees of Lewdity (Lyra Mod 整合包)](https://github.com/DoL-Lyra/Lyra/) 设计的、支持 PWA (Progressive Web App) 的现代化在线启动器。

它旨在提供闪电般的加载速度、离线游戏能力以及无缝的更新体验，特别针对移动设备进行了深度优化。

[![Build Status](https://img.shields.io/github/actions/workflow/status/Lumingtianze/DoL-PWA/.github/workflows/repack.yaml?branch=main)](https://github.com/Lumingtianze/DoL-PWA/actions)
[![Latest Release](https://img.shields.io/github/v/release/Lumingtianze/DoL-PWA)](https://github.com/Lumingtianze/DoL-PWA/releases)

---

## ✨ 项目特点

-   **极速加载**: 首次下载后，游戏资源将缓存到本地。后续启动几乎是瞬时的，无需等待漫长的下载。
-   **PWA 支持**: 可将启动器“安装”到桌面或手机主屏幕，提供接近原生应用的体验。
-   **离线游戏**: 一旦游戏资源被缓存，即可在没有网络连接的情况下随时启动和游玩。
-   **高效的资源管理**:
    -   **智能重打包**: 自动化流程将原始游戏包重构。最终产物是一个高度压缩的 ZIP 压缩包，体积减小约 60%，内部包含一个 HTML 文件和一个**未经压缩**的图片归档 (`img.zip`)。
    -   **运行时零解压**: 游戏运行时，Service Worker 直接从 `img.zip` 中按需读取文件，消除了传统 ZIP 解压带来的 CPU 和内存开销，极大地提升了在低性能设备上的流畅度。
    -   **高级缓存策略**: `sw-game.js` 采用了一个**自适应替换缓存 (ARC) 算法**。它能根据玩家的实际游戏行为，智能地将热门资源保留在内存中，并**持久化其“学习”成果**，用于下次启动时**预热缓存**，实现真正的“秒开”体验。
    -   **精细的性能控制**: 内置**请求合并**与**并发节流**机制，有效避免了资源请求风暴，即使在快速加载大量资源的场景下也能保持流畅响应。
-   **自动更新**: 启动器会自动检查上游 `DoL-Lyra` 仓库的最新版本，并提示用户一键更新。
-   **多 Mod 支持**: 清晰的界面允许玩家在多个可用的 Mod 版本之间轻松选择和切换。
-   **CDN 加速与 API 代理**: 通过边缘函数 (Edge Function) 代理所有对 GitHub 的请求，利用 CDN 边缘缓存大幅提升资源和版本信息的加载速度，并有效规避 GitHub API 的速率限制。
-   **彻底的缓存清理**: 提供一键清理功能，可彻底清除所有本地数据、启动器缓存并注销服务，用于解决潜在问题或强制更新启动器本身。

## 🚀 如何使用

1.  **访问启动器**: 使用现代浏览器（如 Chrome, Edge, Safari, Firefox）访问本项目的部署地址。
2.  **选择 Mod**: 在下拉菜单中选择您想要游玩的 Mod 版本。
3.  **下载游戏**: 点击“下载游戏”按钮。启动器将获取并缓存优化后的游戏资源。进度条会显示下载进度。
4.  **启动游戏**: 下载完成后，按钮将变为“启动游戏”。点击即可进入游戏世界。
5.  **(可选) 安装到主屏幕**:
    -   **手机端**: 浏览器通常会在地址栏或菜单中显示“添加到主屏幕”或“安装应用”的选项。
    -   **桌面端 (Chrome/Edge)**: 地址栏右侧会出现一个带加号的显示器图标，点击即可安装。

## ⚙️ 技术实现

本启动器通过以下技术栈和策略实现其高性能特性：

-   **GitHub Actions**: 完全自动化的 CI/CD 流程，负责：
    1.  每日定时检查上游仓库是否有新版本。
    2.  并行下载所有最新的游戏 Mod 包，提升处理效率。
    3.  执行**智能重打包**:
        -   将 `img` 目录以**仅存储 (不压缩)** 模式打包成 `img.zip`，用于运行时快速读取。
        -   将游戏 `HTML` 文件和 `img.zip` 一起，以标准压缩模式打包成最终的发布文件。
    4.  将优化后的资源发布到本仓库的 Release 页面。
    5.  自动清理旧的构建记录，保持仓库整洁。
-   **Service Workers**: 作为 PWA 的核心，负责拦截网络请求、管理缓存和实现离线功能。
    -   `sw.js`: 负责缓存启动器自身的核心文件（HTML, CSS, JS），实现启动器的离线可用。
    -   `sw-game.js`: 游戏运行时的“引擎”，它将 `img.zip` 作为一个虚拟文件系统。其核心是一个**增强的 ARC (Adaptive Replacement Cache)** 实例，具备以下特性：
        -   **自适应缓存**: 结合了 LRU (近期最少使用) 和 LFU (最不经常使用) 的优点，并能根据工作负载动态调整策略。
        -   **状态持久化与预热**: SW 会将 ARC 缓存中的高频项目列表（元数据）持久化存储。当游戏下次启动时，它会**自动预热**这些高频资源，提前将其解压到内存中，极大缩短了进入游戏和加载场景的时间。
        -   **性能保障**: 通过**请求合并**避免对同一资源的重复解压，并通过**并发节流器**精确控制解压操作的数量，防止 CPU 占用过高，确保游戏平稳运行。
-   **API 代理**:
    -   一个部署在边缘网络的代理服务（例如 Cloudflare Functions, Vercel Edge Functions）。
    -   **规避限制**: 解决浏览器直接请求 GitHub API 时的 CORS 和速率限制问题。
    -   **CDN 缓存**: 为 API 请求（版本信息）和资源下载实施了优化的缓存策略（`s-maxage`, `stale-while-revalidate`），大幅提高了全球用户的访问速度和可靠性。
-   **Cache API**: 用于持久化存储游戏资源包 (`game.html`, `img.zip`) 和 ARC 缓存元数据，实现离线访问。
-   **zip.js**: 一个强大的前端 ZIP 处理库。在启动器中用于解开下载的传输包，在 `sw-game.js` 中用于从 `img.zip` 中读取文件。

## 🛠️ 自行部署

如果您希望部署自己的版本，请遵循以下步骤：

1.  **Fork 本仓库**: 点击页面右上角的 "Fork" 按钮。

2.  **启用 Actions**: 在您 Fork 后的仓库页面，进入 "Actions" 标签页，并启用 GitHub Actions。工作流将自动开始按计划运行。

3.  **部署 `public` 目录**:
    -   本项目的所有前端静态文件都位于 `public` 目录。您需要将这个目录部署到一个静态网站托管服务上。
    -   **重要**: 部署时，请确保网站的**根目录 (root)** 指向 `public` 目录。
    -   推荐的免费托管平台：
        -   **Vercel**: 直接链接您的 GitHub 仓库，在项目设置中将 "Root Directory" 设置为 `public`。
        -   **Netlify**: 链接仓库，在 "Build & deploy" -> "Base directory" 中设置为 `public`。
        -   **Cloudflare Pages**: 链接仓库，构建设置将 "Root Directory" 设置为 `public`。

4.  **(强烈推荐) 配置 API 代理与 GITHUB_TOKEN**:
    -   为了避免 GitHub API 的速率限制（尤其是在多人使用您的部署时），需要设置一个 Personal Access Token。
    -   代码默认会请求 `/api/proxy` 路径下的代理。本项目提供了一个 Vercel 和 Cloudflare Pages 的实现，它会自动被部署。
    -   **配置 Token**:
        1.  前往您的 GitHub "Settings" -> "Developer settings" -> "Personal access tokens" -> "Tokens (classic)"，生成一个**没有勾选任何权限**的空白 Token。
        2.  在您的部署平台（Vercel, Netlify, Cloudflare Pages）的项目设置中，找到 "Environment variables" 选项。
        3.  添加一个名为 `GITHUB_TOKEN` 的环境变量，值为您刚刚生成的 Token。

## 🤝 贡献

欢迎通过 Pull Requests 或 Issues 为本项目做出贡献。