const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const net = require("node:net");
const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/table-interactions",
);
const executableIndex = process.argv.indexOf("--executable");
const executablePath =
  executableIndex >= 0
    ? path.resolve(process.argv[executableIndex + 1])
    : process.env.EXCALIDRAW_E2E_EXECUTABLE ||
      path.resolve(
        desktopDirectory,
        "../../node_modules/electron/dist",
        require("node:fs")
          .readFileSync(
            path.resolve(
              desktopDirectory,
              "../../node_modules/electron/path.txt",
            ),
            "utf8",
          )
          .trim(),
      );
const owned = new Map();
const report = { passed: false, scenarios: [], screenshots: [], errors: [] };
let client;
let application;
let page;
let isolated;
let profile;
let project;
let cleaning;

const bounded = (task, milliseconds, label) => {
  let timer;
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${label}`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const until = async (read, label, milliseconds = 15000) => {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const processes = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return (
        match && {
          pid: Number(match[1]),
          parent: Number(match[2]),
          command: match[3],
        }
      );
    })
    .filter(Boolean);
const remember = () => {
  const current = processes();
  const main = current.find((item) => item.pid === application?.process()?.pid);
  if (main) owned.set(main.pid, main.command);
  let changed;
  do {
    changed = false;
    for (const item of current) {
      if (owned.has(item.parent) && !owned.has(item.pid)) {
        owned.set(item.pid, item.command);
        changed = true;
      }
    }
  } while (changed);
};
const remaining = () =>
  processes().filter((item) => owned.get(item.pid) === item.command);
async function closeApplication() {
  if (!application) return;
  remember();
  const current = application;
  application = null;
  await bounded(
    current.evaluate(({ app }) => app.exit(0)),
    5000,
    "isolated Electron exit",
  ).catch(() => {});
  await bounded(current.close(), 5000, "Electron connection close").catch(
    () => {},
  );
  await until(() => remaining().length === 0, "owned process exit", 5000).catch(
    () => {},
  );
}
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    await bounded(
      client?.close() || Promise.resolve(),
      5000,
      "MCP close",
    ).catch(() => {});
    await closeApplication();
    for (const item of remaining()) {
      try {
        process.kill(item.pid, "SIGTERM");
      } catch {}
    }
    await until(
      () => remaining().length === 0,
      "owned process termination",
      5000,
    ).catch(() => {});
    for (const item of remaining()) {
      try {
        process.kill(item.pid, "SIGKILL");
      } catch {}
    }
    await until(
      () => remaining().length === 0,
      "owned process cleanup",
      5000,
    ).catch(() => {});
    report.ownedProcesses = [...owned].map(([pid, command]) => ({
      pid,
      command,
    }));
    report.remainingProcesses = remaining();
    report.cleanupPassed = report.remainingProcesses.length === 0;
    if (!report.cleanupPassed) report.passed = false;
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (isolated && report.cleanupPassed)
      await fs.rm(isolated, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    report.error = `Interrupted by ${signal}`;
    report.passed = false;
    void cleanup().finally(() => process.exit(1));
  });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return (
    result.structuredContent ||
    JSON.parse(result.content.find((item) => item.type === "text").text)
  );
};
const frames = (count = 2) =>
  page.evaluate(async (count) => {
    const ownerWindow =
      document.querySelector(".desktop-shell").ownerDocument.defaultView;
    for (let index = 0; index < count; index++)
      await new Promise(ownerWindow.requestAnimationFrame.bind(ownerWindow));
  }, count);
const shot = async (name) => {
  remember();
  await page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    fullPage: true,
  });
  report.screenshots.push(`${name}.png`);
};

// Use the production editor's public API only for camera and fixture selection.
// Every resize and structure operation below is real mouse input.
const editor = (configure = null) =>
  page.locator(".desktop-editor-pane.is-active").evaluate((mounted, config) => {
    const owner = (node) =>
      node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))];
    let model;
    for (let fiber = owner(mounted); fiber; fiber = fiber.return) {
      if (fiber.memoizedProps?.document?.api) {
        model = fiber.memoizedProps.document;
        break;
      }
    }
    let app;
    for (
      let fiber = owner(mounted.querySelector(".excalidraw"));
      fiber;
      fiber = fiber.return
    ) {
      if (fiber.stateNode?.viewport && fiber.stateNode?.scene) {
        app = fiber.stateNode;
        break;
      }
    }
    if (!model || !app)
      throw new Error("Cannot locate the production table editor");
    const elements = app.scene.getNonDeletedElements();
    const root = elements.find((element) => element.customData?.table);
    if (config) {
      model.api.updateScene({
        appState: {
          ...(config.select
            ? {
                selectedElementIds: Object.fromEntries(
                  elements
                    .filter(
                      (element) =>
                        element.groupIds[0] === root.groupIds[0] &&
                        element.type !== "text",
                    )
                    .map((element) => [element.id, true]),
                ),
              }
            : {}),
          ...(config.zoom ? { zoom: { value: config.zoom } } : {}),
          ...(config.scrollX !== undefined ? { scrollX: config.scrollX } : {}),
          ...(config.scrollY !== undefined ? { scrollY: config.scrollY } : {}),
        },
        captureUpdate: "EVENTUALLY",
      });
      model.api.setActiveTool({ type: "selection" });
    }
    const state = app.state;
    return {
      root: root && JSON.parse(JSON.stringify(root)),
      data: root?.customData.table,
      path: model.path,
      dirty: model.dirty,
      zoom: state.zoom.value,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      offsetLeft: state.offsetLeft,
      offsetTop: state.offsetTop,
      cursorButton: state.cursorButton,
      animating: app.viewport.isAnimating,
      undoCount: app.history.undoStack.length,
      selected: Object.keys(state.selectedElementIds).filter(
        (id) => state.selectedElementIds[id],
      ),
    };
  }, configure);
const point = (state, x, y) => {
  const root = state.root;
  const dx = x - root.width / 2;
  const dy = y - root.height / 2;
  return {
    x:
      state.offsetLeft +
      (root.x +
        root.width / 2 +
        Math.cos(root.angle) * dx -
        Math.sin(root.angle) * dy +
        state.scrollX) *
        state.zoom,
    y:
      state.offsetTop +
      (root.y +
        root.height / 2 +
        Math.sin(root.angle) * dx +
        Math.cos(root.angle) * dy +
        state.scrollY) *
        state.zoom,
  };
};
const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) < 0.1,
    `${label}: ${actual} != ${expected}`,
  );
const sameSizes = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, index) =>
    near(value, expected[index], `${label} ${index}`),
  );
};
const shortcut = (key) =>
  page.keyboard.press(
    `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`,
  );
async function fixture(
  title,
  { angle = 0, x = 440, y = 220, merged = false } = {},
) {
  const document = await call("create_canvas", { title });
  const scene = await call("read_canvas", { documentId: document.documentId });
  const created = await call("apply_operations", {
    documentId: document.documentId,
    expectedRevision: scene.revision,
    requestId: `create-${title}`,
    operations: [
      {
        type: "create",
        tempId: "table",
        element: {
          type: "table",
          x,
          y,
          angle,
          rows: [90, 90, 90],
          columns: [160, 160, 160],
          cells: [
            { row: 0, column: 0, text: "Merge text" },
            { row: 1, column: 1, text: "Editable" },
          ],
        },
      },
    ],
  });
  if (merged) {
    const next = await call("read_canvas", { documentId: document.documentId });
    await call("apply_operations", {
      documentId: document.documentId,
      expectedRevision: next.revision,
      requestId: `merge-${title}`,
      operations: [
        {
          type: "table",
          id: created.idMap.table,
          merge: { row: 0, column: 0, endRow: 1, endColumn: 1 },
        },
      ],
    });
  }
  await until(
    async () => (await editor()).root?.id === created.idMap.table,
    "new table mounted",
  );
  await editor({ select: true, zoom: 1, scrollX: 0, scrollY: 0 });
  await page.getByTestId("table-canvas-controls").waitFor({ state: "visible" });
  await frames(4);
  return document;
}
async function drag(axis, index, delta, { cancel = false, steps = 5 } = {}) {
  const before = await editor();
  const x =
    axis === "column"
      ? before.data.columns.slice(0, index + 1).reduce((a, b) => a + b, 0)
      : before.data.columns[0] / 2;
  const y =
    axis === "row"
      ? before.data.rows.slice(0, index + 1).reduce((a, b) => a + b, 0)
      : before.data.rows[0] / 2;
  const start = point(before, x, y);
  const end = point(
    before,
    x + (axis === "column" ? delta : 0),
    y + (axis === "row" ? delta : 0),
  );
  await page.mouse.move(start.x, start.y);
  const hit = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest(".table-canvas-controls__resize")
        ?.getAttribute("aria-label"),
    start,
  );
  assert.ok(hit, `Expected resize boundary at ${JSON.stringify(start)}`);
  await page.mouse.down();
  const held = await editor();
  assert.equal(held.cursorButton, "down");
  assert.equal(held.animating, false);
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * step) / steps,
      start.y + ((end.y - start.y) * step) / steps,
    );
    await frames();
    const preview = await editor();
    near(preview.scrollX, held.scrollX, "drag must not pan X");
    near(preview.scrollY, held.scrollY, "drag must not pan Y");
    near(preview.zoom, held.zoom, "drag must not zoom");
    assert.equal(
      preview.undoCount,
      held.undoCount,
      "preview must not create undo entries",
    );
  }
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
  await frames();
  const after = await editor();
  assert.equal(after.cursorButton, "up");
  if (cancel) {
    sameSizes(after.data.columns, before.data.columns, "Escape columns");
    sameSizes(after.data.rows, before.data.rows, "Escape rows");
    assert.equal(after.undoCount, before.undoCount);
  } else {
    assert.equal(
      after.undoCount,
      before.undoCount + 1,
      "one drag creates one undo entry",
    );
    const field = axis === "column" ? "columns" : "rows";
    near(
      after.data[field][index],
      before.data[field][index] + delta,
      "target size",
    );
    after.data[field].forEach((value, item) => {
      if (item !== index)
        near(value, before.data[field][item], "other axis entry");
    });
  }
  return { before, after };
}

async function main() {
  await fs.access(executablePath);
  report.executablePath = executablePath;
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-table-interactions-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  await fs.mkdir(profile);
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: project,
      language: "zh-CN",
      theme: "light",
      toolPanelDock: "left",
      toolPanelWidth: 280,
      toolPanelPinned: false,
    }),
  );
  application = await _electron.launch({
    executablePath,
    args: [desktopDirectory],
    env: {
      ...process.env,
      EXCALIDRAW_DESKTOP_USER_DATA: profile,
      EXCALIDRAW_DESKTOP_DEV_URL: "",
    },
    timeout: 60000,
  });
  remember();
  report.launches = [{ pid: application.process().pid, profile, project }];
  report.mainOutput = [];
  for (const stream of [
    application.process().stdout,
    application.process().stderr,
  ]) {
    stream?.on("data", (chunk) => report.mainOutput.push(chunk.toString()));
  }
  await application.evaluate(({ dialog }) => {
    dialog.showErrorBox = (title, message) => {
      console.error("TABLE_E2E_STARTUP_ERROR", title, message);
    };
  });
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1600, 1000),
  );

  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) =>
    report.errors.push(error.stack || String(error)),
  );
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const service = await enableMcpInSettings(page, await freePort());
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({
    name: "guzi-table-interactions-e2e",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );

  const document = await fixture("Table interactions");
  await page.getByRole("button", { name: "选择第2列", exact: true }).click();
  const initialMenu = page.getByRole("toolbar", {
    name: "列操作",
    exact: true,
  });
  await initialMenu.waitFor({ state: "visible" });
  await shot("initial-column-actions");
  await initialMenu
    .getByRole("button", { name: "右侧插入", exact: true })
    .click();
  assert.equal((await editor()).data.columns.length, 4);
  await shortcut("z");
  await frames();
  sameSizes(
    (await editor()).data.columns,
    [160, 160, 160],
    "initial middle header insertion undo",
  );
  report.scenarios.push(
    "Initial middle column header and its insertion menu stay clickable above the floating selection toolbar",
  );
  const selectAgain = point(await editor(), 80, 45);
  await page.mouse.click(selectAgain.x, selectAgain.y);
  await page.getByTestId("table-canvas-controls").waitFor({ state: "visible" });
  await frames();
  await shot("selected-table");
  const column = await drag("column", 0, 80);
  sameSizes(column.after.data.columns, [240, 160, 160], "resized columns");
  await shortcut("z");
  await frames();
  sameSizes(
    (await editor()).data.columns,
    [160, 160, 160],
    "column single undo",
  );
  await shortcut("Shift+z");
  await frames();
  sameSizes((await editor()).data.columns, [240, 160, 160], "column redo");
  const row = await drag("row", 0, 45);
  sameSizes(row.after.data.rows, [135, 90, 90], "resized rows");
  await shortcut("z");
  await frames();
  sameSizes((await editor()).data.rows, [90, 90, 90], "row single undo");
  await shortcut("Shift+z");
  await frames();
  sameSizes((await editor()).data.rows, [135, 90, 90], "row redo");
  await drag("column", 1, 55, { cancel: true });
  await shot("resized-table");
  report.scenarios.push(
    "Real multi-frame column and row border dragging; one undo each, redo, and Escape rollback without history",
  );

  for (const side of [0, 1]) {
    await page
      .getByRole("button", { name: "在第2列前插入列", exact: true })
      .nth(side)
      .click();
    await page
      .getByRole("button", { name: "在第2行前插入行", exact: true })
      .nth(side)
      .click();
  }
  assert.equal((await editor()).data.rows.length, 5);
  assert.equal((await editor()).data.columns.length, 5);
  await page.getByRole("button", { name: "选择第2行", exact: true }).click();
  await page
    .getByRole("toolbar", { name: "行操作", exact: true })
    .getByRole("button", { name: "删除行", exact: true })
    .click();
  await page.getByRole("button", { name: "选择第2列", exact: true }).click();
  await shot("column-actions");
  await page
    .getByRole("toolbar", { name: "列操作", exact: true })
    .getByRole("button", { name: "删除列", exact: true })
    .click();
  assert.equal((await editor()).data.rows.length, 4);
  assert.equal((await editor()).data.columns.length, 4);
  report.scenarios.push(
    "Top, bottom, left and right plus insertion, and row/column handle deletion with real button clicks",
  );

  const beforeSave = await editor();
  const saved = await call("save_canvas", { documentId: document.documentId });
  const disk = JSON.parse(await fs.readFile(saved.path, "utf8"));
  const savedRoot = disk.elements.find((element) => element.customData?.table);
  sameSizes(
    savedRoot.customData.table.columns,
    beforeSave.data.columns,
    "disk column sizes",
  );
  sameSizes(
    savedRoot.customData.table.rows,
    beforeSave.data.rows,
    "disk row sizes",
  );
  await call("close_document", { documentId: document.documentId });
  const reopened = await call("open_canvas", { path: saved.path });
  assert.notEqual(reopened.documentId, document.documentId);
  await until(
    async () => (await editor()).root?.id === beforeSave.root.id,
    "saved table reopened",
  );
  sameSizes(
    (await editor()).data.columns,
    beforeSave.data.columns,
    "reopened columns",
  );
  sameSizes((await editor()).data.rows, beforeSave.data.rows, "reopened rows");
  report.scenarios.push(
    "Native save, close and reopen preserves every row height and column width",
  );

  await fixture("Merged controls", { merged: true });
  const merged = await editor();
  const hiddenLine = point(merged, 160, 75);
  const intercepted = await page.evaluate(
    ({ x, y }) =>
      Boolean(
        document
          .elementFromPoint(x, y)
          ?.closest(".table-canvas-controls__resize"),
      ),
    hiddenLine,
  );
  assert.equal(
    intercepted,
    false,
    "merged hidden boundary must not have a resize hit target",
  );
  await page.mouse.dblclick(hiddenLine.x, hiddenLine.y);
  await page.locator('[data-type="wysiwyg"]').waitFor({ state: "visible" });
  await shot("merged-text-edit");
  await page.keyboard.press("Escape");
  report.scenarios.push(
    "Merged hidden internal border has no resize hit target and real double-click still enters text editing",
  );

  await fixture("Rotated controls", { angle: Math.PI / 6, x: 450, y: 250 });
  await editor({ zoom: 0.8, scrollX: -40, scrollY: 15 });
  await frames();
  const rotation = await drag("column", 0, 70);
  const oldOrigin = point(rotation.before, 0, 0);
  const newOrigin = point(rotation.after, 0, 0);
  near(oldOrigin.x, newOrigin.x, "rotated local origin X");
  near(oldOrigin.y, newOrigin.y, "rotated local origin Y");
  await shot("rotated-resize");
  report.scenarios.push(
    "Real rotated border drag at 80 percent zoom preserves the world position of the local table origin",
  );

  await fixture("Panel edge controls", { x: 180, y: 230 });
  await editor({ select: true, zoom: 1, scrollX: 0, scrollY: 0 });
  const edge = await drag("column", 0, 35);
  await shot("sidebar-edge-resize");
  const camera = (state) => ({
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    zoom: state.zoom,
    columns: state.data.columns,
    cursorButton: state.cursorButton,
    animating: state.animating,
  });
  report.sidebarEdge = {
    before: camera(edge.before),
    after: camera(edge.after),
  };
  report.scenarios.push(
    "Sidebar-adjacent real border drag interrupts selection reveal and keeps camera unchanged while held",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
}

main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    process.stderr.write(`${report.error}\n`);
    if (page && !page.isClosed()) {
      report.failedEditor = await editor().catch(() => null);
      await shot("failure").catch(() => {});
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed || !report.cleanupPassed) process.exitCode = 1;
  });
