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
  "../../output/playwright/table-resize",
);
const executablePath =
  process.env.EXCALIDRAW_E2E_EXECUTABLE || require("electron");
const report = {
  passed: false,
  scenarios: [],
  screenshots: [],
  gestures: [],
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
  client = new Client({ name: "guzi-table-resize-e2e", version: "1.0.0" });
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
const controls = () => activePane().getByTestId("table-canvas-controls");
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const sum = (values) => values.reduce((total, value) => total + value, 0);

function near(actual, expected, label, tolerance = 1) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected}`,
  );
}

function sameSizes(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, index) =>
    near(value, expected[index], `${label} ${index + 1}`),
  );
}

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

async function frames() {
  await activePane().evaluate(async (mounted) => {
    const view = mounted.ownerDocument.defaultView;
    for (let index = 0; index < 2; index++) {
      await new Promise((resolve) => view.requestAnimationFrame(resolve));
    }
  });
}

async function readTable(documentId) {
  const { elements, revision } = await call("read_canvas", { documentId });
  const root = elements.find((element) => element.customData?.table);
  assert.ok(root, "Expected a table root");
  return {
    root,
    revision,
    data: root.customData.table,
    members: elements.filter(
      (element) => element.groupIds[0] === root.groupIds[0],
    ),
  };
}

async function selectTable(documentId) {
  const table = await readTable(documentId);
  // Set only the camera through the mounted production editor, as in table-interactions-e2e.
  await activePane().evaluate((mounted) => {
    const fiberKey = Object.keys(mounted).find((key) =>
      key.startsWith("__reactFiber$"),
    );
    for (let fiber = mounted[fiberKey]; fiber; fiber = fiber.return) {
      const model = fiber.memoizedProps?.document;
      if (!model?.api) continue;
      model.api.updateScene({
        appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 },
        captureUpdate: "NEVER",
      });
      model.api.setActiveTool({ type: "selection" });
      return;
    }
    throw new Error("Cannot locate the mounted table editor");
  });
  const selection = await call("control_canvas", {
    documentId,
    action: "select",
    ids: table.members
      .filter(({ type }) => type !== "text")
      .map(({ id }) => id),
  });
  assert.equal(selection.zoom, 1);
  await controls().waitFor({ state: "visible" });
  await frames();
}

async function fixture(title, rows, columns, cells) {
  const { documentId } = await call("create_canvas", { title });
  const { revision } = await call("read_canvas", { documentId });
  await call("apply_operations", {
    documentId,
    expectedRevision: revision,
    requestId: randomUUID(),
    operations: [
      {
        type: "create",
        tempId: "table",
        element: { type: "table", x: 380, y: 180, rows, columns, cells },
      },
    ],
  });
  return documentId;
}

function separator(axis, index, segment) {
  const name =
    axis === "column" ? `调整第${index + 1}列宽` : `调整第${index + 1}行高`;
  return controls().getByRole("separator", { name, exact: true }).nth(segment);
}

async function center(locator) {
  const rect = await locator.boundingBox();
  assert.ok(rect, "Resize boundary must be visible");
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function drag(
  axis,
  index,
  segment,
  delta,
  { proportional = false, cancel = false } = {},
) {
  const boundary = separator(axis, index, segment);
  const start = await center(boundary);
  const coordinate = axis === "column" ? "x" : "y";
  const gesture = {
    axis,
    index,
    segment,
    proportional,
    cancel,
    start,
    delta,
    pointerSamples: [],
  };
  report.gestures.push(gesture);
  const hitsBoundary = await boundary.evaluate(
    (node, point) =>
      node.ownerDocument.elementFromPoint(point.x, point.y) === node,
    start,
  );
  assert.ok(
    hitsBoundary,
    `Expected the selected separator at ${JSON.stringify(start)}`,
  );
  await page.mouse.move(start.x, start.y);
  if (proportional) await page.keyboard.down(modifier);
  try {
    await page.mouse.down();
    try {
      for (const progress of [0.25, 0.6, 1]) {
        const pointer = {
          ...start,
          [coordinate]: start[coordinate] + delta * progress,
        };
        await page.mouse.move(pointer.x, pointer.y);
        await frames();
        const edge = await center(boundary);
        gesture.pointerSamples.push({
          pointer: pointer[coordinate],
          edge: edge[coordinate],
        });
        near(
          edge[coordinate],
          pointer[coordinate],
          `${axis} resize boundary follows pointer`,
          1.5,
        );
      }
      if (cancel) await page.keyboard.press("Escape");
    } finally {
      await page.mouse.up();
    }
  } finally {
    if (proportional) await page.keyboard.up(modifier);
  }
  await frames();
}

function textAt(table, row, column) {
  const label = table.members.find(({ customData }) => {
    const cell = customData?.tableCell;
    return cell?.row === row && cell.column === column && cell.role === "text";
  });
  assert.ok(label, `Expected a text label in cell (${row}, ${column})`);
  return label;
}

const lineCount = (label) => label.text.split("\n").length;
const fonts = (table) =>
  table.members
    .filter((element) => element.customData?.tableCell?.role === "text")
    .map(({ id, fontSize }) => ({ id, fontSize }))
    .sort((left, right) => left.id.localeCompare(right.id));

function scaledSizes(sizes, index, delta) {
  const originalDistance = sum(sizes.slice(0, index + 1));
  return sizes.map(
    (size) => (size * (originalDistance + delta)) / originalDistance,
  );
}

async function checkProportionalDrag() {
  const documentId = await fixture(
    "Table proportion fixture",
    [88, 118, 150],
    [140, 110, 160],
    [
      { row: 0, column: 0, text: "A", fontSize: 22 },
      { row: 1, column: 1, text: "B", fontSize: 27 },
      { row: 2, column: 2, text: "C", fontSize: 32 },
    ],
  );
  await selectTable(documentId);
  const initial = await readTable(documentId);
  await screenshot("01-uneven-table");

  await drag("column", 0, 1, 40);
  const ordinary = await readTable(documentId);
  sameSizes(
    ordinary.data.columns,
    [180, 110, 160],
    "plain drag changes only the selected column",
  );
  sameSizes(
    ordinary.data.rows,
    initial.data.rows,
    "plain column drag keeps row heights",
  );
  report.scenarios.push(
    "Plain drag on a middle-row cell edge changes only the selected column",
  );

  await drag("column", 1, 1, 58, { proportional: true });
  const horizontal = await readTable(documentId);
  sameSizes(
    horizontal.data.columns,
    scaledSizes(ordinary.data.columns, 1, 58),
    "proportional columns",
  );
  sameSizes(
    horizontal.data.rows,
    ordinary.data.rows,
    "horizontal drag keeps row heights",
  );
  assert.deepEqual(fonts(horizontal), fonts(initial));
  await screenshot("02-proportional-columns");

  await drag("row", 1, 1, 50, { proportional: true });
  const vertical = await readTable(documentId);
  sameSizes(
    vertical.data.rows,
    scaledSizes(horizontal.data.rows, 1, 50),
    "proportional rows",
  );
  sameSizes(
    vertical.data.columns,
    horizontal.data.columns,
    "vertical drag keeps column widths",
  );
  assert.deepEqual(fonts(vertical), fonts(initial));
  report.samples.proportions = {
    before: { rows: initial.data.rows, columns: initial.data.columns },
    horizontal: {
      rows: horizontal.data.rows,
      columns: horizontal.data.columns,
    },
    vertical: { rows: vertical.data.rows, columns: vertical.data.columns },
  };
  await screenshot("03-proportional-rows");
  report.scenarios.push(
    "Modifier drag on internal edges resizes every row or column proportionally, follows the pointer, and keeps text font sizes",
  );

  await drag("column", 1, 1, 43, { proportional: true, cancel: true });
  assert.deepEqual(
    (await readTable(documentId)).data,
    vertical.data,
    "Escape rolls back resize",
  );
  await page.keyboard.press(`${modifier}+z`);
  await frames();
  assert.deepEqual(
    (await readTable(documentId)).data,
    horizontal.data,
    "one undo reverses the previous committed drag",
  );
  await page.keyboard.press(`${modifier}+Shift+z`);
  await frames();
  assert.deepEqual(
    (await readTable(documentId)).data,
    vertical.data,
    "redo restores proportional heights",
  );
  report.scenarios.push(
    "Escape restores the preview without creating an undo step; undo and redo restore the committed geometry",
  );
  await drag("column", 1, 1, -35, { proportional: true });
  const contracted = await readTable(documentId);
  sameSizes(
    contracted.data.columns,
    scaledSizes(vertical.data.columns, 1, -35),
    "reverse modifier drag proportionally shrinks every column",
  );
  sameSizes(contracted.data.rows, vertical.data.rows, "contraction keeps rows");
  assert.deepEqual(fonts(contracted), fonts(initial));
  report.samples.proportions.contracted = contracted.data.columns;
}

async function openLegacyFixture(workspace) {
  const rows = [96, 114, 84];
  const columns = [95, 140, 100];
  const cells = [
    { row: 0, column: 0, text: "Alpha Alpha", fontSize: 22, fontFamily: 2 },
    { row: 0, column: 1, text: "Keep\nBoth", fontSize: 24, fontFamily: 2 },
    { row: 0, column: 2, text: "比例测试", fontSize: 17 },
    { row: 1, column: 0, text: "Alpha Alpha", fontSize: 22, fontFamily: 2 },
    { row: 1, column: 1, text: "手动行高基准", fontSize: 17 },
    { row: 2, column: 2, text: "普通拖动", fontSize: 17 },
  ];
  const seedId = await fixture("Table reflow seed", rows, columns, cells);
  const saved = await call("save_canvas", { documentId: seedId });
  const legacy = JSON.parse(await fs.readFile(saved.path, "utf8"));
  const table = legacy.elements.find((element) => element.customData?.table)
    .customData.table;
  delete table.rowMinHeights;
  assert.deepEqual(
    table.rows,
    rows,
    "Legacy fixture contains pre-existing extra row height",
  );
  const filename = path.join(workspace, "legacy-table.excalidraw");
  await fs.writeFile(filename, JSON.stringify(legacy));
  const opened = await call("open_canvas", { path: filename });
  return opened.documentId;
}

async function checkRowReflow(workspace) {
  const documentId = await openLegacyFixture(workspace);
  await selectTable(documentId);
  const before = await readTable(documentId);
  assert.equal(lineCount(textAt(before, 0, 0)), 2);
  assert.equal(lineCount(textAt(before, 1, 0)), 2);
  await screenshot("04-wrapped-legacy-rows");

  await drag("row", 2, 1, 24);
  const legacyHeightChanged = await readTable(documentId);
  const thirdRowHeight = before.data.rows[2] + 24;
  sameSizes(
    legacyHeightChanged.data.rows,
    [before.data.rows[0], before.data.rows[1], thirdRowHeight],
    "legacy vertical drag only resizes the target row",
  );

  await drag("column", 0, 1, 100);
  const widened = await readTable(documentId);
  const beforeLineHeight = textAt(before, 1, 0).height;
  const singleLineHeight = textAt(widened, 1, 0).height;
  assert.equal(lineCount(textAt(widened, 0, 0)), 1);
  assert.equal(lineCount(textAt(widened, 1, 0)), 1);
  assert.equal(lineCount(textAt(widened, 0, 1)), 2);
  assert.ok(
    widened.data.rows[0] < before.data.rows[0],
    "Legacy extra height can be reclaimed",
  );
  assert.ok(
    widened.data.rows[1] < before.data.rows[1],
    "Unwrapped row must shrink",
  );
  assert.ok(
    widened.data.rows[0] >= textAt(widened, 0, 1).height,
    "A neighboring two-line cell must remain visible",
  );
  assert.ok(
    widened.data.rows[0] > widened.data.rows[1],
    "Two-line neighbor should keep its row taller",
  );
  near(
    widened.data.rows[2],
    thirdRowHeight,
    "legacy vertical drag establishes a manual baseline only for its target",
  );
  await screenshot("05-legacy-rows-reflowed");
  report.scenarios.push(
    "Widening a legacy column unwraps text and reclaims extra row height while preserving a neighboring two-line cell",
  );

  const manualIncrease = (beforeLineHeight - singleLineHeight) / 2;
  assert.ok(
    manualIncrease >= 8,
    "The manual baseline must fit between the one-line and two-line content heights",
  );
  await drag("row", 1, 1, manualIncrease);
  const manual = await readTable(documentId);
  const baseline = manual.data.rows[1];
  near(baseline, widened.data.rows[1] + manualIncrease, "explicit row height");
  near(
    manual.data.rowMinHeights[1],
    baseline,
    "explicit row baseline recorded",
  );
  sameSizes(
    manual.data.columns,
    widened.data.columns,
    "plain row drag keeps columns",
  );
  near(
    manual.data.rows[0],
    widened.data.rows[0],
    "plain row drag leaves preceding row",
  );
  near(
    manual.data.rows[2],
    widened.data.rows[2],
    "plain row drag leaves following row",
  );
  await drag("column", 0, 1, -100);
  const narrowed = await readTable(documentId);
  assert.equal(lineCount(textAt(narrowed, 1, 0)), 2);
  assert.ok(
    narrowed.data.rows[1] > baseline,
    "Wrapped content should grow above the manual baseline",
  );
  near(
    narrowed.data.rowMinHeights[1],
    baseline,
    "content growth retains manual baseline",
  );

  const saved = await call("save_canvas", { documentId });
  const disk = JSON.parse(await fs.readFile(saved.path, "utf8"));
  assert.deepEqual(
    disk.elements.find(({ customData }) => customData?.table).customData.table,
    narrowed.data,
    "On-disk table preserves dimensions, styling and row height baseline",
  );
  await call("close_document", { documentId });
  const reopened = await call("open_canvas", { path: saved.path });
  assert.notEqual(reopened.documentId, documentId);
  const restored = await readTable(reopened.documentId);
  assert.deepEqual(
    restored.data,
    narrowed.data,
    "Reopen preserves data and the manual baseline",
  );
  await selectTable(reopened.documentId);
  await drag("column", 0, 1, 100);
  const final = await readTable(reopened.documentId);
  assert.equal(lineCount(textAt(final, 1, 0)), 1);
  near(
    final.data.rows[1],
    baseline,
    "A later horizontal drag stops at the saved manual baseline",
  );
  assert.equal(lineCount(textAt(final, 0, 1)), 2);
  assert.ok(final.data.rows[0] >= textAt(final, 0, 1).height);
  report.samples.reflow = {
    before: before.data.rows,
    legacyHeightChanged: legacyHeightChanged.data.rows,
    widened: widened.data.rows,
    manual: manual.data.rows,
    contentExpanded: narrowed.data.rows,
    reopened: restored.data.rows,
    final: final.data.rows,
    baseline,
  };
  await screenshot("06-reopened-manual-baseline");
  report.scenarios.push(
    "Manual height survives content growth and saving, then becomes the shrink floor after reopening",
  );
  return saved.path;
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-table-resize-")),
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
  await checkProportionalDrag();
  const demoSource = await checkRowReflow(workspace);
  assert.deepEqual(
    report.pageErrors,
    [],
    "Renderer emitted unhandled page errors",
  );
  const demoName = "manual-demo.excalidraw";
  await fs.copyFile(demoSource, path.join(artifacts, demoName));
  report.manualDemo = demoName;
  report.passed = true;
}

(async () => {
  try {
    await bounded(main(), 150_000, "complete table resize acceptance");
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
