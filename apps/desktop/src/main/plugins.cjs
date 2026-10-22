const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { atomicWrite } = require("./storage.cjs");

const COMMANDS = new Set([
  "get_capabilities",
  "list_canvases",
  "create_canvas",
  "open_canvas",
  "close_document",
  "control_canvas",
  "read_canvas",
  "apply_operations",
  "export_canvas",
  "save_canvas",
  "create_presentation",
  "read_presentation",
  "update_presentation",
  "control_presentation",
  "export_presentation",
  "save_presentation",
]);
const BUILTIN_PLUGINS = [
  {
    id: "mcp",
    name: "Guzi MCP",
    version: "1.0.0",
    description: "通过本机 MCP 服务读取、编辑和导出 Guzi 画布与演示文稿。",
    commands: [...COMMANDS],
    defaultPort: 43123,
    entrypoint: path.join(__dirname, "mcp-service.cjs"),
  },
];
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT = 30000;
const validPort = (port) =>
  Number.isInteger(port) && port >= 1024 && port <= 65535;
const failure = (code, message) => ({ code, message });

class PluginHost {
  constructor({
    userData,
    fork,
    send,
    requestTimeout = REQUEST_TIMEOUT,
    stopTimeout = 3000,
    registry = BUILTIN_PLUGINS,
  }) {
    this.configPath = path.join(userData, "plugins.json");
    this.fork = fork;
    this.send = send;
    this.requestTimeout = requestTimeout;
    this.stopTimeout = stopTimeout;
    this.ready = false;
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.runtimes = new Map(
      registry.map((manifest) => [
        manifest.id,
        {
          manifest,
          child: null,
          stopping: null,
          stoppingChild: false,
          state: {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            capabilities: [...manifest.commands],
            enabled: false,
            status: "disabled",
            port: manifest.defaultPort,
            token: randomBytes(32).toString("hex"),
          },
        },
      ]),
    );
  }

  async initialize() {
    let configuration;
    let missing = false;
    try {
      configuration = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      if (
        configuration?.version !== 1 ||
        !configuration.plugins ||
        typeof configuration.plugins !== "object" ||
        Array.isArray(configuration.plugins)
      ) {
        throw new Error("Invalid plugin configuration");
      }
      for (const [id, runtime] of this.runtimes) {
        const saved = configuration.plugins[id];
        if (!saved) continue;
        if (
          typeof saved.enabled !== "boolean" ||
          !validPort(saved.port) ||
          typeof saved.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(saved.token)
        ) {
          throw new Error("Invalid plugin configuration");
        }
        runtime.state.enabled = saved.enabled;
        runtime.state.port = saved.port;
        runtime.state.token = saved.token;
      }
    } catch (error) {
      if (error.code === "ENOENT") missing = true;
      else {
        this.configurationError =
          "插件配置损坏或无法读取；请修复或移走 plugins.json 后重启应用。";
        for (const runtime of this.runtimes.values()) {
          runtime.state.enabled = false;
          runtime.state.status = "error";
          runtime.state.error = this.configurationError;
        }
        return this;
      }
    }
    for (const { state } of this.runtimes.values())
      state.status = state.enabled ? "starting" : "disabled";
    if (missing) {
      try {
        await this.persist();
      } catch {
        this.configurationError = "插件配置无法保存，请检查应用数据目录权限。";
        for (const { state } of this.runtimes.values()) {
          state.status = "error";
          state.error = this.configurationError;
        }
      }
    }
    return this;
  }

  list() {
    return [...this.runtimes.values()].map(({ state }) => ({
      ...state,
      capabilities: [...state.capabilities],
    }));
  }
  emit() {
    this.send("plugin-state", this.list());
  }
  async persist() {
    if (this.configurationError) throw new Error(this.configurationError);
    const plugins = Object.fromEntries(
      [...this.runtimes].map(
        ([
          id,
          {
            state: { enabled, port, token },
          },
        ]) => [id, { enabled, port, token }],
      ),
    );
    await atomicWrite(this.configPath, JSON.stringify({ version: 1, plugins }));
    await fs.chmod(this.configPath, 0o600);
  }
  serialize(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  runtime(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error("未知插件。");
    return runtime;
  }

  setEnabled(id, enabled) {
    const runtime = this.runtime(id);
    if (typeof enabled !== "boolean") throw new Error("插件状态无效。");
    return this.serialize(async () => {
      if (this.configurationError) throw new Error(this.configurationError);
      if (runtime.state.enabled === enabled) return this.list();
      const previous = runtime.state.enabled;
      runtime.state.enabled = enabled;
      try {
        await this.persist();
      } catch (error) {
        runtime.state.enabled = previous;
        throw error;
      }
      if (enabled) await this.start(runtime);
      else await this.stop(runtime);
      this.emit();
      return this.list();
    });
  }

  configure(id, configuration) {
    const runtime = this.runtime(id);
    if (
      !configuration ||
      Object.keys(configuration).some((key) => key !== "port") ||
      !validPort(configuration.port)
    ) {
      throw new Error("端口必须是 1024 到 65535 的整数。");
    }
    return this.serialize(async () => {
      if (this.configurationError) throw new Error(this.configurationError);
      if (runtime.state.port === configuration.port) return this.list();
      const previous = runtime.state.port;
      runtime.state.port = configuration.port;
      try {
        await this.persist();
      } catch (error) {
        runtime.state.port = previous;
        throw error;
      }
      await this.stop(runtime);
      await this.start(runtime);
      this.emit();
      return this.list();
    });
  }

  setReady(ready) {
    if (typeof ready !== "boolean") throw new Error("插件工作区状态无效。");
    this.ready = ready;
    // Cancel synchronously before renderer initialization can resume.
    if (!ready)
      for (const runtime of this.runtimes.values())
        this.cancelRequests(runtime);
    return this.serialize(async () => {
      await Promise.all(
        [...this.runtimes.values()].map((runtime) =>
          ready ? this.start(runtime) : this.stop(runtime),
        ),
      );
      this.emit();
    });
  }

  async start(runtime) {
    if (this.configurationError || !this.ready || !runtime.state.enabled)
      return;
    if (runtime.stopping) await runtime.stopping;
    if (runtime.child) return;
    const { state, manifest } = runtime;
    state.status = "starting";
    delete state.error;
    try {
      const child = this.fork(manifest.entrypoint, [], {
        stdio: "ignore",
        serviceName: manifest.name,
      });
      runtime.child = child;
      runtime.stoppingChild = false;
      runtime.startupTimer = setTimeout(() => {
        if (runtime.child === child && state.status === "starting") {
          void this.stop(runtime).then(() => {
            state.status = "error";
            state.error = "插件服务启动超时。";
            this.emit();
          });
        }
      }, 15000);
      runtime.startupTimer.unref?.();
      child.on("message", (message) => {
        if (runtime.child !== child || runtime.stoppingChild) return;
        if (message?.type === "ready") {
          clearTimeout(runtime.startupTimer);
          state.status = "running";
          state.endpoint = `http://127.0.0.1:${state.port}/mcp`;
          this.emit();
        } else if (message?.type === "error") {
          void this.stop(runtime).then(() => {
            state.status = "error";
            state.error =
              message.code === "EADDRINUSE"
                ? "端口已被占用，请修改 MCP 端口。"
                : "插件服务启动失败。";
            this.emit();
          });
        } else if (message?.type === "request") this.forward(runtime, message);
      });
      child.on("exit", () => {
        clearTimeout(runtime.startupTimer);
        if (runtime.child !== child) return;
        runtime.child = null;
        delete state.endpoint;
        this.cancelRequests(runtime);
        runtime.resolveExit?.();
        if (!runtime.stoppingChild) {
          state.status = "error";
          state.error = "插件服务已退出。";
          this.emit();
        }
      });
      child.postMessage({
        type: "initialize",
        port: state.port,
        token: state.token,
      });
    } catch {
      await this.stop(runtime);
      state.status = "error";
      state.error = "无法启动插件独立进程。";
    }
  }

  cancelRequests(runtime) {
    for (const [requestId, pending] of this.pending) {
      if (pending.runtime !== runtime) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      this.send("plugin-request-cancelled", requestId);
      runtime.child?.postMessage({
        type: "response",
        requestId,
        error: failure("HOST_UNAVAILABLE", "画布工作区已关闭或重新加载。"),
      });
    }
  }

  stop(runtime) {
    if (!runtime)
      return Promise.all(
        [...this.runtimes.values()].map((item) => this.stop(item)),
      );
    if (runtime.stopping) return runtime.stopping;
    clearTimeout(runtime.startupTimer);
    this.cancelRequests(runtime);
    delete runtime.state.endpoint;
    if (this.configurationError) return Promise.resolve();
    delete runtime.state.error;
    runtime.state.status = runtime.state.enabled ? "starting" : "disabled";
    if (!runtime.child) return Promise.resolve();
    runtime.stoppingChild = true;
    const child = runtime.child;
    runtime.stopping = new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtime.state.status = "error";
        runtime.state.error = "插件进程尚未退出，请重启应用。";
        this.emit();
        resolve();
      }, this.stopTimeout);
      timer.unref?.();
      runtime.resolveExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.kill();
    }).finally(() => {
      runtime.stopping = null;
      runtime.resolveExit = null;
    });
    return runtime.stopping;
  }

  forward(runtime, message) {
    const { requestId, command, arguments: args } = message;
    if (
      typeof requestId !== "string" ||
      requestId.length > 100 ||
      this.pending.has(requestId)
    )
      return;
    const reject = (code, text) =>
      runtime.child?.postMessage({
        type: "response",
        requestId,
        error: failure(code, text),
      });
    if (!this.ready || runtime.stoppingChild)
      return reject("HOST_UNAVAILABLE", "画布工作区尚未就绪。");
    if (
      !runtime.manifest.commands.includes(command) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > MAX_MESSAGE_BYTES
    )
      return reject("INVALID_ARGUMENTS", "命令参数无效或过大。");
    if (this.pending.size >= 32) return reject("BUSY", "待处理请求过多。");
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      this.send("plugin-request-cancelled", requestId);
      reject("TIMEOUT", "画布操作超时；请读取画布确认结果后再重试写操作。");
    }, this.requestTimeout);
    timer.unref?.();
    this.pending.set(requestId, { runtime, timer });
    this.send("plugin-request", {
      requestId,
      command,
      arguments: args,
      expiresAt: Date.now() + this.requestTimeout,
    });
  }

  respond(response) {
    if (!response || typeof response.requestId !== "string") return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (Buffer.byteLength(JSON.stringify(response)) > 24 * 1024 * 1024) {
      response = {
        requestId: response.requestId,
        error: failure("RESULT_TOO_LARGE", "操作结果过大。"),
      };
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.runtime.child?.postMessage({ ...response, type: "response" });
  }
}

module.exports = { PluginHost, BUILTIN_PLUGINS, COMMANDS, MAX_MESSAGE_BYTES };
