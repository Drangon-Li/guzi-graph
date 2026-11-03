const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/folder-management",
);
const executableIndex = process.argv.indexOf("--executable");
let executablePath =
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
let otherProject;
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
    source: "folder-management-e2e",
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
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1600, 1000);
  });
  await showProjects();
  await snapshot(`launch-${report.launches.length}`);
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
const folderButton = (name) =>
  projectPane().locator(
    `.desktop-categories button[title=${JSON.stringify(name)}]`,
  );
const folder = (name) => folderButton(name).locator("..");
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
async function editor() {
  return page.locator(".desktop-editor-pane.is-active").evaluate((mounted) => {
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
            x: state.offsetLeft + (target.x + state.scrollX) * state.zoom.value,
            y: state.offsetTop + (target.y + state.scrollY) * state.zoom.value,
            width: target.width * state.zoom.value,
            height: target.height * state.zoom.value,
          }
        : null,
    };
  });
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

const inline = () =>
  projectPane().getByRole("textbox", { name: "分类名称", exact: true });
const menu = () => page.getByRole("menu");
async function rightClick(name) {
  const button = folderButton(name);
  await button.scrollIntoViewIfNeeded();
  await frames(3);
  const box = await button.boundingBox();
  assert.ok(box);
  const point = {
    x: box.x + Math.min(65, box.width / 2),
    y: box.y + box.height / 2,
  };
  await page.mouse.click(point.x, point.y, { button: "right" });
  await menu().waitFor({ state: "visible" });
  await frames(8);
  return { point, bounds: await menu().boundingBox() };
}
async function menuAction(name, action) {
  await rightClick(name);
  await menu().getByRole("menuitem", { name: action, exact: true }).click();
}
async function doubleClick(name) {
  await folderButton(name).dblclick();
  await inline().waitFor({ state: "visible" });
}
async function rename(name, next, method = "Enter") {
  if (method === "menu") {
    await menuAction(name, "重命名");
    await inline().waitFor({ state: "visible" });
  } else await doubleClick(name);
  await inline().fill(next);
  if (method === "blur") await projectPane().locator("h1").click();
  else await inline().press("Enter");
  const renamed = [...name.split("/").slice(0, -1), next].join("/");
  await folderButton(renamed).waitFor();
  await inline().waitFor({ state: "detached" });
  assert.equal(await exists(path.join(project, name)), false);
  assert.equal(await exists(path.join(project, renamed)), true);
  assert.equal(await projectPane().getByRole("alert").count(), 0);
  return renamed;
}
async function siblingOrder(parent = "") {
  return projectPane()
    .locator(".desktop-category-row > button[title]")
    .evaluateAll(
      (buttons, parent) =>
        buttons
          .map((button) => button.title)
          .filter((name) => name.split("/").slice(0, -1).join("/") === parent),
      parent,
    );
}
async function pin(name, pinned) {
  await menuAction(name, pinned ? "置顶" : "取消置顶");
  await until(async () => {
    await rightClick(name);
    const toggled = await menu()
      .getByRole("menuitem", {
        name: pinned ? "取消置顶" : "置顶",
        exact: true,
      })
      .count();
    await page.keyboard.press("Escape");
    return toggled === 1;
  }, `pin state ${name} ${pinned}`);
}
async function diskSettings() {
  return JSON.parse(
    await fs.readFile(path.join(profile, "settings.json"), "utf8"),
  );
}
async function switchRoot(rootDirectory) {
  await closeApplication();
  const settings = await diskSettings();
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({ ...settings, rootDirectory }),
  );
  await launch();
}
async function selectDestination(name) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "目标文件夹", exact: true })
    .click();
  await page.getByRole("option", { name, exact: true }).click();
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}
async function makeDirty() {
  const canvas = page.locator(
    ".desktop-editor-pane.is-active canvas.excalidraw__canvas.interactive",
  );
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, {
    steps: 6,
  });
  await page.mouse.up();
  await until(async () => (await editor()).dirty, "native canvas edit");
}
async function main() {
  if (!executablePath) {
    const electronPackage = path.dirname(
      require.resolve("electron/package.json"),
    );
    executablePath = path.join(
      electronPackage,
      "dist",
      (
        await fs.readFile(path.join(electronPackage, "path.txt"), "utf8")
      ).trim(),
    );
  }
  await fs.access(executablePath);
  report.executablePath = executablePath;
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-folder-management-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  otherProject = path.join(isolated, "other-projects");
  await fs.mkdir(profile);
  const directories = [
    "alpha",
    "archive/destination",
    "inbox/sub/empty",
    "inbox/collapsed/deep",
    "inbox/aaa",
    "inbox/zzz",
    "inbox/conflict",
    "loose-folder/empty",
    "超长目录名称用于验证分类侧边栏截断与右键菜单不挤压布局的测试目录",
  ];
  for (const root of [project, otherProject])
    for (const directory of directories)
      await fs.mkdir(path.join(root, directory), { recursive: true });
  const dirty = path.join(project, "inbox", "sub", "dirty.excalidraw");
  const sibling = path.join(project, "inbox", "conflict", "keep.txt");
  await fs.writeFile(dirty, drawing("dirty-shape"));
  await fs.writeFile(sibling, "must not be overwritten");
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
    JSON.stringify([{ path: dirty, lastOpenedAt: Date.now() }]),
  );
  report.fixture = { isolated, profile, project, otherProject };
  await launch();
  await snapshot("wide-long-folder-tree");

  await page.evaluate(() => {
    const ownerDocument =
      document.querySelector(".desktop-shell").ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    ownerWindow.__folderEvents = [];
    for (const type of ["focus", "blur", "focusin", "scroll", "resize"])
      ownerWindow.addEventListener(
        type,
        (event) => {
          ownerWindow.__folderEvents.push({
            type,
            target:
              event.target?.className || event.target?.nodeName || "window",
            trusted: event.isTrusted,
            time: performance.now(),
          });
        },
        true,
      );
  });

  report.contextMenu = await rightClick("inbox/sub");
  for (const action of ["重命名", "置顶", "新建子分类", "移动到分类"])
    assert.equal(
      await menu().getByRole("menuitem", { name: action, exact: true }).count(),
      1,
    );
  assert.ok(
    Math.abs(report.contextMenu.bounds.x - report.contextMenu.point.x) <= 4,
    "folder-name context menu must follow pointer horizontally",
  );
  assert.ok(
    Math.abs(report.contextMenu.bounds.y - report.contextMenu.point.y) <= 4,
    "folder-name context menu must follow pointer vertically",
  );
  await snapshot("folder-name-context-menu");
  report.indexBeforeRefresh = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.equal(
    await menu().isVisible(),
    true,
    "menu must remain open before focus refresh",
  );
  await page.evaluate(() => {
    const ownerWindow =
      document.querySelector(".desktop-shell").ownerDocument.defaultView;
    ownerWindow.dispatchEvent(new ownerWindow.Event("focus"));
  });
  await page.waitForTimeout(500);
  report.indexAfterRefresh = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  report.refreshEvents = await page.evaluate(() => window.__folderEvents);
  assert.deepEqual(
    report.indexAfterRefresh.folders,
    report.indexBeforeRefresh.folders,
  );
  assert.equal(
    await menu().isVisible(),
    true,
    "same-value project refresh must preserve context menu",
  );
  await page.keyboard.press("Escape");
  report.scenarios.push(
    "folder-name native right click opens all actions at pointer; actual focus/index refresh retains menu",
  );

  await menuAction("inbox/aaa", "重命名");
  await inline().waitFor();
  await inline().fill("cancelled");
  await inline().press("Escape");
  assert.equal(await exists(path.join(project, "inbox", "aaa")), true);
  assert.equal(await exists(path.join(project, "inbox", "cancelled")), false);
  await doubleClick("inbox/aaa");
  await inline().fill("ime-pending");
  await inline().dispatchEvent("compositionstart", { data: "中" });
  await inline().press("Enter");
  assert.equal(
    await inline().isVisible(),
    true,
    "composition Enter must not submit",
  );
  assert.equal(await exists(path.join(project, "inbox", "ime-pending")), false);
  await inline().dispatchEvent("compositionend", { data: "中" });
  await inline().press("Escape");
  report.scenarios.push(
    "rename menu enters inline input, Escape cancels; simulated composition boundary ignores native Enter",
  );
  await rename("inbox/aaa", "aaa-blurred", "blur");
  await doubleClick("inbox/aaa-blurred");
  await inline().fill("aaa-entered");
  await snapshot("inline-rename");
  await inline().press("Enter");
  await projectPane().locator("h1").click();
  await folderButton("inbox/aaa-entered").waitFor();
  assert.equal(await projectPane().getByRole("alert").count(), 0);
  assert.equal(await exists(path.join(project, "inbox", "aaa-entered")), true);
  report.scenarios.push(
    "native double click inline rename commits on blur and Enter followed by blur without duplicate error",
  );

  await doubleClick("inbox/aaa-entered");
  await inline().fill("conflict");
  await inline().press("Enter");
  await projectPane().getByRole("alert").first().waitFor({ state: "visible" });
  assert.equal(await fs.readFile(sibling, "utf8"), "must not be overwritten");
  assert.equal(await exists(path.join(project, "inbox", "aaa-entered")), true);
  await inline().press("Escape");
  report.scenarios.push(
    "rename collision leaves source folder and conflicting destination content intact",
  );

  await pin("inbox/zzz", true);
  assert.equal((await siblingOrder("inbox"))[0], "inbox/zzz");
  await pin("archive", true);
  assert.equal((await siblingOrder())[0], "archive");
  assert.equal(
    (await siblingOrder("inbox"))[0],
    "inbox/zzz",
    "root pin cannot reorder another sibling group",
  );
  await pin("inbox/zzz", false);
  assert.notEqual((await siblingOrder("inbox"))[0], "inbox/zzz");
  await pin("inbox/zzz", true);
  report.orderBeforeRestart = {
    root: await siblingOrder(),
    inbox: await siblingOrder("inbox"),
  };
  await snapshot("pinned-root-and-leaf");
  await closeApplication();
  await launch();
  assert.deepEqual(await siblingOrder(), report.orderBeforeRestart.root);
  assert.deepEqual(
    await siblingOrder("inbox"),
    report.orderBeforeRestart.inbox,
  );
  await switchRoot(otherProject);
  assert.notEqual((await siblingOrder())[0], "archive");
  assert.notEqual((await siblingOrder("inbox"))[0], "inbox/zzz");
  await switchRoot(project);
  assert.equal((await siblingOrder())[0], "archive");
  assert.equal((await siblingOrder("inbox"))[0], "inbox/zzz");
  report.scenarios.push(
    "native leaf/root pins sort among siblings; unpin works; restart restores pins; separate roots isolate metadata",
  );

  await menuAction("inbox/sub", "新建子分类");
  const create = page.getByRole("dialog");
  await create
    .getByRole("textbox", { name: "文件夹名称", exact: true })
    .fill("created-child");
  await create.getByRole("button", { name: "确定", exact: true }).click();
  await create.waitFor({ state: "detached" });
  await until(
    () => exists(path.join(project, "inbox", "sub", "created-child")),
    "native child create",
  );
  await folderButton("inbox/sub/created-child").waitFor();
  await folder("loose-folder").dragTo(folder("inbox/sub"));
  await until(
    () => exists(path.join(project, "inbox", "sub", "loose-folder", "empty")),
    "native whole-folder drag into nested folder",
  );
  assert.equal(await exists(path.join(project, "loose-folder")), false);
  await menuAction("inbox/sub/created-child", "移动到分类");
  await selectDestination("archive/destination");
  await until(
    () => exists(path.join(project, "archive", "destination", "created-child")),
    "native folder move menu",
  );
  assert.equal(
    await exists(path.join(project, "inbox", "sub", "created-child")),
    false,
  );
  report.scenarios.push(
    "native child creation, whole real-directory nested drag including empty descendant, and menu move update disk hierarchy",
  );

  await projectPane()
    .getByRole("button", { name: /全部画布/ })
    .click();
  await openCard("dirty");
  await makeDirty();
  await showProjects();
  await folderButton("inbox/sub").click();
  await folder("inbox/collapsed")
    .getByRole("button", { name: "收起 inbox/collapsed", exact: true })
    .click();
  assert.equal(await folderButton("inbox/collapsed/deep").count(), 0);
  await rename("inbox", "menu-inbox", "menu");
  await until(
    async () =>
      (await projectPane().locator("h1").textContent()) === "menu-inbox/sub",
    "selected descendant survives parent rename",
  );
  assert.equal(await folderButton("menu-inbox/collapsed/deep").count(), 0);
  await rename("menu-inbox", "renamed-inbox");
  await until(
    async () =>
      (await projectPane().locator("h1").textContent()) === "renamed-inbox",
    "double-clicked renamed parent remains selected",
  );
  assert.equal(await folderButton("renamed-inbox/collapsed/deep").count(), 0);
  assert.equal(
    await folder("renamed-inbox/collapsed")
      .getByRole("button", {
        name: "展开 renamed-inbox/collapsed",
        exact: true,
      })
      .count(),
    1,
  );
  await snapshot("renamed-parent-preserves-selected-collapsed-tree");
  const moved = path.join(project, "renamed-inbox", "sub", "dirty.excalidraw");
  await page.getByRole("tab", { name: /dirty/ }).click();
  report.dirtyDocumentAfterRename = await editor();
  assert.equal(report.dirtyDocumentAfterRename.path, moved);
  assert.equal(report.dirtyDocumentAfterRename.dirty, true);
  await save();
  assert.ok(JSON.parse(await fs.readFile(moved, "utf8")).elements.length >= 2);
  assert.equal(await exists(dirty), false);
  report.scenarios.push(
    "menu parent rename preserves selected descendant; native double-click parent rename preserves selection/collapsed subtree, dirty document and subsequent real save path",
  );
  await showProjects();
  await pin("renamed-inbox", true);
  await snapshot("final-hierarchy");
  report.finalSettings = await diskSettings();
  report.finalIndex = await page.evaluate(() => window.desktop.listProjects());
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    report.passed = false;
    process.exitCode = 1;
    console.error(report.error);
    if (page && !page.isClosed()) {
      report.failureDOM = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          fullPage: true,
          timeout: 5000,
        })
        .catch(() => {});
    }
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
