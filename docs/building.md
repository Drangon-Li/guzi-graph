# 开发与构建

仓库采用 monorepo 结构；桌面应用位于 [`apps/desktop/`](../apps/desktop)，网页应用位于 [`apps/web/`](../apps/web)，画布核心位于 [`packages/`](../packages)。桌面代码按主进程、preload、共享契约和 renderer 分层；renderer 按工作区、编辑器、项目、设置、导出和示例归类。

共享环境变量、测试配置和构建脚本位于 [`tooling/`](../tooling)，Web 静态资源位于 `apps/web/public/`，Docker 与 Firebase 部署配置位于 [`apps/web/deploy/`](../apps/web/deploy)。开发文档集中在 [`docs/development/`](./development)，用户画布示例与 SDK 集成示例保留在 [`examples/`](../examples)。本地环境覆盖文件放在 `tooling/config/env/.env.local` 或对应模式的 `.env.*.local` 中。

需要 Node.js **22.12.0 或更高版本**和 Yarn **1.22.22**。生成 DMG 需要 macOS；Windows 安装与运行验收使用 Windows x64 环境。首次安装依赖与打包可能需要下载 Electron 和构建工具。

```bash
yarn install --frozen-lockfile

# 启动桌面开发环境（Vite + Electron）
yarn desktop:dev

# 类型检查与桌面测试（Electron 主进程 + renderer）
yarn desktop:typecheck
yarn desktop:test

# 构建桌面前端
yarn desktop:build

# 构建 Apple Silicon DMG（保留原入口）
yarn desktop:package

# 构建 Windows x64 NSIS .exe / unpacked 目录
yarn desktop:package:win
yarn desktop:package:win:dir
```

桌面构建输出位于 `apps/desktop/dist/`，打包产物位于 `apps/desktop/release/`。只生成 `.app` 目录可运行：

```bash
npm --prefix apps/desktop run package:dir
```

Windows unpacked 产物位于 `apps/desktop/release/win-unpacked/`。基础 smoke 使用独立临时工作区，启动打包应用、通过内置 MCP 保存画布与演示文稿，再重启应用重开文件：

```bash
yarn desktop:test:smoke --executable "apps/desktop/release/win-unpacked/Excalidraw-Guzi.exe"
```

`.github/workflows/desktop-windows.yml` 在 Windows runner 上执行检查、打包和 smoke，只上传 Actions artifact，不发布 Release。CI 与真实 Windows 10 / 11 验收的覆盖边界、测试渠道命令及签名说明见 [Windows 开发与验收](./windows-desktop.md)。

修改画布核心后，按受影响范围运行相关测试，例如：

```bash
yarn test:app run packages/excalidraw/tests/table.test.tsx packages/excalidraw/tests/subcanvas.test.tsx
yarn test:app run packages/excalidraw/features/rich-text/editor.test.tsx
```

本地构建沿用 ad-hoc 签名配置，不会自动完成 Developer ID 签名或 Apple 公证。

## 构建单人网页版

安装仓库依赖后，在仓库根目录运行：

```bash
# 构建与在线站点相同的单人模式
yarn --cwd apps/web build:single-user

# 在本机预览构建结果
yarn --cwd apps/web vite preview --host 127.0.0.1 --port 4173 --mode single-user
```

访问 `http://127.0.0.1:4173/` 预览，静态构建输出位于 `apps/web/build/`。单人模式配置位于 `tooling/config/env/.env.single-user`，关闭协作、云分享、AI 和统计服务，并将字体随站点打包；保留浏览器本地保存与文件导入导出。

部署时将整个 `apps/web/build/` 目录交给支持 HTTPS 的静态文件服务器托管。首页和 `sw.js` 应使用重新校验缓存策略，带哈希的 `assets/` 文件可长期缓存；更新时保留旧哈希资源，避免已打开的页面加载失败。当前在线站点通过 Caddy 提供 HTTPS，无需画布存储后端。

## 产品页和官网下载

产品页 g.guzilab.com 不在这个仓库里，由维护者另行管理。发布新版本后，维护者会把安装包同步到国内下载镜像 `download.guzilab.com`，并更新产品页上的下载链接；这一步不需要改动本仓库。
