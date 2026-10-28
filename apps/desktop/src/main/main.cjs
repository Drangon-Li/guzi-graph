const fs = require("node:fs/promises");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  utilityProcess,
} = require("electron");

const { buildChannel } = require("../../package.json");

const { translate } = require("./i18n/i18n.cjs");
const { createUpdateController } = require("./update.cjs");
const { renderPdf, validatePdfRequest } = require("./pdf.cjs");
const { PluginHost } = require("./plugins.cjs");
const { UserPluginStore } = require("./user-plugin-store.cjs");
const { UserPluginRuntime } = require("./user-plugin-runtime.cjs");
const { UserPlugins } = require("./user-plugins.cjs");
const {
  DesktopStorage,
  atomicWrite,
  fileName,
  invalidWindowsFileName,
  EXPORT_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
} = require("./storage.cjs");

if (process.env.EXCALIDRAW_DESKTOP_USER_DATA) {
  const userData = process.env.EXCALIDRAW_DESKTOP_USER_DATA;
  if (!path.isAbsolute(userData)) {
    throw new Error(translate("zh-CN", "隔离 userData 必须使用绝对路径。"));
  }
  app.setPath("userData", userData);
} else {
  // Normal builds keep the legacy profile; test builds must not reuse it.
  const profileName =
    {
      "dev-ppt": "Excalidraw-Guzi Dev PPT",
      test: "Excalidraw-Guzi Test",
    }[buildChannel] || "Excalidraw Local";
  const userData = path.join(app.getPath("appData"), profileName);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let window = null;
let storage;
let plugins;
let userPlugins;
const setHostsReady = (ready) =>
  Promise.all([userPlugins?.setReady(ready), plugins?.setReady(ready)]);
const t = (message, values) =>
  translate(storage?.getSettings().language || "zh-CN", message, values);
let closePending = false;
let closeApproved = false;
let quitRequested = false;
let quitApproved = false;
let closeAttempt = 0;
let closeFinalizing = false;
let rendererUnavailable = false;
let nativeClosePending = false;
let updates;
let startupUpdateChecked = false;
let filesConsumerReady = false;
const pendingPaths = new Set();
const appURL = "app://local/index.html";
const developmentURL = getDevelopmentURL();

function getDevelopmentURL() {
  const value = process.env.EXCALIDRAW_DESKTOP_DEV_URL;
  if (!value || app.isPackaged) {
    return null;
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(t("开发 URL 只允许本机 loopback 地址。"));
  }
  return url;
}

function trustedURL(value) {
  try {
    const url = new URL(value);
    return developmentURL
      ? url.origin === developmentURL.origin
      : url.protocol === "app:" &&
          url.host === "local" &&
          url.pathname === "/index.html";
  } catch {
    return false;
  }
}

function assertSender(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !trustedURL(event.senderFrame.url)
  ) {
    throw new Error(t("拒绝非主窗口的文件访问。"));
  }
}

function emitCommand(command) {
  if (window && !window.isDestroyed()) {
    window.webContents.send("desktop:command", command);
  }
}

function requestClose(quit = false) {
  quitRequested ||= quit;
  if (!window) {
    if (quitRequested) {
      void approveClose();
    }
    return;
  }
  if (closePending) {
    return;
  }
  closePending = true;
  if (rendererUnavailable) {
    void confirmUnavailableClose();
  } else if (filesConsumerReady) {
    emitCommand("close-window");
  }
}

async function confirmUnavailableClose() {
  if (nativeClosePending || closeFinalizing) return;
  nativeClosePending = true;
  const attempt = closeAttempt;
  const choice = await dialog.showMessageBox(
    ...nativeDialogOptions({
      type: "warning",
      buttons: [t("取消"), t("关闭")],
      defaultId: 0,
      cancelId: 0,
      message: t("界面已异常退出"),
      detail: t("未保存的内容可能丢失。"),
      noLink: true,
    }),
  );
  if (attempt !== closeAttempt) return;
  nativeClosePending = false;
  if (!rendererUnavailable) return;
  if (choice.response === 1) {
    await approveClose();
  } else {
    updates.cancelInstall();
    resetClose();
  }
}

function resetClose() {
  closeAttempt++;
  closePending = false;
  closeApproved = false;
  quitRequested = false;
  quitApproved = false;
  closeFinalizing = false;
  nativeClosePending = false;
}

async function approveClose() {
  if (closeFinalizing) return;
  closeFinalizing = true;
  const attempt = closeAttempt;
  if (updates?.isInstallPending()) {
    // Windows quitAndInstall can call app.quit itself after starting the installer.
    closeApproved = true;
    quitApproved = true;
    const installed = await updates.confirmInstall();
    if (attempt !== closeAttempt) return;
    if (!installed) {
      resetClose();
      return;
    }
    app.quit();
    return;
  }
  try {
    await updates?.cancelForQuit();
  } catch {
    if (attempt === closeAttempt) {
      resetClose();
      await dialog.showMessageBox(
        ...nativeDialogOptions({
          type: "error",
          message: t("安装更新失败，请重新下载后重试。"),
        }),
      );
    }
    return;
  }
  if (attempt !== closeAttempt) return;
  closeApproved = true;
  if (quitRequested) {
    quitApproved = true;
    app.quit();
  } else {
    window?.close();
  }
}

async function drainFiles() {
  const paths = [...pendingPaths];
  pendingPaths.clear();
  const documents = [];
  for (const candidate of paths) {
    try {
      const canonical = await storage.grantFile(candidate);
      documents.push(await storage.readFile(canonical));
    } catch (error) {
      await dialog.showMessageBox(
        ...nativeDialogOptions({
          type: "error",
          message: t("无法打开画布"),
          detail: error.message,
        }),
      );
    }
  }
  return documents;
}

async function receiveFiles(paths) {
  for (const candidate of paths) {
    if (
      typeof candidate === "string" &&
      path.isAbsolute(candidate) &&
      DOCUMENT_EXTENSIONS.has(path.extname(candidate).toLowerCase())
    ) {
      pendingPaths.add(candidate);
    }
  }
  if (storage && window && filesConsumerReady) {
    const documents = await drainFiles();
    if (documents.length && window && !window.isDestroyed()) {
      window.webContents.send("desktop:files-opened", documents);
    }
  }
}

function nativeDialogOptions(options) {
  return window ? [window, options] : [options];
}

async function saveDocument(request) {
  if (
    !request ||
    typeof request !== "object" ||
    (request.format !== undefined && request.format !== "presentation")
  ) {
    throw new Error(t("保存请求无效。"));
  }
  let target = request.path;
  let overwrite = false;
  const presentation = request.format === "presentation";
  const extension = presentation ? "guzi-presentation" : "excalidraw";
  if (request.automation) {
    if (request.automation !== true || request.saveAs) {
      throw new Error("自动化仅支持保存当前文档。");
    }
    if (!target) {
      const root = storage.getSettings().rootDirectory;
      if (!root) {
        throw Object.assign(new Error("自动保存前请先在设置中选择项目目录。"), {
          code: "ROOT_REQUIRED",
        });
      }
      const name = fileName(
        request.name,
        extension,
        undefined,
        process.platform,
      );
      target = path.join(
        root,
        `${path.basename(name, `.${extension}`)}-${randomUUID()}.${extension}`,
      );
      return storage.saveFile(
        { ...request, path: target },
        { createOnly: true },
      );
    }
    return storage.saveFile(request);
  }
  if (request.saveAs || !target) {
    const name = fileName(request.name, extension, undefined, process.platform);
    const root = storage.getSettings().rootDirectory;
    const result = await dialog.showSaveDialog(
      ...nativeDialogOptions({
        title: presentation
          ? request.saveAs
            ? t("演示文稿另存为")
            : t("保存演示文稿")
          : request.saveAs
          ? t("画布另存为")
          : t("保存画布"),
        defaultPath: target || (root ? path.join(root, name) : name),
        filters: [
          {
            name: presentation ? t("Guzi 演示文稿") : t("Excalidraw 画布"),
            extensions: [extension],
          },
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      }),
    );
    if (result.canceled || !result.filePath) {
      return null;
    }
    if (path.extname(result.filePath).toLowerCase() !== `.${extension}`) {
      throw new Error(
        presentation
          ? t("演示文稿文件名需要以 .guzi-presentation 结尾。")
          : t("画布文件名需要以 .excalidraw 结尾。"),
      );
    }
    target = result.filePath;
    target = await storage.grantFile(target);
    overwrite = true;
  }
  try {
    return await storage.saveFile({ ...request, path: target }, { overwrite });
  } catch (error) {
    if (error.code !== "EXTERNAL_MODIFICATION") {
      throw error;
    }
    const choice = await dialog.showMessageBox(
      ...nativeDialogOptions({
        type: "warning",
        buttons: [t("取消"), t("覆盖保存")],
        defaultId: 0,
        cancelId: 0,
        message: t("此画布已被其他程序修改或移走"),
        detail: t("覆盖保存会用当前画布替换磁盘上的版本。"),
        noLink: true,
      }),
    );
    if (choice.response !== 1) {
      return null;
    }
    return storage.saveFile({ ...request, path: target }, { overwrite: true });
  }
}

function safeSegment(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    // eslint-disable-next-line no-control-regex -- Control characters are intentionally rejected in user-supplied names.
    /[\\/\x00-\x1f<>:"|?*]/.test(value) ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    (process.platform === "win32" && invalidWindowsFileName(value))
  ) {
    throw new Error(t("导出附件路径无效。"));
  }
  return value;
}

async function assertExportPath(destination) {
  const parent = path.dirname(destination);
  if ((await fs.realpath(parent)) !== parent) {
    throw new Error(t("导出路径不能包含符号链接。"));
  }
  const stat = await fs.lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  });
  if (stat?.isSymbolicLink()) {
    throw new Error(t("导出路径不能包含符号链接。"));
  }
}

async function chooseExport(name, extension) {
  const result = await dialog.showSaveDialog(
    ...nativeDialogOptions({
      title: t("导出画布"),
      defaultPath: fileName(name, extension, undefined, process.platform),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    }),
  );
  if (result.canceled || !result.filePath) {
    return null;
  }
  if (!result.filePath.toLowerCase().endsWith(`.${extension}`)) {
    throw new Error(t("导出文件名需要以 .{extension} 结尾。", { extension }));
  }
  return result.filePath;
}

function installIPC() {
  const handle = (name, callback) =>
    ipcMain.handle(`desktop:${name}`, async (event, ...args) => {
      assertSender(event);
      try {
        return await callback(...args);
      } catch (error) {
        error.message = t(error.message);
        throw error;
      }
    });
  handle("get-update-state", () => updates.getState());
  handle("check-startup-update", () => {
    if (startupUpdateChecked) return null;
    startupUpdateChecked = true;
    return updates.checkForUpdates();
  });
  handle("check-for-updates", () => updates.checkForUpdates());
  handle("download-update", () => updates.downloadUpdate());
  handle("install-update", () => updates.installUpdate());
  handle("get-plugins", () => plugins.list());
  handle("get-user-plugins", () => {
    if (userPlugins.store.configurationError)
      throw new Error(userPlugins.store.configurationError);
    return userPlugins.list();
  });
  handle("install-user-plugin", (plugin, overwrite = false) =>
    userPlugins.install(plugin, overwrite),
  );
  handle("set-user-plugin-enabled", (id, enabled) =>
    userPlugins.setEnabled(id, enabled),
  );
  handle("remove-user-plugin", (id) => userPlugins.remove(id));
  handle("run-user-plugin-command", (id, commandId, args) =>
    userPlugins.run(id, commandId, args),
  );
  handle("set-plugin-enabled", (id, enabled) =>
    plugins.setEnabled(id, enabled),
  );
  handle("configure-plugin", (id, configuration) =>
    plugins.configure(id, configuration),
  );
  handle("set-plugin-host-ready", async (ready) => {
    await setHostsReady(ready);
  });
  ipcMain.on("desktop:plugin-response", (event, response) => {
    try {
      assertSender(event);
      plugins.respond(response);
    } catch {
      // Ignore responses from frames that are no longer the trusted workspace.
    }
  });
  handle("get-settings", () => storage.getSettings());
  handle("update-settings", async (settings) => {
    const updated = await storage.updateSettings(settings);
    installMenu();
    updateWindowControls();
    return updated;
  });
  handle("choose-directory", async () => {
    const result = await dialog.showOpenDialog(
      ...nativeDialogOptions({
        title: t("选择画布项目目录"),
        properties: ["openDirectory", "createDirectory"],
      }),
    );
    return result.canceled || !result.filePaths[0]
      ? null
      : storage.chooseRoot(result.filePaths[0]);
  });
  handle("list-projects", () => storage.listProjects());
  handle("open-files", async () => {
    const result = await dialog.showOpenDialog(
      ...nativeDialogOptions({
        title: t("打开画布"),
        filters: [
          {
            name: t("Guzi 文档"),
            extensions: ["excalidraw", "guzi-presentation"],
          },
        ],
        properties: ["openFile", "multiSelections"],
      }),
    );
    if (result.canceled) {
      return [];
    }
    const documents = [];
    for (const candidate of result.filePaths) {
      const canonical = await storage.grantFile(candidate);
      documents.push(await storage.readFile(canonical));
    }
    return documents;
  });
  handle("read-file", (candidate) => storage.readFile(candidate));
  handle("record-opened-file", (candidate) =>
    storage.recordOpenedFile(candidate),
  );
  handle("save-file", saveDocument);
  handle("save-export", async (request) => {
    if (
      !request ||
      typeof request.extension !== "string" ||
      !EXPORT_EXTENSIONS.has(request.extension.toLowerCase()) ||
      !(request.data instanceof ArrayBuffer)
    ) {
      throw new Error(t("导出格式或数据无效。"));
    }
    const extension = request.extension.toLowerCase();
    const assets = request.assets === undefined ? [] : request.assets;
    if (
      !Array.isArray(assets) ||
      (assets.length && !["md", "json"].includes(extension))
    ) {
      throw new Error(t("导出格式或数据无效。"));
    }
    const assetNames = new Set();
    if (request.assetDirectory !== undefined) {
      safeSegment(request.assetDirectory);
    }
    for (const asset of assets) {
      if (!asset || !(asset.data instanceof ArrayBuffer)) {
        throw new Error(t("导出格式或数据无效。"));
      }
      safeSegment(asset.name);
      if (!request.assetDirectory || assetNames.has(asset.name)) {
        throw new Error(t("导出附件路径无效。"));
      }
      assetNames.add(asset.name);
    }
    const result = await chooseExport(request.name, extension);
    if (!result) {
      return false;
    }
    return storage.serialize(async () => {
      await assertExportPath(result);
      let directory;
      if (assets.length) {
        directory = path.join(path.dirname(result), request.assetDirectory);
        await assertExportPath(directory);
        for (const asset of assets) {
          const target = path.join(directory, asset.name);
          const stat = await fs.lstat(target).catch((error) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
            return null;
          });
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
            throw new Error(t("导出路径不能包含符号链接。"));
          }
          if (
            stat &&
            !(await fs.readFile(target)).equals(Buffer.from(asset.data))
          ) {
            throw new Error(
              t("导出附件已存在且内容不同，请选择其他导出位置。"),
            );
          }
        }
        await fs.mkdir(directory, { recursive: true });
        for (const asset of assets) {
          const target = path.join(directory, asset.name);
          await assertExportPath(target);
          try {
            await fs.writeFile(target, Buffer.from(asset.data), {
              flag: "wx",
              mode: 0o600,
            });
          } catch (error) {
            if (error.code !== "EEXIST") {
              throw error;
            }
            await assertExportPath(target);
            if (!(await fs.readFile(target)).equals(Buffer.from(asset.data))) {
              throw new Error(
                t("导出附件已存在且内容不同，请选择其他导出位置。"),
              );
            }
          }
        }
      }
      await atomicWrite(result, Buffer.from(request.data));
      return true;
    });
  });
  handle("export-pdf", async (request) => {
    validatePdfRequest(request);
    const data = await renderPdf(BrowserWindow, request, {
      language: storage.getSettings().language,
    });
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
  });
  handle("save-pdf", async (request) => {
    validatePdfRequest(request);
    const destination = await chooseExport(request.name, "pdf");
    if (!destination) {
      return false;
    }
    const data = await renderPdf(BrowserWindow, request, {
      language: storage.getSettings().language,
    });
    return storage.serialize(async () => {
      await assertExportPath(destination);
      await atomicWrite(destination, data);
      return true;
    });
  });
  handle("edit-text", (command) => {
    if (!["undo", "redo"].includes(command)) {
      throw new Error(t("文本编辑命令无效。"));
    }
    window.webContents[command]();
  });
  handle("remove-file", (candidate, mode) =>
    storage.removeFile(candidate, mode, (target) => shell.trashItem(target)),
  );
  handle("rename-file", (candidate, name) =>
    storage.renameFile(candidate, name),
  );
  handle("move-file", (candidate, category) =>
    storage.moveFile(candidate, category),
  );
  handle("create-folder", (category) => storage.createFolder(category));
  handle("reveal-file", async (candidate) => {
    shell.showItemInFolder(await storage.allowedPath(candidate));
  });
  handle("get-session", () => storage.getSession());
  handle("set-session", (value) => storage.setSession(value));
  handle("list-drafts", () => storage.listDrafts());
  handle("write-draft", (draft) => storage.writeDraft(draft));
  handle("delete-draft", (id) => storage.deleteDraft(id));
  handle("take-pending-files", async () => {
    filesConsumerReady = true;
    rendererUnavailable = false;
    if (closePending) {
      setImmediate(() => emitCommand("close-window"));
    }
    return drainFiles();
  });
  ipcMain.on("desktop:confirm-close", (event) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    if (!closePending || rendererUnavailable) {
      return;
    }
    void approveClose();
  });
  ipcMain.on("desktop:cancel-close", (event) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    if (rendererUnavailable) return;
    updates.cancelInstall();
    resetClose();
  });
}

async function installLocalProtocol() {
  const dist = await fs.realpath(path.join(__dirname, "..", "..", "dist"));
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "local" || !["GET", "HEAD"].includes(request.method)) {
        return new Response("Not found", { status: 404 });
      }
      const relative =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const resolved = path.resolve(dist, relative);
      if (!resolved.startsWith(`${dist}${path.sep}`)) {
        return new Response("Forbidden", { status: 403 });
      }
      const real = await fs.realpath(resolved);
      if (!real.startsWith(`${dist}${path.sep}`)) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(pathToFileURL(real).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function secureSession() {
  const browserSession = session.defaultSession;
  const clipboardPermission = (contents, permission, details) =>
    Boolean(
      window &&
        contents === window.webContents &&
        ["clipboard-read", "clipboard-sanitized-write", "local-fonts"].includes(
          permission,
        ) &&
        details?.isMainFrame &&
        trustedURL(details.requestingUrl) &&
        trustedURL(contents.getURL()),
    );
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(clipboardPermission(contents, permission, details)),
  );
  browserSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      clipboardPermission(contents, permission, details),
  );
  browserSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      let allowed = false;
      if (developmentURL) {
        const url = new URL(details.url);
        allowed =
          url.hostname === developmentURL.hostname &&
          url.port === developmentURL.port &&
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
      }
      callback({ cancel: !allowed });
    },
  );
  browserSession.on("will-download", (event) => event.preventDefault());
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = developmentURL
      ? `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${developmentURL.origin} ws://${developmentURL.host} wss://${developmentURL.host}; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'`
      : "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

function windowControlsOverlay() {
  const theme = storage.getSettings().theme;
  const dark =
    theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return {
    height: 48,
    color: dark ? "#18181b" : "#f6f6f9",
    symbolColor: dark ? "#e3e3e8" : "#1b1b1f",
  };
}

function updateWindowControls() {
  if (process.platform === "win32" && window && !window.isDestroyed()) {
    window.setTitleBarOverlay(windowControlsOverlay());
  }
}

function createWindow() {
  resetClose();
  filesConsumerReady = false;
  rendererUnavailable = false;
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "Excalidraw",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden",
          trafficLightPosition: { x: 14, y: 16 },
        }
      : process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: windowControlsOverlay() }
      : {}),
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("before-input-event", (event, input) => {
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (
      input.type === "keyDown" &&
      modifier &&
      !input.alt &&
      input.key?.toLowerCase() === "z"
    ) {
      event.preventDefault();
      emitCommand(input.shift ? "redo" : "undo");
    }
  });
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        filesConsumerReady = false;
        void setHostsReady(false);
      }
    },
  );
  window.webContents.on("render-process-gone", () => {
    rendererUnavailable = true;
    filesConsumerReady = false;
    void setHostsReady(false);
    if (closePending) {
      void confirmUnavailableClose();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedURL(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!trustedURL(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (!closeApproved) {
      event.preventDefault();
      requestClose();
    }
  });
  window.on("closed", () => {
    void setHostsReady(false);
    window = null;
    closePending = false;
    closeFinalizing = false;
    filesConsumerReady = false;
  });
  window.once("ready-to-show", () => window?.show());
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        dialog.showErrorBox(t("无法加载 Excalidraw"), `${description}\n${url}`);
      }
    },
  );
  window.loadURL(developmentURL ? developmentURL.href : appURL);
}

function installMenu() {
  const command = (label, name, accelerator) => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => emitCommand(name),
  });
  const editingCommand = (label, keyCode, shift = false) => ({
    label,
    click: () => {
      if (!window) {
        return;
      }
      const modifiers = [
        process.platform === "darwin" ? "meta" : "control",
        ...(shift ? ["shift"] : []),
      ];
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode,
        modifiers,
      });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    },
  });
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: t("关于 {name}", { name: app.name }) },
              { type: "separator" },
              { role: "hide", label: t("隐藏 {name}", { name: app.name }) },
              { role: "hideOthers", label: t("隐藏其他", { name: app.name }) },
              { role: "unhide", label: t("显示全部", { name: app.name }) },
              { type: "separator" },
              { role: "quit", label: t("退出 {name}", { name: app.name }) },
            ],
          },
        ]
      : []),
    {
      label: t("文件"),
      submenu: [
        command(t("新建画布"), "new", "CmdOrCtrl+N"),
        command(t("新建演示文稿"), "new-presentation"),
        command(t("打开画布…"), "open"),
        command(t("保存"), "save"),
        command(t("另存为…"), "save-as"),
        { type: "separator" },
        command(t("项目管理"), "projects", "CmdOrCtrl+Shift+P"),
        command(t("关闭标签"), "close-tab", "CmdOrCtrl+W"),
        {
          label: t("关闭窗口"),
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => requestClose(),
        },
        ...(process.platform === "darwin"
          ? []
          : [{ role: "quit", label: t("退出 {name}", { name: app.name }) }]),
      ],
    },
    {
      label: t("编辑"),
      submenu: [
        command(t("撤销"), "undo", "CmdOrCtrl+Z"),
        command(t("重做"), "redo", "CmdOrCtrl+Shift+Z"),
        { type: "separator" },
        { role: "cut", label: t("剪切", { name: app.name }) },
        { role: "copy", label: t("复制", { name: app.name }) },
        { role: "paste", label: t("粘贴", { name: app.name }) },
        editingCommand(t("全选"), "A"),
      ],
    },
    {
      label: t("窗口"),
      submenu: [
        { role: "minimize", label: t("最小化", { name: app.name }) },
        { role: "zoom", label: t("缩放", { name: app.name }) },
        { role: "togglefullscreen", label: t("切换全屏", { name: app.name }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("open-file", (event, candidate) => {
    event.preventDefault();
    receiveFiles([candidate]);
  });
  app.on("second-instance", (_event, argv) => {
    receiveFiles(argv);
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });
  app.on("before-quit", (event) => {
    if (updates?.consumeBlockedQuit()) {
      event.preventDefault();
      return;
    }
    if (!quitApproved) {
      event.preventDefault();
      requestClose(true);
    } else {
      void setHostsReady(false);
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app
    .whenReady()
    .then(async () => {
      storage = await new DesktopStorage(app.getPath("userData"), {
        platform: process.platform,
      }).initialize();
      plugins = await new PluginHost({
        userData: app.getPath("userData"),
        fork: (...args) => utilityProcess.fork(...args),
        send: (channel, value) => {
          if (window && !window.isDestroyed())
            window.webContents.send(`desktop:${channel}`, value);
        },
        handleCommand: (command, args) =>
          userPlugins.handleCommand(command, args),
      }).initialize();
      userPlugins = new UserPlugins({
        store: await new UserPluginStore({
          userData: app.getPath("userData"),
        }).initialize(),
        createRuntime: (options) =>
          new UserPluginRuntime({
            BrowserWindow,
            session,
            ipcMain,
            ...options,
          }),
        execute: (...args) => plugins.execute(...args),
        send: (value) => {
          if (window && !window.isDestroyed())
            window.webContents.send("desktop:user-plugin-state", value);
        },
      });
      secureSession();
      if (!developmentURL) {
        await installLocalProtocol();
      }
      updates = createUpdateController({
        app,
        buildChannel,
        platform: process.platform,
        arch: process.arch,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        translate: t,
        requestClose: () => requestClose(true),
        emit: (state) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send("desktop:update-state", state);
          }
        },
      });
      installIPC();
      installMenu();
      await receiveFiles(process.argv);
      createWindow();
      if (process.platform === "win32") {
        nativeTheme.on("updated", updateWindowControls);
      }
      app.on("activate", () => {
        if (!window) {
          createWindow();
        }
      });
    })
    .catch((error) => {
      dialog.showErrorBox(t("Excalidraw 无法启动"), error.message);
      quitApproved = true;
      app.quit();
    });
}
