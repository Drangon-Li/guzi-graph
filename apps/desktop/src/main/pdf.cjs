const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const { translate } = require("./i18n/i18n.cjs");

// Electron keeps every partition's session alive until the app quits, so a
// fresh partition per export would leak one browser context per PDF. Exports
// share one in-memory partition instead; its restrictive handlers stay
// installed while any export is active and allow only active temporary pages.
const PDF_PARTITION = "pdf-export";
const sessionLeases = new WeakMap();

function leaseSession(printSession, documentURL) {
  let lease = sessionLeases.get(printSession);
  if (!lease) {
    const urls = new Set();
    lease = { urls };
    sessionLeases.set(printSession, lease);
    printSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    printSession.setPermissionCheckHandler(() => false);
    printSession.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: !urls.has(details.url) && !details.url.startsWith("data:"),
      }),
    );
  }
  lease.urls.add(documentURL);
}

function releaseSession(printSession, documentURL) {
  const lease = sessionLeases.get(printSession);
  if (!lease) {
    return;
  }
  lease.urls.delete(documentURL);
  if (lease.urls.size) {
    return;
  }
  sessionLeases.delete(printSession);
  printSession.setPermissionRequestHandler(null);
  printSession.setPermissionCheckHandler(null);
  printSession.webRequest.onBeforeRequest(null);
}

const escapeHTML = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character]),
  );

const svgImage = (svg) =>
  `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString(
    "base64",
  )}">`;

const PDF_CSP =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'\">";

// Only the variant that is printed is built: each embedded SVG is base64
// encoded once, which matters for large drawings with inline images.
function pdfDocument(request, pageSize) {
  const title = escapeHTML(request.name);
  if (!request.pages?.length) {
    return `<!doctype html><title>${title}</title>${PDF_CSP}<style>@page{size:${
      pageSize.width
    }in ${pageSize.height}in;margin:0}html,body{margin:0;width:${
      pageSize.width
    }in;height:${
      pageSize.height
    }in;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style>${svgImage(
      request.svg,
    )}`;
  }
  const pages = [request, ...request.pages];
  const pageStyles = pages
    .map(
      (page, index) =>
        `@page canvas${index}{size:${page.width / 96}in ${
          page.height / 96
        }in;margin:0}.canvas${index}{page:canvas${index};width:${
          page.width / 96
        }in;height:${page.height / 96}in}`,
    )
    .join("");
  const images = pages
    .map(
      (page, index) =>
        `<section class="canvas${index}">${svgImage(page.svg)}</section>`,
    )
    .join("");
  return `<!doctype html><title>${title}</title>${PDF_CSP}<style>${pageStyles}html,body{margin:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%;object-fit:contain}</style>${images}`;
}

function validatePdfRequest(request) {
  if (
    !request ||
    typeof request.name !== "string" ||
    !request.name.trim() ||
    typeof request.svg !== "string" ||
    !/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(request.svg) ||
    !Number.isFinite(request.width) ||
    !Number.isFinite(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  ) {
    throw new Error("PDF 导出数据无效。");
  }
  if (request.pages !== undefined) {
    if (!Array.isArray(request.pages)) {
      throw new Error("PDF 导出数据无效。");
    }
    for (const page of request.pages) {
      validatePdfRequest({ ...page, name: request.name, pages: undefined });
    }
  }
}

async function renderPdf(
  BrowserWindow,
  request,
  { timeout = 20000, language = "zh-CN" } = {},
) {
  validatePdfRequest(request);
  const t = (message, values) => translate(language, message, values);
  // Electron PrintToPDFOptions measures custom paper sizes in inches.
  const pageSize = { width: request.width / 96, height: request.height / 96 };
  const deadline = Date.now() + timeout;
  let directory;
  let printWindow;
  let contents;
  let printSession;
  let documentURL;
  let stage = "准备页面";
  let failure;
  let rejectStep;
  const stop = (error) => {
    if (failure) {
      return;
    }
    failure = error;
    rejectStep?.(error);
    // Destroy this renderer to cancel its active load/decode/print operation.
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  };
  const timedOut = () =>
    Object.assign(
      new Error(t("PDF 导出超时（{stage}），请重试。", { stage: t(stage) })),
      { code: "PDF_EXPORT_TIMEOUT" },
    );
  const check = () => {
    if (!failure && Date.now() >= deadline) {
      stop(timedOut());
    }
    if (failure) {
      throw failure;
    }
  };
  const timer = setTimeout(() => stop(timedOut()), timeout);
  const run = (name, operation) => {
    stage = name;
    check();
    return new Promise((resolve, reject) => {
      rejectStep = reject;
      Promise.resolve()
        .then(() => {
          check();
          return operation();
        })
        .then(
          (result) => {
            if (rejectStep === reject) {
              rejectStep = null;
            }
            try {
              check();
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          (cause) => {
            if (rejectStep === reject) {
              rejectStep = null;
            }
            reject(
              failure ||
                new Error(
                  t("PDF 导出失败（{stage}），请重试。", { stage: t(name) }),
                  { cause },
                ),
            );
          },
        );
    });
  };
  const onRendererGone = () =>
    stop(
      new Error(
        t("PDF 导出失败（{stage}：{reason}），请重试。", {
          stage: t(stage),
          reason: t("打印进程已退出"),
        }),
      ),
    );
  const onDestroyed = () =>
    stop(
      new Error(
        t("PDF 导出失败（{stage}：{reason}），请重试。", {
          stage: t(stage),
          reason: t("打印窗口已关闭"),
        }),
      ),
    );
  const preventNavigation = (event) => event.preventDefault();
  try {
    await run("创建临时目录", async () => {
      const created = await fs.mkdtemp(
        path.join(os.tmpdir(), "excalidraw-pdf-"),
      );
      if (failure) {
        await fs.rm(created, { recursive: true, force: true });
        throw failure;
      }
      directory = created;
    });
    check();
    const documentPath = path.join(directory, "drawing.html");
    documentURL = pathToFileURL(documentPath).href;
    printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: PDF_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    contents = printWindow.webContents;
    printSession = contents.session;
    contents.once("render-process-gone", onRendererGone);
    contents.once("destroyed", onDestroyed);
    leaseSession(printSession, documentURL);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", preventNavigation);
    contents.on("will-navigate", preventNavigation);
    const html = pdfDocument(request, pageSize);
    await run("写入页面", () =>
      fs.writeFile(documentPath, html, { mode: 0o600, flag: "wx" }),
    );
    // loadFile formats paths differently (notably ~ in Windows short paths).
    // Use the exact encoded URL that the isolated session allows.
    await run("加载页面", () => printWindow.loadURL(documentURL));
    await run("解码字体与图片", () =>
      contents.executeJavaScript(
        "Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())]).then(() => undefined)",
      ),
    );
    return await run("打印页面", () =>
      contents.printToPDF({
        pageSize,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        scale: 1,
      }),
    );
  } finally {
    clearTimeout(timer);
    rejectStep = null;
    contents?.removeListener("render-process-gone", onRendererGone);
    contents?.removeListener("destroyed", onDestroyed);
    contents?.removeListener("will-attach-webview", preventNavigation);
    contents?.removeListener("will-navigate", preventNavigation);
    try {
      if (printWindow && !printWindow.isDestroyed()) {
        printWindow.destroy();
      }
    } finally {
      if (printSession) {
        releaseSession(printSession, documentURL);
      }
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
}

module.exports = { renderPdf, validatePdfRequest };
