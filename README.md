# Excalidraw-Guzi

**Excalidraw-Guzi（谷子白板）** 是基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 二次开发的**免费开源白板**，提供本地桌面版和免安装的单人在线版。用简洁的面板和顺手的快捷键，把想法、论文笔记和流程图整理成自己的图片知识库。保留手绘画布与 `.excalidraw` 文件格式，并加入可编辑表格、富文本和子画布；桌面版还提供本地工作区、多页演示文稿和自定义样式预设。

本项目使用 [MIT 开源许可](./LICENSE)。感谢 Excalidraw 团队与所有贡献者提供优秀的画布基础。

[在线使用](https://graph.guzilab.com/) · [桌面版下载与版本记录](https://github.com/Drangon-Li/guzi-graph/releases) · [反馈问题](https://github.com/Drangon-Li/guzi-graph/issues) · [上游仓库](https://github.com/excalidraw/excalidraw)

## 在线使用

打开 **[graph.guzilab.com](https://graph.guzilab.com/)** 即可开始绘图，无需安装或注册。在线版供每个人独立使用，支持图形、文字、图片、表格和本地素材库；选中文字后，可通过悬浮工具栏调整粗体、斜体、下划线、文字颜色和底色。

1. 直接在画布上绘图，或从左上角菜单选择「打开」，导入 `.excalidraw` 文件。
2. 内容会自动保存在当前浏览器中，刷新或再次访问同一网址可继续编辑。
3. 通过「保存到… → 保存为文件」导出 `.excalidraw` 备份，或通过「导出图片…」保存 PNG / SVG。画布文件也可在谷子白板桌面版中打开。

**内容保存在当前设备的浏览器中，不会跨浏览器或跨设备同步。** 清理网站数据或关闭无痕窗口可能丢失内容，请定期导出文件备份。在线版不提供多人协作、云分享或 AI 服务。

本地工作区、多页演示文稿、Market、内置 MCP、PDF 和结构化信息导出等功能请使用桌面版。下面的功能与使用指南主要介绍桌面版。

## 72 秒认识谷子白板

![谷子白板：把论文，画成自己的知识；简单面板、便捷快捷键、免费开源](./docs/images/guzi-promo-cover-v2.png)

看完 _Attention Is All You Need_，怎样把 Transformer 画成自己的知识？这段宣传片结合双人动画与 **macOS 实机操作**，演示画框与连线、逐字输入、快捷键、表格构建 Causal Mask，以及用子画布展开 Q、K、V 笔记。

https://github.com/user-attachments/assets/261fd3b2-ab8a-4186-8e3d-64b3bbf11995

[下载原版（1080p，约 72 秒）](https://github.com/Drangon-Li/guzi-graph/releases/download/v0.3.0/Guzi-Final-Full.mp4) · [中文字幕](https://github.com/Drangon-Li/guzi-graph/releases/download/v0.3.0/Guzi-Promo-zh.srt) · [可编辑 Transformer 示例](./examples/guzi/transformer-attention.excalidraw) · [视频制作与素材署名](./docs/promo-video.md)

视频与封面为非官方同人演示，视频使用社区合成配音；第三方角色、模型与声音素材不属于本仓库 MIT 许可的授权范围。

## 软件截图

![Excalidraw-Guzi 画布与项目规划示例](./docs/images/canvas-overview.png)

![Excalidraw-Guzi 桌面设置](./docs/images/settings.png)

## 主要功能

- **手绘画布**：图形、箭头、自由绘制、文字、图片、便签、分组与画框，支持缩放和撤销重做。
- **本地工作区**：项目页、文件预览、多标签和文件夹分类；可设置默认画布目录，在多个文档之间切换。
- **表格**：插入与编辑表格，增删行列、合并或拆分单元格，调整行高、列宽、文字与边框样式。
- **富文本**：文字支持粗体、斜体、下划线、底色、有序与无序列表、缩进、行间距和段间距。
- **子画布**：将便签转为子画布图钉，进入独立画布展开细节，通过导航返回上层；子画布与主画布保存在同一文件中。
- **自定义偏好**：设置默认字体、字号与颜色快捷项，可添加本机字体；配置绘图样式预设及其快捷键，选中元素时应用样式，未选中时切换绘图工具。
- **桌面体验**：中英文界面、浅色／深色／跟随系统主题，支持调整工具提示和选区悬浮工具栏。
- **演示文稿**：多页手绘幻灯片、拖拽排序与放映；底部缩略图跟随界面主题，支持保存、重开和整份 PDF 导出。
- **Market 与 MCP**：在设置中启停内置 MCP，让 Codex 等客户端创建、编辑、保存和导出画布与演示文稿；通过 MCP 开发自己的插件，再在 Market 导入、启用或停用，默认采用手绘风格。
- **图片复制**：复制选中元素后，粘贴到聊天或文档时呈现图片，在画板内部粘贴仍可编辑，并保留关联子画布。
- **多种导出**：PNG、SVG、PDF，以及带图片附件的 JSON / Markdown 结构化导出。

## 桌面版安装

已发布的 [v0.8.0](https://github.com/Drangon-Li/guzi-graph/releases/tag/v0.8.0) 提供 **macOS Apple Silicon（arm64）** 和 **Windows 10 / 11 x64** 安装包，并提供 Windows 免安装版本。暂未提供 Intel Mac 或 Linux 安装包。

1. 在 [v0.8.0 Releases](https://github.com/Drangon-Li/guzi-graph/releases/tag/v0.8.0) 下载 `Excalidraw-Guzi-0.8.0-arm64.dmg`。
2. 打开 DMG，将 **Excalidraw-Guzi.app** 拖入「应用程序」。
3. 从「应用程序」启动，也可用它打开 `.excalidraw` 文件。

macOS 安装包使用 ad-hoc 签名，**尚未经过 Apple 公证（notarization）**。首次启动可能受到 Gatekeeper 限制；确认安装包来源后，可在 macOS「系统设置 → 隐私与安全性」中按系统提示允许打开。

更新应用后，macOS 可能再次请求桌面等文件夹访问权限；允许后工作区会继续加载。同一个已授权版本正常重开无需重复授权。

Windows 用户可在同一发布页下载 `Excalidraw-Guzi-0.8.0-win-x64.exe`，运行后按安装向导选择目录；也可下载 `Excalidraw-Guzi-0.8.0-win-x64-unpacked.zip`，完整解压后运行其中的 `Excalidraw-Guzi.exe`。Windows 安装包尚未使用代码签名证书，系统可能显示“未知发布者”。正式渠道沿用 `.excalidraw` 和 `.guzi-presentation` 文件关联。Windows 安装、升级、卸载及文件关联仍需在真实 Windows 10 / 11 上验收；具体步骤见 [Windows 开发与验收](./docs/windows-desktop.md)。

首次安装 v0.8.0 后，后续版本可通过应用内更新安装；Windows 免安装 ZIP 版本除外。

## 连接 MCP

1. 打开项目页左侧的 **设置 → 内置 MCP**，启用 MCP 服务。
2. 使用设置中提供的地址和客户端配置连接 Codex 或其他支持 Streamable HTTP 的 MCP 客户端。命令行客户端需按配置设置 `GUZI_MCP_TOKEN`；令牌可在设置中查看和复制，请勿提交到仓库。
3. 保持谷子白板运行，即可让客户端创建画布、绘图、操作多页演示文稿、放映、导出和保存。新文件保存到设置的默认工作目录，已有文件沿用原位置。

MCP 服务仅监听本机回环地址，并校验访问令牌；关闭设置中的开关后会停止服务。连接后可通过 `get_plugin_development_guide` 和 `get_plugin_api_schema` 获取开发指南与接口定义，校验并安装自己的 JavaScript 插件包。也可以在 Market 导入 `.json` 插件包；新安装或更新的插件默认停用，需要在 Market 手动启用。

## 开始使用与经典示例

1. 在项目页新建画布（macOS `⌘N` / Windows `Ctrl+N`），或打开已有文件（`⌘O` / `Ctrl+O`）。
2. 使用顶部工具绘图，选中元素后调整属性；在桌面设置中配置字体、颜色与样式预设。
3. 使用 `⌘S` / `Ctrl+S` 保存，或使用 `⌘⇧S` / `Ctrl+Shift+S` 另存为 `.excalidraw` 文件。
4. 从画布主菜单导出图片、PDF 或结构化信息，返回项目页管理文件。

保存下面的 `.excalidraw` 文件，用 Excalidraw-Guzi 打开即可继续编辑：

- [项目规划](./examples/guzi/project-planning.excalidraw)：流程图、任务表格与分层整理。
- [Transformer 与 Attention](./examples/guzi/transformer-attention.excalidraw)：Encoder / Decoder 架构、参数表与 QKV 子画布，来自宣传片的实机演示。
- [Encoder / Decoder 入门](./examples/guzi/encoder-decoder.excalidraw)：宣传片中通过复制、连线与改色创建的简洁示例。
- [Transformer Architecture](./examples/guzi/transformer-architecture.excalidraw)：随桌面应用内置，可从项目页的「示例库」打开，包含架构图和子画布笔记。打开后编辑的是未保存副本，保存时选择自己的文件位置。

编辑会自动写入本地恢复草稿，可从草稿恢复入口找回未保存内容。**自动草稿不等于原文件已保存**，需要长期保留的内容仍应显式保存。

项目页的「删除」只从应用中隐藏画布，原文件保留，重新打开即可加入项目页；「彻底删除」会将原文件移到系统废纸篓或回收站。两种操作首次都会提示，并可分别选择不再提示。尚未恢复的草稿会保留；当前文档的未保存改动仍会询问保存或放弃。

## 选择导出格式

| 格式 | 适合用途 | 保留内容与边界 |
| --- | --- | --- |
| `.excalidraw` | 保存、备份、继续编辑 | 保留本应用的画布、子画布与图片资源；继续编辑时优先使用 |
| PNG | 文档插图、聊天分享 | 栅格图片，可在导出面板调整相关选项 |
| SVG | 网页插图、缩放展示 | 矢量图形与嵌入的图片资源 |
| PDF | 阅读、打印、分享 | 当前画布单页，或选择包含子画布、每个画布分别成页；页面按画布尺寸生成，不按 A4 自动分页 |
| JSON | 程序处理、结构检查 | 节点、连接、原文、几何、绑定、资源与结构关系，包含关联的子画布 |
| Markdown | 阅读、笔记整理 | 按推断阅读顺序组织正文，提供结构、连接、子画布和图片引用 |

### JSON 与 Markdown

从主菜单选择「导出结构化信息…」，可预览 JSON 或阅读视图，并切换是否根据位置推断分区。预览与保存使用打开对话框时的同一画布快照。

结构化导出保留有效元素 ID、原始文字、连接端点、箭头方向及几何信息。画框、分组和文本绑定属于显式结构；矩形包含关系属于可选的位置推断。阅读顺序依据布局启发式生成，并标记为推断，不表示已理解图中的业务含义。

可用图片另存到导出文件旁的 `guzi-assets-…/` 目录，JSON 和 Markdown 使用相对路径引用。移动或分享时，请将导出文件与附件目录一起保留。缺失或无法解码的资源会在导出诊断中体现。

**边界**：结构化导出不执行 OCR，不调用 AI 理解图片或推断业务语义，也不是可无损回导的画布格式。复杂布局的阅读顺序和位置推断需要人工复核。新增表格、富文本、子画布等能力由本项目实现，其他 Excalidraw 客户端不保证完整呈现；请保留原始 `.excalidraw` 文件，并使用本应用继续编辑。

### PDF

PDF 导出先将画布转为 SVG，再通过 Electron 的打印接口生成 PDF。页面包含导出边距，并使用画布背景等导出设置；原图中的位图仍是位图。选择「导出 PDF（包含子画布）…」时，关联的非空子画布会分别追加为页面。PDF 用于展示，不包含可恢复编辑的 Excalidraw 场景。

## 开发与构建

仓库采用 monorepo 结构；桌面应用位于 [`apps/desktop/`](./apps/desktop)，网页应用位于 [`apps/web/`](./apps/web)，画布核心位于 [`packages/`](./packages)。桌面代码按主进程、preload、共享契约和 renderer 分层；renderer 按工作区、编辑器、项目、设置、导出和示例归类。

共享环境变量、测试配置和构建脚本位于 [`tooling/`](./tooling)，Web 静态资源位于 `apps/web/public/`，Docker 与 Firebase 部署配置位于 [`apps/web/deploy/`](./apps/web/deploy)。开发文档集中在 [`docs/development/`](./docs/development)，用户画布示例与 SDK 集成示例保留在 [`examples/`](./examples)。本地环境覆盖文件放在 `tooling/config/env/.env.local` 或对应模式的 `.env.*.local` 中。

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

`.github/workflows/desktop-windows.yml` 在 Windows runner 上执行检查、打包和 smoke，只上传 Actions artifact，不发布 Release。CI 与真实 Windows 10 / 11 验收的覆盖边界、测试渠道命令及签名说明见 [Windows 开发与验收](./docs/windows-desktop.md)。

修改画布核心后，按受影响范围运行相关测试，例如：

```bash
yarn test:app run packages/excalidraw/tests/table.test.tsx packages/excalidraw/tests/subcanvas.test.tsx
yarn test:app run packages/excalidraw/features/rich-text/editor.test.tsx
```

本地构建沿用 ad-hoc 签名配置，不会自动完成 Developer ID 签名或 Apple 公证。

### 构建单人网页版

安装仓库依赖后，在仓库根目录运行：

```bash
# 构建与在线站点相同的单人模式
yarn --cwd apps/web build:single-user

# 在本机预览构建结果
yarn --cwd apps/web vite preview --host 127.0.0.1 --port 4173 --mode single-user
```

访问 `http://127.0.0.1:4173/` 预览，静态构建输出位于 `apps/web/build/`。单人模式配置位于 `tooling/config/env/.env.single-user`，关闭协作、云分享、AI 和统计服务，并将字体随站点打包；保留浏览器本地保存与文件导入导出。

部署时将整个 `apps/web/build/` 目录交给支持 HTTPS 的静态文件服务器托管。首页和 `sw.js` 应使用重新校验缓存策略，带哈希的 `assets/` 文件可长期缓存；更新时保留旧哈希资源，避免已打开的页面加载失败。当前在线站点通过 Caddy 提供 HTTPS，无需画布存储后端。

## 上游与许可

本项目基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 修改，遵循 [MIT License](./LICENSE)，保留上游版权与许可声明。Excalidraw-Guzi 是独立修改版本；感谢并致敬 Excalidraw 团队与开源社区。

上游资料：[使用 Excalidraw](https://excalidraw.com) · [组件文档](https://docs.excalidraw.com) · [开发指南](https://docs.excalidraw.com/docs/introduction/development)。上游网站提供的在线协作、分享等功能不代表本项目的桌面版或单人在线版提供相同服务。
