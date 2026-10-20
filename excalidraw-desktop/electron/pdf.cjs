const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

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

async function renderPdf(BrowserWindow, request) {
  validatePdfRequest(request);
  // Electron PrintToPDFOptions measures custom paper sizes in inches.
  const pageSize = { width: request.width / 96, height: request.height / 96 };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-pdf-"));
  const documentPath = path.join(directory, "drawing.html");
  const documentURL = pathToFileURL(documentPath).href;
  let printWindow;
  try {
    printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: `pdf-${randomUUID()}`,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const contents = printWindow.webContents;
    contents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: details.url !== documentURL && !details.url.startsWith("data:"),
      }),
    );
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => event.preventDefault());
    const image = Buffer.from(request.svg).toString("base64");
    const title = request.name.replace(
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
    let html = `<!doctype html><title>${title}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'"><style>@page{size:${pageSize.width}in ${pageSize.height}in;margin:0}html,body{margin:0;width:${pageSize.width}in;height:${pageSize.height}in;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style><img src="data:image/svg+xml;base64,${image}">`;
    if (request.pages?.length) {
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
            `<section class="canvas${index}"><img src="data:image/svg+xml;base64,${Buffer.from(
              page.svg,
            ).toString("base64")}"></section>`,
        )
        .join("");
      html = `<!doctype html><title>${title}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'"><style>${pageStyles}html,body{margin:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%;object-fit:contain}</style>${images}`;
    }
    await fs.writeFile(documentPath, html, { mode: 0o600, flag: "wx" });
    await printWindow.loadFile(documentPath);
    await contents.executeJavaScript(
      "Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())]).then(() => undefined)",
    );
    return await contents.printToPDF({
      pageSize,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      scale: 1,
    });
  } catch {
    throw new Error("PDF 导出失败，请重试。");
  } finally {
    try {
      if (printWindow && !printWindow.isDestroyed()) {
        printWindow.destroy();
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { renderPdf, validatePdfRequest };
