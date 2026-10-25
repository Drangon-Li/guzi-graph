const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const {
  UserPluginRuntime,
  MAX_SOURCE_BYTES,
  MAX_MESSAGE_BYTES,
} = require("./user-plugin-runtime.cjs");

const HOST_URL = pathToFileURL(
  path.join(__dirname, "plugin-runtime-host.html"),
).href;
const PACKAGE = {
  manifest: {
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["canvas.read"],
    commands: [{ id: "sample.read", title: "Read" }],
  },
  source: 'guzi.registerCommand("sample.read", () => ({ ok: true }));',
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, overrides = {}) {
  const ipcMain = new EventEmitter();
  const windows = [];
  const sessions = [];
  const errors = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length + 1;
      this.webContents.mainFrame = { url: HOST_URL };
      this.webContents.messages = [];
      this.webContents.send = (channel, message) =>
        this.webContents.messages.push({ channel, message });
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      windows.push(this);
    }
    loadFile(file) {
      this.loadedFile = file;
      return Promise.resolve();
    }
    isDestroyed() {
      return Boolean(this.destroyed);
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const session = {
    fromPartition(partition, options) {
      const instance = new EventEmitter();
      Object.assign(instance, {
        partition,
        options,
        setPermissionCheckHandler(handler) {
          this.permissionCheck = handler;
        },
        setPermissionRequestHandler(handler) {
          this.permissionRequest = handler;
        },
        setDevicePermissionHandler(handler) {
          this.devicePermission = handler;
        },
        setDisplayMediaRequestHandler(handler) {
          this.displayMedia = handler;
        },
        webRequest: {
          onBeforeRequest(filter, handler) {
            instance.filter = filter;
            instance.beforeRequest = handler;
          },
        },
      });
      sessions.push(instance);
      return instance;
    },
  };
  const runtime = new UserPluginRuntime({
    BrowserWindow,
    session,
    ipcMain,
    onCall: async () => ({ value: true }),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  t.after(() => runtime.stop());
  const send = (message, event = {}) => {
    const window = windows.at(-1);
    const channel = window.options.webPreferences.additionalArguments[0].slice(
      "--guzi-user-plugin-channel=".length,
    );
    ipcMain.emit(
      channel,
      {
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
        ...event,
      },
      message,
    );
  };
  const ready = async () => {
    const started = runtime.start(PACKAGE);
    send({ type: "host-ready" });
    send({ type: "ready", commands: ["sample.read"] });
    await started;
  };
  return { runtime, windows, sessions, ipcMain, errors, send, ready };
}

test("each runtime owns a sandboxed hidden window, private session, and narrow file allowlist", async (t) => {
  const { runtime, windows, sessions, send } = fixture(t);
  const started = runtime.start(PACKAGE);
  const [window] = windows;
  const [session] = sessions;
  const preferences = window.options.webPreferences;
  assert.equal(window.options.show, false);
  assert.equal(preferences.session, session);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInWorker, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.backgroundThrottling, false);
  assert.equal(preferences.webviewTag, false);
  assert.equal(preferences.devTools, false);
  assert.equal(
    preferences.preload,
    path.join(__dirname, "..", "preload", "plugin-runtime.cjs"),
  );
  assert.equal(session.partition.startsWith("persist:"), false);
  assert.equal(session.options.cache, false);
  assert.equal(session.permissionCheck(), false);
  assert.equal(session.devicePermission(), false);
  session.permissionRequest(null, "media", (allowed) =>
    assert.equal(allowed, false),
  );
  session.displayMedia({}, (streams) => assert.deepEqual(streams, {}));
  assert.deepEqual(window.openHandler(), { action: "deny" });
  for (const name of [
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
    "will-attach-webview",
  ]) {
    let prevented = false;
    window.webContents.emit(name, { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, name);
  }
  let prevented = false;
  session.emit("will-download", { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  const requests = [
    [HOST_URL, "mainFrame", window.webContents.id, false],
    [HOST_URL.replace(".html", ".js"), "script", window.webContents.id, false],
    [HOST_URL, "script", window.webContents.id, true],
    [HOST_URL, "mainFrame", 999, true],
    ["file:///etc/passwd", "xhr", window.webContents.id, true],
    ["https://example.com/", "xhr", window.webContents.id, true],
    ["http://127.0.0.1:43123/", "xhr", window.webContents.id, true],
  ];
  for (const [url, resourceType, webContentsId, cancel] of requests) {
    session.beforeRequest({ url, resourceType, webContentsId }, (result) =>
      assert.equal(result.cancel, cancel, url),
    );
  }
  send({ type: "host-ready" });
  assert.equal(window.webContents.messages[0].message.source, PACKAGE.source);
  send({ type: "ready", commands: ["sample.read"] });
  await started;
  runtime.stop();
  const restarted = runtime.start(PACKAGE);
  send({ type: "host-ready" });
  send({ type: "ready", commands: ["sample.read"] });
  await restarted;
  assert.notEqual(sessions[0].partition, sessions[1].partition);
});

test("IPC rejects foreign senders, subframes, wrong URLs and incomplete registration", async (t) => {
  const { runtime, windows, send, errors, ipcMain } = fixture(t);
  const started = runtime.start(PACKAGE);
  const rejected = assert.rejects(started, /register all declared/);
  const window = windows[0];
  send({ type: "host-ready" }, { sender: {} });
  send({ type: "host-ready" }, { senderFrame: { url: HOST_URL } });
  window.webContents.mainFrame.url = "https://example.com";
  send({ type: "host-ready" });
  assert.equal(window.webContents.messages.length, 0);
  window.webContents.mainFrame.url = HOST_URL;
  send({ type: "host-ready" });
  send({ type: "ready", commands: ["undeclared"] });
  await rejected;
  assert.equal(window.destroyed, true);
  assert.equal(ipcMain.eventNames().length, 0);
  assert.equal(errors.length, 1);
});

test("commands execute serially with a bounded queue and return values or errors", async (t) => {
  const { runtime, windows, send, ready } = fixture(t);
  await ready();
  await assert.rejects(runtime.run("other.command"), /Undeclared/);
  const first = runtime.run("sample.read", { documentId: "example" });
  const second = runtime.run("sample.read");
  const messages = windows[0].webContents.messages;
  assert.equal(
    messages.filter(({ message }) => message.type === "run").length,
    1,
  );
  assert.deepEqual(messages.at(-1).message.arguments, {
    documentId: "example",
  });
  await assert.rejects(
    runtime.run("sample.read", []),
    /arguments must be an object/,
  );
  await assert.rejects(
    runtime.run("sample.read", { text: "x".repeat(MAX_MESSAGE_BYTES) }),
    /exceeds/,
  );
  send({ type: "result", id: "command-999", result: "ignored" });
  send({ type: "result", id: "command-1", result: { answer: 42 } });
  assert.deepEqual(await first, { answer: 42 });
  assert.equal(messages.at(-1).message.id, "command-2");
  send({
    type: "result",
    id: "command-2",
    error: { message: "handler failed", code: "CONFLICT" },
  });
  await assert.rejects(second, { message: "handler failed", code: "CONFLICT" });
  const queued = Array.from({ length: 32 }, () => runtime.run("sample.read"));
  const results = Promise.allSettled(queued);
  await assert.rejects(runtime.run("sample.read"), /Too many pending/);
  runtime.stop();
  assert.equal(
    (await results).every((result) => result.status === "rejected"),
    true,
  );
});

test("stop aborts active SDK calls and discards late replies and queued requests", async (t) => {
  let signal;
  let complete;
  const calls = [];
  const { runtime, windows, send, ready, ipcMain } = fixture(t, {
    onCall(command, args, requestSignal) {
      calls.push({ command, args });
      signal = requestSignal;
      return new Promise((resolve) => (complete = resolve));
    },
  });
  await ready();
  send({
    type: "call",
    id: "storage-1",
    command: "storage.get",
    arguments: { key: "count" },
  });
  await turn();
  assert.deepEqual(calls, [{ command: "storage.get", args: { key: "count" } }]);
  assert.equal(signal.aborted, false);
  const pending = runtime.run("sample.read");
  const rejected = assert.rejects(pending, /stopped/);
  const count = windows[0].webContents.messages.length;
  runtime.stop();
  assert.equal(signal.aborted, true);
  assert.equal(windows[0].destroyed, true);
  assert.equal(ipcMain.eventNames().length, 0);
  complete({ late: true });
  send({ type: "call", id: "late", command: "read_canvas", arguments: {} });
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(windows[0].webContents.messages.length, count);
  await rejected;
});

test("stop before an SDK dispatch prevents even the onCall invocation", async (t) => {
  let calls = 0;
  const { runtime, send, ready } = fixture(t, {
    onCall() {
      calls++;
    },
  });
  await ready();
  send({ type: "call", id: "one", command: "read_canvas", arguments: {} });
  runtime.stop();
  await turn();
  assert.equal(calls, 0);
});

test("SDK replies retain host error codes", async (t) => {
  const { windows, send, ready } = fixture(t, {
    onCall: async () => {
      const error = new Error("Canvas access denied");
      error.code = "PERMISSION_DENIED";
      throw error;
    },
  });
  await ready();
  send({ type: "call", id: "one", command: "read_canvas", arguments: {} });
  await turn();
  assert.deepEqual(windows[0].webContents.messages.at(-1).message.error, {
    message: "Canvas access denied",
    code: "PERMISSION_DENIED",
  });
});

test("SDK requests and results are size limited and pending requests are bounded", async (t) => {
  const { runtime, windows, send, ready } = fixture(t, {
    onCall: async (command) => {
      if (command === "large") return "x".repeat(MAX_MESSAGE_BYTES);
      return new Promise(() => {});
    },
  });
  await ready();
  send({ type: "call", id: "large", command: "large", arguments: {} });
  await turn();
  assert.match(
    windows[0].webContents.messages.at(-1).message.error.message,
    /exceeds 2 MiB/,
  );
  for (let index = 0; index < 33; index++) {
    send({
      type: "call",
      id: `call-${index}`,
      command: "read_canvas",
      arguments: {},
    });
  }
  assert.match(
    windows[0].webContents.messages.at(-1).message.error.message,
    /too many pending/,
  );
  runtime.stop();
  await assert.rejects(
    runtime.start({ ...PACKAGE, source: "中".repeat(MAX_SOURCE_BYTES) }),
    /256 KiB/,
  );
});

test("oversized worker messages stop the runtime before onCall", async (t) => {
  let called = false;
  const { send, ready, windows, errors } = fixture(t, {
    onCall() {
      called = true;
    },
  });
  await ready();
  send({
    type: "call",
    id: "large",
    command: "read_canvas",
    arguments: { text: "x".repeat(MAX_MESSAGE_BYTES) },
  });
  assert.equal(called, false);
  assert.equal(windows[0].destroyed, true);
  assert.match(errors[0].message, /exceeds 2 MiB/);
});

test("startup, command, heartbeat and renderer failures terminate the runtime", async (t) => {
  await t.test("startup", async (t) => {
    const { runtime, windows, errors } = fixture(t, { timeoutMs: 20 });
    await assert.rejects(runtime.start(PACKAGE), /startup timed out/);
    assert.equal(windows[0].destroyed, true);
    assert.equal(errors.length, 1);
  });
  await t.test("command", async (t) => {
    const { runtime, windows, errors, ready, send } = fixture(t, {
      timeoutMs: 25,
    });
    await ready();
    const heartbeat = setInterval(() => send({ type: "heartbeat" }), 5);
    t.after(() => clearInterval(heartbeat));
    await assert.rejects(runtime.run("sample.read"), /command timed out/);
    assert.equal(windows[0].destroyed, true);
    assert.equal(errors.length, 1);
  });
  await t.test("heartbeat", async (t) => {
    const { ready, windows, runtime } = fixture(t, { timeoutMs: 20 });
    await ready();
    await new Promise((resolve) => windows[0].once("closed", resolve));
    assert.equal(runtime.active, null);
  });
  await t.test("renderer", async (t) => {
    const { ready, windows, errors } = fixture(t);
    await ready();
    windows[0].webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );
    assert.equal(windows[0].destroyed, true);
    assert.match(errors[0].message, /crashed/);
  });
});

async function workerFixture(source) {
  const hostSource = fs.readFileSync(
    path.join(__dirname, "plugin-runtime-host.js"),
    "utf8",
  );
  const hostMessages = [];
  let deliver;
  let blob;
  let workerSource;
  let workerMessage;
  const workerMessages = [];
  const ownerWindow = {
    TextEncoder,
    pluginRuntimeHost: {
      send: (message) => hostMessages.push(message),
      onMessage: (callback) => {
        deliver = callback;
      },
    },
    URL: { createObjectURL: () => "blob:isolated", revokeObjectURL: () => {} },
    Blob: class {
      constructor(parts) {
        blob = parts.join("");
      }
    },
    Worker: class {
      constructor() {
        workerSource = blob;
      }
      addEventListener() {}
      terminate() {}
    },
  };
  vm.runInNewContext(hostSource, {
    document: {
      currentScript: { ownerDocument: { defaultView: ownerWindow } },
    },
  });
  assert.deepEqual(
    hostMessages.map(({ type }) => type),
    ["host-ready"],
  );
  deliver({
    type: "initialize",
    source,
    commands: ["sample.read"],
    heartbeatInterval: 1000,
  });
  const context = vm.createContext({
    TextEncoder,
    setInterval: () => 1,
    postMessage: (message) => workerMessages.push(message),
    addEventListener: (name, callback) => {
      if (name === "message") workerMessage = callback;
    },
  });
  vm.runInContext(workerSource, context);
  await turn();
  return {
    context,
    messages: workerMessages,
    receive: async (data) => {
      await workerMessage({ data });
    },
  };
}

test("plugin source executes only in a Worker with frozen SDK and supports top-level await", async () => {
  const { context, messages, receive } = await workerFixture(`
    await Promise.resolve();
    guzi.registerCommand("sample.read", () => ({
      frozen: Object.isFrozen(guzi) && Object.isFrozen(guzi.storage),
      node: typeof process,
      require: typeof require,
      dom: typeof document,
      bridge: typeof pluginRuntimeHost,
      network: typeof fetch,
      nestedWorker: typeof Worker,
    }));
  `);
  assert.equal(vm.runInContext("typeof guzi.call", context), "function");
  assert.equal(messages[0].type, "ready");
  await receive({ type: "run", id: "one", commandId: "sample.read" });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).result)), {
    frozen: true,
    node: "undefined",
    require: "undefined",
    dom: "undefined",
    bridge: "undefined",
    network: "undefined",
    nestedWorker: "undefined",
  });
});

test("Worker rejects missing or undeclared registration and bridges SDK storage as RPC", async () => {
  const missing = await workerFixture("await Promise.resolve();");
  assert.equal(missing.messages[0].type, "fatal");
  assert.match(missing.messages[0].error.message, /register all declared/);
  const undeclared = await workerFixture(
    'guzi.registerCommand("other", () => {});',
  );
  assert.equal(undeclared.messages[0].type, "fatal");
  assert.match(undeclared.messages[0].error.message, /Undeclared/);
  const worker = await workerFixture(`
    guzi.registerCommand("sample.read", async () => {
      const value = await guzi.storage.get("counter");
      await guzi.storage.set("counter", value + 1);
      return value;
    });
  `);
  const running = worker.receive({
    type: "run",
    id: "one",
    commandId: "sample.read",
  });
  await turn();
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages.at(-1))), {
    type: "call",
    id: "call-1",
    command: "storage.get",
    arguments: { key: "counter" },
  });
  await worker.receive({ type: "call-result", id: "call-1", result: 2 });
  assert.equal(worker.messages.at(-1).command, "storage.set");
  await worker.receive({ type: "call-result", id: "call-2", result: null });
  await running;
  assert.equal(worker.messages.at(-1).result, 2);
});

test("Worker passes command arguments and preserves RPC error codes through handler rejection", async () => {
  const worker = await workerFixture(`
    guzi.registerCommand("sample.read", (args) => guzi.call("read_canvas", args));
  `);
  const running = worker.receive({
    type: "run",
    id: "one",
    commandId: "sample.read",
    arguments: { documentId: "drawing" },
  });
  await turn();
  assert.deepEqual(
    JSON.parse(JSON.stringify(worker.messages.at(-1).arguments)),
    {
      documentId: "drawing",
    },
  );
  await worker.receive({
    type: "call-result",
    id: "call-1",
    error: { message: "Revision changed", code: "REVISION_CONFLICT" },
  });
  await running;
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages.at(-1).error)), {
    message: "Revision changed",
    code: "REVISION_CONFLICT",
  });
});

test("runtime CSP permits only its static script and Blob worker", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "plugin-runtime-host.html"),
    "utf8",
  );
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /worker-src blob:/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.doesNotMatch(html, /unsafe-eval|unsafe-inline/);
});

test("isolated preload exposes no desktop bridge, limits messages and strips Electron events", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../preload/plugin-runtime.cjs"),
    "utf8",
  );
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (channel, value) => sent.push({ channel, value });
  const exposed = {};
  const channel = "guzi:user-plugin:12345678-1234-1234-1234-123456789abc";
  vm.runInNewContext(source, {
    process: { argv: [`--guzi-user-plugin-channel=${channel}`] },
    Buffer,
    require: (name) => {
      assert.equal(name, "electron");
      return {
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (name, value) => (exposed[name] = value),
        },
      };
    },
  });
  assert.deepEqual(Object.keys(exposed), ["pluginRuntimeHost"]);
  const bridge = exposed.pluginRuntimeHost;
  assert.deepEqual(Object.keys(bridge).sort(), ["onMessage", "send"]);
  bridge.send({ type: "heartbeat" });
  assert.equal(sent[0].channel, channel);
  assert.throws(
    () => bridge.send({ text: "x".repeat(MAX_MESSAGE_BYTES) }),
    /exceeds/,
  );
  let received;
  bridge.onMessage((...args) => {
    received = args;
  });
  ipc.emit(channel, { privileged: true }, { type: "initialize" });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "initialize");
  assert.throws(() => bridge.onMessage(() => {}), /subscription/);
});
