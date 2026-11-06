const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(desktop, "../../output/playwright/ruled-text");
const report = { passed: false, cases: [], evidence: {}, pageErrors: [] };
const owned = new Map();
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let application, page, client, isolated, profile, launch, pid, cleanupTask;

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

async function until(read, label, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  do {
    const result = await read();
    if (result) return result;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function remainingProcesses() {
  const current = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
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
  for (const item of current) {
    if (
      item.pid === pid ||
      (profile && item.command.includes(`--user-data-dir=${profile}`))
    ) {
      if (!owned.has(item.pid)) owned.set(item.pid, item.command);
    }
  }
  const live = new Set(
    current
      .filter((item) => owned.get(item.pid) === item.command)
      .map((item) => item.pid),
  );
  let size;
  do {
    size = live.size;
    for (const item of current) {
      if (live.has(item.parent) && !owned.has(item.pid)) {
        live.add(item.pid);
        owned.set(item.pid, item.command);
      }
    }
  } while (live.size !== size);
  return current.filter((item) => live.has(item.pid));
}

function cleanup() {
  cleanupTask ??= (async () => {
    try {
      await launch?.catch(() => {});
      remainingProcesses();
      if (client)
        await bounded(client.close(), 3_000, "MCP close").catch(() => {});
      if (application) {
        await bounded(
          application.evaluate(({ app }) => app.exit(0)),
          4_000,
          "Electron exit",
        ).catch(() => {});
        await bounded(application.close(), 4_000, "Playwright close").catch(
          () => {},
        );
      }
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        await until(
          () => !remainingProcesses().length,
          "isolated Electron exit",
          2_000,
        ).catch(() => {});
        for (const item of remainingProcesses()) {
          try {
            process.kill(item.pid, signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
      await until(
        () => !remainingProcesses().length,
        "isolated process cleanup",
        5_000,
      );
      if (isolated) await fs.rm(isolated, { recursive: true, force: true });
    } catch (error) {
      report.cleanupError = error.stack || String(error);
      report.passed = false;
    }
    report.ownedProcesses = [...owned].map(([pid, command]) => ({
      pid,
      command,
    }));
    report.remainingProcesses = remainingProcesses();
    report.passed &&= !report.remainingProcesses.length;
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
    report.error = `Interrupted by ${signal}`;
    report.passed = false;
    void cleanup().finally(() => process.exit(1));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function call(name, args = {}) {
  const response = await bounded(
    client.callTool({ name, arguments: args }),
    15_000,
    name,
  );
  const value =
    response.structuredContent ||
    JSON.parse(response.content.find((item) => item.type === "text").text);
  assert.ok(!response.isError, `${name}: ${JSON.stringify(value)}`);
  return value;
}

async function activeDocument(previousId) {
  return until(async () => {
    const list = await call("list_canvases");
    return list.canvases.find(
      (item) =>
        item.documentId === list.activeDocumentId &&
        item.documentId !== previousId &&
        item.initialized,
    );
  }, "active canvas ready");
}

const pane = () => page.locator(".desktop-editor-pane.is-active");
const canvas = () => pane().locator("canvas.interactive");
const editable = () =>
  pane().locator(
    "textarea[data-type=wysiwyg], .excalidraw-rich-text[contenteditable=true]",
  );
const scene = (documentId) => call("read_canvas", { documentId });
const texts = (data) =>
  data.elements.filter(
    (element) => element.type === "text" && !element.isDeleted,
  );
const papers = (data) =>
  data.elements
    .filter((element) => element.customData?.guziPaper)
    .sort((a, b) => a.y - b.y);
const rules = (data, sheet) =>
  data.elements
    .filter(
      (element) =>
        element.type === "line" &&
        element.frameId === sheet.id &&
        element.locked,
    )
    .sort((a, b) => a.y - b.y);
const layout = ({
  x,
  y,
  width,
  height,
  fontSize,
  fontFamily,
  lineHeight,
  autoResize,
  frameId,
  containerId,
  text,
  originalText,
}) => ({
  x,
  y,
  width,
  height,
  fontSize,
  fontFamily,
  lineHeight,
  autoResize,
  frameId,
  containerId,
  text,
  originalText,
});

function near(actual, expected, label, tolerance = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

// Public viewport updates bring fixture points into view. All editing uses
// Playwright's mouse/keyboard on the mounted production editor.
function editor(center) {
  return pane()
    .locator(".excalidraw")
    .evaluate(async (node, center) => {
      const owner = (item) =>
        item[Object.keys(item).find((key) => key.startsWith("__reactFiber$"))];
      let app;
      for (let fiber = owner(node); fiber; fiber = fiber.return) {
        if (fiber.stateNode?.scene && fiber.stateNode?.viewport) {
          app = fiber.stateNode;
          break;
        }
      }
      if (!app) throw new Error("Cannot locate the mounted canvas editor");
      const view = node.ownerDocument.defaultView;
      if (center) {
        app.viewport.interruptSelectionReveal();
        app.updateScene({
          appState: {
            zoom: { value: 1 },
            scrollX: app.state.width / 2 - center.x,
            scrollY: app.state.height / 2 - center.y,
            selectedElementIds: {},
          },
        });
      }
      await new Promise((resolve) =>
        view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)),
      );
      const {
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        zoom,
        activeTool,
        editingTextElement,
      } = app.state;
      return {
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        zoom: zoom.value,
        tool: activeTool.type,
        editingId: editingTextElement?.id,
        editing:
          editingTextElement && app.scene.getElement(editingTextElement.id),
        fontSize: app.state.currentItemFontSize,
        fontFamily: app.state.currentItemFontFamily,
        xl: app.props.desktopIntegration?.fontSizePresets?.xl,
      };
    }, center);
}

function project(view, x, y) {
  return {
    x: view.offsetLeft + (view.scrollX + x) * view.zoom,
    y: view.offsetTop + (view.scrollY + y) * view.zoom,
  };
}

async function begin(x, y, { tool = "selection", center = { x, y } } = {}) {
  await page.keyboard.press(tool === "text" ? "t" : "v");
  const state = await editor(center);
  assert.equal(state.tool, tool);
  const point = project(state, x, y);
  assert.equal(
    await canvas().evaluate(
      (node, { x, y }) => node.ownerDocument.elementFromPoint(x, y) === node,
      point,
    ),
    true,
    "The native input must hit the interactive canvas",
  );
  if (tool === "text") await page.mouse.click(point.x, point.y);
  else await page.mouse.dblclick(point.x, point.y);
  await editable().waitFor();
  return until(
    async () => (await editor()).editing,
    "editing element available",
  );
}

async function submit() {
  await page.keyboard.press("Escape");
  await editable().waitFor({ state: "hidden" });
}

async function enterText(documentId, x, y, value, options) {
  const element = await begin(x, y, options);
  await page.keyboard.insertText(value);
  await submit();
  return until(
    async () =>
      texts(await scene(documentId)).find(
        ({ id, originalText }) => id === element.id && originalText === value,
      ),
    `submitted text: ${value}`,
  );
}

function assertRuled(text, rule, spacing) {
  assert.equal(text.autoResize, false, "Ruled text has fixed wrap width");
  assert.equal(text.frameId, null, "Ruled text remains unclipped free text");
  assert.equal(text.containerId, null);
  near(
    text.x + text.width,
    rule.x + rule.width,
    "Wrap width ends at the physical rule",
  );
  near(text.fontSize * text.lineHeight, spacing, "Line height in scene pixels");
  near(
    text.height,
    spacing * text.text.split("\n").length,
    "Saved height accounts for wrapped and explicit lines",
  );
}

function assertFree(text, x, y) {
  assert.equal(text.autoResize, true, "Ordinary text still auto-sizes");
  near(text.x, x, "Ordinary text starts at the pointer", 2);
  near(
    text.y + (text.fontSize * text.lineHeight) / 2,
    y,
    "Ordinary text centers at the pointer",
    2,
  );
}

async function newDocument(name) {
  const { activeDocumentId: previousId } = await call("list_canvases");
  await page.locator(".desktop-titlebar-new").click();
  const chooser = page.getByRole("dialog", { name: "新建画布", exact: true });
  await chooser.getByRole("button", { name, exact: true }).click();
  if (name !== "无限画布")
    await chooser.getByLabel("纵向", { exact: true }).check();
  await chooser.getByRole("button", { name: "创建", exact: true }).click();
  return (await activeDocument(previousId)).documentId;
}

async function screenshotRows(name, text, firstRule, lastRule) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const view = await editor();
  assert.equal(view.zoom, 1);
  const top = project(view, text.x - 16, firstRule.y - 28);
  const bottom = project(view, firstRule.x + firstRule.width, lastRule.y + 10);
  const clip = {
    x: Math.floor(top.x),
    y: Math.floor(top.y),
    width: Math.floor(bottom.x) - Math.floor(top.x),
    height: Math.floor(bottom.y) - Math.floor(top.y),
  };
  const file = `${name}.png`;
  const bytes = await page.screenshot({
    path: path.join(artifacts, file),
    clip,
    scale: "css",
    caret: "hide",
  });
  const rows = await page.evaluate(
    async ({ source, stroke }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.fillStyle = stroke;
      context.fillRect(0, 0, 1, 1);
      const color = context.getImageData(0, 0, 1, 1).data;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const ink = [],
        rules = [];
      for (let y = 0; y < image.height; y++) {
        let inkPixels = 0;
        let left = Infinity;
        let blue = 0;
        for (let x = 0; x < image.width; x++) {
          const offset = (y * image.width + x) * 4;
          const [r, g, b] = data.subarray(offset, offset + 3);
          if (
            Math.max(
              Math.abs(r - color[0]),
              Math.abs(g - color[1]),
              Math.abs(b - color[2]),
            ) < 110
          ) {
            inkPixels++;
            left = Math.min(left, x);
          }
          if (x < 12 && r >= 185 && r <= 239 && b > g + 5 && g > r + 5) blue++;
        }
        if (inkPixels >= 4) {
          const line = ink.at(-1);
          if (line && y - line.bottom <= 2) {
            line.bottom = y;
            line.left = Math.min(line.left, left);
          } else ink.push({ top: y, bottom: y, left });
        }
        if (blue >= 8 && y - (rules.at(-1) ?? -10) > 2) rules.push(y);
      }
      return { ink, rules };
    },
    {
      source: `data:image/png;base64,${bytes.toString("base64")}`,
      stroke: text.strokeColor,
    },
  );
  return { file, ...rows };
}

function assertVisual(draft, committed, count, spacing) {
  for (const [stage, sample] of Object.entries({ draft, committed })) {
    assert.equal(sample.ink.length, count, `${stage}: all visible text rows`);
    assert.equal(
      sample.rules.length,
      count,
      `${stage}: all visible paper rules`,
    );
    sample.ink.forEach((row, index) => {
      near(
        row.bottom,
        sample.rules[index],
        `${stage}: ink row ${index + 1} ends near its rule`,
        5,
      );
      if (index)
        near(
          sample.rules[index] - sample.rules[index - 1],
          spacing,
          `${stage}: physical rules spacing`,
          1,
        );
    });
  }
  for (let index = 0; index < count; index++) {
    const draftOffset = draft.ink[index].bottom - draft.rules[index];
    const committedOffset =
      committed.ink[index].bottom - committed.rules[index];
    near(
      draftOffset,
      committedOffset,
      `No visible jump on submit for row ${index + 1}`,
      3,
    );
    near(
      draft.ink[index].left,
      committed.ink[index].left,
      `No horizontal jump relative to the rule end for row ${index + 1}`,
      3,
    );
  }
}

async function scenario(name, run) {
  try {
    await run();
    report.cases.push({ name, passed: true });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.cases.push({
      name,
      passed: false,
      error: error.stack || String(error),
    });
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    await page
      .screenshot({
        path: path.join(artifacts, `failure-${report.cases.length}.png`),
        timeout: 3_000,
      })
      .catch(() => {});
  } finally {
    if (await editable().isVisible()) await submit();
  }
}

async function setup() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-ruled-text-"));
  profile = path.join(isolated, "profile");
  const workspace = path.join(isolated, "workspace");
  await Promise.all([fs.mkdir(profile), fs.mkdir(workspace)]);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: workspace,
      language: "zh-CN",
      theme: "light",
      toolPanelDock: "left",
      toolPanelPinned: true,
    }),
  );
  launch = _electron
    .launch({
      executablePath:
        process.env.EXCALIDRAW_E2E_EXECUTABLE || require("electron"),
      args: [desktop, `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        EXCALIDRAW_DESKTOP_USER_DATA: profile,
        EXCALIDRAW_DESKTOP_DEV_URL: "",
      },
      timeout: 30_000,
    })
    .then((current) => {
      application = current;
      pid = current.process().pid;
      remainingProcesses();
    });
  await launch;
  report.runtime = await application.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1450, 950);
    return {
      profile: app.getPath("userData"),
      version: app.getVersion(),
      electron: process.versions.electron,
    };
  });
  assert.equal(report.runtime.profile, profile);
  report.runtime.pid = pid;
  page = await application.firstWindow();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (error) =>
    report.pageErrors.push(error.stack || String(error)),
  );
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const service = await enableMcpInSettings(page, await freePort());
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-ruled-text-e2e", version: "1.0.0" });
  await bounded(
    client.connect(
      new StreamableHTTPClientTransport(new URL(service.endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
      }),
    ),
    15_000,
    "MCP connect",
  );
}

async function importPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, "0") + " 00000 n \n";
  });
  const xref = body.length;
  body += `xref\n0 5\n0000000000 65535 f \n${offsets.join(
    "",
  )}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const source = path.join(isolated, "annotation.pdf");
  await fs.writeFile(source, body);
  await application.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filename],
    });
  }, source);
  const { activeDocumentId } = await call("list_canvases");
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.getByRole("button", { name: "导入 PDF", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入 PDF", exact: true });
  await importer
    .getByRole("button", { name: "选择 PDF 文件", exact: true })
    .click();
  await importer.waitFor({ state: "hidden" });
  return (await activeDocument(activeDocumentId)).documentId;
}

async function main() {
  await setup();
  let documentId = await newDocument("A4 横线");
  const initial = await scene(documentId);
  const [sheet] = papers(initial);
  assert.equal(sheet.customData.guziPaper.kind, "ruled");
  const lines = rules(initial, sheet);
  const first = lines[9];
  const x = sheet.x + 298;
  const y = first.y - 10;
  let ruledId;

  await scenario(
    "Native Chinese soft wrap, Enter and stable raster alignment",
    async () => {
      const draft = await begin(x, y, {
        center: { x: sheet.x + sheet.width / 2, y: y + 35 },
      });
      ruledId = draft.id;
      const long =
        "中文横线纸测试编辑中的长句会自动换行并且后续文字继续沿着每一条规则线排列".repeat(
          2,
        );
      const last = "最后一行手动回车";
      await page.keyboard.insertText(long);
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(last);
      const value = `${long}\n${last}`;
      const live = await until(async () => {
        const item = (await editor()).editing;
        return item?.originalText === value && item;
      }, "both native text inputs and Enter reach the scene");
      const count = live.text.split("\n").length;
      const lastRule = lines[9 + count - 1];
      const editing = await screenshotRows(
        "01-chinese-editing",
        live,
        first,
        lastRule,
      );
      await submit();
      const after = await until(
        async () =>
          texts(await scene(documentId)).find(
            (item) => item.id === ruledId && item.originalText === value,
          ),
        "committed ruled text",
      );
      const committed = await screenshotRows(
        "02-chinese-committed",
        after,
        first,
        lastRule,
      );
      report.evidence.chinese = {
        draft: layout(live),
        saved: layout(after),
        editing,
        committed,
      };
      assert.ok(
        count > 2,
        "The long Chinese paragraph is soft wrapped in addition to the manual break",
      );
      assert.equal(after.text.split("\n").at(-1), last);
      near(after.x, x, "Horizontal anchor stays at click", 1);
      assertRuled(after, first, 32);
      assertVisual(editing, committed, count, 32);
    },
  );

  await scenario(
    "Re-editing and XL preserve the same element, family and 32px grid",
    async () => {
      const before = texts(await scene(documentId)).find(
        ({ id }) => id === ruledId,
      );
      assert.ok(before);
      const editing = await begin(before.x + 12, first.y - 9);
      assert.equal(editing.id, before.id);
      await page.keyboard.press(`${modifier}+a`);
      await page.keyboard.insertText("原来的文字元素");
      await submit();
      const replaced = await until(
        async () =>
          texts(await scene(documentId)).find(
            (item) =>
              item.id === before.id && item.originalText === "原来的文字元素",
          ),
        "same text ID after re-edit",
      );
      assertRuled(replaced, first, 32);
      const state = await editor();
      const point = project(state, replaced.x + 12, first.y - 9);
      await page.mouse.click(point.x, point.y);
      const xl = pane().getByTestId("fontSize-veryLarge");
      await xl.locator("..").click();
      const resized = await until(
        async () =>
          texts(await scene(documentId)).find(
            ({ id, fontSize }) =>
              id === before.id && fontSize !== before.fontSize,
          ),
        "XL font change is applied to the selected ruled text",
      );
      report.evidence.xl = {
        requested: state.xl,
        before: layout(replaced),
        after: layout(resized),
      };
      assertRuled(resized, first, 32);
      assert.equal(resized.fontFamily, before.fontFamily);
      assert.ok(resized.fontSize < state.xl, "XL is reduced to fit the row");
      assert.ok(
        resized.fontSize > before.fontSize,
        "The fitted XL increases the original default font size",
      );
    },
  );

  await scenario(
    "Ruled margins and T tool preserve ordinary text behavior",
    async () => {
      for (const [dx, dy, label, options] of [
        [36, 208, "左边距"],
        [sheet.width - 30, 208, "右边距"],
        [300, 28, "首行上方留白"],
        [450, 211, "文字工具", { tool: "text" }],
      ]) {
        const x = sheet.x + dx;
        const y = sheet.y + dy;
        const result = await enterText(documentId, x, y, label, options);
        assertFree(result, x, y);
      }
    },
  );

  await scenario(
    "Existing free text, shape label, and table cell keep their editing targets",
    async () => {
      const { revision } = await scene(documentId);
      const result = await call("apply_operations", {
        documentId,
        expectedRevision: revision,
        requestId: randomUUID(),
        operations: [
          {
            type: "create",
            tempId: "free",
            element: {
              type: "text",
              x: sheet.x + 180,
              y: sheet.y + 442,
              text: "普通文字",
              fontSize: 20,
            },
          },
          {
            type: "create",
            tempId: "shape",
            element: {
              type: "rectangle",
              x: sheet.x + 180,
              y: sheet.y + 505,
              width: 190,
              height: 60,
              backgroundColor: "#a5d8ff",
              label: { text: "形状标签" },
            },
          },
          {
            type: "create",
            tempId: "table",
            element: {
              type: "table",
              x: sheet.x + 180,
              y: sheet.y + 600,
              rows: [48, 48],
              columns: [140, 130],
              cells: [{ row: 0, column: 0, text: "表格单元格", fontSize: 20 }],
            },
          },
        ],
      });
      const before = texts(await scene(documentId));
      const byText = (value) =>
        before.find(({ originalText }) => originalText === value);
      const cases = [
        [byText("普通文字"), 195, 454, null],
        [byText("形状标签"), 275, 535, result.idMap.shape],
        [byText("表格单元格"), 250, 624, byText("表格单元格")?.containerId],
      ];
      assert.ok(cases[2][3], "Fixture has a bound table-cell label");
      for (const [element, dx, dy, container] of cases) {
        assert.ok(element);
        const draft = await begin(sheet.x + dx, sheet.y + dy);
        assert.equal(draft.id, element.id);
        await page.keyboard.press(`${modifier}+a`);
        const updated = `${element.originalText}已编辑`;
        await page.keyboard.insertText(updated);
        await submit();
        const after = await until(
          async () =>
            texts(await scene(documentId)).find(
              (item) => item.id === element.id && item.originalText === updated,
            ),
          `existing editor: ${element.originalText}`,
        );
        assert.equal(after.containerId, container);
        near(
          after.lineHeight,
          element.lineHeight,
          "Original line-height ratio is retained",
        );
      }
    },
  );

  await scenario(
    "Blank A4 and inter-page gap preserve ordinary text behavior",
    async () => {
      await pane()
        .getByRole("button", { name: "页面管理", exact: true })
        .click();
      await pane()
        .getByRole("button", { name: "在当前页后插入空白页", exact: true })
        .click();
      const blank = await until(
        async () =>
          papers(await scene(documentId)).find((item) => item.id !== sheet.id),
        "inserted blank sheet",
      );
      assert.equal(blank.customData.guziPaper.kind, "blank");
      await page.keyboard.press("Escape");
      for (const [x, y, label] of [
        [sheet.x + 185, (blank.y + sheet.y + sheet.height) / 2, "页间留白"],
        [blank.x + 185, blank.y + 198, "空白纸"],
      ]) {
        assertFree(await enterText(documentId, x, y, label), x, y);
      }
    },
  );

  await scenario(
    "Page reorder moves ruled text with the rule and save/reopen retains layout",
    async () => {
      const before = await scene(documentId);
      const original = texts(before).find(({ id }) => id === ruledId);
      assert.ok(original);
      const toggle = pane().getByRole("button", {
        name: "页面管理",
        exact: true,
      });
      if ((await toggle.getAttribute("aria-expanded")) !== "true")
        await toggle.click();
      const row = pane().locator(".desktop-paper-page-list > li").first();
      await row.getByRole("button", { name: /下移/ }).click();
      const moved = await until(async () => {
        const data = await scene(documentId);
        return papers(data)[1]?.id === sheet.id && data;
      }, "ruled sheet moved to position two");
      const movedSheet = papers(moved)[1];
      const movedRule = rules(moved, movedSheet)[9];
      const movedText = texts(moved).find(({ id }) => id === ruledId);
      near(
        movedText.y - movedRule.y,
        original.y - first.y,
        "Text follows the page's rule when reordered",
      );
      assertRuled(movedText, movedRule, 32);
      await page.keyboard.press("Escape");
      const saved = await call("save_canvas", { documentId });
      assert.ok(
        (await fs.realpath(saved.path)).startsWith(
          `${await fs.realpath(isolated)}${path.sep}`,
        ),
        "Only the isolated workspace can be saved",
      );
      await call("close_document", { documentId });
      const reopened = await call("open_canvas", { path: saved.path });
      assert.notEqual(reopened.documentId, documentId);
      documentId = reopened.documentId;
      const restored = await until(
        async () =>
          texts(await scene(reopened.documentId)).find(
            ({ id }) => id === ruledId,
          ),
        "saved text ID restored",
      );
      report.evidence.reopened = layout(restored);
      assert.deepEqual(layout(restored), layout(movedText));
    },
  );

  await scenario(
    "File settings reflow existing text, undo as one step and survive reopen",
    async () => {
      const settings = { lineSpacing: 44, fontSize: 25 };
      const data = await scene(documentId);
      const currentSheet = papers(data).find(({ id }) => id === sheet.id);
      const original = texts(data).find(({ id }) => id === ruledId);
      assert.ok(original);
      const free = texts(data).find(
        ({ originalText }) => originalText === "普通文字已编辑",
      );
      assert.ok(free);
      await editor({
        x: currentSheet.x + currentSheet.width / 2,
        y: currentSheet.y + 360,
      });
      await pane()
        .getByRole("button", { name: "纸张设置", exact: true })
        .click();
      const dialog = pane().getByRole("dialog", {
        name: "纸张设置",
        exact: true,
      });
      await dialog
        .getByLabel("横线间距", { exact: true })
        .fill(String(settings.lineSpacing));
      await dialog
        .getByLabel("默认字号", { exact: true })
        .fill(String(settings.fontSize));
      const beforeApply = await scene(documentId);
      assert.deepEqual(
        rules(beforeApply, currentSheet).map(({ y }) => y),
        rules(data, currentSheet).map(({ y }) => y),
      );
      await dialog.getByRole("button", { name: "应用", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const readApplied = async () => {
        const data = await scene(documentId);
        const page = papers(data).find(({ id }) => id === sheet.id);
        return (
          page.customData.guziPaper.settings?.lineSpacing ===
            settings.lineSpacing && data
        );
      };
      const changed = await until(
        readApplied,
        "applied file-local paper settings",
      );
      const changedPage = papers(changed).find(({ id }) => id === sheet.id);
      const changedLines = rules(changed, changedPage);
      assert.deepEqual(changedPage.customData.guziPaper.settings, settings);
      assert.equal(changedLines[1].y - changedLines[0].y, settings.lineSpacing);
      const reflowed = texts(changed).find(({ id }) => id === ruledId);
      const previousBaseline = rules(data, currentSheet)[9].y;
      const nearestRule = changedLines.reduce((nearest, rule) =>
        Math.abs(rule.y - previousBaseline) <
        Math.abs(nearest.y - previousBaseline)
          ? rule
          : nearest,
      );
      assertRuled(reflowed, nearestRule, settings.lineSpacing);
      assert.equal(reflowed.originalText, original.originalText);
      near(
        reflowed.y +
          previousBaseline -
          original.y +
          (settings.lineSpacing - 32) / 2,
        nearestRule.y,
        "Existing text baseline snaps to the nearest new rule",
      );
      assert.deepEqual(
        layout(texts(changed).find(({ id }) => id === free.id)),
        layout(free),
      );
      await page.keyboard.press(`${modifier}+z`);
      const undone = await until(async () => {
        const undone = await scene(documentId);
        const sheet = papers(undone).find(({ id }) => id === currentSheet.id);
        const lines = rules(undone, sheet);
        return lines[1].y - lines[0].y === 32 && undone;
      }, "one undo restores previous rule spacing");
      assert.deepEqual(
        layout(texts(undone).find(({ id }) => id === ruledId)),
        layout(original),
      );
      await page.keyboard.press(`${modifier}+Shift+z`);
      await until(readApplied, "one redo restores file settings");

      const saved = await call("save_canvas", { documentId });
      await call("close_document", { documentId });
      const reopened = await call("open_canvas", { path: saved.path });
      documentId = reopened.documentId;
      const restored = await until(
        readApplied,
        "reopened paper retains settings",
      );
      assert.deepEqual(
        layout(texts(restored).find(({ id }) => id === ruledId)),
        layout(reflowed),
      );
      const rule = changedLines[1];
      const created = await enterText(
        documentId,
        changedPage.x + 420,
        rule.y - 9,
        "重开后使用文件默认字号",
      );
      assertRuled(created, rule, settings.lineSpacing);
      assert.equal(created.fontSize, settings.fontSize);
      const visible = await screenshotRows(
        "03-file-setting-restored",
        created,
        rule,
        rule,
      );
      assert.equal(
        visible.rules.length,
        1,
        "The rebuilt rule is visible above the paper background",
      );
      assert.equal(
        visible.ink.length,
        1,
        "The isolated sample occupies one visual row",
      );
      near(
        visible.ink[0].bottom,
        visible.rules[0],
        "Reopened file's new text ends at the visible rebuilt rule",
        5,
      );
      report.evidence.fileSettings = {
        settings,
        moved: layout(reflowed),
        created: layout(created),
        visible,
      };
    },
  );

  await scenario("Another ruled A4 keeps its own defaults", async () => {
    const other = await newDocument("A4 横线");
    const data = await scene(other);
    const [sheet] = papers(data);
    const [first, second] = rules(data, sheet);
    assert.equal(second.y - first.y, 32);
    const text = await enterText(
      other,
      sheet.x + 80,
      first.y - 10,
      "双击空白处开始写字，长句会沿着横线换行。",
    );
    assertRuled(text, first, 32);
    assert.equal(text.fontSize, 20);
    const saved = await call("save_canvas", { documentId: other });
    const demo = "横线文字手测.excalidraw";
    await fs.copyFile(saved.path, path.join(artifacts, demo));
    report.evidence.demo = demo;
  });

  await scenario(
    "Infinite canvas double-click still creates ordinary text",
    async () => {
      const infinite = await newDocument("无限画布");
      const result = await enterText(infinite, 220, 220, "无限画布文字");
      assertFree(result, 220, 220);
    },
  );

  await scenario(
    "Imported PDF keeps ordinary editable annotation behavior",
    async () => {
      const pdf = await importPdf();
      const [sheet] = papers(await scene(pdf));
      assert.equal(sheet.customData.guziPaper.kind, "pdf");
      const x = sheet.x + 240;
      const y = sheet.y + 190;
      assertFree(await enterText(pdf, x, y, "PDF 批注"), x, y);
    },
  );

  report.passed =
    report.cases.every(({ passed }) => passed) && !report.pageErrors.length;
}

bounded(main(), 230_000, "ruled paper text acceptance")
  .catch((error) => {
    report.error = error.stack || String(error);
    process.stderr.write(`${report.error}\n`);
  })
  .finally(async () => {
    await cleanup();
    process.exit(report.passed ? 0 : 1);
  });
