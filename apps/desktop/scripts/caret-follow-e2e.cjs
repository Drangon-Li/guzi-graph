const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/caret-follow",
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
    if (await read()) {
      return;
    }
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
  if (main) {
    owned.set(main.pid, main.command);
  }
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
  if (!application) {
    return;
  }
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
  if (cleaning) {
    return cleaning;
  }
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
    if (!report.cleanupPassed) {
      report.passed = false;
    }
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (isolated && report.cleanupPassed) {
      await fs.rm(isolated, { recursive: true, force: true });
    }
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

const editorState = () =>
  page.evaluate(() => {
    const app = window.__caretApp;
    const editable = app.ownerDocument.querySelector(
      ".desktop-editor-pane.is-active .excalidraw-rich-text, .desktop-editor-pane.is-active textarea[data-type=wysiwyg]",
    );
    const element = app.scene
      .getNonDeletedElements()
      .find((el) => el.type === "text");
    return {
      scrollX: app.state.scrollX,
      scrollY: app.state.scrollY,
      zoom: app.state.zoom.value,
      width: app.state.width,
      height: app.state.height,
      editing: !!app.state.editingTextElement,
      text: element?.originalText,
      domText: editable?.value ?? editable?.textContent,
      focused: app.ownerDocument.activeElement === editable,
      top: editable?.getBoundingClientRect().top,
      bottom: editable?.getBoundingClientRect().bottom,
      offsetTop: app.state.offsetTop,
      pending: app.viewport.isAnimating,
    };
  });
const frames = (count = 2) =>
  page.evaluate(async (number) => {
    const win = window.__caretApp.ownerWindow;
    for (let i = 0; i < number; i++) {
      await new Promise((resolve) => win.requestAnimationFrame(resolve));
    }
  }, count);
const settle = async () => {
  await frames(2);
  await until(
    async () => !(await editorState()).pending,
    "caret animation to settle",
  );
};
async function setup({
  rich = false,
  zoom = 1,
  angle = 0,
  value = "中文",
  caret = value.length,
  list = false,
} = {}) {
  await page.evaluate(
    async (options) => {
      const app = window.__caretApp;
      app.text.textWysiwygSubmitHandler?.();
      const base = window.__caretBase;
      const paragraphs = options.value.split("\n").map((text) => ({
        runs: [{ text }],
        ...(options.list ? { list: { kind: "bullet", indent: 0 } } : {}),
      }));
      const text = {
        ...base,
        id: "caret-test-text",
        x: (app.state.width * 0.55) / options.zoom,
        y: (app.state.height - 34) / options.zoom,
        angle: options.angle,
        text: options.value,
        originalText: options.value,
        width: Math.max(30, options.value.length * 20),
        height: 25 * Math.max(1, paragraphs.length),
        version: base.version + Date.now(),
        versionNonce: Date.now() % 2147483647,
        richText: options.rich ? { version: 1, paragraphs } : undefined,
        containerId: null,
        boundElements: null,
      };
      window.__caretApi.updateScene({
        elements: [text],
        appState: {
          scrollX: 0,
          scrollY: 0,
          zoom: { value: options.zoom },
          selectedElementIds: {},
        },
      });
      await new Promise((resolve) =>
        app.setState({ editingTextElement: text }, () => {
          app.text.handleTextWysiwyg(app.scene.getElement(text.id), {
            isExistingElement: true,
            initialSelection: { start: options.caret, end: options.caret },
          });
          resolve();
        }),
      );
    },
    { rich, zoom, angle, value, caret, list },
  );
  await page
    .locator(
      rich
        ? ".desktop-editor-pane.is-active .excalidraw-rich-text:visible"
        : ".desktop-editor-pane.is-active textarea[data-type=wysiwyg]:visible",
    )
    .waitFor();
  await frames(2);
  return editorState();
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
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guzi-caret-follow-")),
  );
  profile = path.join(isolated, "profile");
  project = path.join(isolated, "projects");
  await fs.mkdir(profile);
  await fs.mkdir(project);
  const fixture = {
    id: "caret-test-text",
    type: "text",
    x: 400,
    y: 300,
    width: 80,
    height: 25,
    angle: 0,
    text: "中文",
    originalText: "中文",
    fontSize: 20,
    fontFamily: 5,
    lineHeight: 1.25,
    textAlign: "left",
    verticalAlign: "top",
    autoResize: true,
    containerId: null,
    strokeColor: "#1b1b1f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
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
  };
  await fs.writeFile(
    path.join(project, "caret-follow.excalidraw"),
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [fixture],
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
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
  await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
  const back = page.getByRole("button", { name: "返回项目页", exact: true });
  if (await back.isVisible()) {
    await back.click();
  }
  await page.getByRole("button", { name: /全部画布/ }).click();
  await page
    .locator(".desktop-project-pane.is-active .desktop-file-card")
    .first()
    .locator(".desktop-file-open")
    .click();
  await page
    .locator(".desktop-editor-pane.is-active canvas.interactive:visible")
    .waitFor();
  await page.locator(".desktop-editor-pane.is-active").evaluate((mounted) => {
    const owner = (node) =>
      node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))];
    let model;
    let app;
    for (let fiber = owner(mounted); fiber; fiber = fiber.return) {
      if (fiber.memoizedProps?.document?.api) {
        model = fiber.memoizedProps.document;
        break;
      }
    }
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
    if (!model || !app) {
      throw Error("Missing production editor");
    }
    window.__caretApp = app;
    window.__caretApi = model.api;
    window.__caretBase = app.scene
      .getNonDeletedElements()
      .find((el) => el.type === "text");
  });
  for (const rich of [false, true]) {
    for (const zoom of [0.5, 1, 2]) {
      for (const angle of [0, 0.25]) {
        const before = await setup({ rich, zoom, angle });
        await page.keyboard.type("!");
        const samples = await page.evaluate(async () => {
          const app = window.__caretApp;
          const samples = [];
          for (let i = 0; i < 16; i++) {
            await new Promise((resolve) =>
              app.ownerWindow.requestAnimationFrame(resolve),
            );
            samples.push(app.state.scrollY);
          }
          return samples;
        });
        await settle();
        const after = await editorState();
        assert.ok(
          after.scrollY < before.scrollY,
          JSON.stringify({ rich, zoom, angle, before, after }),
        );
        assert.equal(after.zoom, zoom);
        assert.ok(after.focused && after.editing);
        assert.equal(after.text, "中文!");
        const stable = after.scrollY;
        await frames(12);
        assert.equal((await editorState()).scrollY, stable);
        report.scenarios.push({
          name: "trusted keyboard input",
          rich,
          zoom,
          angle,
          before,
          after,
          intermediatePositions: [...new Set(samples)].length,
        });
      }
    }
  }
  for (const rich of [false, true]) {
    await setup({ rich });
    const before = await editorState();
    await page.evaluate(() => {
      const app = window.__caretApp;
      const doc = app.ownerDocument;
      const win = app.ownerWindow;
      const editable = doc.querySelector(
        ".desktop-editor-pane.is-active .excalidraw-rich-text, .desktop-editor-pane.is-active textarea[data-type=wysiwyg]",
      );
      window.__composingEditable = editable;
      editable.dispatchEvent(
        new win.CompositionEvent("compositionstart", {
          bubbles: true,
          data: "",
        }),
      );
      let node;
      if (editable.tagName === "TEXTAREA") {
        editable.value = "中文输入";
        editable.setSelectionRange(4, 4);
      } else {
        node = editable.querySelector("[data-lexical-text]").firstChild;
        node.textContent = "中文输入";
        win.getSelection().collapse(node, 4);
      }
      window.__composingNode = node;
      editable.dispatchEvent(
        new win.InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "输入",
          isComposing: true,
        }),
      );
    });
    await settle();
    const during = await editorState();
    assert.ok(during.scrollY < before.scrollY - 30);
    assert.ok(during.focused && during.editing);
    const preserved = await page.evaluate(() => {
      const editable = window.__composingEditable;
      const app = window.__caretApp;
      return {
        same:
          editable.isConnected && app.ownerDocument.activeElement === editable,
        node:
          !window.__composingNode ||
          editable.querySelector("[data-lexical-text]").firstChild ===
            window.__composingNode,
        focus:
          !window.__composingNode ||
          app.ownerWindow.getSelection().focusNode === window.__composingNode,
      };
    });
    assert.ok(preserved.same && preserved.node && preserved.focus);
    const screenshot = `composition-${rich ? "rich" : "plain"}.png`;
    await page.screenshot({ path: path.join(artifacts, screenshot) });
    report.screenshots.push(screenshot);
    await page.evaluate(() => {
      const app = window.__caretApp;
      const win = app.ownerWindow;
      const editable = window.__composingEditable;
      editable.dispatchEvent(
        new win.CompositionEvent("compositionend", {
          bubbles: true,
          data: "输入",
        }),
      );
      editable.dispatchEvent(
        new win.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "输入",
        }),
      );
    });
    await settle();
    assert.equal((await editorState()).text, "中文输入");
    report.scenarios.push({
      name: "simulated composition preserves DOM",
      rich,
      before,
      during,
      preserved,
    });
  }
  await setup({ rich: true, value: "first\n", list: true });
  await page.keyboard.type("next");
  await settle();
  assert.ok((await editorState()).text.includes("next"));
  report.scenarios.push({
    name: "empty list item and soft line",
    state: await editorState(),
  });
  await setup({ rich: true, value: "first\n" });
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("next");
  await settle();
  assert.ok((await editorState()).text.includes("next"));
  report.scenarios.push({ name: "soft break", state: await editorState() });
  await setup();
  await page.keyboard.type("!");
  await frames(2);
  const canvas = await page
    .locator(".desktop-editor-pane.is-active canvas.interactive")
    .boundingBox();
  await page.mouse.move(
    canvas.x + canvas.width * 0.7,
    canvas.y + canvas.height * 0.5,
  );
  await page.mouse.wheel(0, -180);
  await frames(2);
  const stopped = await editorState();
  await frames(20);
  assert.equal((await editorState()).scrollY, stopped.scrollY);
  await page.keyboard.type("?");
  await settle();
  const resumed = await editorState();
  assert.ok(resumed.scrollY < stopped.scrollY);
  report.scenarios.push({
    name: "trusted wheel cancels and new input resumes",
    stopped,
    resumed,
  });
  report.evidenceBoundary =
    "CompositionEvent/InputEvent scenarios simulate composition in Chromium and inspect real native DOM geometry. No OS input method or candidate popup is activated; system Chinese candidate-window clearance remains a manual visual check.";
  assert.deepEqual(report.errors, []);
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    process.exitCode = 1;
    process.stderr.write(`${report.error}\n`);
    if (page && !page.isClosed()) {
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          timeout: 5000,
        })
        .catch(() => {});
    }
  })
  .finally(async () => {
    await cleanup();
    if (!report.cleanupPassed) {
      process.exitCode = 1;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          passed: report.passed,
          cleanupPassed: report.cleanupPassed,
          report: path.join(artifacts, "report.json"),
        },
        null,
        2,
      )}\n`,
    );
  });
