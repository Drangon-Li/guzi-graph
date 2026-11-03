const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

const { _electron } = require("playwright");

const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(desktop, "../../output/playwright/paper-pdf");
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
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-paper-pdf-"));
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
    executablePath: process.env.EXCALIDRAW_E2E_EXECUTABLE || require("electron"),
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
  report.runtime = await application.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    appPath: app.getAppPath(),
  }));
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
  client = new Client({ name: "guzi-paper-pdf-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );
  process.stdout.write(`Electron ready ${report.pid}\n`);

  await page.locator(".desktop-titlebar-new").click();
  const chooser = page.getByRole("dialog", { name: "新建画布", exact: true });
  await chooser.getByRole("button", { name: "A4 横线", exact: true }).click();
  await chooser.getByLabel("横向", { exact: true }).check();
  await page.screenshot({ path: path.join(artifacts, "paper-chooser.png") });
  await chooser.getByRole("button", { name: "创建", exact: true }).click();
  const paper = await waitFor(async () => {
    const value = await current();
    return value?.initialized && value;
  });
  const savedPaper = await call("save_canvas", {
    documentId: paper.documentId,
  });
  const paperFile = JSON.parse(await fs.readFile(savedPaper.path, "utf8"));
  const paperFrame = paperFile.elements.find(
    (element) => element.customData?.guziPaper,
  );
  assert.ok(Math.abs(paperFrame.width - (297 / 25.4) * 96) < 0.01);
  assert.ok(
    paperFile.elements.filter((element) => element.type === "line").length > 10,
  );
  assert.ok(paperFile.elements.every((element) => element.locked));
  await page.screenshot({ path: path.join(artifacts, "a4-ruled.png") });
  report.checks.push(
    "A4 landscape ruled template, locked elements, native save",
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
  const imported = await waitFor(async () => {
    const value = await current();
    return value?.title === "two-pages" && value.initialized && value;
  });
  let scene = await call("read_canvas", { documentId: imported.documentId });
  await call("apply_operations", {
    documentId: imported.documentId,
    expectedRevision: scene.revision,
    requestId: "annotate-pdf",
    operations: [
      {
        type: "create",
        element: {
          type: "text",
          x: 100,
          y: 100,
          text: "PDF 批注",
          fontSize: 30,
          strokeColor: "#e03131",
        },
      },
    ],
  });
  const saved = await call("save_canvas", { documentId: imported.documentId });
  const contents = JSON.parse(await fs.readFile(saved.path, "utf8"));
  const frames = contents.elements.filter(
    (element) => element.customData?.guziPaper,
  );
  const images = contents.elements.filter(
    (element) => element.type === "image",
  );
  assert.equal(frames.length, 2);
  assert.equal(images.length, 2);
  assert.ok(
    images.every(
      (image) =>
        image.locked &&
        contents.files[image.fileId]?.dataURL.startsWith("data:image/png"),
    ),
  );
  assert.ok(frames[1].y > frames[0].height);
  assert.ok(Math.abs(frames[1].width - 816) < 0.01);
  await page.screenshot({ path: path.join(artifacts, "pdf-annotation.png") });
  report.checks.push(
    "PDF native selection, offline font/worker rendering, rotated pages, editable annotation and embedded images",
  );

  const exported = path.join(artifacts, "annotated.pdf");
  await application.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: filename,
    });
  }, exported);
  await page
    .getByRole("button", { name: "展开工具侧栏", exact: true })
    .filter({ visible: true })
    .click();
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
  const pdfTask = getDocument({
    data: new Uint8Array(await fs.readFile(exported)),
  });
  try {
    const pdf = await pdfTask.promise;
    assert.equal(pdf.numPages, 2);
    for (let index = 1; index <= 2; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 96 / 72 });
      assert.ok(Math.abs(viewport.width - frames[index - 1].width) < 1);
      assert.ok(Math.abs(viewport.height - frames[index - 1].height) < 1);
    }
  } finally {
    await pdfTask.destroy();
  }
  await call("close_document", { documentId: imported.documentId });
  await fs.unlink(source);
  const reopened = await call("open_canvas", { path: saved.path });
  scene = await call("read_canvas", { documentId: reopened.documentId });
  assert.equal(
    scene.elements.filter((element) => element.type === "image").length,
    2,
  );
  assert.ok(
    scene.elements.some((element) => element.originalText === "PDF 批注"),
  );
  report.checks.push(
    "Two-page native PDF export with original sizes; saved canvas reopens after deleting the source PDF",
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
      () => reject(new Error("Desktop PDF test timed out")),
      180000,
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
