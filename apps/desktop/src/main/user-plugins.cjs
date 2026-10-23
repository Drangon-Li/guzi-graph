const { z } = require("zod/v4");
const { toolSchemas } = require("./mcp-service.cjs");
const { validatePluginPackage } = require("./user-plugin-store.cjs");
const {
  PLUGIN_COMMAND_PERMISSIONS,
  getPluginDevelopmentGuide,
  getPluginApiSchema,
} = require("./plugin-development.cjs");

const pluginError = (code, message) =>
  Object.assign(new Error(message), { code });

class UserPlugins {
  constructor({ store, createRuntime, execute, send }) {
    this.store = store;
    this.createRuntime = createRuntime;
    this.execute = execute;
    this.send = send;
    this.ready = false;
    this.instances = new Map();
    this.queue = Promise.resolve();
  }

  list() {
    return this.store.list().map(({ manifest, enabled }) => {
      const instance = this.instances.get(manifest.id);
      return {
        manifest,
        enabled,
        status: instance?.status || (enabled ? "starting" : "disabled"),
        ...(instance?.error ? { error: instance.error } : {}),
      };
    });
  }

  emit() {
    this.send(this.list());
  }

  serialize(action) {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }

  stop(id) {
    const instance = this.instances.get(id);
    this.instances.delete(id);
    instance?.runtime?.stop();
  }

  setReady(ready) {
    if (typeof ready !== "boolean") throw new Error("插件工作区状态无效。");
    this.ready = ready;
    if (!ready) {
      for (const id of [...this.instances.keys()]) this.stop(id);
      this.emit();
    }
    return this.serialize(() => {
      if (this.ready) {
        for (const { manifest, enabled } of this.store.list()) {
          if (enabled) void this.start(manifest.id);
        }
      }
      this.emit();
    });
  }

  async start(id) {
    if (!this.ready || this.instances.has(id)) return;
    const instance = { runtime: null, status: "starting" };
    const fail = (error) => {
      if (this.instances.get(id) !== instance) return;
      instance.status = "error";
      instance.error = error.message;
      this.emit();
    };
    this.instances.set(id, instance);
    try {
      const plugin = this.store.get(id);
      instance.runtime = this.createRuntime({
        onCall: (command, args, signal) =>
          this.call(plugin.manifest, instance, command, args, signal),
        onError: fail,
      });
      this.emit();
      await instance.runtime.start(plugin);
      if (this.instances.get(id) !== instance || instance.status !== "starting")
        return;
      instance.status = "running";
      this.emit();
    } catch (error) {
      if (this.instances.get(id) !== instance) return;
      instance.runtime?.stop();
      fail(error);
    }
  }

  install(plugin, overwrite = false) {
    validatePluginPackage(plugin);
    if (typeof overwrite !== "boolean") throw new Error("插件更新选项无效。");
    return this.serialize(async () => {
      if (
        overwrite &&
        !this.store
          .list()
          .some(({ manifest }) => manifest.id === plugin.manifest.id)
      ) {
        throw pluginError("NOT_FOUND", "未知插件。");
      }
      await this.store.install(plugin, { overwrite });
      this.stop(plugin.manifest.id);
      this.emit();
      return this.list();
    });
  }

  remove(id) {
    return this.serialize(async () => {
      await this.store.remove(id);
      this.stop(id);
      this.emit();
      return this.list();
    });
  }

  setEnabled(id, enabled) {
    if (typeof enabled !== "boolean") throw new Error("插件状态无效。");
    return this.serialize(async () => {
      await this.store.setEnabled(id, enabled);
      if (enabled) void this.start(id);
      else this.stop(id);
      this.emit();
      return this.list();
    });
  }

  async run(id, commandId, args = {}) {
    const plugin = this.store.get(id);
    const instance = this.instances.get(id);
    if (!this.ready || instance?.status !== "running") {
      throw pluginError(
        "PLUGIN_DISABLED",
        "请先在 Market 中启用插件并等待启动完成。",
      );
    }
    if (!plugin.manifest.commands.some((command) => command.id === commandId)) {
      throw pluginError("UNKNOWN_COMMAND", "插件未声明此命令。");
    }
    return instance.runtime.run(commandId, args);
  }

  async call(manifest, instance, command, args, signal) {
    if (
      !this.ready ||
      signal.aborted ||
      this.instances.get(manifest.id) !== instance ||
      instance.status === "error"
    ) {
      throw pluginError("CANCELLED", "插件已停止，操作已取消。");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw pluginError("INVALID_ARGUMENTS", "插件命令参数必须是对象。");
    }
    const requirePermission = (permission) => {
      if (permission && !manifest.permissions.includes(permission)) {
        throw pluginError(
          "PERMISSION_DENIED",
          `插件未声明 ${permission} 权限。`,
        );
      }
    };
    if (command === "storage.get" || command === "storage.set") {
      requirePermission("storage");
      if (
        Object.keys(args).some(
          (key) =>
            !["key", ...(command === "storage.set" ? ["value"] : [])].includes(
              key,
            ),
        )
      ) {
        throw pluginError("INVALID_ARGUMENTS", "插件存储参数无效。");
      }
      return command === "storage.get"
        ? this.store.getStorage(manifest.id, args.key)
        : this.store.setStorage(manifest.id, args.key, args.value);
    }
    if (!Object.hasOwn(PLUGIN_COMMAND_PERMISSIONS, command)) {
      throw pluginError("PERMISSION_DENIED", "插件不能调用此宿主命令。");
    }
    requirePermission(PLUGIN_COMMAND_PERMISSIONS[command]);
    if (command === "create_presentation" && args.sourceDocumentId)
      requirePermission("canvas:read");
    if (
      command === "update_presentation" &&
      args.operation?.type === "copy_from"
    )
      requirePermission("presentation:read");
    let parsed;
    try {
      parsed = toolSchemas[command].parse(args);
    } catch {
      throw pluginError("INVALID_ARGUMENTS", "插件命令参数不符合 API schema。");
    }
    if (
      command === "read_canvas" ||
      command === "apply_operations" ||
      command === "control_canvas"
    ) {
      const { canvases } = await this.execute("list_canvases", {}, signal);
      const target = canvases.find(
        (canvas) => canvas.documentId === parsed.documentId,
      );
      if (target?.kind === "presentation") {
        requirePermission(
          command === "read_canvas"
            ? "presentation:read"
            : "presentation:write",
        );
      }
    }
    if (command === "apply_operations" || command === "update_presentation") {
      // Keep retry identities private to the plugin that issued the write.
      parsed.requestId = `${manifest.id}:${parsed.requestId}`;
    }
    return this.execute(command, parsed, signal);
  }

  async handleCommand(command, args) {
    switch (command) {
      case "get_plugin_development_guide":
        return getPluginDevelopmentGuide();
      case "get_plugin_api_schema": {
        const schema = getPluginApiSchema();
        for (const [name, entry] of Object.entries(schema.commands)) {
          entry.inputSchema = z.toJSONSchema(toolSchemas[name]);
        }
        return schema;
      }
      case "list_plugins":
        return {
          plugins: this.list(),
          ...(this.store.configurationError
            ? { error: this.store.configurationError }
            : {}),
        };
      case "get_plugin":
        return this.store.get(args.id);
      case "validate_plugin": {
        const plugin = validatePluginPackage(args.plugin);
        return {
          valid: true,
          manifest: plugin.manifest,
          sourceBytes: Buffer.byteLength(plugin.source),
        };
      }
      case "install_plugin":
        return { plugins: await this.install(args.plugin) };
      case "update_plugin":
        return { plugins: await this.install(args.plugin, true) };
      case "run_plugin_command":
        return { result: await this.run(args.id, args.commandId, args.args) };
      default:
        throw pluginError("UNKNOWN_COMMAND", "未知插件管理命令。");
    }
  }
}

module.exports = { UserPlugins };
