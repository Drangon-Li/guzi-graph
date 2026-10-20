# guzi-graph · Excalidraw Local

基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 的本地 macOS 白板工作区，应用名称为 **Excalidraw Local**。保留手绘画布与 `.excalidraw` 开放格式，加入项目页、多标签、草稿恢复和结构化导出，适合在本地整理图示、研究笔记与流程图。

[下载最新版本](https://github.com/Drangon-Li/guzi-graph/releases/latest) · [反馈问题](https://github.com/Drangon-Li/guzi-graph/issues) · [上游 Excalidraw](https://excalidraw.com)

## 安装

当前提供 **macOS Apple Silicon（arm64）DMG**，暂未提供 Intel Mac、Windows 或 Linux 安装包。

1. 在 [Releases](https://github.com/Drangon-Li/guzi-graph/releases/latest) 下载 `Excalidraw-Local-0.2.0-arm64.dmg`。
2. 打开 DMG，将 **Excalidraw Local.app** 拖入「应用程序」。
3. 从「应用程序」启动；也可用它打开 `.excalidraw` 文件。

当前构建使用 ad-hoc 签名，**尚未经过 Apple 公证（notarization）**。首次启动可能受到 Gatekeeper 限制；确认安装包来源后，可在 macOS「系统设置 → 隐私与安全性」中按系统提示允许打开。

## 本地工作区

- **项目页与多标签**：查看和打开本地画布，在多个文档之间切换；项目页支持预览及文件管理。
- **本地文件与草稿**：通过 `⌘S` 保存 `.excalidraw`，通过 `⌘⇧S` 另存为。编辑会自动写入本地恢复草稿，可从草稿恢复入口找回未保存内容。自动草稿不等于原文件已保存。
- **安全移除**：「删除」只从应用中隐藏画布，原文件保留在原位置，重新打开即可加入项目页；「彻底删除」会将原文件移到 macOS 废纸篓，清空废纸篓前可从中恢复。两种操作首次都会提示，并可分别勾选「不再提示此操作」。尚未恢复的草稿会保留，可独立恢复；当前打开文档的未保存改动仍会询问保存或放弃。
- **中文与英文**：在桌面设置中切换界面语言，也可选择浅色、深色或跟随系统主题。
- **Excalidraw 画布**：支持图形、箭头、文字、自由绘制、图片、分组、画框、缩放和撤销重做。

### 开始绘图

1. 在项目页新建画布（`⌘N`），或打开已有文件（`⌘O`）。
2. 使用顶部工具绘制，在元素属性卡片中调整样式。
3. 按 `⌘S` 选择保存位置。未保存的编辑会进入恢复草稿；仍应显式保存需要长期保留的文件。
4. 通过画布主菜单导出图片、PDF 或结构化信息，或返回项目页管理文件。

### 工具侧栏

工具卡片可保持浮动，也可固定到左侧或右侧；固定后仍以悬浮卡片呈现，可拖动边缘调整宽度。使用同一个按钮展开或收起，收起时选中元素会按需要显示属性卡片，取消选择后自动隐藏。

展开与收起使用非线性缓动动画，顶部工具和底部状态控件保持位置稳定；窗口较窄时回到浮动布局。系统开启减少动态效果时会减少动画。

## 选择导出格式

| 格式 | 适合用途 | 保留内容与边界 |
| --- | --- | --- |
| `.excalidraw` | 保存、备份、继续编辑 | 原生画布格式；需要继续编辑时优先使用 |
| PNG | 文档插图、聊天分享 | 栅格图片；可通过图片导出面板选择相关选项 |
| SVG | 网页插图、缩放展示 | 矢量图形与嵌入的图片资源 |
| PDF | 阅读、打印、分享 | 按整张有效画布边界生成单页，自定义页面尺寸；不按 A4 自动分页 |
| JSON | 程序处理、结构检查 | 节点、连接、原文、几何、绑定、资源与结构关系 |
| Markdown | 阅读、笔记整理 | 按推断阅读顺序组织正文，并提供结构、连接和图片引用 |

### JSON 与 Markdown

从主菜单选择「导出结构化信息…」，可预览 JSON 或阅读视图，并切换是否根据位置推断分区。预览与保存使用打开对话框时的同一画布快照。

结构化导出保留有效元素 ID、原始文字、连接端点、箭头方向及几何信息。画框、分组和文本绑定属于显式结构；矩形包含关系属于可选的位置推断。阅读顺序根据区域、留白与分栏等布局启发式生成，并标记为推断，不表示已理解图中的业务含义。

可用图片另存到导出文件旁的 `guzi-assets-…/` 目录，JSON 和 Markdown 使用相对路径引用。移动或分享导出内容时，请将文件与对应附件目录一起保留。缺失或无法解码的资源会在导出诊断中体现。

**边界**：结构化导出不执行 OCR，不调用 AI 理解图片或推断业务语义，也不是可无损回导的画布格式。复杂布局的阅读顺序和位置推断需要人工复核；原始画布请保留为 `.excalidraw`。

### PDF

PDF 导出先将整张有效画布转为 SVG，再通过 Electron 的打印接口生成 PDF。页面随画布尺寸变化，包含导出边距，并使用当前画布的背景等导出设置；原图中的位图仍是位图。PDF 用于展示，不包含可恢复编辑的 Excalidraw 场景。

## 开发与构建

仓库保留 Excalidraw monorepo 结构；桌面应用位于 [`excalidraw-desktop/`](./excalidraw-desktop)，画布核心位于 [`packages/`](./packages)。

需要 Node.js **22.12.0 或更高版本**和 Yarn **1.22.22**。生成当前 DMG 需要 macOS；首次安装依赖与打包可能需要下载 Electron 和构建工具。

```bash
yarn install --frozen-lockfile

# 启动桌面开发环境（Vite + Electron）
yarn desktop:dev

# 类型检查与桌面测试（Electron 主进程 + renderer）
yarn desktop:typecheck
yarn desktop:test

# 构建桌面前端
yarn desktop:build

# 构建 Apple Silicon DMG
yarn desktop:package
```

桌面构建输出位于 `excalidraw-desktop/dist/`，打包产物位于 `excalidraw-desktop/release/`。需要只生成 `.app` 目录时，可运行：

```bash
npm --prefix excalidraw-desktop run package:dir
```

修改画布核心后，可按受影响范围运行相关测试，例如：

```bash
yarn test:app run packages/excalidraw/tests/toolPanel.test.tsx packages/excalidraw/tests/viewportUI.test.ts
yarn test:app run packages/excalidraw/tests/contextmenu.test.tsx packages/excalidraw/components/dropdownMenu/PersistentMenu.test.tsx
```

本地构建沿用 ad-hoc 签名配置，不会自动完成 Developer ID 签名或 Apple 公证。

## v0.2.0 主要变化

- 整理本地项目页、多标签、草稿恢复和文件操作体验，区分应用内隐藏与移到废纸篓。
- 增加 JSON / Markdown 结构化导出、图片附件、显式与推断结构及阅读预览。
- 增加按画布尺寸生成的单页 PDF 导出。
- 增加左右固定工具侧栏、宽度拖动、同一按钮收放、选中元素自动显示和缓动动画，稳定顶部与底部控件位置。
- 完善中英文桌面界面、菜单与确认提示。
- 修复 macOS `⌘Z` 在画布编辑中的撤销处理，完善桌面菜单及键盘交互。

## 上游与许可

本项目基于开源 [Excalidraw](https://github.com/excalidraw/excalidraw)，遵循 [MIT License](./LICENSE)，保留上游版权与许可声明。感谢 Excalidraw 及其贡献者。

上游资料：[使用 Excalidraw](https://excalidraw.com) · [组件文档](https://docs.excalidraw.com) · [开发指南](https://docs.excalidraw.com/docs/introduction/development)。上游网站提供的在线协作、分享等功能不代表本地桌面应用提供相同服务。
