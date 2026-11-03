const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright");

const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktop,
  "../../output/playwright/rich-text-subcanvas",
);
const fixture = process.argv[2] || process.env.EXCALIDRAW_RICH_TEXT_FIXTURE;
const createFixture = () => {
  const paragraphs = [
    "1、合成布局测试：中文段落与 English words 混排，用于检查固定宽度中的自动换行。".repeat(
      2,
    ),
    "2、第二段包含 Unicode：αβγ、数学符号 ∑ 与数字 12345。每次打开场景，静态导出和编辑器都应保持一致的文字顺序、换行位置与段落距离。".repeat(
      3,
    ),
    "3、最后一段继续检查 mixed text 的显示效果。这里的文字全部由测试生成，不包含用户笔记或外部画布内容。",
    "4、结束。",
  ];
  const base = {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: 42,
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    created: 1,
    link: null,
    locked: false,
  };
  const title = "合成子画布标题 Synthetic subcanvas";
  return {
    type: "excalidraw",
    version: 2,
    source: "rich-text-subcanvas-e2e",
    elements: [
      {
        ...base,
        id: "layout-text",
        type: "text",
        x: 350,
        y: 150,
        width: 1700,
        height: 546,
        text: paragraphs.join("\n"),
        originalText: paragraphs.join("\n"),
        fontSize: 40,
        fontFamily: 5,
        baseFontSize: null,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: false,
        lineHeight: 1.25,
        paragraphSpacing: 0.8,
        labelPosition: null,
        richText: {
          version: 1,
          paragraphs: paragraphs.map((text) => ({ runs: [{ text }] })),
        },
      },
      {
        ...base,
        id: "layout-pin",
        type: "stickynote",
        x: 80,
        y: 160,
        width: 48,
        height: 56,
        baseHeight: 56,
        backgroundColor: "#ffdf6b",
        customData: { subcanvas: { sceneId: "layout-child", title } },
      },
    ],
    appState: {
      subscenes: {
        "layout-child": {
          version: 1,
          title,
          elements: [],
          appState: { viewBackgroundColor: "#ffffff" },
        },
      },
    },
    files: {},
  };
};
let application;
let page;
let cleanupPromise;
const owned = new Map();
const report = {
  fixture: fixture || "generated synthetic scene",
  steps: [],
  pageErrors: [],
  passed: false,
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
  const snapshot = processes();
  const main = snapshot.find(
    (entry) =>
      entry.pid === application?.process().pid &&
      application.process().exitCode === null &&
      application.process().signalCode === null,
  );
  if (main && !owned.has(main.pid)) owned.set(main.pid, main.command);
  let changed;
  do {
    changed = false;
    for (const entry of snapshot) {
      const parent = snapshot.find(
        (candidate) => candidate.pid === entry.parent,
      );
      if (
        parent &&
        owned.get(parent.pid) === parent.command &&
        !owned.has(entry.pid)
      ) {
        owned.set(entry.pid, entry.command);
        changed = true;
      }
    }
  } while (changed);
};
const remainingProcesses = () =>
  processes().filter((entry) => owned.get(entry.pid) === entry.command);
const signalOwned = (entry, signal) => {
  if (
    !remainingProcesses().some(
      (current) =>
        current.pid === entry.pid && current.command === entry.command,
    )
  )
    return;
  try {
    process.kill(entry.pid, signal);
  } catch {}
};
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    remember();
    if (application) {
      const running = application;
      application = null;
      const main = remainingProcesses().find(
        (entry) => entry.pid === running.process().pid,
      );
      const timeout = setTimeout(() => {
        if (main) signalOwned(main, "SIGKILL");
      }, 10000);
      try {
        await running.close();
      } catch {
        if (main) signalOwned(main, "SIGTERM");
      } finally {
        clearTimeout(timeout);
      }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      remember();
      const remaining = remainingProcesses();
      if (!remaining.length) break;
      if (attempt === 10)
        for (const entry of remaining) signalOwned(entry, "SIGTERM");
      if (attempt === 20)
        for (const entry of remaining) signalOwned(entry, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report.ownedPids = [...owned.keys()];
    report.remainingPids = remainingProcesses().map((entry) => entry.pid);
    report.cleanupPassed = report.remainingPids.length === 0;
    if (!report.cleanupPassed) {
      report.passed = false;
      process.exitCode = 1;
    }
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void cleanup().finally(() => process.exit(1)));
const step = (value) => {
  report.steps.push(value);
  console.log(value);
  remember();
};
const screenshot = (name) =>
  page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    animations: "disabled",
  });
const textInkPoint = async () => {
  const canvas = page.locator("canvas.interactive:visible");
  const bounds = await canvas.boundingBox();
  const pngBytes = await page.screenshot({ clip: bounds });
  const point = await application.evaluate(({ nativeImage }, base64) => {
    const png = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    const { width, height } = png.getSize();
    const data = png.toBitmap();
    for (let y = Math.floor(height * 0.2); y < height * 0.8; y++) {
      const pixels = [];
      for (let x = Math.floor(width * 0.3); x < width * 0.8; x++) {
        const offset = (y * width + x) * 4;
        if (data[offset] < 80 && data[offset + 1] < 80 && data[offset + 2] < 80)
          pixels.push(x);
      }
      if (pixels.length > 50) {
        const x = pixels.reduce((best, value) =>
          Math.abs(value - width / 2) < Math.abs(best - width / 2)
            ? value
            : best,
        );
        return { x: x / width, y: y / height };
      }
    }
    throw new Error("Could not locate fixture text in the actual canvas image");
  }, pngBytes.toString("base64"));
  return {
    x: bounds.x + point.x * bounds.width,
    y: bounds.y + point.y * bounds.height,
  };
};
const pinPaperPoint = async () => {
  const bounds = await page.locator("canvas.interactive:visible").boundingBox();
  const bytes = await page.screenshot({ clip: bounds });
  const point = await application.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    const { width, height } = image.getSize();
    const data = image.toBitmap();
    let sx = 0,
      sy = 0,
      count = 0;
    for (let y = Math.floor(height * 0.2); y < height * 0.7; y++) {
      for (let x = Math.floor(width * 0.2); x < width * 0.5; x++) {
        const offset = (y * width + x) * 4;
        const blue = data[offset],
          green = data[offset + 1],
          red = data[offset + 2];
        if (
          red > 235 &&
          green > 210 &&
          blue > 40 &&
          blue < 225 &&
          red - blue > 35
        ) {
          sx += x;
          sy += y;
          count++;
        }
      }
    }
    if (!count)
      throw new Error(
        "Could not locate the pin paper in the actual canvas image",
      );
    return { x: sx / count / width, y: sy / count / height };
  }, bytes.toString("base64"));
  return {
    x: bounds.x + point.x * bounds.width,
    y: bounds.y + point.y * bounds.height,
  };
};
const copySvg = async () => {
  await page
    .getByRole("menuitem", { name: /复制为 SVG 到剪贴板|Copy.*SVG/i })
    .click();
  await page.waitForFunction(
    () =>
      window.__layoutClipboard?.startsWith("<svg") ||
      window.__layoutClipboard?.includes("<svg"),
  );
  const value = await page.evaluate(() => window.__layoutClipboard);
  await page.evaluate(() => {
    window.__layoutClipboard = "";
  });
  return value;
};
const svgLines = (svg) =>
  page.evaluate((source) => {
    const root = new DOMParser().parseFromString(source, "image/svg+xml");
    const lines = [];
    for (const text of root.querySelectorAll("text")) {
      const y = Number(text.getAttribute("y"));
      const previous = lines.at(-1);
      if (previous && previous.y === y) previous.text += text.textContent;
      else lines.push({ y, text: text.textContent });
    }
    return lines.map((line) => ({
      text: line.text.trimEnd(),
      y: line.y - lines[0].y,
    }));
  }, svg);

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  report.profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "guzi-rich-subcanvas-"),
  );
  try {
    report.fixtureCopy = path.join(report.profile, "layout-check.excalidraw");
    if (fixture) await fs.copyFile(fixture, report.fixtureCopy);
    else
      await fs.writeFile(report.fixtureCopy, JSON.stringify(createFixture()));
    const electronPackage = path.dirname(require.resolve("electron"));
    const executablePath = path.join(
      electronPackage,
      "dist",
      (
        await fs.readFile(path.join(electronPackage, "path.txt"), "utf8")
      ).trim(),
    );
    await fs.access(executablePath);
    application = await _electron.launch({
      executablePath,
      args: [desktop],
      env: {
        ...process.env,
        EXCALIDRAW_DESKTOP_USER_DATA: report.profile,
        EXCALIDRAW_DESKTOP_DEV_URL: "",
      },
      timeout: 60000,
    });
    page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    assert.equal(
      await application.evaluate(({ app }) => app.getPath("userData")),
      report.profile,
    );
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(2000, 1200);
    });
    await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
    const back = page.getByRole("button", { name: "返回项目页", exact: true });
    if (await back.isVisible()) await back.click();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, report.fixtureCopy);
    await page.getByRole("button", { name: /打开文件/ }).click();
    await page.locator("canvas.interactive:visible").waitFor();
    await page.evaluate(() => {
      window.__layoutClipboard = "";
      navigator.clipboard.writeText = async (text) => {
        window.__layoutClipboard = text;
      };
      navigator.clipboard.write = async (items) => {
        const item = items[0];
        for (const type of item.types)
          if (type === "text/plain" || type === "image/svg+xml")
            window.__layoutClipboard = await (await item.getType(type)).text();
      };
    });
    step("Opened fixture through the actual desktop Open File action");
    await screenshot("01-imported");
    const textPoint = await textInkPoint();
    await page.mouse.click(textPoint.x, textPoint.y);
    await page.mouse.click(textPoint.x, textPoint.y, { button: "right" });
    await page.getByRole("menu").waitFor();
    const staticSvg = await copySvg();
    await fs.writeFile(path.join(artifacts, "static-text.svg"), staticSvg);
    report.staticLines = await svgLines(staticSvg);
    if (!fixture)
      assert.ok(
        report.staticLines.length > 4,
        "Synthetic rich text must exercise wrapping across multiple paragraphs",
      );
    await screenshot("02-static-text");
    await page.keyboard.press("Enter");
    await page.locator(".excalidraw-rich-text:visible").waitFor();
    report.editor = await page
      .locator(".excalidraw-rich-text:visible")
      .evaluate((editor) => {
        const owner = editor.ownerDocument;
        const rect = editor.getBoundingClientRect();
        const scale = Number.parseFloat(
          editor.style.transform.match(/scale\(([^)]+)/)?.[1] || "1",
        );
        const lines = [];
        const walker = owner.createTreeWalker(editor, 4);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          let index = 0;
          for (const char of text.textContent) {
            const range = owner.createRange();
            range.setStart(text, index);
            index += char.length;
            range.setEnd(text, index);
            const box = range.getBoundingClientRect();
            const top = Math.round(box.top * 10) / 10;
            const previous = lines.at(-1);
            if (previous && previous.top === top) previous.text += char;
            else lines.push({ text: char, top });
          }
        }
        return {
          width: rect.width,
          height: rect.height,
          scale,
          lines: lines.map((line) => ({
            text: line.text.trimEnd(),
            y: (line.top - lines[0].top) / scale,
          })),
        };
      });
    await screenshot("03-editing-text");
    assert.deepEqual(
      report.editor.lines.map((line) => line.text),
      report.staticLines.map((line) => line.text),
      "Editor and static SVG must wrap identically",
    );
    report.staticContentHeight = report.staticLines.at(-1).y + 50;
    assert.ok(
      Math.abs(
        report.editor.height / report.editor.scale - report.staticContentHeight,
      ) < 1,
      "Editor and static content heights must match",
    );
    for (let index = 0; index < report.staticLines.length; index++)
      assert.ok(
        Math.abs(report.editor.lines[index].y - report.staticLines[index].y) <
          1,
        `Line ${index} vertical position mismatch`,
      );
    await page.keyboard.press("Escape");
    step(
      "Verified matching static and editing text lines and paragraph positions",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Shift+Digit1");
    await screenshot("04-full-scene");
    // The import contains one pin, to the left of the text. Fit makes its paper visible.
    await page.keyboard.press("Escape");
    let pinPoint = await pinPaperPoint();
    await page.mouse.click(pinPoint.x, pinPoint.y, { button: "right" });
    await page.getByRole("menu").waitFor();
    await screenshot("05-pin-menu");
    const rename = page.getByRole("menuitem", {
      name: /修改子画布名称|Rename subcanvas/,
    });
    await rename.click();
    const title = "桌面验收：同步的子画布长标题 and English name";
    await page.getByRole("textbox", { name: /名字|Name/ }).fill(title);
    await page
      .getByRole("button", { name: /确定|Confirm/, exact: true })
      .click();
    await screenshot("06-renamed-pin");
    await page
      .getByRole("button", { name: /打开子画布|Open subcanvas/ })
      .click();
    await page.locator(".desktop-subcanvas").waitFor();
    assert.ok(
      await page
        .locator(".desktop-subcanvas-header nav")
        .getByRole("button", { name: title, exact: true })
        .isVisible(),
    );
    await screenshot("07-child-title");
    await page.getByRole("button", { name: "收起子画布", exact: true }).click();
    pinPoint = await pinPaperPoint();
    await page.mouse.click(pinPoint.x, pinPoint.y, { button: "right" });
    const titleSvg = await copySvg();
    await fs.writeFile(path.join(artifacts, "renamed-pin.svg"), titleSvg);
    assert.ok(titleSvg.includes("桌面验收"));
    await page.keyboard.press("ControlOrMeta+s");
    let savedPin;
    for (let attempt = 0; attempt < 100; attempt++) {
      const saved = JSON.parse(await fs.readFile(report.fixtureCopy, "utf8"));
      savedPin = saved.elements.find(
        (element) => element.customData?.subcanvas,
      );
      if (savedPin.customData.subcanvas.title === title) {
        assert.equal(
          saved.appState.subscenes[savedPin.customData.subcanvas.sceneId].title,
          title,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(savedPin.customData.subcanvas.title, title);
    report.savedTitle = title;
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
    step(
      "Verified right-click rename, matching child title and SVG title export",
    );
  } catch (error) {
    report.error = error.stack;
    await screenshot("failure").catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
