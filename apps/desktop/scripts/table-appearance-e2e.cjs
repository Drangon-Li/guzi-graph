const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/table-appearance",
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
    if (isolated && report.cleanupPassed && report.passed)
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

const snapshot = async (name) => {
  remember();
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
};
async function resize(width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(300, 300);
      window.setSize(...size);
    },
    [width, height],
  );
  await until(
    async () => (await page.evaluate(() => innerWidth)) === width,
    "window resize",
  );
}
async function tablePoint() {
  return page.locator(".excalidraw-container").evaluate((mounted) => {
    let fiber =
      mounted[
        Object.keys(mounted).find((key) => key.startsWith("__reactFiber$"))
      ];
    while (fiber && !(fiber.stateNode?.scene && fiber.stateNode?.viewport))
      fiber = fiber.return;
    if (!fiber) throw new Error("Cannot locate production editor");
    const app = fiber.stateNode;
    const table = app.scene
      .getNonDeletedElements()
      .find((element) => element.customData?.table);
    if (!table) throw new Error("No table inserted");
    return {
      x:
        app.state.offsetLeft +
        (table.x + table.width / 2 + app.state.scrollX) * app.state.zoom.value,
      y:
        app.state.offsetTop +
        (table.y + table.height / 2 + app.state.scrollY) * app.state.zoom.value,
    };
  });
}
async function openTableMenu() {
  const point = await tablePoint();
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menu").waitFor();
}
async function appearance(name) {
  const details = page.locator(".table-actions--details");
  const metrics = await details.evaluate((fieldset) => {
    const view = fieldset.ownerDocument.defaultView;
    const style = (node) => view.getComputedStyle(node);
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
      };
    };
    const scope = fieldset.querySelector(".table-details-appearance");
    return {
      fieldset: {
        border: style(fieldset).borderTopWidth,
        padding: style(fieldset).padding,
        margin: style(fieldset).margin,
      },
      scope: box(scope),
      direction: style(scope).flexDirection,
      wrap: style(scope).flexWrap,
      groups: [...scope.querySelectorAll("fieldset")].map((group) => ({
        border: style(group).borderTopWidth,
        listDisplay: style(group.querySelector(".buttonList")).display,
        icons: group.querySelectorAll("svg").length,
        controls: [
          ...group.querySelectorAll(
            ".buttonList > label, .buttonList > button",
          ),
        ].map(box),
      })),
      radios: [...scope.querySelectorAll('input[type="radio"]')].map(
        (input) => ({
          opacity: style(input).opacity,
          position: style(input).position,
        }),
      ),
    };
  });
  assert.equal(metrics.fieldset.border, "0px");
  assert.equal(metrics.fieldset.padding, "0px");
  assert.equal(metrics.fieldset.margin, "0px");
  assert.equal(metrics.direction, "row");
  assert.equal(metrics.wrap, "wrap");
  assert.equal(metrics.groups.length, 3);
  for (const group of metrics.groups) {
    assert.equal(group.border, "0px");
    assert.equal(group.listDisplay, "flex");
    assert.ok(group.icons >= 3);
    assert.ok(group.controls.length >= 3);
    assert.equal(group.controls[0].y, group.controls[1].y);
  }
  for (const radio of metrics.radios) {
    assert.equal(radio.opacity, "0");
    assert.equal(radio.position, "absolute");
  }
  report[name] = metrics;
  await snapshot(name);
}
async function menuMetrics() {
  return page.getByRole("menu").evaluate((menu) => {
    const view = menu.ownerDocument.defaultView;
    const rect = menu.getBoundingClientRect();
    const appRect = menu.closest(".excalidraw").getBoundingClientRect();
    const style = view.getComputedStyle(menu);
    return {
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      appTop: appRect.top,
      appBottom: appRect.bottom,
      appLeft: appRect.left,
      appRight: appRect.right,
      appHeight: appRect.height,
      scrollTop: menu.scrollTop,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      overflowY: style.overflowY,
      overscrollBehavior: style.overscrollBehavior,
      active: menu.ownerDocument.activeElement?.closest("li")?.dataset.testid,
    };
  });
}
async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-table-appearance-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  await fs.mkdir(profile);
  await fs.mkdir(project);
  const fixture = path.join(project, "appearance.excalidraw");
  await fs.writeFile(
    fixture,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "table-appearance-e2e",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: project,
      language: "zh-CN",
      theme: "light",
    }),
  );
  report.fixture = { isolated, profile, project };
  if (!executablePath) {
    const electronPackage = path.dirname(require.resolve("electron"));
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
  for (const stream of ["stdout", "stderr"]) {
    application.process()[stream]?.on("data", (data) => {
      report[stream] = `${report[stream] || ""}${data}`;
    });
  }
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) =>
    report.errors.push(error.stack || String(error)),
  );
  await resize(1400, 1000);
  await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
  const back = page.getByRole("button", { name: "返回项目页", exact: true });
  if (await back.isVisible()) await back.click();
  await application.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filename],
    });
  }, fixture);
  await page.getByRole("button", { name: /打开文件/ }).click();
  await page.locator("canvas.interactive:visible").waitFor();
  await page.getByTestId("toolbar-table").click();
  await openTableMenu();
  await page.getByRole("menuitem", { name: /表格详细设置/ }).click();
  await page.getByRole("dialog", { name: "表格详细设置" }).waitFor();
  await appearance("01-wide-table-details");
  await resize(420, 850);
  await appearance("02-narrow-table-details");
  assert.ok(
    report["02-narrow-table-details"].groups[2].controls[0].y >
      report["02-narrow-table-details"].groups[0].controls[0].y,
    "appearance groups wrap in a narrow window",
  );
  await page.keyboard.press("Escape");
  await resize(1400, 700);
  await openTableMenu();
  report.menuInitial = await menuMetrics();
  assert.ok(report.menuInitial.height <= 480.5);
  assert.ok(report.menuInitial.height <= report.menuInitial.appHeight - 19.5);
  assert.ok(report.menuInitial.top >= report.menuInitial.appTop - 0.5);
  assert.ok(report.menuInitial.bottom <= report.menuInitial.appBottom + 0.5);
  assert.ok(report.menuInitial.left >= report.menuInitial.appLeft - 0.5);
  assert.ok(report.menuInitial.right <= report.menuInitial.appRight + 0.5);
  assert.equal(report.menuInitial.overflowY, "auto");
  assert.equal(report.menuInitial.overscrollBehavior, "contain");
  assert.ok(
    report.menuInitial.scrollHeight > report.menuInitial.clientHeight,
    "table context menu must be long enough to scroll",
  );
  await snapshot("03-long-menu-top");
  const menuBox = await page.getByRole("menu").boundingBox();
  await page.mouse.move(
    menuBox.x + menuBox.width / 2,
    menuBox.y + menuBox.height / 2,
  );
  await page.mouse.wheel(0, 10000);
  await until(
    async () => (await menuMetrics()).scrollTop > 0,
    "menu wheel scroll",
  );
  report.menuWheel = await menuMetrics();
  await page.keyboard.press("End");
  report.menuEnd = await menuMetrics();
  assert.equal(
    await page
      .getByRole("menu")
      .evaluate(
        (menu) =>
          menu.querySelector("li:last-child button") ===
          menu.ownerDocument.activeElement,
      ),
    true,
    "End focuses the final menu action",
  );
  const deletion = page.getByTestId("deleteSelectedElements");
  const deleteBox = await deletion.boundingBox();
  assert.ok(
    deleteBox.y >= report.menuEnd.top &&
      deleteBox.y + deleteBox.height <= report.menuEnd.bottom + 1,
    "delete action is visible after menu navigation",
  );
  await snapshot("04-long-menu-end-delete-visible");
  await page.keyboard.press("Home");
  report.menuHome = await menuMetrics();
  const home = await page.getByRole("menu").evaluate((menu) => {
    const button = menu.querySelector("button");
    const rect = button.getBoundingClientRect();
    const container = menu.getBoundingClientRect();
    return {
      focused: menu.ownerDocument.activeElement === button,
      visible: rect.top >= container.top && rect.bottom <= container.bottom,
    };
  });
  assert.deepEqual(home, { focused: true, visible: true });
  await snapshot("05-long-menu-home");
  await page.keyboard.press("Escape");
  await resize(1100, 500);
  await openTableMenu();
  report.smallMenu = await menuMetrics();
  assert.ok(
    report.smallMenu.height <=
      Math.min(480, report.smallMenu.appHeight - 20) + 0.5,
  );
  assert.ok(report.smallMenu.bottom <= report.smallMenu.appBottom + 0.5);
  await snapshot("06-small-viewport-menu");
  report.scenarios.push(
    "wide and narrow table appearance",
    "480px and viewport menu caps",
    "wheel scrolling and End/Home menu navigation",
    "visible delete action",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    console.error(report.error);
    if (page && !page.isClosed()) await snapshot("failure").catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    if (!report.cleanupPassed) process.exitCode = 1;
    console.log(
      JSON.stringify({
        passed: report.passed,
        cleanupPassed: report.cleanupPassed,
        report: path.join(artifacts, "report.json"),
      }),
    );
  });
