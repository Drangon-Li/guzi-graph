const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/folders-viewport",
);
const executableIndex = process.argv.indexOf("--executable");
const executablePath =
  executableIndex >= 0
    ? path.resolve(process.argv[executableIndex + 1])
    : process.env.EXCALIDRAW_E2E_EXECUTABLE;
const owned = new Map();
const report = { passed: false, scenarios: [], screenshots: [], errors: [] };
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

const rectangle = (id, x, y, width = 120, height = 100) => ({
  id,
  type: "rectangle",
  x,
  y,
  width,
  height,
  angle: 0,
  strokeColor: "#1971c2",
  backgroundColor: "#a5d8ff",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: "a0",
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});
const drawing = (id) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "folders-viewport-e2e",
    elements: [rectangle(id, 500, 250)],
    appState: {
      viewBackgroundColor: "#ffffff",
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    },
    files: {},
  });
async function launch() {
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
  report.launches ||= [];
  report.launches.push({ pid: application.process().pid, profile });
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) =>
    report.errors.push(error.stack || String(error)),
  );
  await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
  await showProjects();
  await snapshot("launch");
}
const snapshot = async (name) => {
  remember();
  await page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    fullPage: true,
  });
  report.screenshots.push(`${name}.png`);
};
const showProjects = async () => {
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.locator(".desktop-project-pane.is-active").waitFor();
};
const projectPane = () => page.locator(".desktop-project-pane.is-active");
const card = (name) =>
  projectPane()
    .locator(".desktop-file-card")
    .filter({
      has: page.locator(".desktop-file-title", {
        hasText: new RegExp(`^${name}$`),
      }),
    });
const folder = (name) =>
  projectPane()
    .locator(`.desktop-categories button[title="${name}"]`)
    .locator("..");
const exists = async (candidate) =>
  fs.stat(candidate).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

// Inspect the actual production editor through the DOM's React owner chain;
// fixture setup uses its existing public API, while gestures stay native input.
async function editor(operation = "read") {
  return page
    .locator(".desktop-editor-pane.is-active")
    .evaluate((mounted, action) => {
      const owner = (node) =>
        node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))];
      let documentModel;
      for (let fiber = owner(mounted); fiber; fiber = fiber.return) {
        if (fiber.memoizedProps?.document?.api) {
          documentModel = fiber.memoizedProps.document;
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
      if (!documentModel || !app)
        throw new Error("Cannot locate the mounted production editor");
      if (action === "reset") {
        app.viewport.interruptSelectionReveal();
        const target = app.scene
          .getNonDeletedElements()
          .find((item) => item.id === "viewport-target");
        if (!target) throw new Error("Missing viewport fixture rectangle");
        documentModel.api.updateScene({
          elements: [
            {
              ...target,
              x: 180,
              y: 250,
              width: 120,
              height: 100,
              version: target.version + 1,
              versionNonce: target.versionNonce + 1,
            },
          ],
          appState: {
            scrollX: 0,
            scrollY: 0,
            zoom: { value: 1 },
            selectedElementIds: {},
          },
        });
        documentModel.api.setActiveTool({ type: "selection" });
      }
      const state = app.state;
      const target = app.scene
        .getNonDeletedElements()
        .find((item) => item.id === "viewport-target");
      const panel = mounted.querySelector(
        '[data-viewport-ui-name="toolDock"], [data-viewport-ui-name="stylesPanel"]',
      );
      const rect = panel?.getBoundingClientRect();
      return {
        path: documentModel.path,
        dirty: documentModel.dirty,
        selected: Object.keys(state.selectedElementIds).filter(
          (id) => state.selectedElementIds[id],
        ),
        scrollX: state.scrollX,
        scrollY: state.scrollY,
        zoom: state.zoom.value,
        animating: app.viewport.isAnimating,
        cursorButton: state.cursorButton,
        panel: rect
          ? {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            }
          : null,
        target: target
          ? {
              x:
                state.offsetLeft +
                (target.x + state.scrollX) * state.zoom.value,
              y:
                state.offsetTop + (target.y + state.scrollY) * state.zoom.value,
              width: target.width * state.zoom.value,
              height: target.height * state.zoom.value,
            }
          : null,
      };
    }, operation);
}
const frames = (count = 2) =>
  page.evaluate(async (number) => {
    const ownerWindow =
      document.querySelector(".desktop-shell").ownerDocument.defaultView;
    for (let index = 0; index < number; index++)
      await new Promise(ownerWindow.requestAnimationFrame.bind(ownerWindow));
  }, count);
async function openCard(name) {
  await card(name).locator(".desktop-file-open").click();
  await page
    .locator(".desktop-editor-pane.is-active canvas")
    .first()
    .waitFor({ state: "visible" });
  await until(async () => {
    try {
      return !!(await editor()).path;
    } catch {
      return false;
    }
  }, "editor initialization");
}
async function save() {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+s" : "Control+s",
  );
  await until(async () => !(await editor()).dirty, "document save");
}
async function resetViewport() {
  await editor("reset");
  await until(async () => {
    const state = await editor();
    return !state.selected.length && !state.panel && state.scrollX === 0;
  }, "collapsed unselected viewport");
  await frames();
  return editor();
}
async function verifyViewport() {
  await showProjects();
  await projectPane()
    .getByRole("button", { name: /全部画布/ })
    .click();
  await openCard("viewport");
  let before = await resetViewport();
  await page.mouse.move(
    before.target.x + before.target.width / 2,
    before.target.y + before.target.height / 2,
  );
  await page.mouse.down();
  await until(
    async () => (await editor()).selected.includes("viewport-target"),
    "pointer selection",
  );
  await until(
    async () => !!(await editor()).panel,
    "desktop properties panel expansion",
  );
  await frames(4);
  const held = await editor();
  assert.equal(
    held.scrollX,
    before.scrollX,
    "selection must not pan while the pointer is held",
  );
  assert.equal(held.zoom, 1);
  assert.ok(
    held.target.x < held.panel.right &&
      held.target.x + held.target.width > held.panel.left,
    "fixture must be obscured by the actual desktop panel",
  );
  await snapshot("viewport-pointer-held");
  await page.mouse.up();
  await until(async () => {
    const state = await editor();
    return state.scrollX > before.scrollX && !state.animating;
  }, "selection reveal animation");
  const revealed = await editor();
  assert.equal(revealed.zoom, before.zoom);
  assert.equal(revealed.scrollY, before.scrollY);
  assert.ok(
    revealed.target.x >= revealed.panel.right + 15,
    "selected rectangle must clear the real desktop panel",
  );
  report.viewport = { before, held, revealed };
  await snapshot("viewport-revealed");
  report.scenarios.push(
    "actual desktop properties dock reveals selected rectangle after pointer release without changing zoom or vertical scroll",
  );

  before = await resetViewport();
  await page.mouse.click(before.target.x + 60, before.target.y + 50);
  await until(
    async () => (await editor()).animating,
    "reveal starts before wheel interruption",
  );
  await page.mouse.move(before.target.x + 500, before.target.y + 100);
  await page.mouse.wheel(0, 120);
  await until(
    async () => (await editor()).scrollY !== before.scrollY,
    "native wheel input",
  );
  const wheel = await editor();
  await page.waitForTimeout(350);
  const settled = await editor();
  assert.equal(
    settled.scrollX,
    wheel.scrollX,
    "interrupted reveal must not resume after wheel input",
  );
  assert.equal(settled.zoom, 1);
  report.viewport.wheel = { interrupted: wheel, settled };
  await snapshot("viewport-wheel-interrupted");
  report.scenarios.push(
    "native wheel input cancels selection reveal and retains user viewport",
  );

  before = await resetViewport();
  await page.mouse.click(before.target.x + 60, before.target.y + 50);
  await until(
    async () => (await editor()).animating,
    "reveal starts before pan interruption",
  );
  await page.keyboard.down("Space");
  await page.mouse.move(before.target.x + 500, before.target.y + 100);
  await page.mouse.down();
  const panStart = await editor();
  await page.mouse.move(before.target.x + 580, before.target.y + 130, {
    steps: 8,
  });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await frames(3);
  const panned = await editor();
  assert.ok(
    panned.scrollX > panStart.scrollX + 50,
    "native space-drag must control horizontal pan",
  );
  assert.equal(panned.zoom, 1);
  await page.waitForTimeout(350);
  assert.equal((await editor()).scrollX, panned.scrollX);
  report.viewport.pan = { panStart, panned };
  await snapshot("viewport-pan-interrupted");
  report.scenarios.push(
    "new pointer and native space-drag cancel the old reveal animation",
  );
  await save();
}
async function main() {
  assert.ok(
    executablePath,
    "Provide --executable or EXCALIDRAW_E2E_EXECUTABLE with the verified Electron binary path",
  );
  await fs.access(executablePath);
  report.executablePath = executablePath;
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-folders-viewport-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  await fs.mkdir(profile);
  await fs.mkdir(path.join(project, "inbox", "sub", "empty"), {
    recursive: true,
  });
  await fs.mkdir(path.join(project, "archive"));
  const loose = path.join(project, "loose.excalidraw");
  const dirty = path.join(project, "inbox", "sub", "dirty.excalidraw");
  const outside = path.join(isolated, "outside.excalidraw");
  const viewport = path.join(project, "viewport.excalidraw");
  for (const [filename, id] of [
    [loose, "loose-shape"],
    [dirty, "dirty-shape"],
    [outside, "outside-shape"],
    [viewport, "viewport-target"],
  ]) {
    await fs.writeFile(filename, drawing(id));
  }
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
  await fs.writeFile(
    path.join(profile, "recent-files.json"),
    JSON.stringify(
      [loose, dirty, outside, viewport].map((filename, index) => ({
        path: filename,
        lastOpenedAt: Date.now() - index,
      })),
    ),
  );
  report.fixture = { isolated, profile, project };
  await launch();
  await card("loose").dragTo(folder("inbox/sub"));
  await until(
    () => exists(path.join(project, "inbox", "sub", "loose.excalidraw")),
    "root card moved into nested category",
  );
  assert.equal(await exists(loose), false);
  await card("outside").dragTo(folder("inbox/sub"));
  await until(
    () => exists(path.join(project, "inbox", "sub", "outside.excalidraw")),
    "external history file moved into nested category",
  );
  assert.equal(await exists(outside), false);
  report.scenarios.push(
    "native file-card drag moves root and external history files into a nested physical category",
  );
  await snapshot("files-moved-to-subcategory");
  await openCard("dirty");
  const canvas = page.locator(
    ".desktop-editor-pane.is-active canvas.excalidraw__canvas.interactive",
  );
  const box = await canvas.boundingBox();
  assert.ok(box, "interactive canvas must be visible");
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, {
    steps: 6,
  });
  await page.mouse.up();
  await until(
    async () => (await editor()).dirty,
    "native edit makes the opened document dirty",
  );
  await showProjects();
  await folder("inbox").dragTo(folder("archive"));
  const moved = path.join(
    project,
    "archive",
    "inbox",
    "sub",
    "dirty.excalidraw",
  );
  await until(() => exists(moved), "complete directory moved");
  assert.equal(await exists(path.join(project, "inbox")), false);
  assert.ok(
    await exists(path.join(project, "archive", "inbox", "sub", "empty")),
  );
  await page.getByRole("tab", { name: /dirty/ }).click();
  const movedDocument = await editor();
  assert.equal(movedDocument.path, moved);
  assert.equal(movedDocument.dirty, true);
  await until(async () => {
    const names = await fs.readdir(path.join(profile, "drafts"));
    const drafts = await Promise.all(
      names.map(async (name) =>
        JSON.parse(
          await fs.readFile(path.join(profile, "drafts", name), "utf8"),
        ),
      ),
    );
    return drafts.some((draft) => draft.path === moved);
  }, "dirty recovery draft points to moved location");
  report.movedDocument = movedDocument;
  await snapshot("dirty-document-after-folder-move");
  await save();
  const saved = JSON.parse(await fs.readFile(moved, "utf8"));
  assert.ok(
    saved.elements.length >= 2,
    "subsequent save must preserve the real unsaved rectangle edit at the new location",
  );
  assert.equal(await exists(dirty), false);
  report.scenarios.push(
    "native complete-directory drag preserves empty descendants and updates an open dirty document, recovery draft and subsequent save path",
  );
  await verifyViewport();
  report.sessionBeforeRestart = JSON.parse(
    await fs.readFile(path.join(profile, "session.json"), "utf8"),
  );
  assert.ok(report.sessionBeforeRestart.paths.includes(moved));
  assert.ok(!report.sessionBeforeRestart.paths.includes(dirty));
  await closeApplication();
  await launch();
  await projectPane()
    .getByRole("button", { name: /全部画布/ })
    .click();
  assert.equal(await folder("archive/inbox/sub/empty").count(), 1);
  assert.equal(
    await projectPane()
      .locator('.desktop-categories button[title="inbox"]')
      .count(),
    0,
  );
  assert.equal(await card("dirty").count(), 1);
  report.scenarios.push(
    "restart retains nested folder tree, moved file index and session paths",
  );
  await snapshot("restarted-folder-tree");
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      report.failedEditor = await editor().catch(() => null);
    }
    console.error(report.error);
    report.passed = false;
    process.exitCode = 1;
    await page
      ?.screenshot({
        path: path.join(artifacts, "failure.png"),
        fullPage: true,
        timeout: 5000,
      })
      .catch(() => {});
  })
  .finally(async () => {
    await cleanup();
    if (!report.cleanupPassed) process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          passed: report.passed,
          cleanupPassed: report.cleanupPassed,
          scenarios: report.scenarios,
          report: path.join(artifacts, "report.json"),
        },
        null,
        2,
      ),
    );
  });
