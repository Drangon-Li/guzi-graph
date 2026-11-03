const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright");
const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/presentation-images",
);
const report = {
  passed: false,
  scenarios: [],
  errors: [],
  launchedPids: [],
  runnerPid: process.pid,
};
const ownedProcesses = new Map();
let application;
let launchedProcess;
let page;
let client;
let cleanup;
let serial = 0;
const imageCount = 24;
const bounded = (promise, label, milliseconds = 15000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${label}`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const processes = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
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
const rememberProcesses = () => {
  const snapshot = processes();
  const main = snapshot.find(
    (entry) =>
      entry.pid === launchedProcess?.pid &&
      launchedProcess.exitCode === null &&
      launchedProcess.signalCode === null,
  );
  if (main && !ownedProcesses.has(main.pid))
    ownedProcesses.set(main.pid, main.command);
  // A rejected launch can leave Electron running before Playwright returns its handle.
  for (const entry of snapshot)
    if (
      entry.parent === process.pid &&
      entry.command.includes(desktopDirectory) &&
      /[Ee]lectron/.test(entry.command) &&
      !ownedProcesses.has(entry.pid)
    )
      ownedProcesses.set(entry.pid, entry.command);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of snapshot) {
      const parent = snapshot.find(
        (candidate) => candidate.pid === entry.parent,
      );
      if (
        parent &&
        ownedProcesses.get(parent.pid) === parent.command &&
        !ownedProcesses.has(entry.pid)
      ) {
        ownedProcesses.set(entry.pid, entry.command);
        changed = true;
      }
    }
  }
};
const remainingProcesses = () =>
  processes().filter(
    (entry) => ownedProcesses.get(entry.pid) === entry.command,
  );
const close = () =>
  (cleanup ??= (async () => {
    rememberProcesses();
    await bounded(
      client?.close() ?? Promise.resolve(),
      "MCP close",
      5000,
    ).catch(() => {});
    if (application) {
      await bounded(
        application.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        }),
        "destroy isolated windows",
        5000,
      ).catch(() => {});
      await bounded(application.close(), "Electron close", 10000).catch(
        () => {},
      );
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      rememberProcesses();
      const alive = remainingProcesses();
      for (const entry of alive) {
        if (
          !remainingProcesses().some(
            (current) =>
              current.pid === entry.pid && current.command === entry.command,
          )
        )
          continue;
        try {
          process.kill(entry.pid, signal);
        } catch {}
      }
      if (alive.length)
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    report.launchedPids = [...ownedProcesses.keys()];
    report.ownedProcesses = [...ownedProcesses].map(([pid, command]) => ({
      pid,
      command,
    }));
    report.residualPids = remainingProcesses().map((entry) => entry.pid);
    assert.deepEqual(report.residualPids, []);
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    report.errors.push(`Interrupted by ${signal}`);
    void close().finally(async () => {
      await fs.writeFile(
        path.join(artifacts, "report.json"),
        JSON.stringify(report, null, 2),
      );
      process.exit(1);
    });
  });
const step = (name) => {
  report.stage = name;
  console.log(`STEP ${name}`);
};
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const result =
    response.structuredContent ??
    JSON.parse(response.content.find((item) => item.type === "text").text);
  assert.ok(!response.isError, `${name}: ${JSON.stringify(result)}`);
  return { result, response };
};
const update = async (documentId, operation) => {
  const { result: before } = await call("read_presentation", { documentId });
  return (
    await call("update_presentation", {
      documentId,
      expectedRevision: before.revision,
      requestId: `image-deck-${++serial}`,
      operation,
    })
  ).result;
};
const visible = (scene) =>
  scene.elements.filter((element) => !element.isDeleted);
const validate = (deck) => {
  assert.equal(deck.version, 1);
  assert.equal(deck.slides.length, 2);
  const images = visible(deck.slides[0].scene);
  assert.equal(images.length, imageCount);
  const ids = new Set();
  for (const image of images) {
    assert.equal(image.type, "image");
    assert.ok(image.fileId);
    assert.ok(image.width > 0 && image.height > 0);
    const file = deck.slides[0].scene.files[image.fileId];
    assert.equal(file.id, image.fileId);
    assert.match(file.dataURL, /^data:image\/png;base64,/);
    ids.add(image.fileId);
  }
  assert.equal(ids.size, imageCount);
  assert.equal(visible(deck.slides[1].scene).length, 0);
};

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const isolated = await fs.mkdtemp(path.join(artifacts, "isolated-"));
  const profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  report.profile = profile;
  report.drawings = drawings;
  const electronPackage = path.dirname(
    require.resolve("electron/package.json"),
  );
  const electronRelative = (
    await fs.readFile(path.join(electronPackage, "path.txt"), "utf8")
  ).trim();
  const executablePath = path.join(electronPackage, "dist", electronRelative);
  await fs.access(executablePath);
  report.executablePath = executablePath;
  step("Launch isolated desktop Electron");
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
  launchedProcess = application.process();
  rememberProcesses();
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const service = await enableMcpInSettings(page, port);
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "presentation-images-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );
  let deck = (await call("create_presentation", { title: "图片稳定性测试" }))
    .result;
  const firstId = deck.slides[0].id;
  let documentId = deck.documentId;
  await update(documentId, {
    type: "rename",
    slideId: firstId,
    title: "图片页",
  });
  deck = await update(documentId, {
    type: "add",
    title: "空白页",
    afterSlideId: firstId,
  });
  const secondId = deck.activeSlideId;
  await update(documentId, { type: "select", slideId: firstId });
  step("Paste 24 real PNG files, immediately switch and save");
  const canvas = page.locator(
    ".desktop-editor-pane.is-active .desktop-root-canvas .excalidraw",
  );
  await canvas.click({ position: { x: 500, y: 260 } });
  const paste = await canvas.evaluate(async (mounted, count) => {
    const ownerDocument = mounted.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const files = [];
    for (let index = 0; index < count; index++) {
      const image = ownerDocument.createElement("canvas");
      image.width = 512;
      image.height = 288;
      const context = image.getContext("2d");
      context.fillStyle = `hsl(${(index * 360) / count} 65% 65%)`;
      context.fillRect(0, 0, image.width, image.height);
      context.fillStyle = "#152238";
      context.font = "bold 80px sans-serif";
      context.fillText(String(index + 1), 35, 180);
      const blob = await new Promise((resolve) =>
        image.toBlob(resolve, "image/png"),
      );
      files.push(
        new ownerWindow.File([blob], `picture-${index + 1}.png`, {
          type: "image/png",
        }),
      );
    }
    // Keep the real hashing and decoding, while making the switch/import race deterministic.
    const subtle = ownerWindow.crypto.subtle;
    const digest = subtle.digest.bind(subtle);
    subtle.digest = async (...args) => {
      await new Promise((resolve) => ownerWindow.setTimeout(resolve, 200));
      return digest(...args);
    };
    const data = new ownerWindow.DataTransfer();
    for (const file of files) data.items.add(file);
    mounted.focus();
    mounted.dispatchEvent(
      new ownerWindow.ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    };
  }, imageCount);
  report.paste = paste;
  await page
    .getByRole("button", { name: "选择幻灯片 2: 空白页", exact: true })
    .click();
  const saved = (await call("save_presentation", { documentId })).result;
  assert.ok(saved.path.startsWith(`${drawings}${path.sep}`));
  report.savedPath = saved.path;
  const disk = JSON.parse(await fs.readFile(saved.path, "utf8"));
  validate(disk);
  report.scenarios.push({
    name: "paste-switch-save",
    images: imageCount,
    files: Object.keys(disk.slides[0].scene.files).length,
  });
  step("Close and reopen the actual saved presentation");
  await call("close_document", { documentId });
  deck = (await call("open_canvas", { path: saved.path })).result;
  assert.notEqual(deck.documentId, documentId);
  documentId = deck.documentId;
  await update(documentId, { type: "select", slideId: firstId });
  const { result: scene } = await call("read_canvas", {
    documentId,
    slideId: firstId,
  });
  assert.equal(scene.elements.length, imageCount);
  assert.equal(scene.files.length, imageCount);
  await call("apply_operations", {
    documentId,
    slideId: firstId,
    expectedRevision: scene.revision,
    requestId: `image-grid-${++serial}`,
    operations: scene.elements.map((image, index) => ({
      type: "patch",
      id: image.id,
      patch: {
        x: 40 + (index % 6) * 200,
        y: 40 + Math.floor(index / 6) * 160,
        width: 180,
        height: 101.25,
      },
    })),
  });
  await page.waitForFunction((count) => {
    const preview = document.querySelector(
      ".desktop-editor-pane.is-active .desktop-slide-preview svg",
    );
    return preview && preview.querySelectorAll("image").length === count;
  }, imageCount);
  await page.screenshot({
    path: path.join(artifacts, "reopened-editor.png"),
    fullPage: true,
  });
  report.scenarios.push({
    name: "close-reopen-editor-preview",
    images: imageCount,
  });
  step("Render and navigate the real desktop slide show");
  await call("control_presentation", {
    documentId,
    action: "start",
    slideId: firstId,
  });
  await page.waitForFunction(
    (count) =>
      document
        .querySelector(".desktop-presentation-player svg")
        ?.querySelectorAll("image").length === count,
    imageCount,
  );
  await page.screenshot({
    path: path.join(artifacts, "slide-show.png"),
    fullPage: true,
  });
  await call("control_presentation", {
    documentId,
    action: "goto",
    slideId: secondId,
  });
  await call("control_presentation", {
    documentId,
    action: "goto",
    slideId: firstId,
  });
  await page.waitForFunction(
    (count) =>
      document
        .querySelector(".desktop-presentation-player svg")
        ?.querySelectorAll("image").length === count,
    imageCount,
  );
  await call("control_presentation", { documentId, action: "stop" });
  report.scenarios.push({ name: "slide-show-navigation", images: imageCount });
  step("Export complete image SVG and re-save");
  const { response } = await call("export_presentation", {
    documentId,
    slideId: firstId,
    format: "svg",
  });
  const svg = response.content.find((item) => item.type === "resource")
    ?.resource.text;
  assert.match(svg, /<svg\b/);
  assert.equal(
    (svg.match(/data:image\/png;base64,/g) ?? []).length,
    imageCount,
  );
  await fs.writeFile(path.join(artifacts, "images.svg"), svg);
  await call("save_presentation", { documentId });
  validate(JSON.parse(await fs.readFile(saved.path, "utf8")));
  assert.deepEqual(report.errors, []);
  report.scenarios.push({ name: "SVG-export-and-resave", images: imageCount });
  report.passed = true;
}

void main()
  .catch(async (error) => {
    report.errors.push(error.stack ?? String(error));
    console.error(error);
    await page
      ?.screenshot({
        path: path.join(artifacts, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await close().catch((error) => {
      report.errors.push(error.stack ?? String(error));
      report.passed = false;
      process.exitCode = 1;
    });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  });
