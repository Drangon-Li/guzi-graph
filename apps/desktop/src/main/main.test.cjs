const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { statSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

async function harness(
  t,
  {
    developmentURL,
    argv = [],
    userDataOverride,
    legacySettings,
    buildChannel,
    platform = "darwin",
    isPackaged = false,
    updateAdapter,
  } = {},
) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-main-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "dist"));
  await fs.writeFile(path.join(base, "dist", "index.html"), "<html></html>");
  const app = new EventEmitter();
  app.name = "Excalidraw-Guzi";
  app.isPackaged = isPackaged;
  app.getVersion = () => "0.7.4";
  app.requestSingleInstanceLock = () => true;
  app.isReady = () => true;
  app.whenReady = () => Promise.resolve();
  const paths = {
    appData: path.join(base, "Application Support"),
    userData: path.join(base, "Application Support", app.name),
  };
  app.getPath = (name) => paths[name];
  app.setPath = (name, value) => {
    assert.equal(statSync(value).isDirectory(), true);
    paths[name] = value;
  };
  const isolatedProfile = userDataOverride ?? path.join(base, "userData");
  if (userDataOverride !== null && path.isAbsolute(isolatedProfile)) {
    await fs.mkdir(isolatedProfile, { recursive: true });
  }
  if (legacySettings) {
    const legacyProfile = path.join(paths.appData, "Excalidraw Local");
    await fs.mkdir(legacyProfile, { recursive: true });
    await fs.writeFile(
      path.join(legacyProfile, "settings.json"),
      JSON.stringify(legacySettings),
    );
  }
  app.quitCompleted = 0;
  app.quit = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    app.emit("before-quit", event);
    if (!event.prevented) app.quitCompleted++;
  };
  const calls = {
    commands: [],
    exports: [],
    errors: [],
    textCommands: [],
    trash: [],
    printWindows: [],
  };
  const handlers = new Map();
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  const browserSession = new EventEmitter();
  browserSession.setPermissionRequestHandler = (handler) => {
    calls.permissionRequest = handler;
  };
  browserSession.setPermissionCheckHandler = (handler) => {
    calls.permissionCheck = handler;
  };
  browserSession.webRequest = {
    onBeforeRequest: (_filter, handler) => {
      calls.beforeRequest = handler;
    },
    onHeadersReceived: (handler) => {
      calls.headersReceived = handler;
    },
  };
  const protocol = {
    registerSchemesAsPrivileged: (schemes) => {
      calls.schemes = schemes;
    },
    handle: (_scheme, handler) => {
      calls.protocol = handler;
    },
  };
  let complete;
  const constructed = new Promise((resolve) => {
    complete = resolve;
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      calls.window = this;
      calls.windowOptions = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "app://local/index.html" };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.setWindowOpenHandler = (handler) => {
        calls.windowOpen = handler;
      };
      this.webContents.send = (channel, value) =>
        calls.commands.push({ channel, value });
      this.webContents.sendInputEvent = (input) => {
        calls.syntheticInput = input;
      };
      this.webContents.undo = () => calls.textCommands.push("undo");
      this.webContents.redo = () => calls.textCommands.push("redo");
      complete(this);
    }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    focus() {}
    show() {}
    setTitleBarOverlay(options) {
      calls.titleBarOverlay = options;
    }
    close() {
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      this.emit("close", event);
      if (!event.prevented) this.emit("closed");
      return event;
    }
  }
  const electron = {
    app,
    BrowserWindow,
    nativeTheme,
    ipcMain,
    protocol,
    session: { defaultSession: browserSession },
    dialog: {
      showSaveDialog: async (...args) => {
        calls.saveDialog = args.at(-1);
        return calls.saveResult || { canceled: true };
      },
      showOpenDialog: async (...args) => {
        calls.openDialog = args.at(-1);
        return calls.openResult || { canceled: true, filePaths: [] };
      },
      showMessageBox: async () => ({ response: calls.conflictChoice || 0 }),
      showErrorBox: (title, message) => calls.errors.push({ title, message }),
    },
    Menu: {
      buildFromTemplate: (template) => {
        calls.menu = template;
        return template;
      },
      setApplicationMenu: () => {},
    },
    net: {
      fetch: async (url) => {
        calls.localFetch = url;
        return new Response("local");
      },
    },
    shell: {
      showItemInFolder: () => {},
      trashItem: async (target) => {
        calls.trash.push(target);
        if (calls.trashError) throw calls.trashError;
        await fs.rename(target, `${target}.trashed-fixture`);
      },
    },
  };
  const source = await fs.readFile(path.join(__dirname, "main.cjs"), "utf8");
  vm.runInNewContext(
    source,
    {
      require: (name) =>
        name === "electron"
          ? electron
          : name === "../../package.json"
          ? { buildChannel }
          : name === "./update.cjs"
          ? {
              createUpdateController: (options) =>
                require("./update.cjs").createUpdateController({
                  ...options,
                  createAdapter: updateAdapter,
                }),
            }
          : name === "./pdf.cjs"
          ? {
              validatePdfRequest: require("./pdf.cjs").validatePdfRequest,
              renderPdf: async (_BrowserWindow, request) => {
                calls.printWindows.push(request);
                return Buffer.from("%PDF-fixture");
              },
            }
          : name === "./storage.cjs"
          ? require("./storage.cjs")
          : require(name),
      __dirname: path.join(base, "src", "main"),
      process: {
        env: {
          ...(userDataOverride === null
            ? {}
            : {
                EXCALIDRAW_DESKTOP_USER_DATA: isolatedProfile,
              }),
          ...(developmentURL
            ? { EXCALIDRAW_DESKTOP_DEV_URL: developmentURL }
            : {}),
        },
        argv: ["electron", ...argv],
        platform,
        arch: "arm64",
        resourcesPath: "/Applications/Guzi.app/Contents/Resources",
        execPath: "/Applications/Guzi.app/Contents/MacOS/Guzi",
      },
      Response,
      URL,
      Buffer,
      ArrayBuffer,
      setImmediate,
      console,
    },
    { filename: "main.cjs" },
  );
  const window = await constructed;
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const invoke = (name, ...args) =>
    handlers.get(`desktop:${name}`)(event, ...args);
  return {
    app,
    base,
    calls,
    window,
    ipcMain,
    handlers,
    event,
    invoke,
    browserSession,
    nativeTheme,
  };
}

test("Windows native controls follow app and system themes while macOS retains traffic lights", async (t) => {
  const mac = await harness(t);
  assert.equal(mac.calls.windowOptions.titleBarStyle, "hidden");
  assert.equal(mac.calls.windowOptions.titleBarOverlay, undefined);
  assert.equal(mac.calls.windowOptions.trafficLightPosition.x, 14);
  assert.equal(mac.calls.windowOptions.trafficLightPosition.y, 16);

  const win = await harness(t, { platform: "win32" });
  assert.equal(win.calls.windowOptions.titleBarStyle, "hidden");
  assert.equal(win.calls.windowOptions.frame, undefined);
  assert.equal(win.calls.windowOptions.trafficLightPosition, undefined);
  assert.equal(win.calls.windowOptions.titleBarOverlay.height, 48);
  assert.equal(win.calls.windowOptions.titleBarOverlay.color, "#f6f6f9");

  await win.invoke("update-settings", { theme: "dark" });
  assert.equal(win.calls.titleBarOverlay.color, "#18181b");
  assert.equal(win.calls.titleBarOverlay.symbolColor, "#e3e3e8");
  win.nativeTheme.emit("updated");
  assert.equal(win.calls.titleBarOverlay.color, "#18181b");

  await win.invoke("update-settings", { theme: "light" });
  win.nativeTheme.shouldUseDarkColors = true;
  win.nativeTheme.emit("updated");
  assert.equal(win.calls.titleBarOverlay.color, "#f6f6f9");

  await win.invoke("update-settings", { theme: "system" });
  assert.equal(win.calls.titleBarOverlay.color, "#18181b");
  win.nativeTheme.shouldUseDarkColors = false;
  win.nativeTheme.emit("updated");
  assert.equal(win.calls.titleBarOverlay.color, "#f6f6f9");
  const linux = await harness(t, { platform: "linux" });
  assert.equal(linux.calls.windowOptions.titleBarStyle, undefined);
  assert.equal(linux.calls.windowOptions.titleBarOverlay, undefined);
});

test("renamed product keeps using the existing legacy profile by default", async (t) => {
  const legacySettings = { theme: "dark", language: "en" };
  const { app, base, invoke } = await harness(t, {
    userDataOverride: null,
    legacySettings,
  });
  const legacyProfile = path.join(
    base,
    "Application Support",
    "Excalidraw Local",
  );
  assert.equal(app.getPath("userData"), legacyProfile);
  assert.equal((await invoke("get-settings")).theme, "dark");
  assert.equal((await invoke("get-settings")).language, "en");
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(legacyProfile, "settings.json"))),
    legacySettings,
  );
  await assert.rejects(fs.stat(path.join(app.getPath("appData"), app.name)), {
    code: "ENOENT",
  });
});

test("absolute isolated profile override takes priority over the legacy profile", async (t) => {
  const { app, base, invoke } = await harness(t, {
    legacySettings: { theme: "dark" },
  });
  assert.equal(app.getPath("userData"), path.join(base, "userData"));
  assert.equal((await invoke("get-settings")).theme, "system");
  await invoke("update-settings", { theme: "light" });
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(
          base,
          "Application Support",
          "Excalidraw Local",
          "settings.json",
        ),
      ),
    ).theme,
    "dark",
  );
});

test("new installations create the stable legacy profile directory", async (t) => {
  const { app, invoke } = await harness(t, { userDataOverride: null });
  assert.equal(
    app.getPath("userData"),
    path.join(app.getPath("appData"), "Excalidraw Local"),
  );
  assert.equal((await fs.stat(app.getPath("userData"))).isDirectory(), true);
  assert.equal((await invoke("get-settings")).theme, "system");
});

for (const [buildChannel, profileName] of [
  ["dev-ppt", "Excalidraw-Guzi Dev PPT"],
  ["test", "Excalidraw-Guzi Test"],
]) {
  test(`${buildChannel} builds use an independent profile and preserve legacy settings`, async (t) => {
    const legacySettings = { theme: "dark", language: "en" };
    const { app, invoke } = await harness(t, {
      buildChannel,
      userDataOverride: null,
      legacySettings,
    });
    const profile = path.join(app.getPath("appData"), profileName);
    assert.equal(app.getPath("userData"), profile);
    assert.equal((await fs.stat(profile)).isDirectory(), true);
    assert.equal((await invoke("get-settings")).theme, "system");
    await invoke("update-settings", { theme: "light" });
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(
          path.join(
            app.getPath("appData"),
            "Excalidraw Local",
            "settings.json",
          ),
        ),
      ),
      legacySettings,
    );
  });

  test(`explicit userData overrides take priority for ${buildChannel} builds`, async (t) => {
    const { app, base } = await harness(t, { buildChannel });
    assert.equal(app.getPath("userData"), path.join(base, "userData"));
    await assert.rejects(fs.stat(app.getPath("appData")), { code: "ENOENT" });
  });
}

test("relative isolated profile overrides are rejected", async (t) => {
  await assert.rejects(
    harness(t, { userDataOverride: "relative-profile" }),
    /隔离 userData 必须使用绝对路径/,
  );
});

test("production main uses local secure scheme, sandbox and blocks network/navigation", async (t) => {
  const { calls, window } = await harness(t);
  assert.equal(window.webContents.getURL(), "app://local/index.html");
  assert.equal(calls.schemes[0].privileges.secure, true);
  assert.equal(calls.schemes[0].privileges.standard, true);
  assert.equal(calls.windowOptions.webPreferences.sandbox, true);
  assert.equal(calls.windowOptions.webPreferences.contextIsolation, true);
  assert.equal(calls.windowOptions.webPreferences.nodeIntegration, false);
  for (const url of [
    "https://excalidraw.com/api",
    "http://localhost:4317/",
    "wss://example.com/ws",
  ]) {
    calls.beforeRequest({ url }, (result) => assert.equal(result.cancel, true));
  }
  assert.equal(calls.windowOpen({ url: "https://example.com" }).action, "deny");
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  window.webContents.emit("will-navigate", event, "https://example.com");
  assert.equal(event.prevented, true);
});

test("development network allowlist only accepts explicitly selected loopback port", async (t) => {
  const { calls } = await harness(t, {
    developmentURL: "http://127.0.0.1:4317/",
  });
  for (const url of [
    "http://127.0.0.1:4317/src/main.tsx",
    "ws://127.0.0.1:4317/",
  ])
    calls.beforeRequest({ url }, (result) =>
      assert.equal(result.cancel, false),
    );
  for (const url of [
    "http://127.0.0.1:9999/",
    "http://example.com:4317/",
    "http://localhost:4317/",
  ])
    calls.beforeRequest({ url }, (result) => assert.equal(result.cancel, true));
});

test("clipboard permission only allows trusted main document and needed operations", async (t) => {
  const { calls, window } = await harness(t);
  const contents = window.webContents;
  const details = {
    isMainFrame: true,
    requestingUrl: "app://local/index.html",
  };
  for (const permission of ["clipboard-read", "clipboard-sanitized-write"]) {
    assert.equal(
      calls.permissionCheck(contents, permission, "app://local", details),
      true,
    );
    calls.permissionRequest(
      contents,
      permission,
      (allowed) => assert.equal(allowed, true),
      details,
    );
    assert.equal(
      calls.permissionCheck(contents, permission, "app://local", {
        ...details,
        isMainFrame: false,
      }),
      false,
    );
    assert.equal(
      calls.permissionCheck(contents, permission, "https://example.com", {
        ...details,
        requestingUrl: "https://example.com/",
      }),
      false,
    );
    assert.equal(
      calls.permissionCheck(null, permission, "app://local", details),
      false,
    );
  }
  for (const permission of [
    "fileSystem",
    "media",
    "notifications",
    "openExternal",
  ]) {
    assert.equal(
      calls.permissionCheck(contents, permission, "app://local", details),
      false,
    );
    calls.permissionRequest(
      contents,
      permission,
      (allowed) => assert.equal(allowed, false),
      details,
    );
  }
});

test("IPC rejects foreign renderer and child frame senders", async (t) => {
  const { handlers, event, window } = await harness(t);
  await assert.rejects(
    handlers.get("desktop:get-settings")({ ...event, sender: {} }),
    /拒绝/,
  );
  await assert.rejects(
    handlers.get("desktop:get-settings")({
      ...event,
      senderFrame: { url: "app://local/index.html" },
    }),
    /拒绝/,
  );
  window.webContents.mainFrame.url = "https://example.com/";
  await assert.rejects(handlers.get("desktop:get-settings")(event), /拒绝/);
});

test("window close and Cmd+Q wait for renderer confirmation, cancellation resets state", async (t) => {
  const { app, calls, window, ipcMain, event, invoke } = await harness(t);
  await invoke("take-pending-files");
  assert.equal(window.close().prevented, true);
  assert.equal(calls.commands.at(-1).value, "close-window");
  ipcMain.emit("desktop:cancel-close", event);
  const count = calls.commands.length;
  app.quit();
  assert.equal(app.quitCompleted, 0);
  assert.equal(calls.commands.length, count + 1);
  assert.equal(calls.commands.at(-1).value, "close-window");
  ipcMain.emit("desktop:confirm-close", { ...event, sender: {} });
  assert.equal(app.quitCompleted, 0);
  ipcMain.emit("desktop:confirm-close", event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.quitCompleted, 1);
});

test("close requested during initialization is replayed when renderer is ready", async (t) => {
  const { app, calls, invoke } = await harness(t);
  app.quit();
  assert.equal(calls.commands.length, 0);
  await invoke("take-pending-files");
  await new Promise(setImmediate);
  assert.equal(calls.commands.at(-1).value, "close-window");
});

test("local protocol rejects traversal, remote hosts and symlink assets", async (t) => {
  const { base, calls } = await harness(t);
  assert.equal(
    (await calls.protocol({ url: "app://local/index.html", method: "GET" }))
      .status,
    200,
  );
  assert.match(calls.localFetch, /^file:/);
  assert.equal(
    (await calls.protocol({ url: "app://remote/index.html", method: "GET" }))
      .status,
    404,
  );
  assert.equal(
    (
      await calls.protocol({
        url: "app://local/%2e%2e%2fsecret",
        method: "GET",
      })
    ).status,
    403,
  );
  await fs.writeFile(path.join(base, "secret"), "private");
  await fs.symlink(path.join(base, "secret"), path.join(base, "dist", "alias"));
  assert.equal(
    (await calls.protocol({ url: "app://local/alias", method: "GET" })).status,
    403,
  );
});

test("save dialog rejects occupied document before writing disk", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const target = path.join(base, "opened.excalidraw");
  await fs.writeFile(target, "another tab");
  calls.saveResult = { canceled: false, filePath: target };
  await assert.rejects(
    invoke("save-file", {
      documentId: require("node:crypto").randomUUID(),
      path: null,
      name: "drawing",
      content: "wrong tab",
      saveAs: true,
      occupiedPaths: [target],
    }),
    { code: "OPEN_DOCUMENT_CONFLICT" },
  );
  assert.equal(await fs.readFile(target, "utf8"), "another tab");
});

test("automation save requires root for new canvas and creates unique files without dialogs", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const request = {
    documentId: require("node:crypto").randomUUID(),
    path: null,
    name: "canvas",
    content: "automated",
    automation: true,
  };
  await assert.rejects(invoke("save-file", request), { code: "ROOT_REQUIRED" });
  const root = path.join(base, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "canvas.excalidraw"), "preserved");
  calls.openResult = { canceled: false, filePaths: [root] };
  await invoke("choose-directory");
  const first = await invoke("save-file", request);
  const second = await invoke("save-file", request);
  assert.equal(path.dirname(first.path), root);
  assert.notEqual(first.path, second.path);
  assert.equal(first.content, "automated");
  assert.equal(
    await fs.readFile(path.join(root, "canvas.excalidraw"), "utf8"),
    "preserved",
  );
  assert.equal(calls.saveDialog, undefined);
  await assert.rejects(
    invoke("save-file", { ...request, saveAs: true }),
    /自动化/,
  );
  const deck = await invoke("save-file", {
    ...request,
    format: "presentation",
  });
  assert.equal(path.dirname(deck.path), root);
  assert.equal(path.extname(deck.path), ".guzi-presentation");
  assert.equal(deck.content, "automated");
  assert.equal(calls.saveDialog, undefined);
});

test("presentation automation retains path authorization and refuses external overwrites", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const candidate = path.join(base, "outside.guzi-presentation");
  await fs.writeFile(candidate, "original deck");
  const request = {
    documentId: require("node:crypto").randomUUID(),
    path: candidate,
    name: "deck",
    format: "presentation",
    content: "automated deck",
    automation: true,
  };
  await assert.rejects(invoke("save-file", request), {
    code: "NOT_AUTHORIZED",
  });
  calls.openResult = { canceled: false, filePaths: [candidate] };
  const [opened] = await invoke("open-files");
  const saved = await invoke("save-file", {
    ...request,
    expectedModifiedAt: opened.modifiedAt,
  });
  assert.equal(saved.content, request.content);
  await fs.writeFile(candidate, "external changed deck");
  const changed = await fs.stat(candidate);
  await fs.utimes(candidate, new Date(), new Date(changed.mtimeMs + 1000));
  await assert.rejects(
    invoke("save-file", { ...request, expectedModifiedAt: saved.modifiedAt }),
    { code: "EXTERNAL_MODIFICATION" },
  );
  assert.equal(await fs.readFile(candidate, "utf8"), "external changed deck");
  assert.equal(calls.saveDialog, undefined);
});

test("automation preserves authorization and external modification checks without overwrite prompt", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const candidate = path.join(base, "outside.excalidraw");
  await fs.writeFile(candidate, "original");
  const request = {
    documentId: require("node:crypto").randomUUID(),
    path: candidate,
    name: "canvas",
    content: "automated",
    automation: true,
  };
  await assert.rejects(invoke("save-file", request), {
    code: "NOT_AUTHORIZED",
  });
  calls.openResult = { canceled: false, filePaths: [candidate] };
  const [opened] = await invoke("open-files");
  const saved = await invoke("save-file", {
    ...request,
    expectedModifiedAt: opened.modifiedAt,
  });
  assert.equal(saved.content, "automated");
  await fs.writeFile(candidate, "external changes with different size");
  const changed = await fs.stat(candidate);
  await fs.utimes(candidate, new Date(), new Date(changed.mtimeMs + 1000));
  calls.conflictChoice = 1;
  await assert.rejects(
    invoke("save-file", { ...request, expectedModifiedAt: saved.modifiedAt }),
    { code: "EXTERNAL_MODIFICATION" },
  );
  assert.equal(
    await fs.readFile(candidate, "utf8"),
    "external changes with different size",
  );
  assert.equal(calls.saveDialog, undefined);
});

test("plugin settings IPC validates sender and unknown plugins", async (t) => {
  const { invoke, handlers, event } = await harness(t);
  const [plugin] = await invoke("get-plugins");
  assert.equal(plugin.id, "mcp");
  assert.equal(plugin.enabled, false);
  await assert.rejects(
    invoke("set-plugin-enabled", "not-installed", true),
    /未知插件/,
  );
  await assert.rejects(invoke("configure-plugin", "mcp", { port: 80 }), /端口/);
  for (const name of [
    "get-plugins",
    "set-plugin-enabled",
    "configure-plugin",
    "set-plugin-host-ready",
    "get-user-plugins",
    "install-user-plugin",
    "set-user-plugin-enabled",
    "remove-user-plugin",
    "run-user-plugin-command",
  ]) {
    await assert.rejects(
      handlers.get(`desktop:${name}`)({ ...event, sender: {} }),
      /拒绝/,
    );
  }
});

test("user plugin IPC installs disabled packages and uninstalls without starting code", async (t) => {
  const { invoke } = await harness(t);
  const { EXAMPLE_PLUGIN } = require("./plugin-development.cjs");
  assert.deepEqual(await invoke("get-user-plugins"), []);
  const installed = await invoke("install-user-plugin", EXAMPLE_PLUGIN);
  assert.equal(installed[0].manifest.id, EXAMPLE_PLUGIN.manifest.id);
  assert.equal(installed[0].enabled, false);
  assert.equal(installed[0].status, "disabled");
  await assert.rejects(
    invoke(
      "run-user-plugin-command",
      EXAMPLE_PLUGIN.manifest.id,
      "insert-note",
    ),
    { code: "PLUGIN_DISABLED" },
  );
  await invoke("remove-user-plugin", EXAMPLE_PLUGIN.manifest.id);
  assert.deepEqual(await invoke("get-user-plugins"), []);
});

test("presentation Save As uses its native extension and rejects drawing destinations", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const drawing = path.join(base, "existing.excalidraw");
  await fs.writeFile(drawing, "keep drawing");
  const request = {
    documentId: require("node:crypto").randomUUID(),
    path: null,
    name: "talk",
    content: '{"type":"guzi-presentation","slides":[]}',
    format: "presentation",
    saveAs: true,
  };
  assert.equal(await invoke("save-file", request), null);
  assert.equal(calls.saveDialog.title, "演示文稿另存为");
  assert.equal(calls.saveDialog.defaultPath, "talk.guzi-presentation");
  assert.deepEqual(Array.from(calls.saveDialog.filters[0].extensions), [
    "guzi-presentation",
  ]);
  calls.saveResult = { canceled: false, filePath: drawing };
  await assert.rejects(invoke("save-file", request), /\.guzi-presentation/);
  assert.equal(await fs.readFile(drawing, "utf8"), "keep drawing");
  const target = path.join(base, "talk.guzi-presentation");
  calls.saveResult = { canceled: false, filePath: target };
  const saved = await invoke("save-file", request);
  assert.equal(saved.path, target);
  assert.equal(saved.content, request.content);
  assert.equal((await invoke("list-projects")).history[0].path, target);
  await assert.rejects(
    invoke("save-file", { ...request, format: undefined }),
    /\.excalidraw/,
  );
  assert.equal(await fs.readFile(target, "utf8"), request.content);
});

test("native open events and dialogs accept presentations alongside drawings", async (t) => {
  const { base, app, calls, invoke } = await harness(t);
  const presentation = path.join(base, "talk.GUZI-PRESENTATION");
  const content = '{"type":"guzi-presentation","slides":[]}';
  await fs.writeFile(presentation, content);
  app.emit("open-file", { preventDefault() {} }, presentation);
  const pending = await invoke("take-pending-files");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].path, presentation);
  assert.equal(pending[0].content, content);
  calls.openResult = { canceled: false, filePaths: [presentation] };
  const opened = await invoke("open-files");
  assert.equal(opened[0].content, content);
  assert.deepEqual(Array.from(calls.openDialog.filters[0].extensions), [
    "excalidraw",
    "guzi-presentation",
  ]);
});

test("native File menu creates a presentation without changing the drawing shortcut", async (t) => {
  const { calls } = await harness(t);
  const fileMenu = calls.menu.find((item) => item.label === "文件").submenu;
  assert.equal(
    fileMenu.find((item) => item.label === "新建画布").accelerator,
    "CmdOrCtrl+N",
  );
  const presentation = fileMenu.find((item) => item.label === "新建演示文稿");
  presentation.click();
  assert.deepEqual(calls.commands, [
    { channel: "desktop:command", value: "new-presentation" },
  ]);
});

test("macOS clipboard menu uses native roles and preserves editor keyboard ownership", async (t) => {
  const { calls } = await harness(t);
  const edit = calls.menu.find((item) => item.label === "编辑").submenu;
  for (const role of ["cut", "copy", "paste"]) {
    const item = edit.find((entry) => entry.role === role);
    assert.ok(
      item,
      `native ${role} role is required for macOS editing commands`,
    );
    assert.equal(item.accelerator, undefined);
    assert.equal(item.click, undefined);
  }
  for (const label of ["撤销", "重做", "全选"]) {
    const item = edit.find((entry) => entry.label === label);
    assert.equal(item.role, undefined);
    assert.equal(
      item.accelerator,
      label === "撤销"
        ? "CmdOrCtrl+Z"
        : label === "重做"
        ? "CmdOrCtrl+Shift+Z"
        : undefined,
    );
    assert.equal(typeof item.click, "function");
  }
});

test("clipboard handlers validate the loaded main frame URL in local development", async (t) => {
  const { calls, window } = await harness(t, {
    developmentURL: "http://127.0.0.1:4317/",
  });
  const details = {
    isMainFrame: true,
    requestingUrl: window.webContents.getURL(),
  };
  assert.equal(details.requestingUrl, "http://127.0.0.1:4317/");
  assert.equal(
    calls.permissionCheck(
      window.webContents,
      "clipboard-read",
      "http://127.0.0.1:4317",
      details,
    ),
    true,
  );
  calls.permissionRequest(
    window.webContents,
    "clipboard-sanitized-write",
    (allowed) => assert.equal(allowed, true),
    details,
  );
  assert.equal(
    calls.permissionCheck(
      window.webContents,
      "clipboard-read",
      "http://127.0.0.1:9999",
      { ...details, requestingUrl: "http://127.0.0.1:9999/" },
    ),
    false,
  );
});

test("history IPC records only authorized drawings and validates the sender", async (t) => {
  const { base, app, invoke, handlers, event } = await harness(t);
  const external = path.join(base, "history.excalidraw");
  await fs.writeFile(external, "drawing");
  await assert.rejects(invoke("record-opened-file", external), {
    code: "NOT_AUTHORIZED",
  });
  app.emit("open-file", { preventDefault() {} }, external);
  const opened = await invoke("take-pending-files");
  assert.equal(opened.length, 1);
  assert.deepEqual((await invoke("list-projects")).history, []);
  await invoke("record-opened-file", external);
  assert.deepEqual(
    (await invoke("list-projects")).history.map((file) => file.path),
    [external],
  );
  await assert.rejects(
    handlers.get("desktop:record-opened-file")(
      { ...event, sender: {} },
      external,
    ),
    /拒绝/,
  );
});

const arrayBuffer = (text) => Uint8Array.from(Buffer.from(text)).buffer;

test("native undo and redo dispatch once without synthesized keyboard input; text IPC uses native webContents methods", async (t) => {
  const { calls, window, invoke } = await harness(t);
  const edit = calls.menu.find((entry) => entry.label === "编辑").submenu;
  for (const [label, command] of [
    ["撤销", "undo"],
    ["重做", "redo"],
  ]) {
    const before = calls.commands.length;
    edit.find((entry) => entry.label === label).click();
    assert.equal(calls.commands.length, before + 1);
    assert.equal(calls.commands.at(-1).value, command);
  }
  for (const shift of [false, true]) {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    const before = calls.commands.length;
    window.webContents.emit("before-input-event", event, {
      type: "keyDown",
      meta: true,
      key: "Z",
      shift,
    });
    assert.equal(event.prevented, true);
    assert.equal(calls.commands.length, before + 1);
    assert.equal(calls.commands.at(-1).value, shift ? "redo" : "undo");
  }
  const before = calls.commands.length;
  window.webContents.emit(
    "before-input-event",
    {
      preventDefault() {
        assert.fail("keyup is not intercepted");
      },
    },
    { type: "keyUp", meta: true, key: "z" },
  );
  assert.equal(calls.commands.length, before);
  await invoke("edit-text", "undo");
  await invoke("edit-text", "redo");
  assert.deepEqual(calls.textCommands, ["undo", "redo"]);
  assert.equal(calls.syntheticInput, undefined);
  await assert.rejects(invoke("edit-text", "copy"), /无效/);
});

test("settings language rebuilds native menus and localizes dialogs and validation errors", async (t) => {
  const { calls, invoke } = await harness(t);
  await invoke("update-settings", { language: "en" });
  assert.ok(calls.menu.some(({ label }) => label === "File"));
  const edit = calls.menu.find(({ label }) => label === "Edit");
  assert.equal(edit.submenu.find(({ role }) => role === "copy").label, "Copy");
  await invoke("open-files");
  assert.equal(calls.openDialog.title, "Open drawing");
  await assert.rejects(
    invoke("save-export", {
      name: "bad",
      extension: "exe",
      data: arrayBuffer("x"),
    }),
    /Invalid export format/,
  );
  await assert.rejects(
    invoke("save-export", {
      name: "../bad",
      extension: "md",
      data: arrayBuffer("x"),
    }),
    /valid file name/,
  );
  await invoke("update-settings", { language: "zh-CN" });
  assert.ok(calls.menu.some(({ label }) => label === "文件"));
});

test("new IPC endpoints reject foreign senders before text, removal or PDF side effects", async (t) => {
  const { calls, handlers, event } = await harness(t);
  for (const endpoint of [
    "remove-file",
    "edit-text",
    "save-pdf",
    "export-pdf",
    "save-export",
  ])
    await assert.rejects(
      handlers.get(`desktop:${endpoint}`)({ ...event, sender: {} }),
      /拒绝/,
    );
  assert.deepEqual(calls.textCommands, []);
  assert.deepEqual(calls.trash, []);
  assert.deepEqual(calls.printWindows, []);
});

test("remove IPC hides without deleting and trash uses the mocked system trash only after authorization", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const target = path.join(base, "fixture.excalidraw");
  await fs.writeFile(target, "fixture");
  await assert.rejects(invoke("remove-file", target, "trash"), {
    code: "NOT_AUTHORIZED",
  });
  calls.openResult = { canceled: false, filePaths: [target] };
  await invoke("open-files");
  await invoke("record-opened-file", target);
  await invoke("remove-file", target, "remove");
  assert.equal(await fs.readFile(target, "utf8"), "fixture");
  assert.deepEqual(calls.trash, []);
  await invoke("record-opened-file", target);
  calls.trashError = new Error("trash unavailable");
  await assert.rejects(
    invoke("remove-file", target, "trash"),
    /trash unavailable/,
  );
  assert.equal((await invoke("list-projects")).history.length, 1);
  calls.trashError = null;
  await invoke("remove-file", target, "trash");
  assert.deepEqual(calls.trash, [target, target]);
  assert.equal(
    await fs.readFile(`${target}.trashed-fixture`, "utf8"),
    "fixture",
  );
  assert.equal((await invoke("list-projects")).history.length, 0);
});

test("Markdown export keeps its attachment directory when the chosen document name changes; cancellation writes nothing", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const request = {
    name: "original",
    extension: "md",
    data: arrayBuffer("![image](original-assets/one.png)"),
    assetDirectory: "original-assets",
    assets: [{ name: "one.png", data: arrayBuffer("png-fixture") }],
  };
  assert.equal(await invoke("save-export", request), false);
  assert.deepEqual(await fs.readdir(base), ["dist", "userData"]);
  const target = path.join(base, "renamed.md");
  calls.saveResult = { canceled: false, filePath: target };
  assert.equal(await invoke("save-export", request), true);
  assert.equal(
    await fs.readFile(target, "utf8"),
    "![image](original-assets/one.png)",
  );
  assert.equal(
    await fs.readFile(path.join(base, "original-assets", "one.png"), "utf8"),
    "png-fixture",
  );
  assert.equal(await invoke("save-export", request), true);
});

test("Windows exports reject device names in attachment directories and filenames", async (t) => {
  const { base, calls, invoke } = await harness(t, { platform: "win32" });
  calls.saveResult = { canceled: false, filePath: path.join(base, "safe.md") };
  const request = {
    name: "safe",
    extension: "md",
    data: arrayBuffer("body"),
    assetDirectory: "assets",
    assets: [{ name: "one.png", data: arrayBuffer("image") }],
  };
  for (const reserved of ["CON", "nul.png", "COM1.md", "LPT²", "CONOUT$"]) {
    await assert.rejects(
      invoke("save-export", { ...request, assetDirectory: reserved }),
      /路径无效/,
    );
    await assert.rejects(
      invoke("save-export", {
        ...request,
        assets: [{ name: reserved, data: arrayBuffer("image") }],
      }),
      /路径无效/,
    );
  }
  await assert.rejects(fs.stat(path.join(base, "assets")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(base, "safe.md")), { code: "ENOENT" });
});

test("Markdown export rejects unsafe paths and symlinks and preserves unrelated existing attachments", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const target = path.join(base, "safe.md");
  calls.saveResult = { canceled: false, filePath: target };
  const request = {
    name: "safe",
    extension: "md",
    data: arrayBuffer("body"),
    assetDirectory: "assets",
    assets: [{ name: "one.png", data: arrayBuffer("new contents") }],
  };
  for (const unsafe of [
    "../outside",
    "a/b",
    "..",
    "a\\b",
    " name",
    "name\0",
    "name:",
  ])
    await assert.rejects(
      invoke("save-export", { ...request, assetDirectory: unsafe }),
      /路径无效/,
    );
  await assert.rejects(
    invoke("save-export", {
      ...request,
      assets: [{ name: "../outside.png", data: arrayBuffer("x") }],
    }),
    /路径无效/,
  );
  await fs.mkdir(path.join(base, "outside"));
  await fs.symlink(path.join(base, "outside"), path.join(base, "assets"));
  await assert.rejects(invoke("save-export", request), /符号链接/);
  assert.deepEqual(await fs.readdir(path.join(base, "outside")), []);
  await fs.unlink(path.join(base, "assets"));
  await fs.mkdir(path.join(base, "assets"));
  const attachment = path.join(base, "assets", "one.png");
  await fs.writeFile(attachment, "unrelated user file");
  await assert.rejects(invoke("save-export", request), /内容不同/);
  assert.equal(await fs.readFile(attachment, "utf8"), "unrelated user file");
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  await fs.unlink(attachment);
  await fs.writeFile(path.join(base, "outside", "original.png"), "original");
  await fs.symlink(path.join(base, "outside", "original.png"), attachment);
  await assert.rejects(invoke("save-export", request), /符号链接/);
  assert.equal(
    await fs.readFile(path.join(base, "outside", "original.png"), "utf8"),
    "original",
  );
});

test("PDF IPC validates before dialog, cancellation skips rendering and success writes the returned PDF", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const request = {
    name: "drawing",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    width: 960,
    height: 480,
  };
  await assert.rejects(invoke("save-pdf", { ...request, width: 0 }), /无效/);
  assert.equal(calls.saveDialog, undefined);
  assert.equal(await invoke("save-pdf", request), false);
  assert.equal(calls.printWindows.length, 0);
  const target = path.join(base, "drawing.pdf");
  calls.saveResult = { canceled: false, filePath: target };
  assert.equal(await invoke("save-pdf", request), true);
  assert.equal(calls.printWindows.length, 1);
  assert.equal(await fs.readFile(target, "utf8"), "%PDF-fixture");
});

test("PDF byte export validates and renders without a save dialog or file destination", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const request = {
    name: "presentation",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    width: 960,
    height: 540,
    pages: [{ svg: "<svg></svg>", width: 960, height: 540 }],
  };
  await assert.rejects(invoke("export-pdf", { ...request, height: 0 }), /无效/);
  assert.equal(calls.printWindows.length, 0);
  const before = await fs.readdir(base);
  const data = await invoke("export-pdf", request);
  assert.equal(Object.prototype.toString.call(data), "[object ArrayBuffer]");
  assert.equal(Buffer.from(data).toString("utf8"), "%PDF-fixture");
  assert.equal(calls.saveDialog, undefined);
  assert.equal(calls.printWindows.length, 1);
  assert.deepEqual(await fs.readdir(base), before);
});

test("JSON structured export writes relative image attachments and other export formats reject attachments", async (t) => {
  const { base, calls, invoke } = await harness(t);
  const target = path.join(base, "renamed.json");
  const manifest = JSON.stringify({
    images: [{ path: "drawing-assets/image.png" }],
  });
  const request = {
    name: "drawing",
    extension: "json",
    data: arrayBuffer(manifest),
    assetDirectory: "drawing-assets",
    assets: [{ name: "image.png", data: arrayBuffer("image-fixture") }],
  };
  calls.saveResult = { canceled: false, filePath: target };
  assert.equal(await invoke("save-export", request), true);
  assert.equal(await fs.readFile(target, "utf8"), manifest);
  assert.equal(
    await fs.readFile(path.join(base, "drawing-assets", "image.png"), "utf8"),
    "image-fixture",
  );
  for (const extension of ["png", "svg", "excalidraw", "excalidrawlib"])
    await assert.rejects(
      invoke("save-export", { ...request, extension }),
      /无效/,
    );
});

test("PDF IPC translates invalid PDF request errors to the selected language", async (t) => {
  const { invoke } = await harness(t);
  await invoke("update-settings", { language: "en" });
  await assert.rejects(
    invoke("save-pdf", {
      name: "invalid",
      width: 0,
      height: 10,
      svg: "<svg/>",
    }),
    /Invalid PDF export data/,
  );
});

const flushUpdates = () => new Promise((resolve) => setImmediate(resolve));
async function updateHarness(t) {
  const calls = { installs: 0, cancels: 0 };
  let emit;
  const adapter = {
    async check() {
      emit({ status: "available", availableVersion: "0.8.0" });
    },
    async download() {
      emit({ status: "downloaded", availableVersion: "0.8.0", progress: 100 });
    },
    async install() {
      calls.installs++;
    },
    async cancel() {
      calls.cancels++;
    },
  };
  const h = await harness(t, {
    isPackaged: true,
    updateAdapter: (options) => {
      emit = options.emit;
      return adapter;
    },
  });
  await h.invoke("take-pending-files");
  await h.invoke("check-for-updates");
  await h.invoke("download-update");
  return { ...h, updateCalls: calls, adapter };
}

test("update IPC rejects foreign senders and renderer cannot provide paths or feed URLs", async (t) => {
  const h = await updateHarness(t);
  for (const endpoint of [
    "get-update-state",
    "check-for-updates",
    "download-update",
    "install-update",
  ]) {
    await assert.rejects(
      h.handlers.get(`desktop:${endpoint}`)({ ...h.event, sender: {} }),
      /拒绝/,
    );
    await assert.rejects(
      h.handlers.get(`desktop:${endpoint}`)({
        ...h.event,
        senderFrame: { url: "app://local/index.html" },
      }),
      /拒绝/,
    );
  }
  assert.equal(h.updateCalls.installs, 0);
  const state = await h.invoke("get-update-state", {
    feed: "https://attacker.invalid",
  });
  assert.equal(state.availableVersion, "0.8.0");
});

test("main update install waits for saved-session confirmation and installs once despite repeated clicks", async (t) => {
  const h = await updateHarness(t);
  await Promise.all([h.invoke("install-update"), h.invoke("install-update")]);
  assert.equal(h.calls.commands.at(-1).value, "close-window");
  assert.equal(h.updateCalls.installs, 0);
  assert.equal(h.app.quitCompleted, 0);
  h.ipcMain.emit("desktop:confirm-close", { ...h.event, sender: {} });
  await flushUpdates();
  assert.equal(h.updateCalls.installs, 0);
  h.ipcMain.emit("desktop:confirm-close", h.event);
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.updateCalls.installs, 1);
  assert.equal(h.app.quitCompleted, 1);
});

test("cancelling save revokes update installation and later normal quit only cancels the helper", async (t) => {
  const h = await updateHarness(t);
  await h.invoke("install-update");
  h.ipcMain.emit("desktop:cancel-close", h.event);
  assert.equal((await h.invoke("get-update-state")).status, "available");
  h.app.quit();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.updateCalls.installs, 0);
  assert.equal(h.updateCalls.cancels, 1);
  assert.equal(h.app.quitCompleted, 1);
});

test("normal quit waits for native cancellation; failed cancellation keeps the application alive", async (t) => {
  const h = await updateHarness(t);
  let release;
  h.adapter.cancel = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  h.app.quit();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 0);
  release();
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 1);
  assert.equal(h.updateCalls.installs, 0);

  const failed = await updateHarness(t);
  failed.adapter.cancel = async () => {
    throw new Error("cancel failed");
  };
  failed.app.quit();
  failed.ipcMain.emit("desktop:confirm-close", failed.event);
  await flushUpdates();
  assert.equal(failed.app.quitCompleted, 0);
  assert.equal((await failed.invoke("get-update-state")).status, "error");
});

test("failed installation keeps the window alive and subsequent quit never installs implicitly", async (t) => {
  const h = await updateHarness(t);
  h.adapter.install = async () => {
    h.updateCalls.installs++;
    throw new Error("installer failed");
  };
  await h.invoke("install-update");
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 0);
  assert.equal((await h.invoke("get-update-state")).status, "error");
  h.app.quit();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.updateCalls.installs, 1);
  assert.equal(h.app.quitCompleted, 1);
});

test("cancel-close invalidates an asynchronous install acknowledgement before it can quit", async (t) => {
  const h = await updateHarness(t);
  let acknowledge;
  h.adapter.install = () =>
    new Promise((resolve) => {
      acknowledge = resolve;
    });
  await h.invoke("install-update");
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  h.ipcMain.emit("desktop:cancel-close", h.event);
  acknowledge();
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 0);
  assert.equal((await h.invoke("get-update-state")).status, "available");
});

test("closing the macOS window leaves later Cmd+Q functional", async (t) => {
  const h = await updateHarness(t);
  h.window.close();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 0);
  assert.equal(
    h.calls.commands
      .filter(({ channel }) => channel === "desktop:update-state")
      .at(-1).value.status,
    "available",
  );
  h.app.quit();
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 1);
});

test("reopening the macOS window clears close finalization and permits another saved quit", async (t) => {
  const h = await updateHarness(t);
  h.window.close();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  h.app.emit("activate");
  const reopened = h.calls.window;
  assert.notEqual(reopened, h.window);
  const event = {
    sender: reopened.webContents,
    senderFrame: reopened.webContents.mainFrame,
  };
  await h.handlers.get("desktop:take-pending-files")(event);
  h.app.quit();
  h.ipcMain.emit("desktop:confirm-close", event);
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 1);
});

test("failed asynchronous NSIS spawn blocks only the updater's stale quit, preserving later normal quit", async (t) => {
  const updater = new EventEmitter();
  const quitEvents = new EventEmitter();
  let application;
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "0.8.0" });
    return { cancellationToken: { cancel() {} } };
  };
  updater.downloadUpdate = async () => {
    updater.emit("update-downloaded", { version: "0.8.0" });
    return ["installer.exe"];
  };
  updater.quitAndInstall = () => {
    queueMicrotask(() => updater.emit("error", new Error("NSIS spawn failed")));
    setImmediate(() => {
      quitEvents.emit("before-quit-for-update");
      application.quit();
    });
  };
  const h = await harness(t, {
    platform: "win32",
    isPackaged: true,
    updateAdapter: (options) =>
      require("./update-windows.cjs").createWindowsUpdateAdapter({
        ...options,
        updater,
        quitEvents,
      }),
  });
  application = h.app;
  await h.invoke("take-pending-files");
  await h.invoke("check-for-updates");
  await h.invoke("download-update");
  await h.invoke("install-update");
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 0);
  assert.equal((await h.invoke("get-update-state")).status, "error");
  h.app.quit();
  h.ipcMain.emit("desktop:confirm-close", h.event);
  await flushUpdates();
  assert.equal(h.app.quitCompleted, 1);
});
