const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const repository = path.resolve(desktopDirectory, "../..");
const executableIndex = process.argv.indexOf("--executable");
const executablePath =
  executableIndex < 0 ? require("electron") : process.argv[executableIndex + 1];
const withCodex = process.argv.includes("--codex");
const artifacts = path.join(
  repository,
  "output/playwright/mcp-presentation-e2e",
);
const expectedTools = [
  "get_capabilities",
  "list_canvases",
  "create_canvas",
  "open_canvas",
  "close_document",
  "control_canvas",
  "read_canvas",
  "apply_operations",
  "export_canvas",
  "save_canvas",
  "create_presentation",
  "read_presentation",
  "update_presentation",
  "control_presentation",
  "export_presentation",
  "save_presentation",
];
const report = {
  executablePath,
  withCodex,
  scenarios: [],
  calls: [],
  errors: [],
  launchedPids: [],
};
const ownedPids = new Set();
const children = new Set();
let application;
let page;
let client;
let endpoint;
let token;
let cleanPromise;
let serial = 0;
let canScreenshot = false;

const bounded = (promise, description, milliseconds = 20000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${description}`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const step = (description) => {
  report.stage = description;
  console.log(`STEP ${description}`);
};
const passed = (name, details = {}) =>
  report.scenarios.push({ name, passed: true, ...details });
const decode = (response) =>
  response.structuredContent ||
  JSON.parse(response.content.find((item) => item.type === "text").text);
const visible = (scene) =>
  scene.elements.filter((element) => !element.isDeleted);
const element = (scene, id) => {
  const result = visible(scene).find((item) => item.id === id);
  assert.ok(result, `Missing element ${id}`);
  return result;
};
const processSnapshot = () =>
  execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
function rememberProcesses() {
  if (application) ownedPids.add(application.process().pid);
  for (const child of children) if (child.pid) ownedPids.add(child.pid);
  const snapshot = processSnapshot();
  let changed;
  do {
    changed = false;
    for (const [pid, parent] of snapshot) {
      if (ownedPids.has(parent) && !ownedPids.has(pid)) {
        ownedPids.add(pid);
        changed = true;
      }
    }
  } while (changed);
}

async function clean() {
  return (cleanPromise ??= (async () => {
    rememberProcesses();
    for (const child of children) child.kill("SIGTERM");
    await bounded(
      client?.close() || Promise.resolve(),
      "MCP client close",
      5000,
    ).catch(() => {});
    if (application) {
      await bounded(
        page?.evaluate(() => window.desktop.setPluginEnabled("mcp", false)) ||
          Promise.resolve(),
        "disable MCP",
        5000,
      ).catch(() => {});
      const child = application.process();
      const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
      try {
        await bounded(
          application.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows())
              window.destroy();
          }),
          "destroy isolated windows",
          5000,
        );
        await bounded(application.close(), "Electron close", 10000);
      } catch {
        child.kill("SIGTERM");
      } finally {
        clearTimeout(timer);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const alive = processSnapshot().filter(([pid]) => ownedPids.has(pid));
      for (const [pid] of alive) {
        try {
          process.kill(pid, signal);
        } catch {}
      }
      if (alive.length)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report.launchedPids = [...ownedPids];
    report.residualPids = processSnapshot()
      .filter(([pid]) => ownedPids.has(pid))
      .map(([pid]) => pid);
    assert.deepEqual(
      report.residualPids,
      [],
      "Test-owned processes must all exit",
    );
    if (endpoint) {
      await assert.rejects(
        fetch(endpoint, { signal: AbortSignal.timeout(3000) }),
      );
      report.endpointReleased = true;
    }
  })());
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(
    signal,
    () =>
      void clean().finally(async () => {
        report.errors.push(`Interrupted by ${signal}`);
        await fs.writeFile(
          path.join(artifacts, "report.json"),
          JSON.stringify(report, null, 2),
        );
        process.exit(1);
      }),
  );
}

async function callRaw(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const result = decode(response);
  report.calls.push({
    name,
    documentId: args.documentId,
    slideId: args.slideId,
    subsceneId: args.subsceneId,
    action: args.action,
    operation: args.operation?.type,
    isError: !!response.isError,
    revision: result?.revision,
    ...(response.isError ? { error: result.error } : {}),
  });
  assert.ok(!response.isError, `${name}: ${JSON.stringify(result)}`);
  return { response, result };
}
const call = async (name, args) => (await callRaw(name, args)).result;
const readDeck = (documentId) => call("read_presentation", { documentId });
const readScene = (documentId, slideId, subsceneId) =>
  call("read_canvas", {
    documentId,
    ...(slideId ? { slideId } : {}),
    ...(subsceneId ? { subsceneId } : {}),
  });
async function apply(documentId, slideId, operations, subsceneId) {
  const before = await readScene(documentId, slideId, subsceneId);
  return call("apply_operations", {
    documentId,
    ...(slideId ? { slideId } : {}),
    ...(subsceneId ? { subsceneId } : {}),
    expectedRevision: before.revision,
    requestId: `sdk-scene-${++serial}`,
    operations,
  });
}
async function update(documentId, operation) {
  const before = await readDeck(documentId);
  return call("update_presentation", {
    documentId,
    expectedRevision: before.revision,
    requestId: `sdk-deck-${++serial}`,
    operation,
  });
}
const screenshot = (name) =>
  page.screenshot({ path: path.join(artifacts, name), fullPage: true });

function assertHandDrawn(item) {
  assert.equal(item.roughness, 1, `${item.type} roughness`);
  assert.equal(item.strokeWidth, 2, `${item.type} stroke width`);
  if (item.type === "text") assert.equal(item.fontFamily, 5);
  if (item.type === "rectangle" || item.type === "stickynote")
    assert.deepEqual(item.roundness, { type: 3 });
  if (item.type === "arrow" || item.type === "line" || item.type === "diamond")
    assert.deepEqual(item.roundness, { type: 2 });
}

async function assertTextMetrics(item, phase) {
  assert.equal(item.fontFamily, 5);
  const metrics = await page.evaluate(async (text) => {
    const ownerDocument =
      document.querySelector(".desktop-workspace").ownerDocument;
    const font = `${text.fontSize}px Excalifont`;
    await ownerDocument.fonts.load(font, text.text);
    const context = ownerDocument.createElement("canvas").getContext("2d");
    context.font = font;
    const measured = context.measureText(text.text);
    return {
      text: text.text,
      font,
      fontFamily: text.fontFamily,
      fontSize: text.fontSize,
      storedWidth: text.width,
      measuredWidth: measured.width,
      glyphRight: measured.actualBoundingBoxRight,
      loaded: ownerDocument.fonts.check(font, text.text),
    };
  }, item);
  assert.equal(metrics.loaded, true);
  assert.ok(
    Math.abs(metrics.storedWidth - metrics.measuredWidth) < 1,
    `Text width must use the loaded hand-drawn font: ${JSON.stringify(
      metrics,
    )}`,
  );
  passed(`hand-drawn text metrics ${phase}`, metrics);
}

async function saveExport(documentId, format, slideId) {
  const { response, result } = await callRaw("export_presentation", {
    documentId,
    format,
    ...(slideId ? { slideId } : {}),
  });
  const output = path.join(
    artifacts,
    `presentation${format === "pdf" && slideId ? "-single" : ""}.${format}`,
  );
  let bytes;
  if (format === "png") {
    const image = response.content.find(
      (item) => item.type === "image" && item.mimeType === "image/png",
    );
    assert.ok(image, "PNG must use MCP image content");
    bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 720);
  } else {
    const resource = response.content.find(
      (item) => item.type === "resource",
    )?.resource;
    assert.equal(
      resource?.mimeType,
      format === "pdf" ? "application/pdf" : "image/svg+xml",
    );
    if (format === "svg") {
      assert.match(resource.text, /<svg\b/);
      assert.match(resource.text, /<\/svg>/);
      const dimensions = await page.evaluate((xml) => {
        const mounted = document.querySelector(".desktop-workspace");
        const ownerWindow = mounted.ownerDocument.defaultView;
        const root = new ownerWindow.DOMParser().parseFromString(
          xml,
          "image/svg+xml",
        ).documentElement;
        return {
          name: root.localName,
          width: root.getAttribute("width"),
          height: root.getAttribute("height"),
          viewBox: root.getAttribute("viewBox"),
          errors: root.querySelectorAll("parsererror").length,
        };
      }, resource.text);
      assert.equal(dimensions.name, "svg");
      assert.equal(dimensions.errors, 0);
      assert.equal(Number(dimensions.width), 1280);
      assert.equal(Number(dimensions.height), 720);
      bytes = Buffer.from(resource.text);
    } else {
      bytes = Buffer.from(resource.blob, "base64");
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.match(bytes.subarray(-100).toString(), /%%EOF/);
    }
  }
  assert.ok(bytes.length > 100, `${format} must contain real export data`);
  await fs.writeFile(output, bytes);
  let pages;
  if (format === "pdf") {
    const info = execFileSync("pdfinfo", [output], { encoding: "utf8" });
    pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    assert.equal(
      pages,
      slideId ? 1 : (await readDeck(documentId)).slides.length,
    );
    await fs.writeFile(
      path.join(artifacts, slideId ? "pdfinfo-single.txt" : "pdfinfo.txt"),
      info,
    );
  }
  passed(
    `export ${format}${format === "pdf" && slideId ? " single slide" : ""}`,
    {
      path: output,
      bytes: bytes.length,
      pages,
      slideId: result.slideId,
    },
  );
}

async function runCodex(drawings) {
  step(
    "Codex creates, edits, presents, exports, saves and reopens a three-slide deck",
  );
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "-C",
    drawings,
    "-c",
    `mcp_servers.guzi.url="${endpoint}"`,
    "-c",
    'mcp_servers.guzi.bearer_token_env_var="GUZI_MCP_TOKEN"',
    "-c",
    `mcp_servers.guzi.enabled_tools=${JSON.stringify(expectedTools)}`,
    "-c",
    'approval_policy="never"',
  ];
  for (const name of [
    "create_canvas",
    "open_canvas",
    "close_document",
    "control_canvas",
    "apply_operations",
    "save_canvas",
    "create_presentation",
    "update_presentation",
    "control_presentation",
    "save_presentation",
  ]) {
    args.push("-c", `mcp_servers.guzi.tools.${name}.approval_mode="approve"`);
  }
  args.push(`You are verifying the complete Guzi presentation MCP workflow. Use ONLY guzi MCP tools, never shell/file/browser/other tools. Make real calls. Follow all steps sequentially. Use fresh reads before each write, unique requestId values, and the exact documentId/slideId/element IDs returned by tools. Keep all default hand-drawn styling. Retry ONLY REVISION_CONFLICT by reading again; stop and report any other error. Do not print image/PDF base64 or SVG source; just confirm export metadata.
1. get_capabilities. create_presentation titled "Codex Presentation E2E". Read it and rename the initial slide "Codex cover". Add a second slide "Codex second" after the cover, then a third "Codex third" after the second. Keep exactly these three slides; retain their IDs.
2. Read the cover with read_canvas(documentId,slideId). In one apply_operations batch create: rectangle tempId "input" at (80,180),size220x120,label text "Input"; rectangle tempId "output" at (640,180),size220x120,label text "Output"; arrow at (300,240),size340x0,start {id:"input"},end {id:"output"}; text at (80,70),fontSize36,text "Codex MCP presentation". Omit style fields so defaults apply.
3. Read the cover again. In a SEPARATE apply_operations call patch the actual Output rectangle ID to y:240 and backgroundColor:"#a5d8ff". Read again to verify the patch.
4. Read the second slide and create a text at (80,80),fontSize36,text "Codex slide two". Read the third slide and create a text at (80,80),fontSize36,text "Codex slide three". Each write uses its own fresh revision and requestId.
5. Actually control playback: start on the cover, status, next, status, goto the third slide, previous, goto the third again, status, stop, status. Verify the returned slide IDs and presenting booleans. All six control actions must be called.
6. Call export_presentation three times: PNG for the cover; SVG for the third slide; PDF for the entire deck (omit slideId for PDF). These calls return real content; do not repeat or print their base64/text payloads.
7. save_presentation and retain the returned path. close_document on that saved document. list_canvases to verify its documentId is no longer open. Then open_canvas with the exact saved path. Read the reopened deck and cover, verify three slides and Output rectangle y:240/backgroundColor:"#a5d8ff". Verify the reopened documentId differs from the closed one. End by reporting path, reopened ID, slide count and patch verification. Do not add extra slides or drawings.`);
  const child = spawn("codex", args, {
    cwd: drawings,
    env: { ...process.env, GUZI_MCP_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  rememberProcesses();
  let output = "";
  const pending = { stdout: "", stderr: "" };
  const events = [];
  let screenshots = Promise.resolve();
  const append = (chunk, stream) => {
    const text = chunk.toString();
    output += text;
    pending[stream] += text;
    const lines = pending[stream].split("\n");
    pending[stream] = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
      if (
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call"
      ) {
        const item = event.item;
        console.log(
          `CODEX ${item.tool}${
            item.arguments?.action ? ` ${item.arguments.action}` : ""
          } ${item.status}`,
        );
        if (
          item.tool === "control_presentation" &&
          ["start", "goto", "stop"].includes(item.arguments?.action) &&
          item.status === "completed"
        ) {
          screenshots = screenshots.then(async () => {
            try {
              await bounded(
                screenshot(`codex-playback-${item.arguments.action}.png`),
                "Codex playback screenshot",
                5000,
              );
            } catch (error) {
              report.errors.push(`Codex screenshot: ${error.message}`);
            }
          });
        }
        if (
          item.status !== "completed" ||
          item.error ||
          item.result?.isError ||
          item.result?.is_error
        )
          child.kill("SIGTERM");
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    append(chunk, "stdout");
  });
  child.stderr.on("data", (chunk) => {
    append(chunk, "stderr");
  });
  const processPoll = setInterval(rememberProcesses, 1000);
  const progress = setInterval(
    () =>
      console.log(
        `CODEX running; ${
          events.filter(
            (event) =>
              event.type === "item.completed" &&
              event.item?.type === "mcp_tool_call",
          ).length
        } tool calls completed`,
      ),
    30000,
  );
  const timeout = setTimeout(() => {
    rememberProcesses();
    child.kill("SIGTERM");
  }, 480000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(processPoll);
    clearInterval(progress);
    children.delete(child);
    const log = output
      .split("\n")
      .map((line) => {
        try {
          const event = JSON.parse(line);
          for (const block of event.item?.result?.content || []) {
            if (block.type === "image")
              block.data = `[${block.data.length} base64 characters]`;
            if (block.type === "resource") {
              if (block.resource.blob)
                block.resource.blob = `[${block.resource.blob.length} base64 characters]`;
              if (
                block.resource.text &&
                block.resource.mimeType === "image/svg+xml"
              )
                block.resource.text = `[${block.resource.text.length} SVG characters]`;
            }
          }
          return JSON.stringify(event);
        } catch {
          return line;
        }
      })
      .join("\n");
    await fs.writeFile(
      path.join(artifacts, "codex.log"),
      log.split(token).join("[REDACTED]"),
    );
  }
  assert.equal(code, 0, "Codex CLI must exit successfully; see codex.log");
  await screenshots;
  assert.ok(
    !events.some((event) =>
      ["command_execution", "file_change", "web_search"].includes(
        event.item?.type,
      ),
    ),
    "Codex must use only Guzi MCP tools",
  );
  const calls = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "mcp_tool_call",
    )
    .map((event) => event.item);
  assert.ok(
    calls.length >= 25,
    "Codex must execute the complete real workflow",
  );
  for (const item of calls) {
    assert.equal(item.server, "guzi");
    assert.equal(item.status, "completed", `${item.tool} failed`);
    assert.ok(
      !item.error && !item.result?.isError && !item.result?.is_error,
      `${item.tool} returned an error`,
    );
  }
  const resultOf = (item) =>
    item.result.structured_content ||
    item.result.structuredContent ||
    JSON.parse(item.result.content.find((entry) => entry.type === "text").text);
  const create = calls.find(
    (item) =>
      item.tool === "create_presentation" &&
      item.arguments.title === "Codex Presentation E2E",
  );
  assert.ok(create, "Codex must create its own deck");
  const created = resultOf(create);
  const deckCalls = calls.filter(
    (item) => item.arguments.documentId === created.documentId,
  );
  assert.equal(
    deckCalls.filter(
      (item) =>
        item.tool === "update_presentation" &&
        item.arguments.operation.type === "add",
    ).length,
    2,
  );
  const writes = deckCalls.filter((item) => item.tool === "apply_operations");
  assert.ok(
    writes.some((item) =>
      item.arguments.operations.some(
        (operation) =>
          operation.type === "create" && operation.element.type === "rectangle",
      ),
    ),
  );
  assert.ok(
    writes.some((item) =>
      item.arguments.operations.some(
        (operation) =>
          operation.type === "patch" &&
          operation.patch.y === 240 &&
          operation.patch.backgroundColor === "#a5d8ff",
      ),
    ),
  );
  for (const action of [
    "start",
    "next",
    "previous",
    "goto",
    "stop",
    "status",
  ]) {
    const control = deckCalls.find(
      (item) =>
        item.tool === "control_presentation" &&
        item.arguments.action === action,
    );
    assert.ok(control, `Codex must actually ${action} playback`);
    if (action === "start") assert.equal(resultOf(control).presenting, true);
    if (action === "stop") assert.equal(resultOf(control).presenting, false);
  }
  const exports = [];
  for (const format of ["png", "svg", "pdf"]) {
    const exported = deckCalls.find(
      (item) =>
        item.tool === "export_presentation" && item.arguments.format === format,
    );
    assert.ok(exported, `Codex must export ${format}`);
    const blocks = exported.result.content;
    const block = blocks.find(
      (entry) => entry.type === (format === "png" ? "image" : "resource"),
    );
    const bytes =
      format === "png"
        ? Buffer.from(block.data, "base64")
        : format === "svg"
        ? Buffer.from(block.resource.text)
        : Buffer.from(block.resource.blob, "base64");
    if (format === "png") {
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), 1280);
      assert.equal(bytes.readUInt32BE(20), 720);
    }
    if (format === "svg") assert.match(bytes.toString(), /<svg\b/);
    if (format === "pdf")
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const outputPath = path.join(artifacts, `codex-presentation.${format}`);
    await fs.writeFile(outputPath, bytes);
    let pages;
    if (format === "pdf") {
      const info = execFileSync("pdfinfo", [outputPath], { encoding: "utf8" });
      pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      assert.equal(pages, 3);
      await fs.writeFile(path.join(artifacts, "codex-pdfinfo.txt"), info);
    }
    exports.push({ format, path: outputPath, bytes: bytes.length, pages });
  }
  const save = deckCalls.find((item) => item.tool === "save_presentation");
  assert.ok(save, "Codex must save its deck");
  const savedPath = resultOf(save).path;
  assert.ok(savedPath.startsWith(`${drawings}${path.sep}`));
  const close = deckCalls.find((item) => item.tool === "close_document");
  assert.ok(
    close && resultOf(close).closed,
    "Codex must genuinely close its deck",
  );
  const open = calls.find(
    (item) => item.tool === "open_canvas" && item.arguments.path === savedPath,
  );
  assert.ok(open, "Codex must reopen its saved file");
  assert.ok(
    calls.indexOf(save) < calls.indexOf(close) &&
      calls.indexOf(close) < calls.indexOf(open),
  );
  assert.notEqual(resultOf(open).documentId, created.documentId);
  assert.ok(
    calls
      .slice(calls.indexOf(open) + 1)
      .some(
        (item) =>
          item.tool === "read_presentation" &&
          item.arguments.documentId === resultOf(open).documentId,
      ),
  );
  const listed = await call("list_canvases");
  const reopened = listed.canvases.find((item) => item.path === savedPath);
  assert.ok(reopened, "Codex must reopen the presentation");
  const reopenedDeck = await readDeck(reopened.documentId);
  assert.equal(reopenedDeck.slides.length, 3);
  const disk = JSON.parse(await fs.readFile(savedPath, "utf8"));
  assert.equal(disk.type, "guzi-presentation");
  assert.equal(disk.slides.length, 3);
  const cover = disk.slides.find((slide) =>
    slide.scene.elements.some((item) => item.text === "Codex MCP presentation"),
  );
  assert.ok(cover, "Codex must persist its cover drawing");
  const patched = cover.scene.elements.find(
    (item) =>
      item.type === "rectangle" &&
      item.y === 240 &&
      item.backgroundColor === "#a5d8ff",
  );
  assert.ok(patched, "Codex second write must persist the Output patch");
  for (const slide of disk.slides)
    slide.scene.elements
      .filter((item) => !item.isDeleted)
      .forEach(assertHandDrawn);
  for (const marker of ["Codex slide two", "Codex slide three"])
    assert.ok(
      disk.slides.some((slide) =>
        slide.scene.elements.some((item) => item.text === marker),
      ),
    );
  assert.ok(
    cover.scene.elements.some(
      (item) => item.type === "arrow" && item.startBinding && item.endBinding,
    ),
  );
  const reopenedCover = await readScene(reopened.documentId, cover.id);
  assert.ok(
    reopenedCover.elements.some(
      (item) =>
        item.id === patched.id &&
        item.y === 240 &&
        item.backgroundColor === "#a5d8ff",
    ),
  );
  const toolCalls = calls.map((item) => ({
    tool: item.tool,
    status: item.status,
    action: item.arguments.action,
    operation: item.arguments.operation?.type,
    format: item.arguments.format,
    documentId: item.arguments.documentId,
  }));
  passed(
    "Codex complete create, draw, patch, playback, export, save, close and reopen",
    {
      originalDocumentId: created.documentId,
      documentId: reopened.documentId,
      path: savedPath,
      slides: disk.slides.length,
      exports,
      toolCalls,
    },
  );
  await screenshot("codex-reopened.png");
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const isolated = await fs.mkdtemp(path.join(artifacts, "isolated-"));
  const profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  report.isolated = isolated;
  step("Launch isolated Electron and enable MCP");
  application = await _electron.launch({
    executablePath,
    args: executableIndex < 0 ? [desktopDirectory] : [],
    env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile },
    timeout: 60000,
  });
  rememberProcesses();
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) =>
    report.errors.push(`pageerror: ${error.message}`),
  );
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await page.getByRole("spinbutton", { name: "本地端口" }).fill(String(port));
  await page.getByRole("button", { name: "应用端口", exact: true }).click();
  await page.getByRole("switch", { name: "启用插件" }).click();
  await page.getByText("运行中", { exact: true }).waitFor();
  const plugin = await page.evaluate(
    async () => (await window.desktop.getPlugins())[0],
  );
  assert.equal(plugin.status, "running", plugin.error || plugin.status);
  endpoint = plugin.endpoint;
  token = plugin.token;
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-presentation-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const tools = await client.listTools();
  report.tools = tools.tools.map((tool) => tool.name);
  assert.deepEqual([...report.tools].sort(), [...expectedTools].sort());
  const capabilities = await call("get_capabilities");
  assert.equal(capabilities.defaults.roughness, 1);
  assert.equal(capabilities.defaults.fontFamily, 5);
  assert.ok(capabilities.canvas.elementTypes.includes("table"));
  assert.ok(capabilities.presentations.export.includes("pdf"));
  report.capabilities = capabilities;
  passed("tool discovery and capabilities", { tools: report.tools });

  step("Create three-slide presentation");
  let deck = await call("create_presentation", {
    title: "SDK Presentation E2E",
  });
  const documentId = deck.documentId;
  assert.equal(deck.slides.length, 1);
  const coverId = deck.slides[0].id;
  await update(documentId, {
    type: "rename",
    slideId: coverId,
    title: "Cover",
  });
  deck = await update(documentId, {
    type: "add",
    title: "Second",
    afterSlideId: coverId,
  });
  const secondId = deck.activeSlideId;
  deck = await update(documentId, {
    type: "add",
    title: "Advanced",
    afterSlideId: secondId,
  });
  const advancedId = deck.activeSlideId;
  assert.deepEqual(
    deck.slides.map((slide) => slide.title),
    ["Cover", "Second", "Advanced"],
  );
  await update(documentId, { type: "select", slideId: coverId });
  await page.getByRole("toolbar", { name: "演示文稿", exact: true }).waitFor();
  canScreenshot = true;
  const cover = await apply(documentId, coverId, [
    {
      type: "create",
      tempId: "input",
      element: {
        type: "rectangle",
        x: 80,
        y: 180,
        width: 220,
        height: 120,
        label: { text: "Input" },
      },
    },
    {
      type: "create",
      tempId: "output",
      element: {
        type: "rectangle",
        x: 640,
        y: 180,
        width: 220,
        height: 120,
        backgroundColor: "#b2f2bb",
        label: { text: "Output" },
      },
    },
    {
      type: "create",
      tempId: "link",
      element: {
        type: "arrow",
        x: 300,
        y: 240,
        width: 340,
        height: 0,
        start: { id: "input" },
        end: { id: "output" },
      },
    },
    {
      type: "create",
      tempId: "heading",
      element: {
        type: "text",
        x: 80,
        y: 70,
        text: "MCP presentation verification",
        fontSize: 36,
      },
    },
  ]);
  const coverBefore = await readScene(documentId, coverId);
  visible(coverBefore).forEach(assertHandDrawn);
  await assertTextMetrics(
    element(coverBefore, cover.idMap.heading),
    "on first create",
  );
  const second = await apply(documentId, secondId, [
    {
      type: "create",
      tempId: "marker",
      element: {
        type: "text",
        x: 80,
        y: 80,
        text: "Second slide only",
        fontSize: 36,
      },
    },
    {
      type: "create",
      tempId: "override",
      element: {
        type: "rectangle",
        x: 80,
        y: 180,
        width: 240,
        height: 140,
        roughness: 0,
        strokeWidth: 1,
        roundness: null,
      },
    },
  ]);
  assert.deepEqual(
    (await readScene(documentId, coverId)).elements,
    coverBefore.elements,
    "Editing a non-current slide must not change the current slide",
  );
  assert.equal(
    (await readDeck(documentId)).activeSlideId,
    coverId,
    "Targeted edit must not switch the current slide",
  );
  const secondScene = await readScene(documentId, secondId);
  assert.equal(
    element(secondScene, second.idMap.marker).text,
    "Second slide only",
  );
  assertHandDrawn(element(secondScene, second.idMap.marker));
  assert.equal(element(secondScene, second.idMap.override).roughness, 0);
  assert.equal(element(secondScene, second.idMap.override).roundness, null);
  passed("three slides and isolated non-current slide editing", {
    documentId,
    slideIds: [coverId, secondId, advancedId],
    explicitStyleOverride: true,
  });

  step("Exercise tables, rich text, images and nested canvases");
  const imageDataURL = await application.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([
          64, 96, 208, 255, 64, 96, 208, 255, 64, 96, 208, 255, 64, 96, 208,
          255,
        ]),
        { width: 2, height: 2 },
      )
      .toDataURL(),
  );
  const richText = {
    version: 1,
    paragraphs: [
      {
        runs: [
          { text: "Rich ", bold: true },
          {
            text: "text",
            italic: true,
            underline: true,
            background: "#fff3bf",
          },
        ],
      },
    ],
  };
  const advanced = await apply(documentId, advancedId, [
    {
      type: "create",
      tempId: "rich",
      element: {
        type: "text",
        x: 60,
        y: 60,
        richText,
        paragraphSpacing: 8,
        fontSize: 28,
      },
    },
    {
      type: "create",
      tempId: "table",
      element: {
        type: "table",
        x: 60,
        y: 160,
        rows: [48, 48],
        columns: [170, 170],
        cells: [
          { row: 0, column: 0, text: "Metric" },
          { row: 0, column: 1, text: "Value" },
          { row: 1, column: 0, text: "MCP" },
          { row: 1, column: 1, text: "pending" },
        ],
      },
    },
    {
      type: "create",
      tempId: "image",
      element: {
        type: "image",
        x: 440,
        y: 160,
        width: 100,
        height: 100,
        file: { mimeType: "image/png", dataURL: imageDataURL },
      },
    },
    {
      type: "create",
      tempId: "subcanvas",
      element: {
        type: "subcanvas",
        x: 60,
        y: 350,
        width: 250,
        height: 180,
        title: "Nested MCP",
      },
    },
    {
      type: "create",
      tempId: "a",
      element: { type: "rectangle", x: 660, y: 200, width: 100, height: 80 },
    },
    {
      type: "create",
      tempId: "b",
      element: { type: "ellipse", x: 820, y: 200, width: 100, height: 80 },
    },
    {
      type: "create",
      tempId: "frame",
      element: {
        type: "frame",
        x: 620,
        y: 140,
        width: 380,
        height: 220,
        name: "MCP frame",
      },
    },
    {
      type: "create",
      tempId: "freedraw",
      element: {
        type: "freedraw",
        x: 660,
        y: 430,
        points: [
          [0, 0],
          [60, 30],
          [120, 0],
        ],
        pressures: [0.3, 0.7, 0.3],
        simulatePressure: false,
      },
    },
  ]);
  let advancedScene = await readScene(documentId, advancedId);
  assert.deepEqual(
    element(advancedScene, advanced.idMap.rich).richText,
    richText,
  );
  assertHandDrawn(element(advancedScene, advanced.idMap.rich));
  const tableRoot = element(advancedScene, advanced.idMap.table);
  assert.equal(
    tableRoot.customData.table.cells.find(
      (cell) => cell.row === 0 && cell.column === 0,
    ).fontFamily,
    5,
  );
  assert.equal(
    tableRoot.customData.table.cells.find(
      (cell) => cell.row === 0 && cell.column === 0,
    ).strokeWidth,
    2,
  );
  const image = element(advancedScene, advanced.idMap.image);
  assert.ok(
    advancedScene.files.some(
      (file) => file.id === image.fileId && file.mimeType === "image/png",
    ),
  );
  assert.equal(
    advancedScene.files.some((file) => "dataURL" in file),
    false,
    "read_canvas must not expose image bytes",
  );
  const subsceneId = element(advancedScene, advanced.idMap.subcanvas).customData
    .subcanvas.sceneId;
  assert.ok(advancedScene.subscenes.some((scene) => scene.id === subsceneId));
  await apply(documentId, advancedId, [
    {
      type: "table",
      id: advanced.idMap.table,
      cells: [
        { row: 1, column: 1, text: "verified", backgroundColor: "#b2f2bb" },
      ],
    },
    {
      type: "subcanvas",
      id: advanced.idMap.subcanvas,
      title: "Nested MCP verified",
    },
  ]);
  const nested = await apply(
    documentId,
    advancedId,
    [
      {
        type: "create",
        tempId: "nested",
        element: {
          type: "rectangle",
          x: 20,
          y: 20,
          width: 180,
          height: 90,
          label: { text: "Nested drawing" },
        },
      },
    ],
    subsceneId,
  );
  const nestedScene = await readScene(documentId, advancedId, subsceneId);
  assertHandDrawn(element(nestedScene, nested.idMap.nested));
  assert.ok(
    nestedScene.elements.some((item) => item.text === "Nested drawing"),
  );
  advancedScene = await readScene(documentId, advancedId);
  assert.ok(
    !advancedScene.elements.some((item) => item.id === nested.idMap.nested),
    "Nested drawing must stay inside the child scene",
  );
  assert.equal(
    element(advancedScene, advanced.idMap.table).customData.table.cells.find(
      (cell) => cell.row === 1 && cell.column === 1,
    ).text,
    "verified",
  );
  passed("table cells, rich text, image and nested canvas", {
    subsceneId,
    fileId: image.fileId,
    nestedElementId: nested.idMap.nested,
  });

  step("Exercise grouping, ordering, locking and frame membership");
  await apply(documentId, advancedId, [
    { type: "group", ids: [advanced.idMap.a, advanced.idMap.b] },
  ]);
  advancedScene = await readScene(documentId, advancedId);
  assert.ok(element(advancedScene, advanced.idMap.a).groupIds.length);
  assert.deepEqual(
    element(advancedScene, advanced.idMap.a).groupIds,
    element(advancedScene, advanced.idMap.b).groupIds,
  );
  await apply(documentId, advancedId, [
    {
      type: "order",
      ids: [advanced.idMap.a, advanced.idMap.b],
      position: "front",
    },
  ]);
  advancedScene = await readScene(documentId, advancedId);
  assert.ok(
    advancedScene.elements.findIndex((item) => item.id === advanced.idMap.a) >
      advancedScene.elements.findIndex(
        (item) => item.id === advanced.idMap.rich,
      ),
  );
  await apply(documentId, advancedId, [
    { type: "lock", ids: [advanced.idMap.a, advanced.idMap.b], locked: true },
  ]);
  assert.equal(
    element(await readScene(documentId, advancedId), advanced.idMap.a).locked,
    true,
  );
  await apply(documentId, advancedId, [
    { type: "lock", ids: [advanced.idMap.a, advanced.idMap.b], locked: false },
    { type: "ungroup", ids: [advanced.idMap.a, advanced.idMap.b] },
    {
      type: "frame",
      ids: [advanced.idMap.a, advanced.idMap.b],
      frameId: advanced.idMap.frame,
    },
  ]);
  advancedScene = await readScene(documentId, advancedId);
  assert.equal(element(advancedScene, advanced.idMap.a).locked, false);
  assert.deepEqual(element(advancedScene, advanced.idMap.a).groupIds, []);
  assert.equal(
    element(advancedScene, advanced.idMap.a).frameId,
    advanced.idMap.frame,
  );
  assert.equal(
    element(advancedScene, advanced.idMap.b).frameId,
    advanced.idMap.frame,
  );
  passed("group, ungroup, order, lock, unlock and frame");

  step("Exercise slide duplicate, rename, move and delete");
  deck = await update(documentId, { type: "duplicate", slideId: secondId });
  const duplicateId = deck.activeSlideId;
  assert.equal(deck.slides.length, 4);
  assert.ok(
    (await readScene(documentId, duplicateId)).elements.some(
      (item) => item.text === "Second slide only",
    ),
  );
  await update(documentId, {
    type: "rename",
    slideId: duplicateId,
    title: "Temporary duplicate",
  });
  deck = await update(documentId, {
    type: "move",
    slideId: duplicateId,
    toIndex: 0,
  });
  assert.equal(deck.slides[0].id, duplicateId);
  assert.equal(deck.slides[0].title, "Temporary duplicate");
  deck = await update(documentId, { type: "delete", slideId: duplicateId });
  assert.equal(deck.slides.length, 3);
  assert.ok(!deck.slides.some((slide) => slide.id === duplicateId));
  passed("slide add, duplicate, rename, move, delete and select");

  step("Exercise root canvas controls and copying slides between decks");
  const source = await call("create_canvas", { title: "SDK MCP source" });
  const sourceDrawing = await apply(source.documentId, undefined, [
    {
      type: "create",
      tempId: "source",
      element: {
        type: "text",
        x: 80,
        y: 80,
        text: "Copied from source canvas",
        fontSize: 30,
      },
    },
  ]);
  await call("control_canvas", {
    documentId: source.documentId,
    action: "select",
    ids: [sourceDrawing.idMap.source],
  });
  await call("control_canvas", {
    documentId: source.documentId,
    action: "fit",
  });
  await call("control_canvas", {
    documentId: source.documentId,
    action: "zoom",
    zoom: 1,
  });
  await apply(source.documentId, undefined, [
    { type: "patch", id: sourceDrawing.idMap.source, patch: { x: 180 } },
  ]);
  await call("control_canvas", {
    documentId: source.documentId,
    action: "undo",
  });
  assert.equal(
    element(await readScene(source.documentId), sourceDrawing.idMap.source).x,
    80,
  );
  await call("control_canvas", {
    documentId: source.documentId,
    action: "redo",
  });
  assert.equal(
    element(await readScene(source.documentId), sourceDrawing.idMap.source).x,
    180,
  );
  const sourceDeck = await call("create_presentation", {
    title: "SDK source deck",
    sourceDocumentId: source.documentId,
  });
  assert.ok(
    (
      await readScene(sourceDeck.documentId, sourceDeck.slides[0].id)
    ).elements.some((item) => item.text === "Copied from source canvas"),
  );
  deck = await update(documentId, {
    type: "copy_from",
    sourceDocumentId: sourceDeck.documentId,
    sourceSlideId: sourceDeck.slides[0].id,
  });
  const copiedId = deck.activeSlideId;
  assert.equal(deck.slides.length, 4);
  assert.ok(
    (await readScene(documentId, copiedId)).elements.some(
      (item) => item.text === "Copied from source canvas",
    ),
  );
  await update(documentId, { type: "delete", slideId: copiedId });
  await update(documentId, { type: "select", slideId: advancedId });
  await page.getByRole("tab", { name: /SDK Presentation E2E/ }).click();
  await call("control_canvas", {
    documentId,
    slideId: advancedId,
    action: "fit",
  });
  await screenshot("advanced-slide.png");
  passed(
    "canvas select, fit, zoom, undo, redo, presentation from canvas and copy_from",
  );

  step("Control the real presentation player through MCP");
  let playback = await call("control_presentation", {
    documentId,
    action: "start",
    slideId: coverId,
  });
  assert.equal(playback.presenting, true);
  assert.equal(playback.slideId, coverId);
  await page.getByRole("dialog", { name: "幻灯片放映", exact: true }).waitFor();
  await screenshot("playback-start.png");
  playback = await call("control_presentation", { documentId, action: "next" });
  assert.equal(playback.slideId, secondId);
  await screenshot("playback-next.png");
  playback = await call("control_presentation", {
    documentId,
    action: "previous",
  });
  assert.equal(playback.slideId, coverId);
  playback = await call("control_presentation", {
    documentId,
    action: "goto",
    slideId: advancedId,
  });
  assert.equal(playback.slideId, advancedId);
  await screenshot("playback-goto.png");
  const status = await call("control_presentation", {
    documentId,
    action: "status",
  });
  assert.equal(status.presenting, true);
  assert.equal(status.slideId, advancedId);
  assert.equal(status.slideCount, 3);
  playback = await call("control_presentation", { documentId, action: "stop" });
  assert.equal(playback.presenting, false);
  await page
    .getByRole("dialog", { name: "幻灯片放映", exact: true })
    .waitFor({ state: "hidden" });
  await screenshot("playback-stopped.png");
  passed("start, next, previous, goto, status and stop", {
    status,
    stopped: playback,
  });

  step("Export PNG, SVG and PDF over MCP");
  await saveExport(documentId, "png", coverId);
  await saveExport(documentId, "svg", advancedId);
  await saveExport(documentId, "pdf");
  await saveExport(documentId, "pdf", advancedId);
  const sceneExport = await callRaw("export_canvas", {
    documentId,
    slideId: advancedId,
    subsceneId,
    format: "svg",
  });
  const nestedSvg = sceneExport.response.content.find(
    (item) => item.type === "resource",
  )?.resource.text;
  assert.match(nestedSvg, /<svg\b/);
  await fs.writeFile(path.join(artifacts, "nested-canvas.svg"), nestedSvg);
  passed("nested canvas SVG export");

  step("Persist, genuinely close and reopen the presentation");
  let saved = await call("save_presentation", { documentId });
  assert.equal(saved.dirty, false);
  assert.ok(saved.path.startsWith(`${drawings}${path.sep}`));
  assert.ok(saved.path.endsWith(".guzi-presentation"));
  const disk = JSON.parse(await fs.readFile(saved.path, "utf8"));
  assert.equal(disk.type, "guzi-presentation");
  assert.equal(disk.slides.length, 3);
  assert.equal(
    disk.slides
      .find((slide) => slide.id === secondId)
      .scene.elements.find((item) => item.id === second.idMap.override)
      .roughness,
    0,
  );
  const diskAdvanced = disk.slides.find(
    (slide) => slide.id === advancedId,
  ).scene;
  assert.ok(
    diskAdvanced.appState.subscenes[subsceneId].elements.some(
      (item) => item.text === "Nested drawing",
    ),
  );
  assert.ok(
    diskAdvanced.files[image.fileId].dataURL.startsWith(
      "data:image/png;base64,",
    ),
  );
  const savedPath = saved.path;
  const beforeClose = await readDeck(documentId);
  await call("close_document", { documentId });
  let listed = await call("list_canvases");
  assert.ok(!listed.canvases.some((item) => item.documentId === documentId));
  assert.ok(
    listed.files.some(
      (file) => file.path === savedPath && file.kind === "presentation",
    ),
  );
  const closedRead = await client.callTool({
    name: "read_presentation",
    arguments: { documentId },
  });
  assert.equal(closedRead.isError, true);
  assert.equal(decode(closedRead).error.code, "NOT_FOUND");
  const reopened = await call("open_canvas", { path: savedPath });
  assert.notEqual(
    reopened.documentId,
    documentId,
    "Reopening a genuinely closed file must allocate a new document ID",
  );
  const persisted = await readDeck(reopened.documentId);
  assert.deepEqual(
    persisted.slides.map(({ id, title }) => ({ id, title })),
    beforeClose.slides.map(({ id, title }) => ({ id, title })),
  );
  const reopenedAdvanced = await readScene(reopened.documentId, advancedId);
  const reopenedCover = await readScene(reopened.documentId, coverId);
  await assertTextMetrics(
    element(reopenedCover, cover.idMap.heading),
    "after save and reopen",
  );
  assert.equal(
    element(reopenedAdvanced, advanced.idMap.table).customData.table.cells.find(
      (cell) => cell.row === 1 && cell.column === 1,
    ).text,
    "verified",
  );
  assert.deepEqual(
    element(reopenedAdvanced, advanced.idMap.rich).richText,
    richText,
  );
  assert.ok(
    (
      await readScene(reopened.documentId, advancedId, subsceneId)
    ).elements.some((item) => item.text === "Nested drawing"),
  );
  await screenshot("sdk-reopened.png");
  report.savedPresentation = savedPath;
  passed("save, close, authorized file discovery and genuine reopen", {
    path: savedPath,
    originalDocumentId: documentId,
    reopenedDocumentId: reopened.documentId,
    slides: persisted.slides.length,
  });
  if (withCodex) {
    await call("close_document", { documentId: reopened.documentId });
    await runCodex(drawings);
  }
  rememberProcesses();
  assert.deepEqual(report.errors, [], "Renderer must not emit uncaught errors");
}

main()
  .catch(async (error) => {
    report.errors.push(error.stack || error.message);
    console.error(error.message);
    if (canScreenshot)
      await bounded(
        screenshot("failure.png"),
        "failure screenshot",
        5000,
      ).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await clean().catch((error) => {
      report.errors.push(`Cleanup: ${error.message}`);
      process.exitCode = 1;
    });
    report.completedAt = new Date().toISOString();
    report.passed = report.errors.length === 0 && process.exitCode !== 1;
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          report: path.join(artifacts, "report.json"),
          passed: report.passed,
          scenarios: report.scenarios.length,
          calls: report.calls.length,
          errors: report.errors,
          residualPids: report.residualPids,
        },
        null,
        2,
      ),
    );
  });
