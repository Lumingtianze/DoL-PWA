# DoL Lyra PWA Launcher

这是一个为 [Degrees of Lewdity (Lyra Mod 整合包)](https://github.com/DoL-Lyra/Lyra/) 设计的 PWA (Progressive Web App) 启动器。


[![Build Status](https://img.shields.io/github/actions/workflow/status/Lumingtianze/DoL-PWA/.github/workflows/repack.yaml?branch=main)](https://github.com/Lumingtianze/DoL-PWA/actions)
[![Latest Release](https://img.shields.io/github/v/release/Lumingtianze/DoL-PWA)](https://github.com/Lumingtianze/DoL-PWA/releases)

---

## 项目特点

- **离线游玩**: 资源包下载并写入本地缓存后，可在无网络环境下直接启动游戏。
- **PWA 安装**: 支持在桌面浏览器或移动端添加到主屏幕，以独立应用窗口运行。
- **分体打包与按需读取**:
  - **资源重打包**: 自动化构建流程将整合包内的 `img` 目录以无压缩（仅存储）方式归档为 `img.zip`，再与游戏 HTML 一同打包为外层压缩包以节省下载流量。
  - **按需切片读取**: 游戏运行时，Service Worker 直接从本地 `img.zip` 按路径按需读取所需文件，避免在启动时一次性解压全部图片。
  - **并发控制**: 对同时进行的读取请求做去重合并与并发数限制，防止大量图片并发加载时占用过多资源。
- **版本检查与预发行支持**: 自动拉取发布列表，支持通过界面开关切换是否包含上游预发行版本（Pre-release），并可一键更新或切换模组包。
- **边缘代理与缓存**: 通过 Edge Function 代理对 GitHub 的请求，利用 CDN 缓存减少直连 GitHub API 时的跨域与速率限制问题。
- **安全清理缓存**: 支持一键清除本地游戏资源缓存、启动器缓存并注销 Service Worker。


## 如何使用

1. **访问启动器**: 使用现代浏览器（Chrome、Edge、Safari、Firefox 等）打开部署地址。
2. **选择版本与模组**: 可按需开启或关闭“包含预发行版本”开关，并在下拉列表中选择对应模组包。
3. **下载游戏**: 点击“下载游戏”，等待资源包下载与本地写入完成。
4. **启动游戏**: 缓存完成后按钮变为“启动游戏”，点击即可进入游戏。
5. **安装为主屏幕应用（可选）**:
   - **移动端**: 在浏览器菜单或分享面板中选择“添加到主屏幕”或“安装应用”。
   - **桌面端**: 在地址栏右侧点击安装应用图标。

## 技术实现

- **GitHub Actions (`.github/workflows/repack.yaml`)**:
  1. 每日定时检查上游 `DoL-Lyra/Lyra` 最新发布（含预发行版本）。
  2. 对比仓库已有标签后，并行下载各版本压缩包，将 `img` 目录生成为无压缩的 `img.zip`，再与 `.html` 一起以高压缩比（`-mx=9`）打包并同步发布到当前仓库 Releases。
  3. 清理旧的工作流运行记录。
- **Service Workers**:
  - `sw.js`: 负责启动器自身的离线缓存，核心页面与脚本采用网络优先并在成功后更新缓存。
  - `sw-game.js`: 接管 `/play/` 作用域，直接从 Cache API 返回游戏主页面，其余相对路径资源按需从 `img.zip` 提取返回。
- **Edge 代理 (`api/proxy.js` / `functions/api/proxy.js`)**:
  - 分别适配 Vercel Edge Runtime 与 Cloudflare Pages Functions，校验允许访问的仓库接口与下载路径，并附带 `Cache-Control` 响应头供边缘节点缓存。
- **前端构建与依赖**:
  - 使用 `esbuild` 压缩 `src/*.js` 至 `public/`，前端通过 `zip.js` 完成外层下载包的解析与运行时 `img.zip` 的切片读取。

## 自行部署

1. **Fork 本仓库**: 点击仓库右上角的 Fork。
2. **修改仓库地址**: 若希望在自己的仓库中自动打包并分发，请将 `src/launcher.js`、`api/proxy.js` 和 `functions/api/proxy.js` 中的仓库名称替换为你的 `<用户名>/<仓库名>`。
3. **启用 Actions**: 在 Fork 后的仓库中进入 Actions 标签页启用工作流，并手动运行一次 `Check Upstream and Repack Release` 生成首个 Release。
4. **部署站点**:
   - **Vercel**: 关联仓库后保留仓库根目录以启用 `api/proxy.js`，构建命令设为 `npm run build`，输出目录设为 `public`。
   - **Cloudflare Pages**: 关联仓库后保留仓库根目录以启用 `functions/api/proxy.js`，构建命令设为 `npm run build`，构建输出目录设为 `public`。
5. **配置 `GITHUB_TOKEN`（推荐）**:
   - 在 GitHub Settings -> Developer settings -> Personal access tokens 中生成一个无需勾选额外权限的 Token。
   - 在托管平台的环境变量设置中添加 `GITHUB_TOKEN`，可避免多人或频繁访问时触发 GitHub API 匿名速率限制。

## 贡献

欢迎通过 Issues 或 Pull Requests 提交反馈与改进。