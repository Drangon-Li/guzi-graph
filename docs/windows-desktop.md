# Windows 开发与验收

本分支的目标为 Windows 10 / 11 **x64**，安装包采用 electron-builder 的 NSIS 向导。macOS Apple Silicon 的 DMG、开发启动和原有打包入口继续保留。Windows ARM64、32 位及 Linux 不在本次构建范围。

仓库中的构建配置和自动化测试不能代替真实 Windows 10 / 11 安装验收。本文是操作与验收说明，不代表安装、文件关联、字体、剪贴板或 CI 已经通过。

## 开发与构建

在仓库根目录使用 Node.js 22.12.0 或更高版本，以及 Yarn 1.22.22。Electron 44.7.2、electron-builder 26.15.3 和 Playwright 1.64.1 保持现有版本。

```powershell
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
yarn desktop:dev
```

桌面开发脚本直接通过 Node 启动 Vite 和 Electron，不需要 Bash 或额外的 shell。以下命令从仓库根目录执行，PowerShell、Windows 命令提示符和 macOS shell 均可识别：

```powershell
yarn desktop:typecheck
yarn desktop:test
yarn desktop:build
yarn desktop:package:win:dir
yarn desktop:test:smoke --executable "apps/desktop/release/win-unpacked/Excalidraw-Guzi.exe"
yarn desktop:package:win
```

输出目录：

| 产物 | 路径 |
| --- | --- |
| 前端构建 | `apps/desktop/dist/` |
| Windows x64 应用目录 | `apps/desktop/release/win-unpacked/` |
| Windows NSIS 安装包 | `apps/desktop/release/Excalidraw-Guzi-<version>-win-x64.exe` |
| macOS arm64 DMG | `apps/desktop/release/Excalidraw-Guzi-<version>-arm64.dmg` |
| smoke 截图与报告 | `output/playwright/desktop-smoke/` |

`win-unpacked` 目录需要整体保留，不能只复制其中的 `.exe`。`package:win` 和 `package:win:dir` 会先构建前端；CI 在前端构建后直接调用 electron-builder，避免重复构建。打包命令显式使用 `--publish never`。

建议在 Windows x64 机器上生成并验收 Windows 包。跨平台构建受宿主、目标架构、工具下载和原生依赖约束，macOS 上生成 `.exe` 不能证明 Windows 上能够正常安装运行。macOS DMG 仍使用 `yarn desktop:package` 或 `npm --prefix apps/desktop run package:dir`。

## 隔离测试渠道

测试和 Dev PPT 渠道保留独立 appId、产品名称、用户配置与输出目录，并继续不注册文件关联，避免覆盖正式渠道的默认打开程序。渠道构建通过 Node 设置环境变量；electron-builder 自行获取目标平台的 Electron，不复用宿主机的 Electron `dist`。

```powershell
# Windows 测试渠道安装包 / unpacked
npm --prefix apps/desktop run package:win:test
npm --prefix apps/desktop run package:win:test:dir

# Windows Dev PPT 渠道安装包
npm --prefix apps/desktop run package:win:dev-ppt

# macOS 原有隔离渠道入口
npm --prefix apps/desktop run package:test
npm --prefix apps/desktop run package:dev-ppt
```

Windows 渠道安装包名分别为 `Excalidraw-Guzi-test-<version>-win-x64.exe` 和 `Excalidraw-Guzi-dev-ppt-<version>-win-x64.exe`，位于 `release/test/` 和 `release/dev-ppt/`。

## 安装与文件关联

正式渠道安装器默认按当前用户安装，提供安装目录选择、桌面快捷方式和开始菜单入口。NSIS 沿用全局 `.excalidraw`、`.guzi-presentation` 两种关联配置；测试渠道不注册。Windows 的默认应用选择仍由系统管理，必要时在「设置 → 应用 → 默认应用」中选择 Excalidraw-Guzi。

当前 Windows 配置没有提供代码签名证书。未签名测试安装包可能受到 SmartScreen 或组织策略限制；是否签名应在正式分发前单独确认。本配置保留 electron-builder 的正常可执行文件资源编辑和签名能力。卸载配置不会主动删除用户应用数据；仍须在实机确认升级与卸载行为。

## CI 覆盖

[Windows workflow](../.github/workflows/desktop-windows.yml) 使用 Windows runner、Node 22 和 Yarn 1.22.22，依次执行 frozen-lockfile 安装、根目录与桌面类型检查、主进程与 preload 测试、打包配置测试、全仓 Vitest、前端构建、x64 unpacked 打包、Playwright smoke 和 NSIS 打包。全仓 Vitest 已覆盖桌面 renderer，并排除交由 Node 运行的主进程、preload 和脚本测试，避免重复执行。PowerShell 中每个命令使用独立步骤，前一步失败不会被后一步的成功覆盖。成功后上传安装包及 unpacked 目录；smoke 诊断在可用时也会上传。该 workflow 没有发布 Release 的步骤，也没有写仓库权限。

基础 smoke 直接使用仓库已有 MCP SDK 连接应用内置服务，通过 Playwright 启动打包的 Electron。它在 `os.tmpdir()` 下创建带中文及空格路径的独立工作区与用户配置，创建包含中文、图片和手绘元素的画布，保存 `.excalidraw` 和 `.guzi-presentation`，退出并重启应用，再读取两个文件确认内容保留。脚本直接读取 MCP 响应中的导出字节：PNG 验证可解码及场景色块，SVG 验证中文、图片与绘制路径；演示文稿 PDF 检查文件结构并标注 `structure_only`。重启后，两类项目缩略图还须通过像素检查，不能仅靠尺寸正常通过。脚本只管理本次启动的进程，不依赖系统 `ps`，不要求安装 Codex 或 Claude 客户端。

此 smoke 覆盖打包应用启动、内置服务、文件持久化、PNG/SVG 导出内容及重启后的文件重开与预览。PDF 仅验证结构，不代表已验证页面视觉内容。它不运行 NSIS 安装器，不验证 Windows 注册表中的关联、资源管理器双击、系统字体枚举、图片剪贴板、打印机或真实 Windows 10 / 11 设备行为。`windows-latest` 的实际镜像也不能同时代表 Windows 10 和 Windows 11。

## Windows 10 / 11 实机验收

分别在干净或可回滚的 Windows 10 x64、Windows 11 x64 环境执行，并记录系统版本、安装包版本与 hash、通过或失败的步骤及截图。以下项目在完成实测前均为待验收：

| 项目 | 操作与预期 |
| --- | --- |
| 安装及快捷方式 | 运行正式渠道 NSIS，选择含空格和中文的安装路径；桌面、开始菜单与安装目录启动均能进入项目页 |
| 文档保存重开 | 分别新建画布与演示文稿，在中文工作目录中保存，退出后重开，内容与图片保留 |
| 文件关联 | 应用关闭时分别双击两种扩展名，打开正确文档；应用已运行时再次双击，复用现有实例；含空格、中文路径均可打开 |
| 文件打开参数 | 多选文档后使用「打开方式」，确认两种格式均能打开；不把可执行程序路径或其他启动参数识别为文档 |
| 快捷键与菜单 | `Ctrl+N/O/S`、`Ctrl+Shift+S`、撤销重做、复制粘贴、全选、文本编辑及菜单提示符合 Windows 使用习惯 |
| 字体 | 字体列表可加载；选择本机中文字体后显示正常，保存重开仍可渲染；不访问 macOS 字体目录 |
| 图片剪贴板 | 选中元素复制后粘贴到系统画图或文档软件为图片，应用内粘贴仍可编辑；带图片与子画布的场景分别检查 |
| 窗口 | 无 macOS 红黄绿按钮留白；标题栏拖动、最小化、最大化、还原及关闭正常，未保存文档关闭时正确提示 |
| 删除与恢复 | 项目页隐藏不删除原文件；彻底删除进入 Windows 回收站；恢复草稿可读，不覆盖已保存文件 |
| 隔离渠道 | 正式版与测试版并存，配置与工作区记录互不覆盖；测试版不抢占默认文件关联 |
| 升级与卸载 | 更新安装后旧文档与设置可用；卸载移除快捷方式与程序，用户文档保留；在明确允许的环境中检查配置保留与关联清理 |
| 导出与 MCP | PNG/SVG/PDF 导出可打开；内置 MCP 能启停并保存修改，无需外部 AI 客户端作为启动条件 |

## 最新功能集成与本地验证（2026-10-25）

Windows 分支 `codex/windows-desktop` 已基于远端 `main` 的 `3c8911147e3e05b236958b6ed96c24be2ca2ccd1`（Merge upstream Excalidraw updates through 2026-10-23）更新。新导出接口、跨文档渲染环境、箭头及懒加载等主线改动随基线保留；桌面 PDF 导出额外补齐了所属文档的传递，Windows 路径、快捷键和安装器适配继续保留。

在 macOS arm64、Node.js 24.14.0、Yarn 1.22.22 环境完成以下检查。本节记录推送前的本地验证；Windows CI 的运行结果需单独查看。

| 检查 | 结果 |
| --- | --- |
| 根目录与桌面类型检查、生产前端构建 | 通过 |
| 全仓 Vitest（含桌面渲染层及更新的核心） | 198 个文件通过，3,227 项通过、47 项跳过、1 项待实现 |
| 主进程与 preload 测试 | 211 / 211 通过 |
| 打包配置与图标测试 | 3 / 3 通过；合计 3,441 项通过 |
| Windows x64 NSIS 交叉打包 | 成功，生成 `Excalidraw-Guzi-0.7.2-win-x64.exe` |
| Windows 与 macOS 打包内容核验 | 两份 app.asar 一致；各核对 355 个运行时代码与前端文件，均与工作区一致；Windows 内部应用为 AMD64 |
| macOS arm64 应用打包 | 成功 |
| macOS 开发运行与打包应用 smoke | 均通过；保存与重启重开、中文及图片 PNG/SVG 导出、两类文档缩略图内容通过，演示文稿 PDF 仅检查结构 |
| 根目录 ESLint、格式检查、修改脚本检查、Git 空白检查 | 通过 |
| Windows 原生 CI、Windows 10 / 11 安装与系统集成 | 尚未执行 |

增强后的打包 smoke 首次在重启阶段失败：脚本在工作区恢复完成前点击返回项目页，存在随后被旧活动页覆盖的时序问题。脚本现等待现有加载完成状态和项目页可见，并断言隔离配置路径正确；修改后开发版与打包版均通过。首次失败的错误信息、截图和报告保留供排查。

当前 Windows 安装包大小为 129,172,022 字节，SHA-256 为 `b11658b19b44fa1c31e24d3111fae1da5b957223363f9087fca462fa2a91ac1e`。这是未签名测试包；本记录不代表已完成 Windows 安装与运行验收。

最新源文件清单、日志和报告保存在忽略的 `output/windows-validation/main-sync-3c891114/` 中，`output/windows-validation/report.json` 指向本次结果。此前基于 `15cce41e` 的改动、安装包与验证报告已另存至 `output/windows-validation/before-main-sync-20261025-130843/`；Git stash `e0636c3b583cfefb306ac7d919b0d8d2b0002dd0` 也保留了集成前的源码改动。以上生成文件不随源码发布。

## 构建依据

- [electron-builder v26 NSIS 配置](https://www.electron.build/v26/docs/nsis/)
- [electron-builder v26 跨平台构建限制](https://www.electron.build/v26/docs/features/multi-platform-build/)
- [electron-react-boilerplate CI 示例](https://github.com/electron-react-boilerplate/electron-react-boilerplate/blob/main/.github/workflows/test.yml)，仅用于参考 Windows 测试组织，不沿用发布行为。
