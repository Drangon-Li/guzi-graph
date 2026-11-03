const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/drag-preview",
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

const exists = (name) =>
  fs.stat(name).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
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
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-drag-preview-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  await fs.mkdir(profile);
  await fs.mkdir(path.join(project, "destination"), { recursive: true });
  const filename =
    "A long drawing title for a compact moving preview.excalidraw";
  await fs.writeFile(
    path.join(project, filename),
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "drag-preview-blue-rectangle",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 160,
          height: 100,
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
        },
      ],
      appState: {},
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
  application = await _electron.launch({
    executablePath,
    args: [desktopDirectory],
    timeout: 60000,
    env: {
      ...process.env,
      EXCALIDRAW_DESKTOP_USER_DATA: profile,
      EXCALIDRAW_DESKTOP_DEV_URL: "",
    },
  });
  remember();
  report.pid = application.process().pid;
  report.profile = profile;
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const pane = page.locator(".desktop-project-pane.is-active");
  await pane.getByRole("button", { name: /全部画布/ }).click();
  const card = pane.locator(".desktop-file-card").first();
  const target = pane
    .locator('.desktop-category-row > button[title="destination"]')
    .locator("..");
  await card.waitFor();
  await card.locator(".desktop-file-preview img").waitFor();
  await page.evaluate(() => {
    const root = document.querySelector(".desktop-shell");
    const ownerWindow = root.ownerDocument.defaultView;
    const original = ownerWindow.DataTransfer.prototype.setDragImage;
    ownerWindow.__dragEvents = [];
    for (const type of ["dragstart", "dragover", "drop", "dragend"])
      root.addEventListener(
        type,
        (event) => {
          ownerWindow.__dragEvents.push({ type, trusted: event.isTrusted });
        },
        true,
      );
    ownerWindow.DataTransfer.prototype.setDragImage = function (node, x, y) {
      const preview = node.querySelector(".desktop-drag-preview");
      const content = node.querySelector(".desktop-file-preview");
      const style = ownerWindow.getComputedStyle(preview);
      ownerWindow.__dragImage = {
        width: node.offsetWidth,
        height: node.offsetHeight,
        contentWidth: content.offsetWidth,
        contentHeight: content.offsetHeight,
        transform: style.transform,
        background: style.backgroundColor,
        title: node.querySelector(".desktop-drag-preview-title").textContent,
        label: node.querySelector(".desktop-drag-preview-label").textContent,
        animation: ownerWindow.getComputedStyle(
          content.firstElementChild || content,
        ).animationName,
        x,
        y,
        connected: node.isConnected,
        scoped: node.parentElement === root,
        html: node.outerHTML,
      };
      return original.call(this, node, x, y);
    };
  });
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + 75);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 35, from.y + 95, {
    steps: 8,
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 18,
  });
  await page.mouse.move(to.x + to.width / 2 + 1, to.y + to.height / 2, {
    steps: 2,
  });
  await target
    .locator(".desktop-drop-target")
    .count()
    .catch(() => {});
  assert.equal(
    await target.evaluate((node) =>
      node.classList.contains("desktop-drop-target"),
    ),
    true,
  );
  await page.screenshot({
    path: path.join(artifacts, "during-native-drag.png"),
  });
  report.screenshots.push("during-native-drag.png");
  await page.mouse.up();
  await until(
    () => exists(path.join(project, "destination", filename)),
    "real native file drop",
  );
  assert.equal(await exists(path.join(project, filename)), false);
  report.dragImage = await page.evaluate(() => window.__dragImage);
  report.events = await page.evaluate(() => window.__dragEvents);
  assert.equal(report.dragImage.contentWidth, 144);
  assert.equal(report.dragImage.contentHeight, 96);
  assert.equal(report.dragImage.width, 184);
  assert.match(report.dragImage.transform, /^matrix\(0\.996/);
  assert.equal(report.dragImage.animation, "none");
  assert.equal(report.dragImage.connected, true);
  assert.equal(report.dragImage.scoped, true);
  assert.deepEqual([report.dragImage.x, report.dragImage.y], [0, 0]);
  assert.ok(
    report.events.some((event) => event.type === "dragstart" && event.trusted),
  );
  assert.ok(
    report.events.some((event) => event.type === "drop" && event.trusted),
  );
  assert.equal(await page.locator(".desktop-drag-preview-host").count(), 0);
  await page.evaluate(() => {
    const root = document.querySelector(".desktop-shell");
    const template = root.ownerDocument.createElement("template");
    template.innerHTML = root.ownerDocument.defaultView.__dragImage.html;
    const host = template.content.firstElementChild;
    host.style.left = "400px";
    host.style.top = "200px";
    host.dataset.e2ePreview = "true";
    root.append(host);
  });
  await page.screenshot({
    path: path.join(artifacts, "captured-setDragImage-node.png"),
  });
  report.screenshots.push("captured-setDragImage-node.png");
  delete report.dragImage.html;
  await page.locator("[data-e2e-preview]").evaluate((node) => node.remove());
  report.evidenceBoundary =
    "during-native-drag.png is a renderer screenshot; OS drag ghost may be omitted. captured-setDragImage-node.png displays the exact captured node separately, not the native OS ghost. Geometry and transform recorded synchronously from the actual native setDragImage call; trusted dragstart/drop and disk move verify actual mouse DnD.";
  report.scenarios.push(
    "trusted mouse drag uses compact rotated preview, highlights destination, moves real fixture file, and removes temporary preview",
  );
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    process.exitCode = 1;
    console.error(report.error);
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
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
          report: path.join(artifacts, "report.json"),
        },
        null,
        2,
      ),
    );
  });
