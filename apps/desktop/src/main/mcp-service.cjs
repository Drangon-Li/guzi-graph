const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { McpServer, createMcpHandler } = require("@modelcontextprotocol/server");
const {
  localhostHostValidation,
  localhostOriginValidation,
} = require("@modelcontextprotocol/node");
const { z } = require("zod/v4");
const { createRequestListener } = require("./mcp-http.cjs");
const { MAX_MESSAGE_BYTES } = require("./plugins.cjs");

const HAND_DRAWN_STYLE_INSTRUCTIONS =
  'Use Guzi Canvas\'s hand-drawn style by default: rough lines, rounded corners, and handwritten text. Prefer omitting style fields on create to use the defaults: roughness:1, strokeWidth:2, fillStyle:"solid", fontFamily:5 (Excalifont); rectangle roundness:{type:3}, diamond/arrow/line roundness:{type:2}, ellipse/text roundness:null. Only override this style when the user explicitly requests another style. Do not independently choose roughness:0, sans-serif fonts, or sharp corners (roundness:null on shapes/lines that support rounding). A patch preserves every style field that it omits; do not restyle existing elements unless the user requests it.';

const canvasID = z.string().min(1).max(100);
const coordinate = z.number().min(-1e7).max(1e7);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestID = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(200);
const ids = z.array(canvasID).min(1).max(500);
const richText = z
  .object({
    version: z.literal(1),
    paragraphs: z
      .array(
        z
          .object({
            runs: z
              .array(
                z
                  .object({
                    text: z.string().max(100000),
                    bold: z.boolean().optional(),
                    italic: z.boolean().optional(),
                    underline: z.boolean().optional(),
                    background: z.string().optional(),
                  })
                  .strict(),
              )
              .max(1000),
            list: z
              .object({
                kind: z.enum(["ordered", "bullet"]),
                indent: z.number().int().min(0).max(8),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
const tableCell = z
  .object({
    row: z.number().int().min(0).max(99),
    column: z.number().int().min(0).max(99),
    text: z.string().max(100000).optional(),
    richText: richText.nullable().optional(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().min(0).optional(),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
    fontSize: z.number().positive().max(512).optional(),
    fontFamily: z.number().int().optional(),
    paragraphSpacing: z.number().min(0).max(1000).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();
const tableSizes = z.array(z.number().min(1).max(100000)).min(1).max(100);
const tableRange = z
  .object({
    row: z.number().int().min(0).max(99),
    column: z.number().int().min(0).max(99),
    endRow: z.number().int().min(0).max(99),
    endColumn: z.number().int().min(0).max(99),
  })
  .strict();
const sceneTarget = {
  documentId: canvasID,
  slideId: canvasID.optional(),
  subsceneId: canvasID.optional(),
};
const pluginID = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const pluginCommandID = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const pluginPackage = z
  .object({
    manifest: z
      .object({
        id: pluginID,
        name: z.string().trim().min(1).max(100),
        description: z.string().max(2000),
        version: z.string().min(1).max(100),
        apiVersion: z.literal(1),
        permissions: z
          .array(
            z.enum([
              "canvas:read",
              "canvas:write",
              "presentation:read",
              "presentation:write",
              "storage",
            ]),
          )
          .max(5),
        commands: z
          .array(
            z
              .object({
                id: pluginCommandID,
                title: z.string().trim().min(1).max(100),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    source: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();
const toolSchemas = {
  get_plugin_development_guide: z.object({}).strict(),
  get_plugin_api_schema: z.object({}).strict(),
  list_plugins: z.object({}).strict(),
  get_plugin: z.object({ id: pluginID }).strict(),
  validate_plugin: z.object({ plugin: pluginPackage }).strict(),
  install_plugin: z.object({ plugin: pluginPackage }).strict(),
  update_plugin: z.object({ plugin: pluginPackage }).strict(),
  run_plugin_command: z
    .object({
      id: pluginID,
      commandId: pluginCommandID,
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  get_capabilities: z.object({}).strict(),
  list_canvases: z.object({}).strict(),
  create_canvas: z
    .object({ title: z.string().trim().min(1).max(200) })
    .strict(),
  open_canvas: z.object({ path: z.string().min(1).max(4096) }).strict(),
  close_document: z.object({ documentId: canvasID }).strict(),
  control_canvas: z
    .object({
      documentId: canvasID,
      slideId: canvasID.optional(),
      action: z.enum(["undo", "redo", "select", "fit", "zoom"]),
      ids: z.array(canvasID).max(500).optional(),
      zoom: z.number().min(0.1).max(10).optional(),
    })
    .strict(),
  read_canvas: z.object(sceneTarget).strict(),
  apply_operations: z
    .object({
      ...sceneTarget,
      expectedRevision: revision,
      requestId: requestID,
      operations: z
        .array(
          z.discriminatedUnion("type", [
            z
              .object({
                type: z.literal("create"),
                tempId: z.string().min(1).max(200).optional(),
                element: z
                  .object({
                    type: z.enum([
                      "rectangle",
                      "ellipse",
                      "diamond",
                      "text",
                      "arrow",
                      "line",
                      "table",
                      "image",
                      "freedraw",
                      "frame",
                      "stickynote",
                      "subcanvas",
                    ]),
                    x: coordinate,
                    y: coordinate,
                    width: z.number().min(0).max(1e7).optional(),
                    height: z.number().min(0).max(1e7).optional(),
                    rows: tableSizes.optional(),
                    columns: tableSizes.optional(),
                    cells: z.array(tableCell).max(2500).optional(),
                    richText: richText.optional(),
                    paragraphSpacing: z.number().min(0).max(1000).optional(),
                    fileId: canvasID.optional(),
                    file: z
                      .object({
                        mimeType: z.enum([
                          "image/png",
                          "image/jpeg",
                          "image/gif",
                          "image/webp",
                        ]),
                        dataURL: z.string().min(1).max(1048576),
                      })
                      .strict()
                      .optional(),
                    scale: z
                      .tuple([
                        z.union([z.literal(1), z.literal(-1)]),
                        z.union([z.literal(1), z.literal(-1)]),
                      ])
                      .optional(),
                    points: z
                      .array(z.tuple([coordinate, coordinate]))
                      .min(2)
                      .max(1000)
                      .optional(),
                    pressures: z
                      .array(z.number().min(0).max(1))
                      .min(2)
                      .max(1000)
                      .optional(),
                    simulatePressure: z.boolean().optional(),
                    name: z.string().nullable().optional(),
                    title: title.optional(),
                  })
                  .catchall(z.unknown()),
              })
              .strict(),
            z
              .object({
                type: z.literal("patch"),
                id: canvasID,
                patch: z.record(z.string(), z.unknown()),
              })
              .strict(),
            z.object({ type: z.literal("delete"), id: canvasID }).strict(),
            z
              .object({
                type: z.literal("table"),
                id: canvasID,
                cells: z.array(tableCell).max(2500).optional(),
                rows: tableSizes.optional(),
                columns: tableSizes.optional(),
                merge: tableRange.optional(),
                split: tableRange.optional(),
              })
              .strict(),
            z.object({ type: z.literal("group"), ids }).strict(),
            z.object({ type: z.literal("ungroup"), ids }).strict(),
            z
              .object({ type: z.literal("lock"), ids, locked: z.boolean() })
              .strict(),
            z
              .object({
                type: z.literal("order"),
                ids,
                position: z.enum(["front", "back", "forward", "backward"]),
              })
              .strict(),
            z
              .object({
                type: z.literal("frame"),
                ids,
                frameId: canvasID.nullable(),
              })
              .strict(),
            z
              .object({ type: z.literal("subcanvas"), id: canvasID, title })
              .strict(),
            z
              .object({
                type: z.literal("canvas"),
                patch: z
                  .object({
                    viewBackgroundColor: z.string().optional(),
                    gridModeEnabled: z.boolean().optional(),
                    gridSize: z.number().int().min(1).max(1000).optional(),
                    objectsSnapModeEnabled: z.boolean().optional(),
                  })
                  .strict(),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(500),
    })
    .strict(),
  export_canvas: z
    .object({ ...sceneTarget, format: z.enum(["png", "svg"]) })
    .strict(),
  save_canvas: z.object({ documentId: canvasID }).strict(),
  create_presentation: z
    .object({ title, sourceDocumentId: canvasID.optional() })
    .strict(),
  read_presentation: z.object({ documentId: canvasID }).strict(),
  update_presentation: z
    .object({
      documentId: canvasID,
      expectedRevision: revision,
      requestId: requestID,
      operation: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("add"),
            title: title.optional(),
            afterSlideId: canvasID.optional(),
          })
          .strict(),
        z.object({ type: z.literal("duplicate"), slideId: canvasID }).strict(),
        z
          .object({ type: z.literal("rename"), slideId: canvasID, title })
          .strict(),
        z
          .object({
            type: z.literal("move"),
            slideId: canvasID,
            toIndex: z.number().int().min(0),
          })
          .strict(),
        z.object({ type: z.literal("delete"), slideId: canvasID }).strict(),
        z.object({ type: z.literal("select"), slideId: canvasID }).strict(),
        z
          .object({
            type: z.literal("copy_from"),
            sourceDocumentId: canvasID,
            sourceSlideId: canvasID,
          })
          .strict(),
      ]),
    })
    .strict(),
  control_presentation: z
    .object({
      documentId: canvasID,
      action: z.enum(["start", "next", "previous", "goto", "stop", "status"]),
      slideId: canvasID.optional(),
    })
    .strict(),
  export_presentation: z
    .object({
      documentId: canvasID,
      format: z.enum(["png", "svg", "pdf"]),
      slideId: canvasID.optional(),
    })
    .strict(),
  save_presentation: z.object({ documentId: canvasID }).strict(),
};

const descriptions = {
  get_plugin_development_guide:
    "Read the Guzi JavaScript plugin development guide, manifest format, isolated SDK, permissions, working example and install/update workflow. Start here to develop a personal plugin. Installation never enables code; the user enables it in Market.",
  get_plugin_api_schema:
    "Read versioned plugin package and SDK schemas, allowed commands and their full argument schemas. Plugins run locally in an isolated Worker without Node, filesystem, DOM or network access.",
  list_plugins:
    "List installed user plugins, manifests, enabled flags and runtime status. The built-in MCP service is managed in Settings and is excluded.",
  get_plugin:
    "Read an installed user plugin package {id}, including manifest and JavaScript source, before developing an update. Does not read arbitrary files or execute code.",
  validate_plugin:
    "Validate {plugin:{manifest,source}} including API version, permissions, IDs, size and JavaScript syntax, without running or installing its code.",
  install_plugin:
    "Install a new local JavaScript plugin package {plugin:{manifest,source}} without executing it. Existing IDs are rejected. The plugin is disabled until the user enables it in Market.",
  update_plugin:
    "Replace an existing local plugin package {plugin:{manifest,source}} atomically after validation. Stops its runtime and leaves it disabled for the user to review and enable in Market. Plugin storage is preserved.",
  run_plugin_command:
    "Run a declared command {id,commandId,args?:object} of an already-enabled user plugin through its isolated runtime. Disabled plugins cannot be started by this tool. The command can modify documents only within its declared permissions.",
  get_capabilities:
    "Discover supported document kinds, tools, element types, operation schemas, defaults and limits before editing. Takes {}. All tools operate only on this local workspace; no arbitrary filesystem access or network fetch is granted.",
  list_canvases:
    "List open canvases and presentations (documentId, path, title, revision, dirty, initialized, kind) and available authorized workspace files. Use read_presentation for deck slide IDs; use read_canvas with slideId/subsceneId for scene contents.",
  create_canvas:
    "Create and initialize a new ordinary root canvas. This does not save it; save_canvas requires a configured workspace directory for a new file.",
  open_canvas:
    "Open an authorized .excalidraw or .guzi-presentation file and wait until initialized. path must belong to the configured workspace or already be authorized by the user. This never grants access to a new external path.",
  close_document:
    "Close an existing open canvas or presentation {documentId} only after it has been saved and has no unsaved changes. Dirty documents return UNSAVED_CHANGES; there is no discard option. Save with save_canvas/save_presentation first. This closes local UI state without deleting files or granting new path access.",
  control_canvas:
    "Control an existing root canvas or presentation slide {documentId,slideId?,action:'undo'|'redo'|'select'|'fit'|'zoom',ids?,zoom?}. undo/redo modify scene contents: read_canvas before invoking, then reread the new revision before subsequent writes. select requires ids (an empty array clears selection). fit fits the whole scene or the supplied ids. zoom requires zoom between 0.1 and 10. subsceneId is unsupported. These actions affect local scene/history/view state without saving, fetching remote content or granting new path access.",
  read_canvas:
    "Read scene revision, elements, background and image metadata. Takes {documentId,slideId?,subsceneId?}; slideId targets a presentation slide, subsceneId targets an existing nested canvas. Read before writing to obtain expectedRevision. Image bytes and private app state are excluded.",
  apply_operations: `${HAND_DRAWN_STYLE_INSTRUCTIONS} Atomically apply 1–500 operations to {documentId,slideId?,subsceneId?,expectedRevision,requestId,operations}; IDs and revisions come from reads. Retrying the same requestId is idempotent; conflicts require rereading and replanning. create:{type:'create',tempId?,element:{type,x,y,...}} supports rectangle/ellipse/diamond/text/arrow/line/table/image/freedraw/frame/stickynote/subcanvas. Common style: width,height,angle,strokeColor,backgroundColor,fillStyle,strokeWidth,strokeStyle,roughness,opacity,roundness. Text/label: text,fontSize<=512,fontFamily,textAlign,verticalAlign,lineHeight<=10,paragraphSpacing:0..1000,richText:{version:1,paragraphs:[{runs:[{text,bold?,italic?,underline?,background?}],list?:{kind:'ordered'|'bullet',indent:0..8}}]}. richText can replace text; if both supplied their text must match. Patch richText:null clears formatting; patch text clears old richText. Shape/arrow label is a text object. Arrow/line points contain 2–1000 coordinate pairs, first [0,0]; startArrowhead/endArrowhead supported. Arrow start/end:{id:existing-or-tempId} or an inline rectangle/ellipse/diamond/text. table create requires rows:number[],columns:number[], each length 1–100, each size 1..100000, total cells<=2500; cells:[{row,column,text?,richText?,backgroundColor?,textColor?,strokeColor?,strokeWidth?,strokeStyle?,fontSize?,fontFamily?,paragraphSpacing?,textAlign?}]. image requires existing fileId OR file:{mimeType:'image/png'|'image/jpeg'|'image/gif'|'image/webp',dataURL}; scale?:[1|-1,1|-1]; no remote fetch. freedraw requires points, optional pressures:0..1 matching points length and simulatePressure:boolean. frame:name?:string|null; subcanvas:title?. Other operations: patch:{type:'patch',id,patch}; delete:{type:'delete',id}; table:{type:'table',id,cells?,rows?,columns?,merge?:{row,column,endRow,endColumn},split?:same-range}; group/ungroup:{type,ids}; lock:{type:'lock',ids,locked}; order:{type:'order',ids,position:'front'|'back'|'forward'|'backward'}; frame:{type:'frame',ids,frameId:string|null}; subcanvas:{type:'subcanvas',id,title}; canvas:{type:'canvas',patch:{viewBackgroundColor?,gridModeEnabled?,gridSize?:integer 1..1000,objectsSnapModeEnabled?}}. Raw element IDs, versions, customData and unsupported fields are rejected. Locked elements cannot be edited until explicitly unlocked. Only existing authorized documents/scenes can be targeted.`,
  export_canvas:
    "Export {documentId,format:'png'|'svg',slideId?,subsceneId?}. PNG returns MCP image content; SVG returns an embedded resource. Presentation slide IDs and nested canvas IDs must exist. PNG output is limited to 4096px per side / 16MP; source bounds over 100000px per side are rejected. Returns content without dialogs or filesystem writes.",
  save_canvas:
    "Save a canvas or presentation {documentId} without dialogs. New files are exclusively created under the configured workspace directory; existing files retain path authorization and external modification checks. Does not overwrite external changes.",
  create_presentation: `${HAND_DRAWN_STYLE_INSTRUCTIONS} Create a presentation {title,sourceDocumentId?}. Omit sourceDocumentId for an empty deck; an existing open canvas may supply the first slide. Source IDs confer no new path authorization. Use read_presentation for slide IDs and save_presentation to persist under the configured workspace.`,
  read_presentation:
    "Read presentation {documentId}: deck revision, title, slide order and IDs, selected slide and playback state. Use read_canvas {documentId,slideId} to inspect a slide before editing its elements. Requires an existing open presentation.",
  update_presentation: `${HAND_DRAWN_STYLE_INSTRUCTIONS} Update one deck operation {documentId,expectedRevision,requestId,operation}. Operations: {type:'add',title?,afterSlideId?}; {type:'duplicate',slideId}; {type:'rename',slideId,title}; {type:'move',slideId,toIndex} (zero based); {type:'delete',slideId}; {type:'select',slideId}; {type:'copy_from',sourceDocumentId,sourceSlideId} from an existing open presentation. Read current deck revision first; unique requestId enables idempotent retries. A conflict requires rereading. Slide deletion is destructive. Source IDs grant no external path access.`,
  control_presentation:
    "Control playback {documentId,action:'start'|'next'|'previous'|'goto'|'stop'|'status',slideId?}. goto requires a valid slideId; start optionally begins on slideId. status reads current playback without changing it. Other actions update the local presentation UI; no save or filesystem access occurs.",
  export_presentation:
    "Export {documentId,format:'png'|'svg'|'pdf',slideId?} without dialogs or filesystem writes. PNG/SVG exports the specified slide (or selected slide). PDF exports the deck (or the specified slide) as an embedded application/pdf resource with documentId/revision metadata. Only an existing open presentation and its slides can be exported; image dimensions follow export_canvas limits.",
  save_presentation:
    "Save presentation {documentId} without dialogs as .guzi-presentation. New files are exclusively created in the configured workspace; existing files require retained path authorization and external modification checks. Does not overwrite external changes.",
};

function toToolResult(response) {
  if (response.error) {
    return {
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ error: response.error }) },
      ],
      structuredContent: { error: response.error },
    };
  }
  const result = response.result;
  const file = result?.file;
  if (
    file &&
    typeof file.data === "string" &&
    file.mimeType === "application/pdf"
  ) {
    const { file: _file, ...metadata } = result;
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: `guzi://presentation/${encodeURIComponent(
              result.documentId || "export",
            )}/${encodeURIComponent(file.name || "export.pdf")}`,
            mimeType: file.mimeType,
            blob: file.data,
          },
        },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    };
  }
  const image = result?.image;
  if (
    image &&
    typeof image.data === "string" &&
    typeof image.mimeType === "string"
  ) {
    const { image: _image, ...metadata } = result;
    const content =
      image.mimeType === "image/svg+xml"
        ? {
            type: "resource",
            resource: {
              uri: `guzi://canvas/${encodeURIComponent(
                result.documentId || "export",
              )}/export.svg`,
              mimeType: "image/svg+xml",
              text: Buffer.from(image.data, "base64").toString("utf8"),
            },
          }
        : { type: "image", data: image.data, mimeType: image.mimeType };
    return {
      content: [content, { type: "text", text: JSON.stringify(metadata) }],
      structuredContent: metadata,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    ...(result && typeof result === "object" && !Array.isArray(result)
      ? { structuredContent: result }
      : {}),
  };
}

function createCanvasHandler(execute) {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "guzi-canvas", version: "1.0.0" },
        { instructions: HAND_DRAWN_STYLE_INSTRUCTIONS },
      );
      for (const [command, inputSchema] of Object.entries(toolSchemas)) {
        const readOnly = [
          "get_capabilities",
          "list_canvases",
          "read_canvas",
          "export_canvas",
          "read_presentation",
          "export_presentation",
          "get_plugin_development_guide",
          "get_plugin_api_schema",
          "list_plugins",
          "get_plugin",
          "validate_plugin",
        ].includes(command);
        server.registerTool(
          command,
          {
            description: descriptions[command],
            inputSchema,
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: [
                "apply_operations",
                "update_presentation",
                "control_canvas",
                "update_plugin",
                "run_plugin_command",
              ].includes(command),
              openWorldHint: false,
            },
          },
          async (args) => {
            try {
              return toToolResult(await execute(command, args));
            } catch (error) {
              return toToolResult({
                error: {
                  code: error.code || "HOST_UNAVAILABLE",
                  message: error.message || "画布工作区不可用。",
                },
              });
            }
          },
        );
      }
      return server;
    },
    { maxRequestBodySize: MAX_MESSAGE_BYTES, maxSubscriptions: 1 },
  );
}

async function startService({ port, token, execute }) {
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== "string" ||
    token.length < 32
  ) {
    throw new Error("Invalid service configuration");
  }
  const handler = createCanvasHandler(execute);
  const listener = createRequestListener({
    port,
    token,
    handle: (request) => handler.fetch(request),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = http.createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      req.resume();
      return;
    }
    void listener(req, res);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  return {
    port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await handler.close();
    },
  };
}

function runUtility(parentPort) {
  const pending = new Map();
  let initialized = false;
  let service;
  const execute = (command, args) =>
    new Promise((resolve) => {
      if (pending.size >= 32)
        return resolve({
          error: { code: "BUSY", message: "待处理请求过多。" },
        });
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({
          error: {
            code: "TIMEOUT",
            message: "画布操作超时；请读取画布确认结果后再重试写操作。",
          },
        });
      }, 31000);
      timer.unref?.();
      pending.set(requestId, { resolve, timer });
      parentPort.postMessage({
        type: "request",
        requestId,
        command,
        arguments: args,
      });
    });
  const close = async () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve({
        error: { code: "HOST_UNAVAILABLE", message: "MCP 服务已关闭。" },
      });
    }
    pending.clear();
    await service?.close();
  };
  parentPort.on("message", async ({ data: message }) => {
    if (message?.type === "initialize" && !initialized) {
      initialized = true;
      try {
        service = await startService({ ...message, execute });
        parentPort.postMessage({ type: "ready" });
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          code: error.code || "START_FAILED",
        });
      }
    } else if (message?.type === "response") {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      clearTimeout(request.timer);
      request.resolve(message);
    }
  });
  parentPort.on("close", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

if (process.parentPort) runUtility(process.parentPort);

module.exports = {
  startService,
  createCanvasHandler,
  toolSchemas,
  toToolResult,
};
