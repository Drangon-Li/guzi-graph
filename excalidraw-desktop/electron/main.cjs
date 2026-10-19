const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  DesktopStorage,
  atomicWrite,
  fileName,
  EXPORT_EXTENSIONS,
} = require("./storage.cjs");

if (process.env.EXCALIDRAW_DESKTOP_USER_DATA) {
  const userData = process.env.EXCALIDRAW_DESKTOP_USER_DATA;
  if (!path.isAbsolute(userData))
    throw new Error("隔离 userData 必须使用绝对路径。");
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
let closePending = false;
let closeApproved = false;
let quitRequested = false;
let quitApproved = false;
let filesConsumerReady = false;
const pendingPaths = new Set();
const appURL = "app://local/index.html";
const developmentURL = getDevelopmentURL();

function getDevelopmentURL() {
  const value = process.env.EXCALIDRAW_DESKTOP_DEV_URL;
  if (!value || app.isPackaged) return null;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("开发 URL 只允许本机 loopback 地址。");
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
  )
    throw new Error("拒绝非主窗口的文件访问。");
}

function emitCommand(command) {
  if (window && !window.isDestroyed())
    window.webContents.send("desktop:command", command);
}

function requestClose(quit = false) {
  quitRequested ||= quit;
  if (!window) {
    if (quitRequested) {
      quitApproved = true;
      app.quit();
    }
    return;
  }
  if (closePending) return;
  closePending = true;
  if (filesConsumerReady) emitCommand("close-window");
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
          message: "无法打开画布",
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
      path.extname(candidate).toLowerCase() === ".excalidraw"
    )
      pendingPaths.add(candidate);
  }
  if (storage && window && filesConsumerReady) {
    const documents = await drainFiles();
    if (documents.length && window && !window.isDestroyed())
      window.webContents.send("desktop:files-opened", documents);
  }
}

function nativeDialogOptions(options) {
  return window ? [window, options] : [options];
}

async function saveDocument(request) {
  if (!request || typeof request !== "object")
    throw new Error("保存请求无效。");
  let target = request.path;
  let overwrite = false;
  if (request.saveAs || !target) {
    const name = fileName(request.name);
    const root = storage.getSettings().rootDirectory;
    const result = await dialog.showSaveDialog(
      ...nativeDialogOptions({
        title: request.saveAs ? "画布另存为" : "保存画布",
        defaultPath: target || (root ? path.join(root, name) : name),
        filters: [{ name: "Excalidraw 画布", extensions: ["excalidraw"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      }),
    );
    if (result.canceled || !result.filePath) return null;
    if (path.extname(result.filePath).toLowerCase() !== ".excalidraw")
      throw new Error("画布文件名需要以 .excalidraw 结尾。");
    target = result.filePath;
    target = await storage.grantFile(target);
    overwrite = true;
  }
  try {
    return await storage.saveFile({ ...request, path: target }, { overwrite });
  } catch (error) {
    if (error.code !== "EXTERNAL_MODIFICATION") throw error;
    const choice = await dialog.showMessageBox(
      ...nativeDialogOptions({
        type: "warning",
        buttons: ["取消", "覆盖保存"],
        defaultId: 0,
        cancelId: 0,
        message: "此画布已被其他程序修改或移走",
        detail: "覆盖保存会用当前画布替换磁盘上的版本。",
        noLink: true,
      }),
    );
    if (choice.response !== 1) return null;
    return storage.saveFile({ ...request, path: target }, { overwrite: true });
  }
}

function installIPC() {
  const handle = (name, callback) =>
    ipcMain.handle(`desktop:${name}`, async (event, ...args) => {
      assertSender(event);
      return callback(...args);
    });
  handle("get-settings", () => storage.getSettings());
  handle("update-settings", (settings) => storage.updateSettings(settings));
  handle("choose-directory", async () => {
    const result = await dialog.showOpenDialog(
      ...nativeDialogOptions({
        title: "选择画布项目目录",
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
        title: "打开画布",
        filters: [{ name: "Excalidraw 画布", extensions: ["excalidraw"] }],
        properties: ["openFile", "multiSelections"],
      }),
    );
    if (result.canceled) return [];
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
    )
      throw new Error("导出格式或数据无效。");
    const extension = request.extension.toLowerCase();
    const name = fileName(request.name, extension);
    const result = await dialog.showSaveDialog(
      ...nativeDialogOptions({
        title: "导出画布",
        defaultPath: name,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      }),
    );
    if (result.canceled || !result.filePath) return false;
    if (!result.filePath.toLowerCase().endsWith(`.${extension}`))
      throw new Error(`导出文件名需要以 .${extension} 结尾。`);
    const destination = result.filePath;
    await atomicWrite(destination, Buffer.from(request.data));
    return true;
  });
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
    if (closePending) setImmediate(() => emitCommand("close-window"));
    return drainFiles();
  });
  ipcMain.on("desktop:confirm-close", (event) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    if (!closePending) return;
    closeApproved = true;
    if (quitRequested) {
      quitApproved = true;
      app.quit();
    } else window.close();
  });
  ipcMain.on("desktop:cancel-close", (event) => {
    try {
      assertSender(event);
    } catch {
      return;
    }
    closePending = false;
    quitRequested = false;
  });
}

async function installLocalProtocol() {
  const dist = await fs.realpath(path.join(__dirname, "..", "dist"));
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "local" || !["GET", "HEAD"].includes(request.method))
        return new Response("Not found", { status: 404 });
      const relative =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const resolved = path.resolve(dist, relative);
      if (!resolved.startsWith(`${dist}${path.sep}`))
        return new Response("Forbidden", { status: 403 });
      const real = await fs.realpath(resolved);
      if (!real.startsWith(`${dist}${path.sep}`))
        return new Response("Forbidden", { status: 403 });
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
        ["clipboard-read", "clipboard-sanitized-write"].includes(permission) &&
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

function createWindow() {
  closePending = false;
  closeApproved = false;
  quitRequested = false;
  filesConsumerReady = false;
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "Excalidraw",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) filesConsumerReady = false;
    },
  );
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedURL(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!trustedURL(url)) event.preventDefault();
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
    window = null;
    closePending = false;
    filesConsumerReady = false;
  });
  window.once("ready-to-show", () => window?.show());
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        dialog.showErrorBox("无法加载 Excalidraw", `${description}\n${url}`);
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
      if (!window) return;
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
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        command("新建画布", "new", "CmdOrCtrl+N"),
        command("打开画布…", "open"),
        command("保存", "save"),
        command("另存为…", "save-as"),
        { type: "separator" },
        command("项目管理", "projects", "CmdOrCtrl+Shift+P"),
        command("关闭标签", "close-tab", "CmdOrCtrl+W"),
        {
          label: "关闭窗口",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => requestClose(),
        },
        ...(process.platform === "darwin" ? [] : [{ role: "quit" }]),
      ],
    },
    {
      label: "编辑",
      submenu: [
        editingCommand("撤销", "Z"),
        editingCommand("重做", "Z", true),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        editingCommand("全选", "A"),
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on("open-file", (event, candidate) => {
    event.preventDefault();
    receiveFiles([candidate]);
  });
  app.on("second-instance", (_event, argv) => {
    receiveFiles(argv);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    } else if (app.isReady()) createWindow();
  });
  app.on("before-quit", (event) => {
    if (!quitApproved && window) {
      event.preventDefault();
      requestClose(true);
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      storage = await new DesktopStorage(app.getPath("userData")).initialize();
      secureSession();
      if (!developmentURL) await installLocalProtocol();
      installIPC();
      installMenu();
      await receiveFiles(process.argv);
      createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Excalidraw 无法启动", error.message);
      quitApproved = true;
      app.quit();
    });
}
