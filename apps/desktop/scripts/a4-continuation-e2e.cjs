const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

const { _electron } = require("playwright");

const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktop,
  "../../output/playwright/a4-continuation",
);
const report = { passed: false, checks: [], errors: [] };
let application;
let page;
let client;
let isolated;
const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
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
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const waitFor = async (test) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for desktop test result");
};
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const value =
    response.structuredContent ||
    JSON.parse(response.content.find((item) => item.type === "text").text);
  assert.ok(!response.isError, JSON.stringify(value));
  return value;
};
const current = async () => {
  const state = await call("list_canvases");
  return state.canvases.find(
    (item) => item.documentId === state.activeDocumentId,
  );
};

function fixturePdf() {
  const streams = [
    "0.8 0.1 0.1 rg 50 600 200 80 re f BT /F1 24 Tf 50 550 Td (PDF Page One) Tj ET",
    "0.1 0.3 0.8 rg 40 350 200 80 re f BT /F1 24 Tf 40 300 Td (PDF Page Two) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.2756 841.8898] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-a4-continuation-"));
  const drawings = path.join(isolated, "drawings");
  const profile = path.join(isolated, "profile");
  await fs.mkdir(drawings);
  await fs.mkdir(profile);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  application = await _electron.launch({
    executablePath: require("electron"),
    args: [desktop],
    env: {
      ...process.env,
      EXCALIDRAW_DESKTOP_USER_DATA: profile,
      EXCALIDRAW_DESKTOP_DEV_URL: "",
    },
    timeout: 30000,
  });
  report.pid = application.process().pid;
  report.profile = profile;
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      report.errors.push(message.text());
    }
  });
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const service = await enableMcpInSettings(page, await freePort());
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-a4-continuation-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );
  process.stdout.write(`Electron ready ${report.pid}\n`);

  const activeScene = async () =>
    call("read_canvas", { documentId: (await current()).documentId });
  const frames = async () =>
    (await activeScene()).elements
      .filter((element) => element.customData?.guziPaper && !element.isDeleted)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  const count = async (expected) =>
    waitFor(async () => (await frames()).length === expected);
  const fitLast = async () => {
    const sheets = await frames();
    await call("control_canvas", {
      documentId: (await current()).documentId,
      action: "fit",
      ids: [sheets.at(-1).id],
    });
  };
  const drag = async (distance, { retreat = 0, release = true } = {}) => {
    const box = await page
      .locator(".desktop-editor-pane.is-active canvas.interactive")
      .boundingBox();
    const x = box.x + box.width * 0.6;
    const y = box.y + Math.min(box.height - 80, 400);
    await page.mouse.move(x, y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(x, y - distance, { steps: 6 });
    if (retreat) await page.mouse.move(x, y - distance + retreat, { steps: 6 });
    if (release) {
      await page.mouse.up();
      await page.keyboard.up("Space");
    }
  };
  const release = async () => {
    await page.mouse.up();
    await page.keyboard.up("Space");
  };
  const newDocument = async (template, orientation) => {
    await page.locator(".desktop-titlebar-new").click();
    const chooser = page.getByRole("dialog", { name: "新建画布", exact: true });
    await chooser
      .getByRole("button", {
        name:
          template === "ruled"
            ? "A4 横线"
            : template === "blank"
            ? "A4 空白"
            : "无限画布",
        exact: true,
      })
      .click();
    if (template !== "infinite")
      await chooser
        .getByLabel(orientation === "portrait" ? "纵向" : "横向", {
          exact: true,
        })
        .check();
    await chooser.getByRole("button", { name: "创建", exact: true }).click();
    await waitFor(async () => (await current())?.initialized);
  };

  for (const template of ["blank", "ruled"]) {
    for (const orientation of ["portrait", "landscape"]) {
      process.stdout.write(`Checking ${template} ${orientation}\n`);
      await newDocument(template, orientation);
      const initial = (await frames())[0];
      await fitLast();
      await drag(80);
      assert.equal(
        (await frames()).length,
        1,
        "release before 96 screen pixels must not add a sheet",
      );
      await fitLast();
      await drag(160, { retreat: 140 });
      assert.equal(
        (await frames()).length,
        1,
        "retreat below 48 pixels must disarm",
      );
      await fitLast();
      await drag(160, { release: false });
      await page.getByText("松手新建一页", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await release();
      assert.equal(
        (await frames()).length,
        1,
        "Escape must cancel an armed drag",
      );

      const documentId = (await current()).documentId;
      let scene = await activeScene();
      await call("apply_operations", {
        documentId,
        expectedRevision: scene.revision,
        requestId: `outside-${template}-${orientation}`,
        operations: [
          {
            type: "create",
            element: {
              type: "text",
              x: initial.x + 100,
              y: initial.y + initial.height + 160,
              text: "OUTSIDE INK",
              fontSize: 28,
              strokeColor: "#e03131",
            },
          },
        ],
      });
      const ink = (await activeScene()).elements.find(
        (element) => element.originalText === "OUTSIDE INK",
      );
      for (let expected = 2; expected <= 3; expected++) {
        await fitLast();
        await drag(160, { release: false });
        await page.getByText("松手新建一页", { exact: true }).waitFor();
        assert.equal(
          (await frames()).length,
          expected - 1,
          "the pointer must release before creating",
        );
        await page.screenshot({
          path: path.join(
            artifacts,
            `${template}-${orientation}-armed-${expected}.png`,
          ),
        });
        await release();
        await count(expected);
      }
      const sheets = await frames();
      assert.ok(
        sheets.every(
          (sheet) =>
            sheet.width === initial.width &&
            sheet.height === initial.height &&
            sheet.customData.guziPaper.kind === template,
        ),
      );
      assert.equal(sheets[1].y, sheets[0].y + sheets[0].height + 48);
      scene = await activeScene();
      const secondBackground = scene.elements.find(
        (element) =>
          element.type === "rectangle" && element.frameId === sheets[1].id,
      );
      assert.ok(
        scene.elements.indexOf(secondBackground) <
          scene.elements.findIndex((element) => element.id === ink.id),
        "new sheet background must stay below preexisting ink",
      );
      await call("control_canvas", { documentId, action: "undo" });
      await count(2);
      await call("control_canvas", { documentId, action: "redo" });
      await count(3);
      const input = page.locator(
        ".desktop-editor-pane.is-active .desktop-paper-page-controls input",
      );
      await input.fill("1");
      await input.press("Enter");
      await waitFor(async () => (await input.inputValue()) === "1");
      await page
        .getByRole("button", { name: "下一页", exact: true })
        .filter({ visible: true })
        .click();
      await waitFor(async () => (await input.inputValue()) === "2");
      await input.fill("3");
      await input.press("Enter");
      await page
        .getByRole("button", { name: "适合页宽", exact: true })
        .filter({ visible: true })
        .click();
      const zoom = await call("control_canvas", {
        documentId,
        action: "select",
        ids: [],
      });
      assert.ok(zoom.zoom > 0);
      await page.screenshot({
        path: path.join(artifacts, `${template}-${orientation}-fit-width.png`),
      });
      await page.evaluate(() => {
        const controls = document
          .querySelector(
            ".desktop-editor-pane.is-active .desktop-paper-page-controls",
          )
          .getBoundingClientRect();
        const footer = Array.from(
          document.querySelectorAll(
            ".desktop-editor-pane.is-active .App-menu_bottom button",
          ),
        );
        for (const button of footer) {
          const rect = button.getBoundingClientRect();
          if (
            rect.width &&
            rect.height &&
            controls.left < rect.right &&
            controls.right > rect.left &&
            controls.top < rect.bottom &&
            controls.bottom > rect.top
          )
            throw new Error(
              `Paper controls overlap footer button: ${button.getAttribute(
                "aria-label",
              )}`,
            );
        }
      });
      const saved = await call("save_canvas", { documentId });
      await call("close_document", { documentId });
      const reopened = await call("open_canvas", { path: saved.path });
      await count(3);
      assert.ok(
        (await activeScene()).elements.some((element) => element.id === ink.id),
      );
      report.checks.push(
        `${template} ${orientation}: native Space drag, threshold/retreat/Escape, two continued sheets, ink order, undo/redo, page jump, fit width, save/reopen`,
      );
      process.stdout.write(`Passed ${template} ${orientation}\n`);

      if (template === "ruled" && orientation === "landscape") {
        const exported = path.join(artifacts, "continued-pages.pdf");
        await application.evaluate(({ dialog }, filename) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: filename,
          });
        }, exported);
        const expand = page
          .getByRole("button", { name: "展开工具侧栏", exact: true })
          .filter({ visible: true });
        if (await expand.count()) await expand.click();
        await page
          .getByRole("tab", { name: "画布", exact: true })
          .filter({ visible: true })
          .click();
        await page
          .locator(".desktop-editor-pane.is-active")
          .getByRole("button", { name: "导出 PDF…", exact: true })
          .click();
        await waitFor(async () => {
          try {
            return (await fs.stat(exported)).size > 100;
          } catch {
            return false;
          }
        });
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = getDocument({
          data: new Uint8Array(await fs.readFile(exported)),
        });
        try {
          const pdf = await task.promise;
          assert.equal(pdf.numPages, 3);
          for (let index = 1; index <= 3; index++) {
            const viewport = (await pdf.getPage(index)).getViewport({
              scale: 96 / 72,
            });
            assert.ok(Math.abs(viewport.width - initial.width) < 1);
            assert.ok(Math.abs(viewport.height - initial.height) < 1);
          }
        } finally {
          await task.destroy();
        }
        report.checks.push(
          "Native PDF export contains all three continued sheets at the original dimensions",
        );
      }
    }
  }
  await newDocument("infinite", "portrait");
  await drag(200);
  assert.equal((await frames()).length, 0);
  assert.equal(
    await page
      .locator(".desktop-editor-pane.is-active .desktop-paper-page-controls")
      .count(),
    0,
  );
  report.checks.push(
    "Infinite canvas has no paper controls or automatic continuation",
  );

  const source = path.join(isolated, "two-pages.pdf");
  await fs.writeFile(source, fixturePdf());
  await application.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filename],
    });
  }, source);
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.getByRole("button", { name: "导入 PDF", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入 PDF", exact: true });
  await importer
    .getByRole("button", { name: "选择 PDF 文件", exact: true })
    .click();
  await importer.waitFor({ state: "hidden" });
  await waitFor(
    async () =>
      (await current())?.title === "two-pages" && (await current()).initialized,
  );
  await fitLast();
  await drag(200);
  assert.equal((await frames()).length, 2);
  assert.ok(
    (await frames()).every(
      (frame) => frame.customData.guziPaper.kind === "pdf",
    ),
  );
  await page
    .getByRole("button", { name: "适合页宽", exact: true })
    .filter({ visible: true })
    .click();
  await page.screenshot({
    path: path.join(artifacts, "pdf-navigation-no-continuation.png"),
  });
  report.checks.push(
    "Imported PDF supports navigation and fit width without automatic continuation",
  );
  report.passed = true;
}

let stopping;
async function stop() {
  if (stopping) {
    return stopping;
  }
  stopping = (async () => {
    await client?.close().catch(() => {});
    if (application) {
      const child = application.process();
      const table = processTable();
      const owned = new Set([child.pid]);
      let size;
      do {
        size = owned.size;
        for (const process of table)
          if (owned.has(process.parent)) owned.add(process.pid);
      } while (owned.size !== size);
      const tracked = table.filter((process) => owned.has(process.pid));
      report.ownedPids = [...owned];
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      const remaining = () =>
        processTable().filter((process) =>
          tracked.some(
            (item) =>
              item.pid === process.pid && item.command === process.command,
          ),
        );
      for (const processInfo of remaining())
        process.kill(processInfo.pid, "SIGTERM");
      await waitFor(() => remaining().length === 0).catch(() => {});
      report.remainingPids = remaining().map((process) => process.pid);
      if (report.remainingPids.length) {
        report.passed = false;
        process.exitCode = 1;
      }
      report.processExited = child.exitCode !== null || child.killed;
    }
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(1));
  });
}
let timeout;
Promise.race([
  main(),
  new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Desktop A4 continuation test timed out")),
      240000,
    );
  }),
])
  .catch(async (error) => {
    report.failure = error.stack;
    process.exitCode = 1;
    await page
      ?.screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
  })
  .finally(async () => {
    clearTimeout(timeout);
    await stop();
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
