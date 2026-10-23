const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright");
const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const repository = path.resolve(desktopDirectory, "../..");
const executableIndex = process.argv.indexOf("--executable");
const sourceIndex = process.argv.indexOf("--source");
const roundsIndex = process.argv.indexOf("--rounds");
const executablePath =
  executableIndex < 0 ? require("electron") : process.argv[executableIndex + 1];
const sourceArgument =
  sourceIndex < 0 ? undefined : process.argv[sourceIndex + 1];
assert.ok(
  sourceArgument && !sourceArgument.startsWith("--"),
  "--source <path> is required for an existing presentation",
);
const sourcePath = path.resolve(sourceArgument);
assert.ok(
  fsSync.statSync(sourcePath).isFile(),
  "--source must point to a file",
);
const rounds = roundsIndex < 0 ? 3 : Number(process.argv[roundsIndex + 1]);
assert.ok(
  Number.isInteger(rounds) && rounds >= 2 && rounds <= 10,
  "--rounds must be an integer from 2 to 10",
);
const artifacts = path.join(
  repository,
  "output/playwright/mcp-chinese-presentation-e2e",
);
const report = {
  executablePath,
  sourcePath,
  rounds,
  scenarios: [],
  calls: [],
  exports: [],
  rendererProcessEvents: [],
  rendererCrashes: [],
  childProcessEvents: [],
  pageErrors: [],
  errors: [],
  launchedPids: [],
};
const ownedPids = new Set();
let application;
let page;
let client;
let endpoint;
let cleanPromise;
let cleaning = false;
let canScreenshot = false;
let serial = 0;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bounded = (promise, name, ms = 20000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), ms);
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
const screenshot = (name) =>
  page.screenshot({ path: path.join(artifacts, name), fullPage: true });
const processSnapshot = () =>
  execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
function rememberProcesses() {
  if (application) ownedPids.add(application.process().pid);
  const rows = processSnapshot();
  let changed;
  do {
    changed = false;
    for (const [pid, parent] of rows) {
      if (ownedPids.has(parent) && !ownedPids.has(pid)) {
        ownedPids.add(pid);
        changed = true;
      }
    }
  } while (changed);
}

async function collectProcessEvents() {
  if (!application) return;
  const events = await bounded(
    application.evaluate(() => globalThis.__mcpChineseProcessEvents),
    "read renderer crash events",
    3000,
  ).catch(() => null);
  if (!events) return;
  report.rendererProcessEvents = events.renderer;
  report.rendererCrashes = [
    ...report.rendererCrashes.filter((event) => event.source !== "electron"),
    ...events.renderer
      .filter((event) => event.reason !== "clean-exit")
      .map((event) => ({ source: "electron", ...event })),
  ];
  report.childProcessEvents = events.child;
}

async function assertHealthy() {
  await collectProcessEvents();
  assert.deepEqual(
    report.rendererCrashes,
    [],
    "Renderer process must not crash",
  );
  assert.deepEqual(report.pageErrors, [], "Renderer must not emit page errors");
  assert.deepEqual(report.errors, [], "Application must remain running");
}

async function clean() {
  return (cleanPromise ??= (async () => {
    cleaning = true;
    rememberProcesses();
    await collectProcessEvents();
    await bounded(
      client?.close() || Promise.resolve(),
      "MCP client close",
      5000,
    ).catch(() => {});
    if (application) {
      await bounded(
        page?.evaluate(() => window.desktop.setPluginEnabled("mcp", false)) ||
          Promise.resolve(),
        "disable isolated MCP",
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
        await bounded(application.close(), "close isolated Electron", 10000);
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
      "All test-owned processes must exit",
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
  const entry = {
    name,
    documentId: args.documentId,
    slideId: args.slideId,
    action: args.action,
    operation: args.operation?.type,
    format: args.format,
    startedAt: new Date().toISOString(),
  };
  report.calls.push(entry);
  const started = Date.now();
  try {
    const response = await client.callTool({ name, arguments: args });
    const result = decode(response);
    entry.milliseconds = Date.now() - started;
    entry.isError = !!response.isError;
    if (response.isError) entry.error = result.error;
    assert.ok(!response.isError, `${name}: ${JSON.stringify(result)}`);
    await assertHealthy();
    return { response, result };
  } catch (error) {
    entry.milliseconds = Date.now() - started;
    entry.failure = error.message;
    await collectProcessEvents();
    throw error;
  }
}
const call = async (name, args) => (await callRaw(name, args)).result;
const readDeck = (documentId) => call("read_presentation", { documentId });
async function update(documentId, operation) {
  const deck = await readDeck(documentId);
  return call("update_presentation", {
    documentId,
    expectedRevision: deck.revision,
    requestId: `chinese-deck-${++serial}`,
    operation,
  });
}
async function apply(documentId, slideId, operations) {
  const scene = await call("read_canvas", { documentId, slideId });
  return call("apply_operations", {
    documentId,
    slideId,
    expectedRevision: scene.revision,
    requestId: `chinese-scene-${++serial}`,
    operations,
  });
}

async function exportFile(
  documentId,
  format,
  round,
  index,
  slideId,
  slideCount,
) {
  const { response } = await callRaw("export_presentation", {
    documentId,
    format,
    ...(slideId ? { slideId } : {}),
  });
  const filename =
    format === "pdf"
      ? `round-${round}-deck.pdf`
      : `round-${round}-slide-${String(index + 1).padStart(2, "0")}.${format}`;
  const output = path.join(artifacts, filename);
  let bytes;
  let fonts;
  if (format === "png") {
    const image = response.content.find(
      (item) => item.type === "image" && item.mimeType === "image/png",
    );
    assert.ok(image, "PNG must return real MCP image content");
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
      const parsed = await page.evaluate((xml) => {
        const ownerDocument =
          document.querySelector(".desktop-workspace").ownerDocument;
        const svg = new ownerDocument.defaultView.DOMParser().parseFromString(
          xml,
          "image/svg+xml",
        );
        return {
          name: svg.documentElement.localName,
          errors: svg.querySelectorAll("parsererror").length,
          width: svg.documentElement.getAttribute("width"),
          height: svg.documentElement.getAttribute("height"),
        };
      }, resource.text);
      assert.equal(parsed.name, "svg");
      assert.equal(parsed.errors, 0);
      assert.equal(Number(parsed.width), 1280);
      assert.equal(Number(parsed.height), 720);
      fonts = (resource.text.match(/@font-face/g) || []).length;
      assert.ok(fonts > 0, "Chinese SVG must embed font faces");
      bytes = Buffer.from(resource.text);
    } else {
      bytes = Buffer.from(resource.blob, "base64");
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.match(bytes.subarray(-100).toString(), /%%EOF/);
    }
  }
  assert.ok(bytes.length > 100);
  await fs.writeFile(output, bytes);
  let pages;
  if (format === "pdf") {
    const info = execFileSync("pdfinfo", [output], { encoding: "utf8" });
    pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    assert.equal(pages, slideCount);
    await fs.writeFile(
      path.join(artifacts, `round-${round}-pdfinfo.txt`),
      info,
    );
  }
  report.exports.push({
    format,
    path: output,
    bytes: bytes.length,
    pages,
    fonts,
    round,
    slideId,
  });
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const source = await fs.readFile(sourcePath);
  const original = JSON.parse(source);
  assert.equal(original.type, "guzi-presentation");
  assert.equal(
    original.slides.length,
    6,
    "The saved regression source must contain its six existing slides",
  );
  report.sourceSha256 = digest(source);
  report.originalSlides = original.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    elements: slide.scene.elements.length,
  }));
  const isolated = await fs.mkdtemp(path.join(artifacts, "isolated-"));
  const profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  const fixture = path.join(drawings, "中文字体隔离回归.guzi-presentation");
  await fs.writeFile(fixture, source);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  report.isolated = isolated;
  report.fixture = fixture;
  step("Launch isolated Electron and record renderer crash events");
  application = await _electron.launch({
    executablePath,
    args: executableIndex < 0 ? [desktopDirectory] : [],
    env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile },
    timeout: 60000,
  });
  application.process().on("exit", (code, signal) => {
    if (!cleaning)
      report.errors.push(
        `Electron exited unexpectedly: code=${code} signal=${signal}`,
      );
  });
  rememberProcesses();
  await application.evaluate(({ app }) => {
    globalThis.__mcpChineseProcessEvents = { renderer: [], child: [] };
    app.on("render-process-gone", (_event, contents, details) => {
      globalThis.__mcpChineseProcessEvents.renderer.push({
        at: new Date().toISOString(),
        webContentsId: contents.id,
        ...details,
      });
    });
    app.on("child-process-gone", (_event, details) => {
      globalThis.__mcpChineseProcessEvents.child.push({
        at: new Date().toISOString(),
        ...details,
      });
    });
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  application.on("window", (window) =>
    window.on("crash", () =>
      report.rendererCrashes.push({
        source: "playwright",
        at: new Date().toISOString(),
      }),
    ),
  );
  page.on("crash", () =>
    report.rendererCrashes.push({
      source: "playwright",
      at: new Date().toISOString(),
    }),
  );
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  step("Enable isolated MCP endpoint");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const plugin = await enableMcpInSettings(page, port);
  assert.equal(plugin.status, "running", plugin.error || plugin.status);
  endpoint = plugin.endpoint;
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({
    name: "guzi-chinese-presentation-e2e",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${plugin.token}` } },
    }),
  );
  report.tools = (await client.listTools()).tools.map((tool) => tool.name);
  step("Open a copy of the six-slide real Chinese presentation");
  let deck = await call("open_canvas", { path: fixture });
  const documentId = deck.documentId;
  assert.equal(deck.slides.length, 6);
  await page.getByRole("toolbar", { name: "演示文稿", exact: true }).waitFor();
  canScreenshot = true;
  await screenshot("original-six-slide-copy.png");
  passed("read-only copy of the real Chinese presentation", {
    slides: deck.slides.length,
    sourceSha256: report.sourceSha256,
  });

  step(
    "Add two Chinese long-title, multiline-label and formula stress slides to the copy",
  );
  const addedIds = [];
  for (const [index, title] of [
    "07 · 中文长标题、绑定标签与公式回归",
    "08 · 多页连续导出与放映稳定性",
  ].entries()) {
    deck = await update(documentId, {
      type: "add",
      title,
      afterSlideId: deck.slides.at(-1).id,
    });
    const slideId = deck.activeSlideId;
    addedIds.push(slideId);
    const created = await apply(documentId, slideId, [
      {
        type: "create",
        tempId: "title",
        element: {
          type: "text",
          x: 64,
          y: 44,
          text: index
            ? "多页稳定性：中文、生僻字、数学符号与手绘字体的连续渲染验证"
            : "中文长标题：从注意力到多头表示，验证手写字体、导出和持久化",
          fontSize: 30,
        },
      },
      {
        type: "create",
        tempId: "query",
        element: {
          type: "rectangle",
          x: 80,
          y: 180,
          width: 320,
          height: 210,
          label: {
            text: "查询 Query · Q\n我在寻找什么？\n缩放与数值稳定性",
            fontSize: 25,
          },
        },
      },
      {
        type: "create",
        tempId: "value",
        element: {
          type: "rectangle",
          x: 850,
          y: 180,
          width: 340,
          height: 210,
          label: {
            text: "键和值 Key / Value\n根据上下文建立联系\n中文多行标签与箭头绑定",
            fontSize: 25,
          },
        },
      },
      {
        type: "create",
        tempId: "arrow",
        element: {
          type: "arrow",
          x: 400,
          y: 285,
          width: 450,
          height: 0,
          start: { id: "query" },
          end: { id: "value" },
          label: {
            text: "相似度分数 → 概率分布\nsoftmax(QKᵀ / √dₖ)",
            fontSize: 22,
          },
        },
      },
      {
        type: "create",
        tempId: "formula",
        element: {
          type: "text",
          x: 64,
          y: 460,
          text: index
            ? "zᵢ = ∑ⱼ αᵢⱼvⱼ；μ、σ、ε、θ、ℓ、⊕ 与 ×\n梯度、蒸馏、稀疏、噪声、嵌入、掩码、泛化与收敛。\n验证第八页：保存重开后仍保留完整中文内容。"
            : "Attention(Q, K, V) = softmax(QKᵀ / √dₖ)V\nPE(pos, 2i) = sin(pos / 10000^(2i/d_model))\n中文备注：概率和为 1，保留上下文依赖与相对位置。",
          fontSize: 27,
        },
      },
    ]);
    const scene = await call("read_canvas", { documentId, slideId });
    const arrow = scene.elements.find(
      (element) => element.id === created.idMap.arrow,
    );
    assert.ok(arrow.startBinding && arrow.endBinding);
    assert.ok(
      scene.elements.some(
        (element) =>
          element.type === "text" &&
          element.containerId &&
          element.text.includes("\n") &&
          /中文|查询/.test(element.text),
      ),
    );
    for (const text of scene.elements.filter(
      (element) => element.type === "text",
    ))
      assert.equal(text.fontFamily, 5);
    await screenshot(`added-slide-${index + 7}.png`);
  }
  deck = await readDeck(documentId);
  assert.equal(deck.slides.length, 8);
  passed(
    "eight slides with Chinese long titles, bound multiline labels and formulas",
    { addedIds },
  );

  for (let round = 1; round <= rounds; round++) {
    step(
      `Round ${round}/${rounds}: export all eight slides to PNG and SVG, then the deck to PDF`,
    );
    for (const [index, slide] of deck.slides.entries()) {
      await exportFile(
        documentId,
        "png",
        round,
        index,
        slide.id,
        deck.slides.length,
      );
      await exportFile(
        documentId,
        "svg",
        round,
        index,
        slide.id,
        deck.slides.length,
      );
    }
    await exportFile(
      documentId,
      "pdf",
      round,
      0,
      undefined,
      deck.slides.length,
    );
    passed(`round ${round} continuous PNG/SVG/PDF exports`, {
      slides: deck.slides.length,
    });
    step(
      `Round ${round}/${rounds}: start, visit every slide and stop the real player`,
    );
    let playback = await call("control_presentation", {
      documentId,
      action: "start",
      slideId: deck.slides[0].id,
    });
    assert.equal(playback.presenting, true);
    await page
      .getByRole("dialog", { name: "幻灯片放映", exact: true })
      .waitFor();
    await screenshot(`round-${round}-playback-start.png`);
    for (const [index, slide] of deck.slides.entries()) {
      playback = await call("control_presentation", {
        documentId,
        action: "goto",
        slideId: slide.id,
      });
      assert.equal(playback.slideId, slide.id);
      assert.equal(playback.presenting, true);
      if (index === 1 || index >= 6)
        await screenshot(`round-${round}-playback-slide-${index + 1}.png`);
    }
    playback = await call("control_presentation", {
      documentId,
      action: "status",
    });
    assert.equal(playback.slideCount, 8);
    assert.equal(playback.slideId, addedIds[1]);
    playback = await call("control_presentation", {
      documentId,
      action: "stop",
    });
    assert.equal(playback.presenting, false);
    await page
      .getByRole("dialog", { name: "幻灯片放映", exact: true })
      .waitFor({ state: "hidden" });
    await assertHealthy();
    passed(`round ${round} playback of all Chinese slides`);
    rememberProcesses();
  }

  step("Save the isolated eight-slide copy, genuinely close it and reopen it");
  const saved = await call("save_presentation", { documentId });
  assert.equal(saved.path, fixture);
  assert.equal(saved.dirty, false);
  const disk = JSON.parse(await fs.readFile(fixture, "utf8"));
  assert.equal(disk.slides.length, 8);
  await call("close_document", { documentId });
  assert.ok(
    !(await call("list_canvases")).canvases.some(
      (item) => item.documentId === documentId,
    ),
  );
  const reopened = await call("open_canvas", { path: fixture });
  assert.notEqual(reopened.documentId, documentId);
  const persisted = await readDeck(reopened.documentId);
  assert.deepEqual(
    persisted.slides.map(({ id, title }) => ({ id, title })),
    deck.slides.map(({ id, title }) => ({ id, title })),
  );
  const lastScene = await call("read_canvas", {
    documentId: reopened.documentId,
    slideId: addedIds[1],
  });
  assert.ok(
    lastScene.elements.some((element) =>
      element.text?.includes("保存重开后仍保留完整中文内容"),
    ),
  );
  await update(reopened.documentId, { type: "select", slideId: addedIds[1] });
  await screenshot("reopened-eight-slide-copy.png");
  await exportFile(reopened.documentId, "png", "reopened", 7, addedIds[1], 8);
  await exportFile(reopened.documentId, "pdf", "reopened", 0, undefined, 8);
  report.sourceSha256After = digest(await fs.readFile(sourcePath));
  report.sourceUnchanged = report.sourceSha256After === report.sourceSha256;
  assert.equal(
    report.sourceUnchanged,
    true,
    "The user's original presentation must remain unchanged",
  );
  report.savedPresentation = fixture;
  passed("save, close, reopen and re-export the isolated Chinese copy", {
    path: fixture,
    slides: 8,
    sourceUnchanged: report.sourceUnchanged,
  });
  await assertHealthy();
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
    report.passed =
      report.errors.length === 0 &&
      report.rendererCrashes.length === 0 &&
      process.exitCode !== 1;
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
          exports: report.exports.length,
          rendererCrashes: report.rendererCrashes,
          errors: report.errors,
          residualPids: report.residualPids,
        },
        null,
        2,
      ),
    );
  });
