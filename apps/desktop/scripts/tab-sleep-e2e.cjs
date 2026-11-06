const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const {
  enableMcpInSettings,
  waitForMcpReady,
} = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/tab-sleep",
);
const executablePath =
  process.env.EXCALIDRAW_E2E_EXECUTABLE || require("electron");
const sleepDelay = 5 * 60_000 + 1_000;
const report = {
  passed: false,
  scenarios: [],
  screenshots: [],
  memory: {},
  pageErrors: [],
  launches: [],
};
const owned = new Map();
let isolated;
let profile;
let launching;
let application;
let page;
let client;
let cdp;
let cleanupTask;
let stopped = false;

async function bounded(task, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(read, label, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
  })
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              command: match[3],
            },
          ]
        : [];
    });
}

function rememberProcesses() {
  const current = processes();
  const mainPid = application?.process()?.pid;
  for (const { pid, command } of current) {
    if (
      pid === mainPid ||
      (profile && command.split(" ").includes(`--user-data-dir=${profile}`))
    ) {
      owned.set(pid, command);
    }
  }
  const known = new Set(
    current
      .filter(({ pid, command }) => owned.get(pid) === command)
      .map(({ pid }) => pid),
  );
  let previousSize;
  do {
    previousSize = known.size;
    for (const { pid, parent, command } of current) {
      if (known.has(parent)) {
        known.add(pid);
        owned.set(pid, command);
      }
    }
  } while (known.size !== previousSize);
  return current.filter(({ pid, command }) => owned.get(pid) === command);
}

async function closeApplication() {
  // A signal or timeout can occur while Playwright is still launching.
  await launching?.catch(() => {});
  if (client) {
    await bounded(client.close(), 3_000, "MCP client close").catch(() => {});
    client = undefined;
  }
  if (application) {
    rememberProcesses();
    const current = application;
    application = undefined;
    await bounded(
      current.evaluate(({ app }) => app.exit(0)),
      5_000,
      "Electron exit",
    ).catch(() => {});
    await bounded(current.close(), 5_000, "Playwright Electron close").catch(
      () => {},
    );
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!rememberProcesses().length) return;
    await until(
      () => !rememberProcesses().length,
      "owned Electron exit",
      3_000,
    ).catch(() => {});
    for (const { pid } of rememberProcesses()) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  await until(
    () => !rememberProcesses().length,
    "owned Electron cleanup",
    5_000,
  );
}

function cleanup() {
  cleanupTask ??= (async () => {
    try {
      await closeApplication();
    } catch (error) {
      report.cleanupError = error.stack || String(error);
      report.passed = false;
    }
    report.remainingProcesses = rememberProcesses();
    report.ownedProcesses = [...owned].map(([pid, command]) => ({
      pid,
      command,
    }));
    report.cleanupPassed =
      report.remainingProcesses.length === 0 && !report.cleanupError;
    if (!report.cleanupPassed) report.passed = false;
    if (isolated && report.cleanupPassed) {
      await fs.rm(isolated, { recursive: true, force: true });
    }
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
  })();
  return cleanupTask;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopped = true;
    report.passed = false;
    report.error = `Interrupted by ${signal}`;
    void cleanup().finally(() => process.exit(1));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function launch({ configureMcp = false } = {}) {
  assert.ok(!stopped, "Acceptance run has stopped");
  launching = _electron
    .launch({
      executablePath,
      args: [desktopDirectory, `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        EXCALIDRAW_DESKTOP_USER_DATA: profile,
        EXCALIDRAW_DESKTOP_DEV_URL: "",
      },
      timeout: 30_000,
    })
    .then((current) => {
      application = current;
      rememberProcesses();
      return current;
    });
  await launching;
  launching = undefined;
  assert.ok(!stopped, "Acceptance run has stopped");
  const runtime = await bounded(
    application.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000);
      return {
        profile: app.getPath("userData"),
        version: app.getVersion(),
        platform: process.platform,
      };
    }),
    15_000,
    "Electron app state",
  );
  assert.equal(runtime.profile, profile);
  report.launches.push({ ...runtime, pid: application.process().pid });
  page = await bounded(application.firstWindow(), 20_000, "first window");
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) =>
    report.pageErrors.push(error.stack || String(error)),
  );
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const service = configureMcp
    ? await enableMcpInSettings(
        page,
        await bounded(freePort(), 5_000, "reserve MCP port"),
      )
    : await bounded(waitForMcpReady(page), 20_000, "restart MCP service");
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-tab-sleep-e2e", version: "1.0.0" });
  await bounded(
    client.connect(
      new StreamableHTTPClientTransport(new URL(service.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
      }),
    ),
    15_000,
    "MCP client connect",
  );
  cdp = await bounded(
    page.context().newCDPSession(page),
    10_000,
    "renderer CDP session",
  );
}

async function call(name, args = {}) {
  const response = await bounded(
    client.callTool({ name, arguments: args }),
    20_000,
    name,
  );
  const result =
    response.structuredContent ||
    JSON.parse(response.content.find((item) => item.type === "text").text);
  if (response.isError) {
    throw Object.assign(new Error(`${name}: ${JSON.stringify(result)}`), {
      code: result.error?.code,
    });
  }
  return result;
}

const pane = (id) =>
  page.locator(`.desktop-editor-pane[data-document-id=${JSON.stringify(id)}]`);
const tab = (title) =>
  page.getByRole("tab").filter({ has: page.getByText(title, { exact: true }) });
const asleep = (title) =>
  page
    .locator(".desktop-tab")
    .filter({ has: tab(title) })
    .locator(".desktop-tab-sleep");

const notes = "休眠后保留的演讲备注";
const editedCanvasColor = "#b2f2bb";
const childTitle = "休眠测试子画布";

async function editorGeometry(documentId, elementId) {
  // Use the mounted editor's scene-to-screen transform for native pointer input.
  return pane(documentId)
    .locator(".excalidraw")
    .first()
    .evaluate((editor, id) => {
      const fiberKey = Object.keys(editor).find((key) =>
        key.startsWith("__reactFiber$"),
      );
      for (let fiber = editor[fiberKey]; fiber; fiber = fiber.return) {
        const app = fiber.stateNode;
        if (!app?.viewport || !app.scene) continue;
        const { offsetLeft, offsetTop, scrollX, scrollY, zoom } = app.state;
        const element =
          id &&
          app.scene.getNonDeletedElements().find((item) => item.id === id);
        if (id && !element)
          throw new Error(`Cannot locate editor element ${id}`);
        const point = element
          ? {
              x:
                offsetLeft +
                (element.x + element.width / 2 + scrollX) * zoom.value,
              y:
                offsetTop +
                (element.y + element.height / 2 + scrollY) * zoom.value,
            }
          : null;
        const target =
          point && editor.ownerDocument.elementFromPoint(point.x, point.y);
        return {
          viewport: { scrollX, scrollY, zoom: zoom.value },
          mode: {
            interactive: app.isInteractionEnabled(),
            viewing: app.state.viewModeEnabled,
          },
          point,
          hit: element && {
            dom: target?.getAttribute("class"),
            elementId: app.getElementAtPosition(
              element.x + element.width / 2,
              element.y + element.height / 2,
            )?.id,
            activeTool: app.state.activeTool.type,
            preferredSelectionTool: app.state.preferredSelectionTool.type,
            animation: app.viewport.isAnimating,
          },
        };
      }
      throw new Error("Cannot locate the mounted production editor");
    }, elementId);
}

async function openNotes(deck) {
  const slide = deck.slides.find(({ id }) => id === deck.selected.id);
  const dialog = page.getByRole("dialog", {
    name: `“${slide.title}”的备注`,
    exact: true,
  });
  await pane(deck.documentId)
    .getByRole("button", {
      name: new RegExp(`^(添加|编辑)备注 ${slide.index + 1}:`),
    })
    .click();
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function closeNotes(dialog) {
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function snapshot(name) {
  rememberProcesses();
  const filename = `${name}.png`;
  await page.screenshot({
    path: path.join(artifacts, filename),
    timeout: 15_000,
  });
  report.screenshots.push(filename);
}

async function captureFailure() {
  if (!page || page.isClosed()) return;
  const diagnostics = await Promise.allSettled([
    page.screenshot({
      path: path.join(artifacts, "failure.png"),
      timeout: 5_000,
      mask: [
        page.locator(
          ".desktop-plugin-value code, .desktop-plugin-connection pre",
        ),
      ],
    }),
    page.locator("body").evaluate(
      (mounted) => {
        const ownerDocument = mounted.ownerDocument;
        const active = ownerDocument.querySelector(
          ".desktop-editor-pane.is-active",
        );
        return {
          activeDocument: active?.getAttribute("data-document-id"),
          tabs: Array.from(
            ownerDocument.querySelectorAll(".desktop-tab"),
            (tab) => ({
              title: tab.querySelector('[role="tab"]')?.textContent?.trim(),
              active: tab.classList.contains("is-active"),
              asleep: !!tab.querySelector(".desktop-tab-sleep"),
            }),
          ),
          dialogs: Array.from(
            ownerDocument.querySelectorAll('[role="dialog"]'),
            (dialog) => ({
              label: dialog.getAttribute("aria-label"),
              className: dialog.getAttribute("class"),
            }),
          ),
          buttons: Array.from(
            active?.querySelectorAll('button, [role="button"]') ?? [],
          )
            .filter(
              (button) =>
                button.getClientRects().length &&
                !button.closest(".desktop-mcp-settings"),
            )
            .slice(0, 100)
            .map((button) => ({
              name:
                button.getAttribute("aria-label") ||
                button.textContent.trim() ||
                button.getAttribute("title"),
              disabled: button.hasAttribute("disabled"),
              current: button.getAttribute("aria-current"),
            })),
        };
      },
      undefined,
      { timeout: 5_000 },
    ),
  ]);
  if (diagnostics[0].status === "fulfilled")
    report.screenshots.push("failure.png");
  report.failureDiagnosticErrors = diagnostics.flatMap((item) =>
    item.status === "rejected" ? [String(item.reason)] : [],
  );
  if (diagnostics[1].status === "fulfilled")
    report.failureDom = diagnostics[1].value;
}

async function sampleMemory(label) {
  const read = async () => {
    const [heapBytes, processesKiB] = await Promise.all([
      bounded(cdp.send("Runtime.getHeapUsage"), 10_000, "renderer heap usage"),
      bounded(
        application.evaluate(({ app, BrowserWindow }) => {
          const renderer =
            BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
          return app
            .getAppMetrics()
            .filter(({ pid, type }) => pid === renderer || type === "GPU")
            .map(({ pid, type, memory }) => ({ pid, type, memory }));
        }),
        10_000,
        "Electron renderer and GPU metrics",
      ),
    ]);
    assert.ok(Number.isFinite(heapBytes.usedSize), "renderer heap measurement");
    assert.ok(
      processesKiB.some(({ type }) => type === "Tab"),
      "Electron renderer measurement",
    );
    return { heapBytes, processesKiB };
  };
  const beforeGC = await read();
  await bounded(cdp.send("HeapProfiler.collectGarbage"), 15_000, "renderer GC");
  const afterGC = await read();
  report.memory[label] = {
    beforeGC,
    afterGC,
    gcHeapUsedDeltaBytes:
      afterGC.heapBytes.usedSize - beforeGC.heapBytes.usedSize,
  };
}

const readCanvas = (documentId, slideId, subsceneId) =>
  call("read_canvas", { documentId, slideId, subsceneId });
const readDeck = (documentId) => call("read_presentation", { documentId });
const apply = ({ documentId, slideId, subsceneId, revision }, operations) =>
  call("apply_operations", {
    documentId,
    slideId,
    subsceneId,
    expectedRevision: revision,
    requestId: randomUUID(),
    operations,
  });

const rectangle = {
  type: "create",
  tempId: "rectangle",
  element: {
    type: "rectangle",
    x: 40,
    y: 40,
    width: 210,
    height: 140,
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
  },
};

async function populate(documentId, images, slideId) {
  const scene = await readCanvas(documentId, slideId);
  const result = await apply(scene, [
    rectangle,
    ...images.map((dataURL, index) => ({
      type: "create",
      tempId: `image-${index}`,
      element: {
        type: "image",
        x: 280 + index * 390,
        y: 40,
        width: 360,
        height: 360,
        file: { mimeType: "image/png", dataURL },
      },
    })),
  ]);
  return result.idMap.rectangle;
}

async function verifyScene(
  documentId,
  rectangleId,
  imageCount,
  slideId,
  color = "#a5d8ff",
) {
  const scene = await readCanvas(documentId, slideId);
  assert.equal(
    scene.elements.find(({ id }) => id === rectangleId)?.backgroundColor,
    color,
  );
  assert.equal(
    scene.elements.filter(({ type }) => type === "image").length,
    imageCount,
  );
  assert.equal(scene.files.length, imageCount);
  return scene;
}

async function waitForSleep(background, foreground) {
  await bounded(
    page.clock.fastForward(sleepDelay),
    15_000,
    "advance background inactivity",
  );
  await Promise.all(
    background.flatMap(({ title, documentId }) => [
      asleep(title).waitFor({ state: "attached", timeout: 25_000 }),
      pane(documentId).waitFor({ state: "detached", timeout: 25_000 }),
    ]),
  );
  // The main process creates MCP request expirations with its real wall clock.
  await page.clock.setSystemTime(Date.now());
  assert.equal(await pane(foreground.documentId).count(), 1);
  assert.equal(await page.locator(".desktop-editor-pane").count(), 1);
  assert.equal(
    await page.locator(".desktop-tab-sleep").count(),
    background.length,
  );
  assert.equal(
    (await call("list_canvases")).activeDocumentId,
    foreground.documentId,
  );
}

async function verifyDeckWake(deck) {
  await tab(deck.title).click();
  await pane(deck.documentId).waitFor({ state: "visible" });
  await asleep(deck.title).waitFor({ state: "detached" });
  const reopened = await readDeck(deck.documentId);
  assert.equal(reopened.activeSlideId, deck.selected.id);
  assert.deepEqual(
    reopened.slides.map(({ id, title }) => ({ id, title })),
    deck.slides.map(({ id, title }) => ({ id, title })),
  );
  await verifyScene(
    deck.documentId,
    deck.selected.rectangleId,
    2,
    deck.selected.id,
  );
  assert.deepEqual(
    (await editorGeometry(deck.documentId)).viewport,
    deck.viewport,
  );
  const dialog = await openNotes(deck);
  assert.equal(await dialog.getByRole("textbox").inputValue(), notes);
  await closeNotes(dialog);
}

async function openChildCanvas(documentId) {
  const created = await apply(await readCanvas(documentId), [
    {
      type: "create",
      tempId: "child-pin",
      element: {
        type: "subcanvas",
        x: 40,
        y: 260,
        width: 190,
        height: 100,
        title: childTitle,
      },
    },
  ]);
  const pinId = created.idMap["child-pin"];
  const root = await readCanvas(documentId);
  const childId = root.elements.find(({ id }) => id === pinId).customData
    .subcanvas.sceneId;
  const child = await apply(await readCanvas(documentId, undefined, childId), [
    rectangle,
  ]);
  await call("control_canvas", { documentId, action: "fit", ids: [pinId] });
  const geometry = await editorGeometry(documentId, pinId);
  report.childPointer = { pinId, ...geometry };
  const events = [];
  const trace = ({ type, x, y, target, detail, trusted }) =>
    events.push({ type, x, y, target, detail, trusted });
  await page.exposeBinding("recordChildPointer", (_, event) => trace(event));
  await pane(documentId).evaluate((mounted) => {
    const ownerDocument = mounted.ownerDocument;
    const record = (event) => {
      void ownerDocument.defaultView.recordChildPointer({
        type: event.type,
        x: event.clientX,
        y: event.clientY,
        target: event.target?.getAttribute?.("class"),
        detail: event.detail,
        trusted: event.isTrusted,
      });
    };
    const types = ["pointerdown", "pointerup", "click", "dblclick"];
    function observe(event) {
      record(event);
      if (event.type === "dblclick") {
        for (const type of types)
          ownerDocument.removeEventListener(type, observe, true);
      }
    }
    for (const type of types) {
      ownerDocument.addEventListener(type, observe, true);
    }
  });
  report.childPointer.events = events;
  await page.mouse.dblclick(geometry.point.x, geometry.point.y, { delay: 80 });
  const breadcrumb = pane(documentId).getByRole("navigation", {
    name: "画布路径",
  });
  await breadcrumb
    .getByRole("button", { name: childTitle, exact: true })
    .waitFor();
  return { childId, rectangleId: child.idMap.rectangle };
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-tab-sleep-"));
  profile = path.join(isolated, "profile");
  const workspace = path.join(isolated, "workspace");
  await Promise.all([fs.mkdir(profile), fs.mkdir(workspace)]);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: workspace,
      language: "zh-CN",
      theme: "light",
    }),
  );
  await launch({ configureMcp: true });
  await page.clock.install();

  const deckCount = 4;
  const pagesPerDeck = 4;
  const imageDataURLs = await bounded(
    application.evaluate(({ nativeImage }, count) => {
      const width = 800;
      const height = 800;
      const bitmap = Buffer.alloc(width * height * 4);
      return Array.from({ length: count }, (_, index) => {
        const color = Buffer.from([
          (index * 21 + 60) % 256,
          (index * 11 + 80) % 256,
          (index * 17 + 100) % 256,
          255,
        ]);
        const stripe = Buffer.from([225, (index * 19 + 40) % 256, 80, 255]);
        bitmap.fill(color);
        bitmap.fill(
          stripe,
          (60 + index * 5) * width * 4,
          (340 + index * 5) * width * 4,
        );
        return nativeImage
          .createFromBitmap(bitmap, { width, height })
          .toDataURL();
      });
    }, 2 + deckCount * pagesPerDeck * 2),
    20_000,
    "create fixture images",
  );
  report.fixture = {
    tabs: 6,
    deckCount,
    pagesPerDeck,
    imageCount: imageDataURLs.length,
  };

  const canvas = await call("create_canvas", { title: "休眠测试未保存画布" });
  const canvasRectangle = await populate(
    canvas.documentId,
    imageDataURLs.splice(0, 2),
  );
  await apply(await verifyScene(canvas.documentId, canvasRectangle, 2), [
    {
      type: "patch",
      id: canvasRectangle,
      patch: { backgroundColor: editedCanvasColor },
    },
  ]);

  const decks = [];
  for (let index = 0; index < deckCount; index++) {
    const created = await call("create_presentation", {
      title: `休眠演示 ${index + 1}`,
    });
    let deck = await readDeck(created.documentId);
    for (let number = 2; number <= pagesPerDeck; number++) {
      deck = await call("update_presentation", {
        documentId: deck.documentId,
        expectedRevision: deck.revision,
        requestId: randomUUID(),
        operation: { type: "add", title: `Fixture ${number}` },
      });
    }
    const rectangles = new Map();
    for (const { id } of deck.slides) {
      rectangles.set(
        id,
        await populate(deck.documentId, imageDataURLs.splice(0, 2), id),
      );
    }
    deck = await readDeck(created.documentId);
    assert.equal(deck.slides.length, pagesPerDeck);
    assert.equal(deck.activeSlideId, deck.slides.at(-1).id);
    const selected = {
      id: deck.activeSlideId,
      rectangleId: rectangles.get(deck.activeSlideId),
    };
    const selectedScene = await verifyScene(
      deck.documentId,
      selected.rectangleId,
      2,
      selected.id,
    );
    const fixture = { ...deck, selected, selectedScene };
    if (index === 0) {
      const dialog = await openNotes(fixture);
      await dialog.getByRole("textbox").fill(notes);
      await closeNotes(dialog);
      await call("control_canvas", {
        documentId: deck.documentId,
        slideId: selected.id,
        action: "fit",
        ids: [selected.rectangleId],
      });
      await call("control_canvas", {
        documentId: deck.documentId,
        slideId: selected.id,
        action: "zoom",
        zoom: 1.25,
      });
      fixture.viewport = (await editorGeometry(deck.documentId)).viewport;
      assert.equal(fixture.viewport.zoom, 1.25);
    }
    decks.push(fixture);
  }
  const foreground = await call("create_canvas", { title: "保持前台" });
  const background = [canvas, ...decks];
  assert.equal(await page.locator(".desktop-editor-pane").count(), 6);
  await snapshot("01-awake");
  await sampleMemory("sixEditorsAwake");

  await waitForSleep(background, foreground);
  await snapshot("02-background-asleep");
  await sampleMemory("fiveEditorsAsleep");
  report.scenarios.push(
    "Five inactive editors unmounted with sleep leaves; active editor stayed mounted",
  );
  await verifyDeckWake(decks[0]);
  await snapshot("03-presentation-restored");
  await tab(foreground.title).click();
  report.scenarios.push(
    "Tab click restored presentation slide order, selected page, viewport, speaker notes, shape and images",
  );

  assert.equal(await asleep(canvas.title).count(), 1);
  await verifyScene(
    canvas.documentId,
    canvasRectangle,
    2,
    undefined,
    editedCanvasColor,
  );
  await pane(canvas.documentId).waitFor({ state: "attached" });
  await asleep(canvas.title).waitFor({ state: "detached" });
  assert.equal(
    (await call("list_canvases")).activeDocumentId,
    foreground.documentId,
  );

  const edited = decks[1];
  assert.equal(await asleep(edited.title).count(), 1);
  await apply(edited.selectedScene, [
    {
      type: "patch",
      id: edited.selected.rectangleId,
      patch: { backgroundColor: "#ffa8a8" },
    },
  ]);
  await pane(edited.documentId).waitFor({ state: "attached" });
  await asleep(edited.title).waitFor({ state: "detached" });
  await verifyScene(
    edited.documentId,
    edited.selected.rectangleId,
    2,
    edited.selected.id,
    "#ffa8a8",
  );
  assert.equal(
    (await call("list_canvases")).activeDocumentId,
    foreground.documentId,
  );
  await snapshot("04-mcp-background-wake");
  report.scenarios.push(
    "Authenticated MCP read and direct write woke separate inactive tabs without changing active document",
  );

  await waitForSleep(background, foreground);
  await verifyDeckWake(decks[0]);
  assert.equal(await asleep(canvas.title).count(), 1);
  await tab(canvas.title).click();
  await pane(canvas.documentId).waitFor({ state: "visible" });
  await verifyScene(
    canvas.documentId,
    canvasRectangle,
    2,
    undefined,
    editedCanvasColor,
  );
  report.canvasWakeEditorMode = (await editorGeometry(canvas.documentId)).mode;
  assert.deepEqual(
    report.canvasWakeEditorMode,
    { interactive: true, viewing: false },
    "Tab click should restore an editable ordinary canvas",
  );
  await call("control_canvas", {
    documentId: canvas.documentId,
    action: "undo",
  });
  await verifyScene(canvas.documentId, canvasRectangle, 2);
  await call("control_canvas", {
    documentId: canvas.documentId,
    action: "redo",
  });
  await verifyScene(
    canvas.documentId,
    canvasRectangle,
    2,
    undefined,
    editedCanvasColor,
  );
  report.scenarios.push(
    "Ordinary canvas restored undo and redo across editor unmount",
  );
  const child = await openChildCanvas(canvas.documentId);
  await tab(foreground.title).click();
  await waitForSleep(background, foreground);
  await sampleMemory("fiveEditorsAsleepAfterRepeat");
  const { sixEditorsAwake, fiveEditorsAsleep } = report.memory;
  report.memory.sleepHeapUsedDeltaBytes = {
    beforeGC:
      fiveEditorsAsleep.beforeGC.heapBytes.usedSize -
      sixEditorsAwake.beforeGC.heapBytes.usedSize,
    afterGC:
      fiveEditorsAsleep.afterGC.heapBytes.usedSize -
      sixEditorsAwake.afterGC.heapBytes.usedSize,
  };
  await verifyScene(
    edited.documentId,
    edited.selected.rectangleId,
    2,
    edited.selected.id,
    "#ffa8a8",
  );
  assert.equal(
    (await call("list_canvases")).activeDocumentId,
    foreground.documentId,
  );
  await tab(canvas.title).click();
  const childBreadcrumb = pane(canvas.documentId)
    .getByRole("navigation", { name: "画布路径" })
    .getByRole("button", { name: childTitle, exact: true });
  await childBreadcrumb.waitFor({ state: "visible" });
  assert.equal(await childBreadcrumb.getAttribute("aria-current"), "page");
  const childScene = await readCanvas(
    canvas.documentId,
    undefined,
    child.childId,
  );
  assert.ok(childScene.elements.some(({ id }) => id === child.rectangleId));
  await snapshot("05-subcanvas-restored");
  report.scenarios.push(
    "Tab click restored the open subcanvas path and child content",
  );
  const draft = JSON.parse(
    await fs.readFile(
      path.join(profile, "drafts", `${canvas.documentId}.json`),
      "utf8",
    ),
  );
  assert.equal(draft.path, null);
  assert.ok(
    JSON.parse(draft.content).elements.some(({ id }) => id === canvasRectangle),
  );
  report.scenarios.push(
    "Three sleep rounds preserved ordinary and presentation content and the unsaved recovery draft",
  );

  await closeApplication();
  await launch();
  await page.getByRole("button", { name: "查看并恢复", exact: true }).click();
  const recovery = page.getByRole("dialog", {
    name: "恢复未保存的画布",
    exact: true,
  });
  const canvasDraft = recovery
    .locator("article")
    .filter({ hasText: canvas.title });
  await canvasDraft.getByRole("button", { name: "恢复", exact: true }).click();
  await pane(canvas.documentId).waitFor({ state: "visible" });
  const recovered = await until(async () => {
    try {
      return await verifyScene(
        canvas.documentId,
        canvasRectangle,
        2,
        undefined,
        editedCanvasColor,
      );
    } catch (error) {
      if (error.code !== "NOT_READY") throw error;
      return false;
    }
  }, "recovered canvas initialization");
  assert.equal(recovered.dirty, true);
  assert.equal(recovered.path, null);
  await snapshot("06-recovered-draft");
  report.scenarios.push(
    "Restart recovered the unsaved canvas and its images through the project recovery dialog",
  );
  assert.deepEqual(
    report.pageErrors,
    [],
    "Renderer emitted unhandled page errors",
  );
  report.passed = true;
}

(async () => {
  try {
    await bounded(main(), 240_000, "complete tab sleep acceptance");
  } catch (error) {
    report.error = error.stack || String(error);
    console.error(report.error);
    await captureFailure();
  } finally {
    stopped = true;
    await cleanup();
    console.log(path.join(artifacts, "report.json"));
    process.exitCode = report.passed ? 0 : 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
