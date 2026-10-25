const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { renderPdf, validatePdfRequest } = require("./pdf.cjs");

const request = {
  name: "drawing",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480"><rect width="960" height="480" fill="#ff00ff"/></svg>',
  width: 960,
  height: 480,
};

function fixture(failure, { hang, event, delays = {} } = {}) {
  const calls = { destroyed: 0, created: 0, stages: [] };
  const runStage = (stage) => {
    calls.stages.push(stage);
    if (hang === stage || event?.stage === stage) {
      if (event) {
        setImmediate(() => {
          if (event.name === "destroyed") {
            calls.window.destroy();
          } else {
            calls.contents.emit(event.name, {}, { reason: "crashed" });
          }
        });
      }
      return new Promise((resolve) => {
        calls.resume = resolve;
      });
    }
    if (failure === stage) {
      throw new Error(`${stage} failed`);
    }
    if (delays[stage]) {
      return new Promise((resolve) => setTimeout(resolve, delays[stage]));
    }
  };
  class PrintWindow {
    constructor(options) {
      calls.created++;
      calls.window = this;
      calls.options = options;
      const session = {
        setPermissionRequestHandler: (handler) => {
          calls.permissionRequestCurrent = handler;
          if (handler) {
            calls.permissionRequest = handler;
          }
        },
        setPermissionCheckHandler: (handler) => {
          calls.permissionCheckCurrent = handler;
          if (handler) {
            calls.permissionCheck = handler;
          }
        },
        webRequest: {
          onBeforeRequest: (handler) => {
            calls.requestCurrent = handler;
            if (handler) {
              calls.request = handler;
            }
          },
        },
      };
      this.webContents = Object.assign(new EventEmitter(), {
        session,
        setWindowOpenHandler: (handler) => {
          calls.open = handler;
        },
        executeJavaScript: async (script) => {
          calls.script = script;
          await runStage("decode");
        },
        printToPDF: async (options) => {
          calls.print = options;
          await runStage("print");
          return Buffer.from("%PDF-fixture");
        },
      });
      calls.contents = this.webContents;
    }
    async loadFile(file) {
      calls.file = file;
      calls.html = await fs.readFile(file, "utf8");
      await runStage("load");
    }
    isDestroyed() {
      return calls.destroyed > 0;
    }
    destroy() {
      calls.destroyed++;
      this.webContents.emit("destroyed");
    }
  }
  return { PrintWindow, calls };
}

test("PDF uses one proportional page in inches, a hidden isolated sandbox and destroys the window", async () => {
  const { PrintWindow, calls } = fixture();
  assert.equal(
    (await renderPdf(PrintWindow, request)).toString(),
    "%PDF-fixture",
  );
  assert.equal(calls.options.show, false);
  assert.equal(calls.options.webPreferences.preload, undefined);
  assert.equal(calls.options.webPreferences.sandbox, true);
  assert.equal(calls.options.webPreferences.nodeIntegration, false);
  assert.equal(calls.options.webPreferences.contextIsolation, true);
  assert.equal(calls.options.webPreferences.backgroundThrottling, false);
  assert.match(calls.options.webPreferences.partition, /^pdf-/);
  assert.deepEqual(calls.print.pageSize, { width: 10, height: 5 });
  assert.equal(calls.print.printBackground, true);
  assert.equal(calls.print.preferCSSPageSize, true);
  assert.deepEqual(calls.print.margins, {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });
  assert.equal(calls.destroyed, 1);
  const html = calls.html;
  assert.match(html, /@page\{size:10in 5in;margin:0\}/);
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
  assert.match(html, /script-src 'none'/);
  assert.match(calls.script, /document.fonts.ready/);
  assert.match(calls.script, /image.decode\(\)/);
  for (const url of [
    "https://example.com/image.png",
    "file:///private/image.png",
    "app://local/index.html",
  ]) {
    calls.request({ url }, ({ cancel }) => assert.equal(cancel, true));
  }
  calls.request({ url: "data:image/svg+xml;base64,AA==" }, ({ cancel }) =>
    assert.equal(cancel, false),
  );
  calls.request({ url: pathToFileURL(calls.file).href }, ({ cancel }) =>
    assert.equal(cancel, false),
  );
  await assert.rejects(fs.stat(path.dirname(calls.file)), { code: "ENOENT" });
  assert.equal(calls.permissionCheck(), false);
  calls.permissionRequest(null, "media", (allowed) =>
    assert.equal(allowed, false),
  );
  assert.equal(calls.open().action, "deny");
  assertReleased(calls);
});

function assertReleased(calls) {
  assert.equal(calls.permissionRequestCurrent, null);
  assert.equal(calls.permissionCheckCurrent, null);
  assert.equal(calls.requestCurrent, null);
  for (const event of [
    "render-process-gone",
    "destroyed",
    "will-navigate",
    "will-attach-webview",
  ]) {
    assert.equal(calls.contents.listenerCount(event), 0);
  }
}

const stageLabels = {
  load: "加载页面",
  decode: "解码字体与图片",
  print: "打印页面",
};

for (const failure of ["load", "decode", "print"]) {
  test(`PDF destroys its hidden window when ${failure} fails`, async () => {
    const { PrintWindow, calls } = fixture(failure);
    await assert.rejects(renderPdf(PrintWindow, request), {
      message: `PDF 导出失败（${stageLabels[failure]}），请重试。`,
    });
    assert.equal(calls.destroyed, 1);
    await assert.rejects(fs.stat(path.dirname(calls.file)), { code: "ENOENT" });
    assertReleased(calls);
  });
}

for (const hang of ["load", "decode", "print"]) {
  test(`PDF aborts a hanging ${hang}, ignores late completion and permits a later export`, async () => {
    const { PrintWindow, calls } = fixture(undefined, { hang });
    await assert.rejects(renderPdf(PrintWindow, request, { timeout: 50 }), {
      code: "PDF_EXPORT_TIMEOUT",
      message: `PDF 导出超时（${stageLabels[hang]}），请重试。`,
    });
    assert.equal(calls.destroyed, 1);
    assertReleased(calls);
    await assert.rejects(fs.stat(path.dirname(calls.file)), { code: "ENOENT" });
    const stages = [...calls.stages];
    calls.resume();
    await new Promise(setImmediate);
    assert.deepEqual(calls.stages, stages);
    assert.equal(calls.created, 1);
    assert.equal(calls.destroyed, 1);
    const next = fixture();
    assert.equal(
      (await renderPdf(next.PrintWindow, request)).toString(),
      "%PDF-fixture",
    );
    assert.equal(next.calls.destroyed, 1);
    assertReleased(next.calls);
  });
}

for (const name of ["render-process-gone", "destroyed"]) {
  for (const stage of ["load", "decode", "print"]) {
    test(`PDF stops when ${name} occurs during ${stage}`, async () => {
      const { PrintWindow, calls } = fixture(undefined, {
        event: { name, stage },
      });
      await assert.rejects(renderPdf(PrintWindow, request), {
        message: `PDF 导出失败（${stageLabels[stage]}：${
          name === "destroyed" ? "打印窗口已关闭" : "打印进程已退出"
        }），请重试。`,
      });
      assert.equal(calls.destroyed, 1);
      assertReleased(calls);
      await assert.rejects(fs.stat(path.dirname(calls.file)), {
        code: "ENOENT",
      });
      const stages = [...calls.stages];
      calls.resume();
      await new Promise(setImmediate);
      assert.deepEqual(calls.stages, stages);
      const next = fixture();
      assert.equal(
        (await renderPdf(next.PrintWindow, request)).toString(),
        "%PDF-fixture",
      );
      assertReleased(next.calls);
    });
  }
}

test("PDF timeout errors use the selected language for both template and stage", async () => {
  const { PrintWindow, calls } = fixture(undefined, { hang: "decode" });
  await assert.rejects(
    renderPdf(PrintWindow, request, { timeout: 50, language: "en" }),
    {
      code: "PDF_EXPORT_TIMEOUT",
      message: "PDF export timed out (decoding fonts and images). Try again.",
    },
  );
  assert.equal(calls.destroyed, 1);
  assertReleased(calls);
});

test("PDF applies one deadline across load and decode", async () => {
  const { PrintWindow, calls } = fixture(undefined, {
    delays: { load: 60, decode: 60 },
  });
  await assert.rejects(renderPdf(PrintWindow, request, { timeout: 100 }), {
    code: "PDF_EXPORT_TIMEOUT",
    message: "PDF 导出超时（解码字体与图片），请重试。",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.stages, ["load", "decode"]);
  assert.equal(calls.destroyed, 1);
  assertReleased(calls);
});

test("aborting one PDF export leaves another active print window intact", async () => {
  const active = fixture(undefined, { hang: "decode" });
  const activeExport = renderPdf(active.PrintWindow, request);
  const stalled = fixture(undefined, { hang: "load" });
  await assert.rejects(
    renderPdf(stalled.PrintWindow, request, { timeout: 50 }),
    {
      code: "PDF_EXPORT_TIMEOUT",
    },
  );
  assert.equal(stalled.calls.destroyed, 1);
  assert.equal(active.calls.destroyed, 0);
  stalled.calls.resume();
  active.calls.resume();
  assert.equal((await activeExport).toString(), "%PDF-fixture");
  assert.equal(active.calls.destroyed, 1);
  assert.deepEqual(stalled.calls.stages, ["load"]);
  assertReleased(active.calls);
  assertReleased(stalled.calls);
});

test("PDF removes a late temporary directory without creating a window after its deadline", async (t) => {
  const originalMkdtemp = fs.mkdtemp;
  const originalRm = fs.rm;
  let directory;
  let resume;
  let markRemoved;
  const removed = new Promise((resolve) => {
    markRemoved = resolve;
  });
  fs.mkdtemp = async (...args) => {
    directory = await originalMkdtemp(...args);
    await new Promise((resolve) => {
      resume = resolve;
    });
    return directory;
  };
  fs.rm = async (...args) => {
    await originalRm(...args);
    if (args[0] === directory) {
      markRemoved();
    }
  };
  t.after(() => {
    fs.mkdtemp = originalMkdtemp;
    fs.rm = originalRm;
  });
  const { PrintWindow, calls } = fixture();
  await assert.rejects(renderPdf(PrintWindow, request, { timeout: 50 }), {
    code: "PDF_EXPORT_TIMEOUT",
    message: "PDF 导出超时（创建临时目录），请重试。",
  });
  resume();
  await removed;
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  assert.equal(calls.created, 0);
});

test("PDF rejects invalid sizes and non-SVG data before opening a window", () => {
  for (const update of [
    { width: NaN },
    { height: Infinity },
    { width: -1 },
    { height: 0 },
    { svg: "<html>bad</html>" },
    { svg: null },
    { name: null },
    { name: " " },
  ]) {
    assert.throws(() => validatePdfRequest({ ...request, ...update }), /无效/);
  }
});

test("PDF metadata title uses the drawing name with HTML escaped characters", async () => {
  const { PrintWindow, calls } = fixture();
  await renderPdf(PrintWindow, {
    ...request,
    name: `A & <drawing> "quote" 'name'`,
  });
  const html = calls.html;
  assert.match(
    html,
    /<title>A &amp; &lt;drawing&gt; &quot;quote&quot; &#39;name&#39;<\/title>/,
  );
  assert.equal(html.includes("<drawing>"), false);
});

test("large SVG exports load a temporary HTML file instead of a navigation data URL", async () => {
  const { PrintWindow, calls } = fixture();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(
    4 * 1024 * 1024,
  )}--></svg>`;
  await renderPdf(PrintWindow, { ...request, svg });
  assert.equal(typeof calls.file, "string");
  assert.ok(calls.html.length > 4 * 1024 * 1024);
  assert.equal(path.basename(calls.file), "drawing.html");
  assert.match(path.basename(path.dirname(calls.file)), /^excalidraw-pdf-.+$/);
  assert.equal(calls.destroyed, 1);
  await assert.rejects(fs.stat(path.dirname(calls.file)), { code: "ENOENT" });
});

test("PDF subcanvas pages use separate named page sizes and decode every SVG before printing", async () => {
  const { PrintWindow, calls } = fixture();
  await renderPdf(PrintWindow, {
    ...request,
    pages: [{ svg: request.svg, width: 192, height: 288 }],
  });
  assert.match(calls.html, /@page canvas0\{size:10in 5in;margin:0\}/);
  assert.match(calls.html, /@page canvas1\{size:2in 3in;margin:0\}/);
  assert.equal((calls.html.match(/<section /g) || []).length, 2);
  assert.equal((calls.html.match(/<img /g) || []).length, 2);
  assert.match(calls.html, /section:last-child\{break-after:auto\}/);
  assert.equal(calls.print.preferCSSPageSize, true);
  assert.equal(calls.destroyed, 1);
});

test("PDF validates every subcanvas page before opening the print window", () => {
  for (const pages of [
    null,
    {},
    [{ svg: request.svg, width: 0, height: 50 }],
    [{ svg: "<html>", width: 100, height: 50 }],
  ]) {
    assert.throws(() => validatePdfRequest({ ...request, pages }), /无效/);
  }
});
