const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 32;
const DEFAULT_TIMEOUT = 30000;
const HOST_PATH = path.join(__dirname, "plugin-runtime-host.html");
const HOST_URL = pathToFileURL(HOST_PATH).href;
const SCRIPT_URL = pathToFileURL(
  path.join(__dirname, "plugin-runtime-host.js"),
).href;

const messageError = (error) =>
  String(error?.message || error || "Plugin failed").slice(0, 1000);
const errorDetails = (error) => ({
  message: messageError(error),
  ...(typeof error?.code === "string"
    ? { code: error.code.slice(0, 128) }
    : {}),
});
const errorFromDetails = (details) => {
  const error = new Error(messageError(details));
  if (typeof details?.code === "string")
    error.code = details.code.slice(0, 128);
  return error;
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

function jsonValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    if (value === undefined) return undefined;
    throw new Error("Plugin messages must contain JSON values");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Plugin message exceeds 2 MiB");
  }
  return JSON.parse(serialized);
}

function validatePackage(pkg) {
  if (
    !isRecord(pkg) ||
    !isRecord(pkg.manifest) ||
    pkg.manifest.apiVersion !== 1 ||
    !validId(pkg.manifest.id) ||
    !Array.isArray(pkg.manifest.commands) ||
    typeof pkg.source !== "string" ||
    Buffer.byteLength(pkg.source, "utf8") > MAX_SOURCE_BYTES
  ) {
    throw new Error("Invalid plugin package or source exceeds 256 KiB");
  }
  const commands = pkg.manifest.commands.map((command) => {
    if (!isRecord(command) || !validId(command.id)) {
      throw new Error("Invalid plugin command declaration");
    }
    return command.id;
  });
  if (new Set(commands).size !== commands.length) {
    throw new Error("Duplicate plugin command declaration");
  }
  jsonValue({ commands, source: pkg.source });
  return commands;
}

class UserPluginRuntime {
  constructor({
    BrowserWindow,
    session,
    ipcMain,
    onCall,
    onError = () => {},
    timeoutMs = DEFAULT_TIMEOUT,
  }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Invalid plugin timeout");
    }
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.ipcMain = ipcMain;
    this.onCall = onCall;
    this.onError = onError;
    this.timeoutMs = timeoutMs;
    this.active = null;
  }

  start(pkg) {
    if (this.active) return Promise.reject(new Error("Plugin already started"));
    let commands;
    try {
      commands = validatePackage(pkg);
    } catch (error) {
      return Promise.reject(error);
    }
    const nonce = randomUUID();
    const active = {
      channel: `guzi:user-plugin:${nonce}`,
      commands: new Set(commands),
      source: pkg.source,
      ready: false,
      initialized: false,
      window: null,
      calls: new Map(),
      pending: new Map(),
      queue: [],
      running: null,
      sequence: 0,
      heartbeatInterval: Math.min(1000, Math.max(10, this.timeoutMs / 4)),
    };
    this.active = active;
    const started = new Promise((resolve, reject) => {
      active.resolveStart = resolve;
      active.rejectStart = reject;
    });
    active.startTimer = setTimeout(
      () => this.fail(active, new Error("Plugin startup timed out")),
      this.timeoutMs,
    );
    try {
      const isolatedSession = this.session.fromPartition(
        `guzi-user-plugin-${nonce}`,
        { cache: false },
      );
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setPermissionRequestHandler(
        (_contents, _name, callback) => callback(false),
      );
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.setDisplayMediaRequestHandler((_request, callback) =>
        callback({}),
      );
      isolatedSession.on("will-download", (event) => event.preventDefault());
      isolatedSession.webRequest.onBeforeRequest(
        { urls: ["<all_urls>"] },
        (details, callback) => {
          const ownContents = active.window?.webContents;
          const allowed =
            this.active === active &&
            ownContents &&
            details.webContentsId === ownContents.id &&
            ((details.url === HOST_URL &&
              details.resourceType === "mainFrame") ||
              (details.url === SCRIPT_URL &&
                details.resourceType === "script"));
          callback({ cancel: !allowed });
        },
      );
      const window = new this.BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          session: isolatedSession,
          preload: path.join(__dirname, "../preload/plugin-runtime.cjs"),
          additionalArguments: [`--guzi-user-plugin-channel=${active.channel}`],
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          backgroundThrottling: false,
          webviewTag: false,
          navigateOnDragDrop: false,
          devTools: false,
          spellcheck: false,
        },
      });
      active.window = window;
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const eventName of [
        "will-navigate",
        "will-frame-navigate",
        "will-redirect",
        "will-attach-webview",
      ]) {
        contents.on(eventName, (event) => event.preventDefault());
      }
      contents.on("render-process-gone", (_event, details) =>
        this.fail(
          active,
          new Error(`Plugin renderer exited: ${details.reason || "unknown"}`),
        ),
      );
      window.on("unresponsive", () =>
        this.fail(active, new Error("Plugin renderer is unresponsive")),
      );
      window.on("closed", () =>
        this.fail(active, new Error("Plugin runtime window closed")),
      );
      active.listener = (event, message) => {
        if (
          this.active !== active ||
          event.sender !== contents ||
          event.senderFrame !== contents.mainFrame ||
          event.senderFrame?.url !== HOST_URL
        ) {
          return;
        }
        this.receive(active, message);
      };
      this.ipcMain.on(active.channel, active.listener);
      Promise.resolve(window.loadFile(HOST_PATH)).catch((error) =>
        this.fail(active, error),
      );
    } catch (error) {
      this.fail(active, error);
    }
    return started;
  }

  send(active, message) {
    if (this.active === active && !active.window.isDestroyed()) {
      active.window.webContents.send(active.channel, message);
    }
  }

  receive(active, input) {
    let message;
    try {
      message = jsonValue(input);
      if (!isRecord(message)) throw new Error("Invalid plugin message");
    } catch (error) {
      this.fail(active, error);
      return;
    }
    if (message.type === "host-ready" && !active.initialized) {
      active.initialized = true;
      this.send(active, {
        type: "initialize",
        source: active.source,
        commands: [...active.commands],
        heartbeatInterval: active.heartbeatInterval,
      });
      active.source = null;
    } else if (message.type === "ready" && !active.ready) {
      if (
        !active.initialized ||
        !Array.isArray(message.commands) ||
        message.commands.length !== active.commands.size ||
        new Set(message.commands).size !== active.commands.size ||
        message.commands.some((command) => !active.commands.has(command))
      ) {
        this.fail(
          active,
          new Error("Plugin did not register all declared commands"),
        );
        return;
      }
      active.ready = true;
      clearTimeout(active.startTimer);
      active.lastHeartbeat = Date.now();
      active.watchdog = setInterval(() => {
        if (Date.now() - active.lastHeartbeat > this.timeoutMs) {
          this.fail(active, new Error("Plugin heartbeat timed out"));
        }
      }, active.heartbeatInterval);
      active.resolveStart();
    } else if (message.type === "heartbeat" && active.ready) {
      active.lastHeartbeat = Date.now();
    } else if (message.type === "fatal") {
      this.fail(active, errorFromDetails(message.error));
    } else if (message.type === "result" && active.ready) {
      const pending = active.pending.get(message.id);
      if (!pending || active.running !== message.id) return;
      clearTimeout(pending.timer);
      active.pending.delete(message.id);
      active.running = null;
      if (message.error) pending.reject(errorFromDetails(message.error));
      else pending.resolve(message.result);
      this.drain(active);
    } else if (message.type === "call" && active.initialized) {
      this.call(active, message);
    }
  }

  call(active, message) {
    const reply = (response) => {
      let result = { type: "call-result", id: message.id, ...response };
      try {
        result = jsonValue(result);
      } catch (error) {
        result = {
          type: "call-result",
          id: message.id,
          error: errorDetails(error),
        };
      }
      this.send(active, result);
    };
    if (
      !validId(message.id) ||
      !validId(message.command) ||
      !isRecord(message.arguments) ||
      active.calls.has(message.id) ||
      active.calls.size >= MAX_PENDING
    ) {
      reply({
        error: {
          message: "Invalid plugin request or too many pending requests",
        },
      });
      return;
    }
    const controller = new AbortController();
    const call = { controller };
    active.calls.set(message.id, call);
    call.timer = setTimeout(() => {
      if (active.calls.get(message.id) !== call) return;
      active.calls.delete(message.id);
      controller.abort();
      reply({
        error: { message: "Plugin request timed out", code: "TIMEOUT" },
      });
    }, this.timeoutMs);
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new Error("Plugin stopped");
        return this.onCall(
          message.command,
          message.arguments,
          controller.signal,
        );
      })
      .then(
        (result) => {
          if (this.active !== active || active.calls.get(message.id) !== call) {
            return;
          }
          reply({ result });
        },
        (error) => {
          if (this.active === active && active.calls.get(message.id) === call) {
            reply({ error: errorDetails(error) });
          }
        },
      )
      .finally(() => {
        clearTimeout(call.timer);
        if (active.calls.get(message.id) === call) {
          active.calls.delete(message.id);
        }
      });
  }

  run(commandId, args = {}) {
    const active = this.active;
    if (!active?.ready)
      return Promise.reject(new Error("Plugin is not running"));
    if (!active.commands.has(commandId)) {
      return Promise.reject(new Error("Undeclared plugin command"));
    }
    if (active.pending.size >= MAX_PENDING) {
      return Promise.reject(new Error("Too many pending plugin commands"));
    }
    let argumentsValue;
    try {
      if (!isRecord(args))
        throw new Error("Plugin command arguments must be an object");
      argumentsValue = jsonValue({
        type: "run",
        id: `command-${active.sequence + 1}`,
        commandId,
        arguments: args,
      }).arguments;
      if (!isRecord(argumentsValue)) {
        throw new Error("Plugin command arguments must be an object");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const id = `command-${++active.sequence}`;
      active.pending.set(id, {
        commandId,
        arguments: argumentsValue,
        resolve,
        reject,
      });
      active.queue.push(id);
      this.drain(active);
    });
  }

  drain(active) {
    if (this.active !== active || active.running || !active.queue.length)
      return;
    const id = active.queue.shift();
    const pending = active.pending.get(id);
    active.running = id;
    pending.timer = setTimeout(
      () => this.fail(active, new Error("Plugin command timed out")),
      this.timeoutMs,
    );
    this.send(active, {
      type: "run",
      id,
      commandId: pending.commandId,
      arguments: pending.arguments,
    });
  }

  fail(active, error) {
    if (this.active !== active) return;
    const failure =
      error instanceof Error ? error : new Error(messageError(error));
    this.stop(failure);
    this.onError(failure);
  }

  stop(error = new Error("Plugin stopped")) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    clearTimeout(active.startTimer);
    clearInterval(active.watchdog);
    if (active.listener) {
      this.ipcMain.removeListener(active.channel, active.listener);
    }
    active.rejectStart(error);
    for (const pending of active.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    active.pending.clear();
    active.queue.length = 0;
    for (const call of active.calls.values()) {
      clearTimeout(call.timer);
      call.controller.abort();
    }
    active.calls.clear();
    if (active.window && !active.window.isDestroyed()) active.window.destroy();
    active.window = null;
    active.source = null;
  }
}

module.exports = { UserPluginRuntime, MAX_SOURCE_BYTES, MAX_MESSAGE_BYTES };
