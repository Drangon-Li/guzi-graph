const {
  PLUGIN_PERMISSIONS,
  MAX_SOURCE_BYTES,
  MAX_STORAGE_BYTES,
  MAX_STORE_BYTES,
  MAX_PLUGINS,
} = require("./user-plugin-store.cjs");

const PLUGIN_COMMAND_PERMISSIONS = Object.freeze({
  get_capabilities: "canvas:read",
  list_canvases: "canvas:read",
  read_canvas: "canvas:read",
  create_canvas: "canvas:write",
  apply_operations: "canvas:write",
  control_canvas: "canvas:write",
  read_presentation: "presentation:read",
  create_presentation: "presentation:write",
  update_presentation: "presentation:write",
  control_presentation: "presentation:write",
});
const DEVELOPMENT_COMMANDS = Object.freeze([
  "get_plugin_development_guide",
  "get_plugin_api_schema",
  "list_plugins",
  "get_plugin",
  "validate_plugin",
  "install_plugin",
  "update_plugin",
  "run_plugin_command",
]);

const EXAMPLE_PLUGIN = Object.freeze({
  manifest: Object.freeze({
    id: "handwritten-note",
    name: "手绘便签",
    description: "在当前画布添加一张手写风格便签。",
    version: "1.0.0",
    apiVersion: 1,
    permissions: Object.freeze(["canvas:read", "canvas:write"]),
    commands: Object.freeze([
      Object.freeze({ id: "insert-note", title: "插入手绘便签" }),
    ]),
  }),
  source: `guzi.registerCommand("insert-note", async (args) => {
  const options = args || {};
  const listing = await guzi.call("list_canvases", {});
  let canvas = listing.canvases.find((item) =>
    item.documentId === listing.activeDocumentId &&
    item.kind === "canvas" && item.initialized);
  if (!canvas) {
    canvas = listing.canvases.find((item) =>
      item.kind === "canvas" && item.initialized);
  }
  if (!canvas) {
    canvas = await guzi.call("create_canvas", { title: "便签画布" });
  }
  const scene = await guzi.call("read_canvas", { documentId: canvas.documentId });
  const requestId = "note-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2);
  const result = await guzi.call("apply_operations", {
    documentId: canvas.documentId,
    expectedRevision: scene.revision,
    requestId,
    operations: [{
      type: "create",
      tempId: "new-note",
      element: {
        type: "stickynote",
        x: typeof options.x === "number" ? options.x : 120,
        y: typeof options.y === "number" ? options.y : 120,
        width: 240,
        height: 180,
        label: {
          text: typeof options.text === "string" ? options.text : "记录一个好想法"
        },
        backgroundColor: "#fff3bf"
      }
    }]
  });
  return { documentId: canvas.documentId, result };
});`,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function getPluginApiSchema() {
  return {
    apiVersion: 1,
    packageSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["manifest", "source"],
      properties: {
        manifest: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "description",
            "version",
            "apiVersion",
            "permissions",
            "commands",
          ],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9-]{0,63}$",
              not: { const: "mcp" },
            },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              pattern: "\\S",
            },
            description: { type: "string", maxLength: 2000 },
            version: {
              type: "string",
              maxLength: 100,
              pattern:
                "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
            },
            apiVersion: { const: 1 },
            permissions: {
              type: "array",
              uniqueItems: true,
              maxItems: PLUGIN_PERMISSIONS.length,
              items: { enum: [...PLUGIN_PERMISSIONS] },
            },
            commands: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "title"],
                properties: {
                  id: { type: "string", pattern: "^[a-z][a-z0-9.-]{0,63}$" },
                  title: {
                    type: "string",
                    minLength: 1,
                    maxLength: 100,
                    pattern: "\\S",
                  },
                },
              },
              description: "Command IDs must be unique within this plugin.",
            },
          },
        },
        source: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SOURCE_BYTES,
          pattern: "\\S",
          description:
            "UTF-8 JavaScript source, at most 256 KiB. Parsed as the body of an async function; no execution during validation or installation.",
        },
      },
    },
    sdk: {
      global: "guzi",
      registerCommand: {
        signature: "guzi.registerCommand(commandId, async (args) => JSONValue)",
        description:
          "Register exactly the commands declared in manifest.commands during source initialization. Do not perform canvas work at top level.",
      },
      call: {
        signature: "await guzi.call(command, args)",
        returns: "Unwrapped JSON command result; rejects on host error.",
        description:
          "Only commands in this response's commands map are available; all arguments are JSON objects.",
      },
      storage: {
        permission: "storage",
        get: "await guzi.storage.get(key): JSONValue | null (null when absent)",
        set: "await guzi.storage.set(key, JSONValue): void",
        description:
          "Private per-plugin JSON storage. Keys contain 1–100 characters; __proto__, constructor and prototype are forbidden. JSON must be finite, acyclic and contain no accessors or those prototype keys. Combined encoded storage is at most 64 KiB; persists across updates, removed on uninstall.",
      },
      unavailable: [
        "Node.js",
        "require",
        "process",
        "DOM",
        "filesystem",
        "network",
        "dynamic imports",
        "open/save/export/close commands",
      ],
    },
    commands: Object.fromEntries(
      Object.entries(PLUGIN_COMMAND_PERMISSIONS).map(
        ([command, permission]) => [command, { permission }],
      ),
    ),
    limits: {
      sourceBytes: MAX_SOURCE_BYTES,
      storageBytesPerPlugin: MAX_STORAGE_BYTES,
      totalStoreBytes: MAX_STORE_BYTES,
      installedPlugins: MAX_PLUGINS,
      commandsPerPlugin: 20,
      storageKeyLength: 100,
      jsonMaxDepth: 64,
    },
    example: clone(EXAMPLE_PLUGIN),
  };
}

function getPluginDevelopmentGuide() {
  return `# Guzi 本地 JavaScript 插件开发指南（API 1）

插件是一个 JSON 包 {manifest, source}：manifest 声明名称、权限与用户命令，source 是 JavaScript 字符串。使用本机 MCP 的 get_plugin_api_schema 获取严格 JSON Schema 与画布参数定义；get_capabilities 返回可创建元素、默认样式及操作限制。插件只依赖全局 guzi SDK，不依赖 npm、Node、DOM、文件系统或网络；不支持 require、process、动态 import 或任意文件路径入口。运行实例内的定时器只在实例存活时有效；停用、更新或关闭/重载工作区会终止实例及其定时器，不能依赖它们跨生命周期执行后台工作。

## 从开发到使用

1. 读取本指南和 get_plugin_api_schema；按需求选择最小 permissions 集合。
2. 编写完整 {manifest,source} 包。manifest 只能含 id/name/description/version/apiVersion/permissions/commands，不能添加 entrypoint、path 等字段。id 用小写字母开头，只含小写字母、数字、连字符，最长 64 字符；mcp 是保留 ID。version 为 x.y.z，可加 -prerelease。apiVersion 固定为 1。
3. source 顶层只调用 guzi.registerCommand 注册全部清单命令：guzi.registerCommand("命令 ID", async (args) => { ...; return JSON值; })。命令 ID 用小写字母开头，只含小写字母、数字、点、连字符，最长 64 字符；清单内 1–20 个命令且 ID 唯一，title 为用户可读名称。不要在顶层执行读写画布等工作。
4. 使用 validate_plugin 仅校验包和语法，然后 install_plugin 安装。检查这些 MCP 工具自己的 inputSchema 确认包参数名称；工具不接收源码路径、不读取外部源码、不执行安装脚本。已安装包用 update_plugin 明确更新，install_plugin 不覆盖已有 ID。
5. 安装和每次更新均默认关闭。用户须到 Market 手动启用；MCP 无法代替用户启用。用户在 Market 点击命令，或启用后通过 run_plugin_command 调用清单中的命令。用 list_plugins 查看状态、get_plugin 读取已装包。停用后命令不可运行，未完成的宿主调用会被撤销；已完成的画布变更仍保留，可在画布撤销。更新也会停止旧运行实例，且保留该插件自己的 storage；卸载清除包和自有 storage。

## 权限与 SDK

可用权限只有 canvas:read、canvas:write、presentation:read、presentation:write、storage。读写权限分别声明，写权限不会隐式授予读权限。guzi.call(command, args) 的 args 必须是 JSON 对象，返回 Promise，成功值是命令结果本身，没有 MCP content/structuredContent 包装；失败会 reject，保留错误码供调用者判断。命令处理器的输入与返回值都应是 JSON，避免 undefined、函数、BigInt、循环引用和非有限数字。

命令与权限映射：
${Object.entries(PLUGIN_COMMAND_PERMISSIONS)
  .map(([command, permission]) => `- ${command}: ${permission}`)
  .join("\n")}

宿主只允许这十个命令；保存、导出、打开文件、关闭文档不在 SDK 内。get_capabilities 中可能列出完整工作区能力，并不表示插件获准调用所有能力。

guzi.storage.get(key) / guzi.storage.set(key, value) 必须声明 storage 权限。get 在键不存在时返回 null。键长度为 1–100，禁止 __proto__/constructor/prototype。值必须为有效 JSON；整个插件 storage 编码后共不超过 64 KiB。storage 在同一 ID 更新后保留，卸载后删除，不能访问其他插件的值。例如 await guzi.storage.set("lastText", {text:"想法"}); const saved = await guzi.storage.get("lastText");

## 画布读写约定

list_canvases({}) 返回 {activeDocumentId, canvases, files}；activeDocumentId 可为 null。canvases 为当前打开文档列表，每项含 documentId/path/title/revision/dirty/initialized/kind，kind 为 canvas 或 presentation。files 是工作区文件清单，插件不能通过 open_canvas 打开它们。优先按 activeDocumentId 找 initialized 的 canvas，找不到可选首个已打开画布，均无则 create_canvas({title})。create_canvas 返回新文档描述（包含 documentId 和 revision），创建不会自动保存到文件。

read_canvas({documentId, slideId?, subsceneId?}) 返回目标场景的 revision、elements、appState、files、subscenes 及文档描述。普通画布传 documentId；幻灯片传 documentId + slideId；内嵌画布再加 subsceneId。先读取当前 revision 和现有元素 ID，再执行 apply_operations({documentId, slideId?, subsceneId?, expectedRevision, requestId, operations})。expectedRevision 必须等于本次读取的 revision；requestId 是本次语义写入的唯一非空字符串（最长 200），operations 为 1–500 条操作。

create 操作形如 {type:"create",tempId:"note",element:{type:"stickynote",x:120,y:120,label:{text:"想法"}}}。便签和其他带文字标签的形状使用 label:{text:...}；只有独立 text 元素直接使用 text 字段。tempId 是批次内临时引用，不要填原始 element id/version/customData。支持 create/patch/delete/table/group/ungroup/lock/order/frame/subcanvas/canvas，完整字段和限制查看 get_plugin_api_schema 的 apply_operations 参数或 get_capabilities；现有元素修改先读取 ID。坐标为有限数字；文本、图片 dataURL、行列及操作数量均有上限。锁定对象修改前需明确解锁。默认保留手绘样式：省略 roughness/strokeWidth/fontFamily/roundness 等字段即可采用粗糙线条、圆角、手写字体；patch 省略的样式保留不变。

同一 requestId 和相同参数重试是幂等的；禁止把旧 requestId 用于不同参数。REVISION_CONFLICT 表示画布已发生变化，应重新 read_canvas、重新规划操作并生成新的 requestId，不能仅替换 revision 盲重放。超时或取消后操作可能已经完成，先重新读取确认结果，必要时以相同 requestId 与原始参数重试，不要直接生成新 requestId 重复写入。control_canvas({documentId,slideId?,action,ids?,zoom?}) 支持 undo/redo/select/fit/zoom；undo/redo 也修改 revision，后续写入前重新读取；select 传 ids（空数组清除选择），zoom 范围 0.1–10，不支持 subsceneId。

## 演示文稿

create_presentation({title,sourceDocumentId?}) 新建文稿，可从已打开画布创建；提供 sourceDocumentId 时，除 presentation:write 外还需 canvas:read。read_presentation({documentId}) 返回文稿 revision、幻灯片顺序/ID、当前页及播放状态。update_presentation({documentId,expectedRevision,requestId,operation}) 支持 add/duplicate/rename/move/delete/select/copy_from（参数见 Schema），修订冲突规则与画布一致；copy_from 除 presentation:write 外还需 presentation:read。control_presentation({documentId,action,slideId?}) 支持 start/next/previous/goto/stop/status。读写幻灯片元素仍使用画布命令并带 slideId：read_canvas 同时需要 canvas:read 和 presentation:read；apply_operations/control_canvas 同时需要 canvas:write 和 presentation:write。这些权限须显式声明，不会由另一项权限自动授予。

## 完整示例：插入手绘便签

将以下 JSON 包交给 validate_plugin 和 install_plugin；用户在 Market 启用后运行 insert-note。可传 {"text":"今天的想法","x":120,"y":120}，默认无参数也能工作。示例不捕获修订冲突并自动重试，失败会报告给调用者，由调用者读取最新画布后决定重试。

\`\`\`json
${JSON.stringify(EXAMPLE_PLUGIN, null, 2)}
\`\`\`

源码上限为 256 KiB（UTF-8），总插件存储上限 16 MiB，最多 64 个包。validate/install 只编译语法，不执行源码，也不保证运行时逻辑或注册行为正确；应先在测试画布运行并检查结果。插件启用会运行注册代码，命令仅在用户调用时运行；权限在宿主调用时验证，停用、关闭/重载工作区会撤销正在进行的调用。
`;
}

module.exports = {
  getPluginDevelopmentGuide,
  getPluginApiSchema,
  EXAMPLE_PLUGIN,
  PLUGIN_COMMAND_PERMISSIONS,
  DEVELOPMENT_COMMANDS,
};
