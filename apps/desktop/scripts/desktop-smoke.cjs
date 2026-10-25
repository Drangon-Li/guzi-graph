const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { _electron } = require("playwright");

const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const executableIndex = process.argv.indexOf("--executable");
const executablePath =
  executableIndex < 0
    ? require("electron")
    : process.argv[executableIndex + 1] &&
      path.resolve(
        desktopDirectory,
        "../..",
        process.argv[executableIndex + 1],
      );
if (!executablePath) {
  throw new Error("--executable requires an application path");
}
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/desktop-smoke",
);
let application;
let page;
let client;
let isolated;
const report = {
  platform: process.platform,
  executablePath,
  passed: false,
  exports: [],
  previews: [],
};

const bounded = (promise, milliseconds, description) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${description}`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

async function closeApplication() {
  await bounded(client?.close(), 5000, "MCP client shutdown").catch(() => {});
  client = undefined;
  if (!application) {
    return;
  }
  const running = application;
  application = undefined;
  try {
    await bounded(running.close(), 15000, "Electron shutdown");
  } catch (error) {
    const child = running.process();
    if (child.exitCode !== null) {
      return;
    }
    // Only terminate the Electron process tree owned by this smoke run.
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { timeout: 5000 },
          resolve,
        );
      });
    } else {
      child.kill("SIGKILL");
    }
    throw error;
  }
}

const disableMcp = () =>
  page
    .locator(".desktop-workspace")
    .evaluate((mounted) =>
      mounted.ownerDocument.defaultView.desktop.setPluginEnabled("mcp", false),
    );

async function launch(profile) {
  application = await _electron.launch({
    executablePath: path.resolve(executablePath),
    args: executableIndex < 0 ? [desktopDirectory] : [],
    env: {
      ...process.env,
      EXCALIDRAW_DESKTOP_USER_DATA: profile,
      EXCALIDRAW_DESKTOP_DEV_URL: "",
    },
    timeout: 60000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  if (executableIndex >= 0) {
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  }
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  // The window header exists before session restoration can change the active pane.
  await page.locator(".desktop-project-pane").waitFor({ state: "attached" });
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.locator(".desktop-project-pane.is-active").waitFor();
  const service = await enableMcpInSettings(page, await freePort());
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-desktop-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );
}

async function callRaw(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const result =
    response.structuredContent ||
    JSON.parse(response.content.find((item) => item.type === "text").text);
  assert.ok(!response.isError, `${name}: ${JSON.stringify(result)}`);
  return { response, result };
}

const call = async (name, args) => (await callRaw(name, args)).result;

const assertPixelContent = (pixels, name) => {
  assert.ok(
    pixels.opaqueColors > 1,
    `${name} must contain multiple opaque colors`,
  );
  assert.ok(pixels.nonWhite > 25, `${name} must contain non-white content`);
  assert.ok(pixels.green > 25, `${name} must contain the green rectangle`);
  assert.ok(pixels.blue > 25, `${name} must contain the blue image`);
};

async function verifyExport(documentId, format, presentation = false) {
  const name = `${presentation ? "presentation" : "canvas"}.${format}`;
  const { response } = await callRaw(
    presentation ? "export_presentation" : "export_canvas",
    { documentId, format },
  );
  let bytes;
  let dimensions;
  if (format === "png") {
    const content = response.content.find(
      (item) => item.type === "image" && item.mimeType === "image/png",
    );
    assert.ok(content?.data, `${name} must contain MCP image bytes`);
    bytes = Buffer.from(content.data, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    dimensions = await application.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const bitmap = image.toBitmap();
      const colors = new Set();
      let nonWhite = 0;
      let green = 0;
      let blue = 0;
      // Electron's raw bitmap uses BGRA; the fixture uses opaque pixels.
      for (let index = 0; index < bitmap.length; index += 4) {
        const [b, g, r, a] = bitmap.subarray(index, index + 4);
        if (a < 250) {
          continue;
        }
        colors.add((r << 16) | (g << 8) | b);
        if (r < 245 || g < 245 || b < 245) {
          nonWhite++;
        }
        if (
          Math.abs(r - 178) < 12 &&
          Math.abs(g - 242) < 12 &&
          Math.abs(b - 187) < 12
        ) {
          green++;
        }
        if (
          Math.abs(r - 64) < 12 &&
          Math.abs(g - 96) < 12 &&
          Math.abs(b - 208) < 12
        ) {
          blue++;
        }
      }
      return {
        ...image.getSize(),
        empty: image.isEmpty(),
        pixels: { opaqueColors: colors.size, nonWhite, green, blue },
      };
    }, content.data);
    assert.equal(dimensions.empty, false, `${name} must decode`);
    assert.ok(dimensions.width > 0 && dimensions.height > 0);
    assertPixelContent(dimensions.pixels, name);
  } else {
    const resource = response.content.find(
      (item) => item.type === "resource",
    )?.resource;
    assert.equal(
      resource?.mimeType,
      format === "pdf" ? "application/pdf" : "image/svg+xml",
    );
    if (format === "svg") {
      assert.ok(resource.text, `${name} must contain SVG text`);
      dimensions = await page
        .locator(".desktop-workspace")
        .evaluate((mounted, xml) => {
          const ownerWindow = mounted.ownerDocument.defaultView;
          const document = new ownerWindow.DOMParser().parseFromString(
            xml,
            "image/svg+xml",
          );
          const svg = document.documentElement;
          return {
            rootName: svg.localName,
            errors: document.querySelectorAll("parsererror").length,
            width: Number(svg.getAttribute("width")),
            height: Number(svg.getAttribute("height")),
            text: svg.textContent,
            images: svg.querySelectorAll("image").length,
            paths: svg.querySelectorAll("path").length,
          };
        }, resource.text);
      assert.equal(dimensions.rootName, "svg");
      assert.equal(dimensions.errors, 0);
      assert.ok(dimensions.width > 0 && dimensions.height > 0);
      assert.match(dimensions.text, /中文导出验证/);
      assert.ok(dimensions.images > 0, `${name} must include the source image`);
      assert.ok(dimensions.paths > 0, `${name} must include drawn paths`);
      assert.match(resource.text, /data:image\/png;base64,/);
      bytes = Buffer.from(resource.text, "utf8");
      delete dimensions.text;
    } else {
      assert.ok(resource.blob, `${name} must contain PDF bytes`);
      bytes = Buffer.from(resource.blob, "base64");
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.match(bytes.subarray(-1024).toString(), /%%EOF/);
      assert.match(bytes.toString("latin1"), /\/Type\s*\/Page\b/);
      assert.match(bytes.toString("latin1"), /stream\r?\n[^\r\n]/);
    }
  }
  assert.ok(bytes.length > 100, `${name} must contain real export data`);
  await fs.writeFile(path.join(artifacts, name), bytes);
  report.exports.push({
    name,
    bytes: bytes.length,
    validation:
      format === "pdf"
        ? "structure_only"
        : format === "png"
        ? "decoded_pixels"
        : "svg_content",
    ...dimensions,
  });
}

async function verifyPreviews(paths) {
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  for (const filename of paths) {
    const card = page.getByTitle(`打开 ${path.basename(filename)}`, {
      exact: true,
    });
    await card.scrollIntoViewIfNeeded();
    const image = card.locator(".desktop-file-preview img");
    await image.waitFor();
    const dimensions = await image.evaluate(async (image) => {
      await image.decode();
      const canvas = image.ownerDocument.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      try {
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const colors = new Set();
        let nonWhite = 0;
        let green = 0;
        let blue = 0;
        for (let index = 0; index < data.length; index += 4) {
          const [r, g, b, a] = data.subarray(index, index + 4);
          if (a < 250) {
            continue;
          }
          colors.add((r << 16) | (g << 8) | b);
          if (r < 245 || g < 245 || b < 245) {
            nonWhite++;
          }
          if (
            Math.abs(r - 178) < 12 &&
            Math.abs(g - 242) < 12 &&
            Math.abs(b - 187) < 12
          ) {
            green++;
          }
          if (
            Math.abs(r - 64) < 12 &&
            Math.abs(g - 96) < 12 &&
            Math.abs(b - 208) < 12
          ) {
            blue++;
          }
        }
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          pixels: { opaqueColors: colors.size, nonWhite, green, blue },
        };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
    assert.ok(dimensions.width > 0 && dimensions.height > 0);
    assertPixelContent(dimensions.pixels, path.basename(filename));
    assert.equal(await card.locator(".desktop-preview-error").count(), 0);
    report.previews.push({ file: path.basename(filename), ...dimensions });
  }
  assert.equal(await page.locator(".desktop-preview-error").count(), 0);
  await page.screenshot({
    path: path.join(artifacts, "previews.png"),
    fullPage: true,
  });
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-desktop-smoke-"));
  const drawings = path.join(isolated, "画布 workspace");
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
  await launch(profile);
  const imageDataURL = await application.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([
          208, 96, 64, 255, 208, 96, 64, 255, 208, 96, 64, 255, 208, 96, 64,
          255,
        ]),
        { width: 2, height: 2 },
      )
      .toDataURL(),
  );
  const canvas = await call("create_canvas", { title: "Windows 保存重开" });
  const before = await call("read_canvas", { documentId: canvas.documentId });
  const applied = await call("apply_operations", {
    documentId: canvas.documentId,
    expectedRevision: before.revision,
    requestId: "desktop-smoke-export-scene",
    operations: [
      {
        type: "create",
        tempId: "rectangle",
        element: {
          type: "rectangle",
          x: 80,
          y: 80,
          width: 240,
          height: 120,
          backgroundColor: "#b2f2bb",
          fillStyle: "solid",
        },
      },
      {
        type: "create",
        tempId: "chinese",
        element: {
          type: "text",
          x: 100,
          y: 110,
          text: "中文导出验证",
          fontSize: 24,
        },
      },
      {
        type: "create",
        tempId: "image",
        element: {
          type: "image",
          x: 360,
          y: 80,
          width: 120,
          height: 120,
          file: { mimeType: "image/png", dataURL: imageDataURL },
        },
      },
      {
        type: "create",
        tempId: "freedraw",
        element: {
          type: "freedraw",
          x: 100,
          y: 250,
          points: [
            [0, 0],
            [70, 40],
            [140, 0],
          ],
          pressures: [0.3, 0.7, 0.3],
          simulatePressure: false,
        },
      },
    ],
  });
  await call("save_canvas", { documentId: canvas.documentId });
  const savedCanvas = await call("read_canvas", {
    documentId: canvas.documentId,
  });
  assert.equal(savedCanvas.dirty, false);
  assert.equal(path.extname(savedCanvas.path), ".excalidraw");
  const deck = await call("create_presentation", {
    title: "Windows 演示文稿",
    sourceDocumentId: canvas.documentId,
  });
  await call("save_presentation", { documentId: deck.documentId });
  const savedDeck = await call("read_presentation", {
    documentId: deck.documentId,
  });
  assert.equal(savedDeck.dirty, false);
  assert.equal(path.extname(savedDeck.path), ".guzi-presentation");
  for (const format of ["png", "svg"]) {
    await verifyExport(canvas.documentId, format);
  }
  for (const format of ["png", "svg", "pdf"]) {
    await verifyExport(deck.documentId, format, true);
  }
  await page.screenshot({
    path: path.join(artifacts, "saved.png"),
    fullPage: true,
  });
  await disableMcp();
  await closeApplication();

  await launch(profile);
  const reopenedCanvas = await call("open_canvas", { path: savedCanvas.path });
  const scene = await call("read_canvas", {
    documentId: reopenedCanvas.documentId,
  });
  assert.equal(
    scene.elements.find((element) => element.id === applied.idMap.rectangle)
      ?.backgroundColor,
    "#b2f2bb",
  );
  assert.ok(scene.elements.some((element) => element.text === "中文导出验证"));
  assert.ok(scene.elements.some((element) => element.type === "image"));
  assert.ok(scene.elements.some((element) => element.type === "freedraw"));
  const reopenedDeck = await call("open_canvas", { path: savedDeck.path });
  const presentation = await call("read_presentation", {
    documentId: reopenedDeck.documentId,
  });
  assert.equal(presentation.slides.length, savedDeck.slides.length);
  const slide = await call("read_canvas", {
    documentId: reopenedDeck.documentId,
    slideId: presentation.slides[0].id,
  });
  assert.ok(
    slide.elements.some((element) => element.backgroundColor === "#b2f2bb"),
  );
  await page.screenshot({
    path: path.join(artifacts, "reopened.png"),
    fullPage: true,
  });
  await verifyPreviews([savedCanvas.path, savedDeck.path]);
  await disableMcp();
  report.passed = true;
  report.scenarios = [
    "launch",
    "canvas edit/save/reopen after restart",
    "presentation save/reopen after restart",
    "canvas and presentation PNG contain fixture colors; SVG contains scene content",
    "presentation PDF contains real bytes; structure_only validation",
    "canvas and presentation project thumbnails contain fixture colors after restart",
  ];
}

main()
  .catch(async (error) => {
    report.error = error.stack || String(error);
    console.error(report.error);
    await page
      ?.screenshot({
        path: path.join(artifacts, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeApplication();
    } catch (error) {
      report.passed = false;
      report.cleanupError = error.stack || String(error);
      console.error(report.cleanupError);
      process.exitCode = 1;
    } finally {
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(
        path.join(artifacts, "report.json"),
        JSON.stringify(report, null, 2),
      );
      if (isolated) {
        await fs.rm(isolated, { recursive: true, force: true });
      }
    }
  });
