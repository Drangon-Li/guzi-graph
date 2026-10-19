const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

async function harness(t, { developmentURL, argv = [] } = {}) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-main-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "dist"));
  await fs.writeFile(path.join(base, "dist", "index.html"), "<html></html>");
  const app = new EventEmitter();
  app.name = "Excalidraw Local";
  app.isPackaged = false;
  app.requestSingleInstanceLock = () => true;
  app.isReady = () => true;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => path.join(base, "userData");
  app.setPath = () => {};
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
  const calls = { commands: [], exports: [], errors: [] };
  const handlers = new Map();
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
      this.webContents.sendInputEvent = () => {};
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
    ipcMain,
    protocol,
    session: { defaultSession: browserSession },
    dialog: {
      showSaveDialog: async () => calls.saveResult || { canceled: true },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
    shell: { showItemInFolder: () => {} },
  };
  const source = await fs.readFile(path.join(__dirname, "main.cjs"), "utf8");
  vm.runInNewContext(
    source,
    {
      require: (name) =>
        name === "electron"
          ? electron
          : name === "./storage.cjs"
          ? require("./storage.cjs")
          : require(name),
      __dirname: path.join(base, "electron"),
      process: {
        env: {
          EXCALIDRAW_DESKTOP_USER_DATA: path.join(base, "userData"),
          ...(developmentURL
            ? { EXCALIDRAW_DESKTOP_DEV_URL: developmentURL }
            : {}),
        },
        argv: ["electron", ...argv],
        platform: "darwin",
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
  };
}

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
    assert.equal(item.accelerator, undefined);
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
