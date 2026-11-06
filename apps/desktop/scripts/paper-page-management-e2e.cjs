const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/paper-page-management",
);
const executablePath =
  process.env.EXCALIDRAW_E2E_EXECUTABLE || require("electron");
const report = {
  passed: false,
  scenarios: [],
  screenshots: [],
  samples: {},
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

async function launch() {
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
  const service = await enableMcpInSettings(
    page,
    await bounded(freePort(), 5_000, "reserve MCP port"),
  );
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({
    name: "guzi-paper-page-management-e2e",
    version: "1.0.0",
  });
  await bounded(
    client.connect(
      new StreamableHTTPClientTransport(new URL(service.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
      }),
    ),
    15_000,
    "MCP client connect",
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

const activePane = () => page.locator(".desktop-editor-pane.is-active");
const management = () =>
  activePane().getByRole("region", { name: "页面管理", exact: true });
const pageRows = () => management().locator(".desktop-paper-page-list > li");
const pageLink = (number) =>
  management().getByRole("button", { name: `第 ${number} 页`, exact: true });
const managementAction = (name) =>
  management().getByRole("button", { name, exact: true });
const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function screenshot(name) {
  if (!page || page.isClosed()) return;
  rememberProcesses();
  const filename = `${name}.png`;
  await page.screenshot({
    path: path.join(artifacts, filename),
    timeout: 8_000,
    mask: [
      page.locator(
        ".desktop-plugin-value code, .desktop-plugin-connection pre",
      ),
    ],
  });
  report.screenshots.push(filename);
}

async function readScene(documentId) {
  const scene = await call("read_canvas", { documentId });
  return {
    ...scene,
    papers: scene.elements
      .filter(
        (element) =>
          element.type === "frame" &&
          element.customData?.guziPaper?.version === 1,
      )
      .sort((left, right) => left.y - right.y || left.x - right.x),
  };
}

const orderOf = (scene) => scene.papers.map(({ id }) => id);

async function waitOrder(documentId, expected, label) {
  return until(async () => {
    const scene = await readScene(documentId);
    return JSON.stringify(orderOf(scene)) === JSON.stringify(expected) && scene;
  }, label);
}

const byId = (scene, id) => scene.elements.find((element) => element.id === id);

async function openManagement() {
  const toggle = activePane().getByRole("button", {
    name: "页面管理",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await management().waitFor();
}

async function expectActive(number) {
  await until(
    async () =>
      (await pageLink(number).getAttribute("aria-current")) === "page",
    `page ${number} active`,
  );
  assert.equal(await pageRows().locator("[aria-current=page]").count(), 1);
  assert.equal(
    await activePane()
      .locator(".desktop-paper-page-controls input")
      .inputValue(),
    String(number),
  );
}

async function jump(number) {
  await pageLink(number).click();
  await expectActive(number);
}

async function createA4() {
  await page.locator(".desktop-titlebar-new").click();
  const chooser = page.getByRole("dialog", { name: "新建画布", exact: true });
  await chooser.getByRole("button", { name: "A4 空白", exact: true }).click();
  await chooser.getByLabel("纵向", { exact: true }).check();
  await chooser.getByRole("button", { name: "创建", exact: true }).click();
  const document = await until(async () => {
    const listing = await call("list_canvases");
    return listing.canvases.find(
      (item) =>
        item.documentId === listing.activeDocumentId && item.initialized,
    );
  }, "new A4 editor");
  return document.documentId;
}

async function editorViewport() {
  return activePane()
    .locator(".excalidraw")
    .first()
    .evaluate((editor) => {
      const ownerKey = Object.keys(editor).find((key) =>
        key.startsWith("__reactFiber$"),
      );
      for (let fiber = editor[ownerKey]; fiber; fiber = fiber.return) {
        const app = fiber.stateNode;
        if (!app?.viewport || !app.scene) continue;
        const {
          offsetLeft,
          offsetTop,
          scrollX,
          scrollY,
          zoom,
          activeTool,
          selectedElementIds,
        } = app.state;
        return {
          offsetLeft,
          offsetTop,
          scrollX,
          scrollY,
          zoom: zoom.value,
          activeTool: activeTool.type,
          selected: Object.keys(selectedElementIds).filter(
            (id) => selectedElementIds[id],
          ),
          animating: app.viewport.isAnimating,
        };
      }
      throw new Error("Cannot locate mounted production editor");
    });
}

async function drawFirstRectangle(documentId, firstPaper) {
  await activePane()
    .getByRole("button", { name: "适合页宽", exact: true })
    .click();
  const before = await readScene(documentId);
  await page.keyboard.press("r");
  const state = await until(async () => {
    const viewport = await editorViewport();
    return (
      viewport.activeTool === "rectangle" && !viewport.animating && viewport
    );
  }, "native rectangle tool and settled viewport");
  const project = (x, y) => ({
    x: state.offsetLeft + (firstPaper.x + x + state.scrollX) * state.zoom,
    y: state.offsetTop + (firstPaper.y + y + state.scrollY) * state.zoom,
  });
  const start = project(firstPaper.width * 0.27, firstPaper.height * 0.17);
  const end = project(firstPaper.width * 0.52, firstPaper.height * 0.29);
  const canvas = activePane().locator("canvas.interactive");
  const hit = await canvas.evaluate(
    (node, points) =>
      points.every(
        ({ x, y }) => node.ownerDocument.elementFromPoint(x, y) === node,
      ),
    [start, end],
  );
  assert.equal(
    hit,
    true,
    "The native drawing endpoints must hit the A4 canvas",
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(end.x, end.y, { steps: 7 });
  } finally {
    await page.mouse.up();
  }
  const priorIds = new Set(before.elements.map(({ id }) => id));
  const rectangle = await until(
    async () =>
      (
        await readScene(documentId)
      ).elements.find(
        (element) => element.type === "rectangle" && !priorIds.has(element.id),
      ),
    "native rectangle drawn on A4",
  );
  assert.equal(
    rectangle.frameId,
    null,
    "Native A4 ink has no explicit frame ownership",
  );
  assert.ok(
    rectangle.x > firstPaper.x &&
      rectangle.x + rectangle.width < firstPaper.x + firstPaper.width,
  );
  assert.ok(
    rectangle.y > firstPaper.y &&
      rectangle.y + rectangle.height < firstPaper.y + firstPaper.height,
  );
  return rectangle;
}

async function waitThumbnail(number) {
  const image = pageLink(number).locator("img");
  await pageLink(number).scrollIntoViewIfNeeded();
  await image.waitFor({ state: "visible" });
  return until(
    async () =>
      image.evaluate(
        (node) =>
          node.complete &&
          node.naturalWidth > 0 && {
            width: node.naturalWidth,
            height: node.naturalHeight,
          },
      ),
    `page ${number} PNG preview`,
  );
}

async function insertAfter(documentId, after) {
  await managementAction("在当前页后插入空白页").click();
  const result = await until(async () => {
    const scene = await readScene(documentId);
    return scene.papers.length === after.length + 1 && scene;
  }, "inserted blank A4 page");
  const created = result.papers.find(({ id }) => !after.includes(id));
  assert.ok(created);
  assert.equal(created.customData.guziPaper.kind, "blank");
  assert.equal(created.width, result.papers[0].width);
  assert.equal(created.height, result.papers[0].height);
  return result;
}

const shape = (page, x, y, extra = {}) => ({
  type: "rectangle",
  x: page.x + x,
  y: page.y + y,
  width: 150,
  height: 82,
  backgroundColor: "#a5d8ff",
  fillStyle: "solid",
  ...extra,
});

async function addFixtures(documentId, scene, nativeInk) {
  const [first, second, third] = scene.papers;
  const applied = await call("apply_operations", {
    documentId,
    expectedRevision: scene.revision,
    requestId: randomUUID(),
    operations: [
      {
        type: "create",
        tempId: "bound",
        element: shape(second, 245, 210, {
          label: { text: "蓝色形状 · 绑定文字", fontSize: 22 },
          width: 225,
        }),
      },
      {
        type: "create",
        tempId: "explicit-overflow",
        element: shape(second, second.width - 32, 360, {
          backgroundColor: "#ffd8a8",
        }),
      },
      { type: "lock", ids: [second.id], locked: false },
      {
        type: "frame",
        ids: ["bound", "explicit-overflow"],
        frameId: second.id,
      },
      {
        type: "create",
        tempId: "table",
        element: {
          type: "table",
          x: third.x + 160,
          y: third.y + 170,
          rows: [54, 72],
          columns: [150, 118],
          cells: [{ row: 0, column: 0, text: "随页移动的表格", fontSize: 18 }],
        },
      },
      {
        type: "create",
        tempId: "crossing",
        element: shape(first, 300, first.height - 37, {
          width: 190,
          height: second.y - first.y - first.height + 95,
          backgroundColor: "#ffc9c9",
        }),
      },
      {
        type: "create",
        tempId: "arrow",
        element: {
          type: "arrow",
          x: nativeInk.x + nativeInk.width,
          y: nativeInk.y + 30,
          width: 110,
          height: second.y - nativeInk.y + 210,
          start: { id: nativeInk.id },
          end: { id: "bound" },
        },
      },
      { type: "lock", ids: [second.id], locked: true },
    ],
  });
  const ready = await readScene(documentId);
  const { bound, table, crossing, arrow } = applied.idMap;
  const boundText = ready.elements.find(
    ({ containerId }) => containerId === bound,
  );
  assert.ok(boundText);
  assert.equal(byId(ready, bound).frameId, second.id);
  const explicitOverflow = byId(ready, applied.idMap["explicit-overflow"]);
  assert.equal(explicitOverflow.frameId, second.id);
  assert.ok(
    explicitOverflow.x + explicitOverflow.width > second.x + second.width,
  );
  const tableRoot = byId(ready, table);
  const tableMembers = ready.elements
    .filter((element) => element.groupIds[0] === tableRoot.groupIds[0])
    .map(({ id }) => id);
  assert.ok(tableMembers.length > 4);
  const outside = byId(ready, crossing);
  assert.equal(outside.frameId, null);
  assert.ok(
    outside.y < first.y + first.height && outside.y + outside.height > second.y,
  );
  const link = byId(ready, arrow);
  assert.equal(link.startBinding.elementId, nativeInk.id);
  assert.equal(link.endBinding.elementId, bound);
  return {
    ready,
    owners: new Map([
      [first.id, [nativeInk.id]],
      [second.id, [bound, boundText.id, explicitOverflow.id]],
      [third.id, tableMembers],
    ]),
    bound,
    boundText: boundText.id,
    table,
    crossing,
    arrow,
  };
}

function assertOwnership(reference, changed, fixture) {
  for (const [paperId, elementIds] of fixture.owners) {
    const originalPage = byId(reference, paperId);
    const nextPage = byId(changed, paperId);
    if (!nextPage) {
      for (const id of elementIds)
        assert.equal(byId(changed, id), undefined, `deleted content ${id}`);
      continue;
    }
    const displacement = nextPage.y - originalPage.y;
    for (const id of elementIds) {
      const original = byId(reference, id);
      const next = byId(changed, id);
      assert.ok(next, `paper ${paperId} still owns ${id}`);
      assert.ok(
        Math.abs(next.y - original.y - displacement) < 0.02,
        `content ${id} follows its page displacement`,
      );
      assert.equal(next.x, original.x);
      assert.equal(next.frameId, original.frameId);
    }
  }
  const originalCrossing = byId(reference, fixture.crossing);
  const survivingCrossing = byId(changed, fixture.crossing);
  assert.ok(survivingCrossing, "Cross-page shape survives page operations");
  assert.deepEqual(
    [
      survivingCrossing.x,
      survivingCrossing.y,
      survivingCrossing.width,
      survivingCrossing.height,
    ],
    [
      originalCrossing.x,
      originalCrossing.y,
      originalCrossing.width,
      originalCrossing.height,
    ],
  );
  const arrow = byId(changed, fixture.arrow);
  assert.ok(arrow, "A cross-page arrow is preserved");
  for (const key of ["startBinding", "endBinding"]) {
    const original = byId(reference, fixture.arrow)[key];
    assert.equal(
      arrow[key]?.elementId,
      byId(changed, original.elementId) ? original.elementId : undefined,
    );
  }
}

const dragPreview = () => page.locator(".desktop-paper-page-drag-preview");

async function bounds(locator) {
  const rect = await locator.boundingBox();
  assert.ok(rect, "Expected a rendered pointer target");
  return rect;
}

const center = ({ x, y, width, height }) => ({
  x: x + width / 2,
  y: y + height / 2,
});
const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) <= 1.5,
    `${label}: ${actual} vs ${expected}`,
  );

async function checkGhost(source, originalRow, start, pointer) {
  await dragPreview().waitFor({ state: "visible" });
  assert.equal(await source.getAttribute("data-drag-source"), "true");
  assert.equal(
    await dragPreview().locator("img").count(),
    1,
    "The ghost keeps the loaded thumbnail",
  );
  const ghost = await dragPreview().evaluate((node) => {
    const view = node.ownerDocument.defaultView;
    const css = new view.DOMMatrixReadOnly(
      view.getComputedStyle(node).transform,
    );
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      transformX: css.m41,
      transformY: css.m42,
    };
  });
  const expectedX = originalRow.x + pointer.x - start.x;
  const expectedY = originalRow.y + pointer.y - start.y;
  near(ghost.x, expectedX, "card preview follows mouse X");
  near(ghost.y, expectedY, "card preview follows mouse Y");
  near(ghost.transformX, expectedX, "preview transform X");
  near(ghost.transformY, expectedY, "preview transform Y");
  near(
    ghost.width,
    originalRow.width,
    "the whole card is rendered while dragging",
  );
  report.samples.dragTracking.push({ pointer, expectedX, expectedY, ghost });
}

async function waitDragEnded() {
  await dragPreview().waitFor({ state: "detached" });
  assert.equal(
    await management()
      .locator("[data-drag-source], [data-drop-target]")
      .count(),
    0,
  );
}

async function nativeDrag(from, to, { cancel, screenshotName } = {}) {
  const source = pageRows().nth(from - 1);
  const target = pageRows().nth(to - 1);
  await target.scrollIntoViewIfNeeded();
  await waitThumbnail(from);
  const thumbnail = pageLink(from).locator("img");
  const originalRow = await bounds(source);
  const start = center(await bounds(thumbnail));
  const targetRect = await bounds(target);
  const destination = {
    x: targetRect.x + targetRect.width * 0.45,
    y: targetRect.y + targetRect.height / 2 + (from < to ? 8 : -8),
  };
  assert.equal(await thumbnail.getAttribute("draggable"), "false");
  assert.ok(
    await thumbnail.evaluate(
      (node, pointer) =>
        node.ownerDocument.elementFromPoint(pointer.x, pointer.y) === node,
      start,
    ),
    "Drag starts on the painted thumbnail itself",
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    const intermediate = {
      x: start.x + 13,
      y: start.y + (from < to ? 11 : -11),
    };
    await page.mouse.move(intermediate.x, intermediate.y);
    await checkGhost(source, originalRow, start, intermediate);
    assert.deepEqual(
      await bounds(source),
      originalRow,
      "The source remains as a card-sized placeholder",
    );
    await page.mouse.move(destination.x, destination.y, { steps: 8 });
    await until(
      async () =>
        (await target.getAttribute("data-drop-target")) ===
        (from < to ? "after" : "before"),
      "pointer drag drop target",
    );
    await checkGhost(source, originalRow, start, destination);
    if (screenshotName) await screenshot(screenshotName);
    if (cancel === "escape") await page.keyboard.press("Escape");
    if (cancel === "outside") {
      const panel = await bounds(management());
      const outside = { x: panel.x - 28, y: destination.y };
      await page.mouse.move(outside.x, outside.y, { steps: 4 });
      await until(
        async () => !(await management().locator("[data-drop-target]").count()),
        "drag target clears outside the list",
      );
      await checkGhost(source, originalRow, start, outside);
    }
  } finally {
    await page.mouse.up();
  }
  await waitDragEnded();
}

async function checkShortClick(number) {
  const link = pageLink(number);
  const start = center(await bounds(link));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x + 2, start.y + 1);
    assert.equal(
      await dragPreview().count(),
      0,
      "Sub-threshold pointer motion must not start a drag",
    );
  } finally {
    await page.mouse.up();
  }
  await expectActive(number);
  assert.equal(
    await management().isVisible(),
    true,
    "An inside click keeps the panel open",
  );
}

async function checkActionButtonNoDrag() {
  const start = center(await bounds(managementAction("下移第 1 页")));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x - 55, start.y, { steps: 3 });
    assert.equal(
      await dragPreview().count(),
      0,
      "A press on the row's action buttons cannot initiate card dragging",
    );
  } finally {
    await page.mouse.up();
  }
  await waitDragEnded();
}

async function checkOutsideClick(documentId, ink, number) {
  const toggle = activePane().getByRole("button", {
    name: "页面管理",
    exact: true,
  });
  const togglePoint = center(await bounds(toggle));
  await page.mouse.move(togglePoint.x, togglePoint.y);
  await page.mouse.down();
  try {
    assert.equal(
      await management().isVisible(),
      true,
      "Toggle pointerdown must not dismiss before its click",
    );
  } finally {
    await page.mouse.up();
  }
  await management().waitFor({ state: "hidden" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await openManagement();
  await jump(number);
  await call("control_canvas", { documentId, action: "select", ids: [] });
  const viewport = await until(async () => {
    const state = await editorViewport();
    return !state.animating && state;
  }, "drawing camera settles before outside click");
  assert.ok(!viewport.selected.includes(ink.id));
  const point = {
    x: viewport.offsetLeft + (ink.x + viewport.scrollX) * viewport.zoom,
    y:
      viewport.offsetTop +
      (ink.y + ink.height / 2 + viewport.scrollY) * viewport.zoom,
  };
  const canvas = activePane().locator("canvas.interactive");
  assert.ok(
    await canvas.evaluate(
      (node, pointer) =>
        node.ownerDocument.elementFromPoint(pointer.x, pointer.y) === node,
      point,
    ),
    "Outside click actually lands on the canvas",
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await management().waitFor({ state: "hidden" });
  } finally {
    await page.mouse.up();
  }
  await until(
    async () => (await editorViewport()).selected.includes(ink.id),
    "the same outside click selects the canvas element",
  );
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  report.scenarios.push(
    "A sub-threshold drag clicks the page link; inside clicks keep the panel open; the toggle closes once and outside pointerdown passes through to canvas selection",
  );
}

async function checkAutoScroll(documentId, currentOrder) {
  let order = currentOrder;
  while (order.length < 9) {
    order = orderOf(await insertAfter(documentId, order));
  }
  await jump(1);
  await waitThumbnail(1);
  const list = management().locator(".desktop-paper-page-list");
  const first = pageRows().first();
  const listState = () =>
    list.evaluate((node) => ({
      top: node.scrollTop,
      height: node.clientHeight,
      limit: node.scrollHeight - node.clientHeight,
    }));
  const before = await listState();
  assert.ok(
    before.limit > 100 && before.top <= 5,
    "Scrollable fixture starts at the top",
  );
  const start = center(await bounds(pageLink(1).locator("img")));
  const listRect = await bounds(list);
  const edge = {
    x: listRect.x + listRect.width / 2,
    y: listRect.y + listRect.height - 6,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(edge.x, edge.y, { steps: 12 });
    await dragPreview().waitFor({ state: "visible" });
    assert.equal(await first.getAttribute("data-drag-source"), "true");
    const scrolled = await until(async () => {
      const value = await listState();
      return value.top >= value.limit - 2 && value;
    }, "holding the pointer near the bottom edge scrolls to the last page");
    assert.equal(
      await pageRows().last().getAttribute("data-drop-target"),
      "after",
    );
    report.samples.autoScroll = { before, scrolled };
    await screenshot("07-page-list-edge-auto-scroll");
    await page.keyboard.press("Escape");
  } finally {
    await page.mouse.up();
  }
  await waitDragEnded();
  assert.deepEqual(orderOf(await readScene(documentId)), order);
  report.scenarios.push(
    "Holding a whole-card drag at the list edge scrolls and retargets off-screen pages; Escape leaves the order unchanged",
  );
}

async function deleteWithConfirmation(number, { cancel = false } = {}) {
  await managementAction(`删除第 ${number} 页`).click();
  const confirm = managementAction("确认删除");
  await confirm.waitFor({ state: "visible" });
  await (cancel ? managementAction("取消") : confirm).click();
  await confirm.waitFor({ state: "hidden" });
}

async function exercise(documentId) {
  report.samples.dragTracking = [];
  const original = await readScene(documentId);
  assert.equal(original.papers.length, 1);
  const first = original.papers[0].id;
  const ink = await drawFirstRectangle(documentId, original.papers[0]);
  await openManagement();
  await expectActive(1);
  assert.equal(await managementAction("删除第 1 页").isDisabled(), true);
  report.samples.preview = await waitThumbnail(1);
  assert.ok(report.samples.preview.height > report.samples.preview.width);
  await screenshot("01-native-ink-and-preview");

  const appended = await insertAfter(documentId, [first]);
  const third = appended.papers[1].id;
  await expectActive(2);
  await jump(1);
  const middleInserted = await insertAfter(documentId, [first, third]);
  const second = middleInserted.papers[1].id;
  const initialOrder = [first, second, third];
  assert.deepEqual(orderOf(middleInserted), initialOrder);
  await expectActive(2);
  report.scenarios.push(
    "Native rectangle with no frameId; A4 thumbnail, page jump, blank insertion in the middle, last-page delete guard",
  );

  const fixture = await addFixtures(documentId, middleInserted, ink);
  const reference = fixture.ready;
  await waitThumbnail(2);
  await screenshot("02-three-pages");
  await checkActionButtonNoDrag();
  assert.deepEqual(orderOf(await readScene(documentId)), initialOrder);

  await managementAction("上移第 3 页").click();
  const raised = await waitOrder(
    documentId,
    [first, third, second],
    "button moves third page up",
  );
  assertOwnership(reference, raised, fixture);
  await expectActive(2);

  await managementAction("下移第 1 页").click();
  const loweredOrder = [third, first, second];
  const lowered = await waitOrder(
    documentId,
    loweredOrder,
    "button moves first page down",
  );
  assertOwnership(reference, lowered, fixture);
  await expectActive(2);

  await checkShortClick(1);
  await checkShortClick(2);
  await nativeDrag(2, 3, { cancel: "escape" });
  assert.deepEqual(orderOf(await readScene(documentId)), loweredOrder);
  await expectActive(2);
  await nativeDrag(2, 3, { cancel: "outside" });
  assert.deepEqual(orderOf(await readScene(documentId)), loweredOrder);
  await expectActive(2);
  await nativeDrag(2, 3, { screenshotName: "03-card-tracks-pointer" });
  const reordered = [third, second, first];
  const dragged = await waitOrder(documentId, reordered, "native drag reorder");
  assertOwnership(reference, dragged, fixture);
  await expectActive(3);
  await screenshot("04-reordered-pages");
  await page.keyboard.press(`${modifier}+z`);
  const undoDrag = await waitOrder(
    documentId,
    loweredOrder,
    "single undo of page drag",
  );
  assertOwnership(reference, undoDrag, fixture);
  await page.keyboard.press(`${modifier}+Shift+z`);
  const redoDrag = await waitOrder(
    documentId,
    reordered,
    "single redo of page drag",
  );
  assertOwnership(reference, redoDrag, fixture);
  report.scenarios.push(
    "Up, down and whole-card native drag reorder move unframed ink, explicit frame content, bound text and complete table groups; arrow bindings remain attached; row action buttons do not drag; Escape and an outside drop leave order unchanged; one undo/redo",
  );

  await checkOutsideClick(documentId, byId(redoDrag, ink.id), 3);
  await openManagement();
  await deleteWithConfirmation(3, { cancel: true });
  assert.deepEqual(orderOf(await readScene(documentId)), reordered);
  await deleteWithConfirmation(3);
  const deleted = await waitOrder(
    documentId,
    [third, second],
    "confirmed page removal",
  );
  assertOwnership(reference, deleted, fixture);
  await page
    .getByText(/已保留 \d+ 个跨页或页外元素/)
    .first()
    .waitFor();
  await screenshot("05-delete-preserves-cross-page-content");
  await page.keyboard.press(`${modifier}+z`);
  assertOwnership(
    reference,
    await waitOrder(documentId, reordered, "single undo of page deletion"),
    fixture,
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  assertOwnership(
    reference,
    await waitOrder(
      documentId,
      [third, second],
      "single redo of page deletion",
    ),
    fixture,
  );
  await page.keyboard.press(`${modifier}+z`);
  assertOwnership(
    reference,
    await waitOrder(documentId, reordered, "restore all pages for save"),
    fixture,
  );
  report.scenarios.push(
    "Delete confirms owned ink, cancel is inert, cross-page content survives with a toast, and deletion is one undo/redo step",
  );

  const saved = await call("save_canvas", { documentId });
  await call("close_document", { documentId });
  const reopened = await call("open_canvas", { path: saved.path });
  assert.notEqual(reopened.documentId, documentId);
  const restored = await waitOrder(
    reopened.documentId,
    reordered,
    "saved page order after reopening",
  );
  assertOwnership(reference, restored, fixture);
  await openManagement();
  await jump(2);
  await waitThumbnail(2);
  await screenshot("06-reopened-page-order");
  await deleteWithConfirmation(3);
  await waitOrder(
    reopened.documentId,
    [third, second],
    "first removal on reopened file",
  );
  await deleteWithConfirmation(2);
  await waitOrder(reopened.documentId, [third], "only one page remains");
  assert.equal(await managementAction("删除第 1 页").isDisabled(), true);
  await managementAction("收起页面面板").click();
  await management().waitFor({ state: "hidden" });
  assert.equal(
    await activePane()
      .getByRole("button", { name: "页面管理", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await openManagement();
  await checkAutoScroll(reopened.documentId, [third]);
  await managementAction("收起页面面板").click();
  await management().waitFor({ state: "hidden" });
  report.samples.order = {
    initialOrder,
    loweredOrder,
    reordered,
    savedOrder: orderOf(restored),
  };
  report.scenarios.push(
    "Save/reopen retains page order and content; deleting down to one disables deletion and the panel can close",
  );
  return saved.path;
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-paper-page-management-")),
  );
  profile = path.join(isolated, "profile");
  const workspace = path.join(isolated, "workspace");
  await Promise.all([fs.mkdir(profile), fs.mkdir(workspace)]);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: workspace,
      language: "zh-CN",
      theme: "light",
      toolPanelPinned: false,
    }),
  );
  await launch();
  const demo = await exercise(await createA4());
  assert.deepEqual(
    report.pageErrors,
    [],
    "Renderer emitted unhandled page errors",
  );
  report.manualDemo = "manual-demo.excalidraw";
  await fs.copyFile(demo, path.join(artifacts, report.manualDemo));
  report.passed = true;
}

(async () => {
  try {
    await bounded(main(), 180_000, "complete paper page management acceptance");
  } catch (error) {
    report.error = error.stack || String(error);
    console.error(report.error);
    await screenshot("failure").catch(() => {});
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
