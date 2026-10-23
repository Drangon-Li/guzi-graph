const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Script } = require("node:vm");

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_STORAGE_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_PLUGINS = 64;
const PLUGIN_PERMISSIONS = Object.freeze([
  "canvas:read",
  "canvas:write",
  "presentation:read",
  "presentation:write",
  "storage",
]);
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

function object(value, fields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    ) ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    throw new Error(`${label} 字段无效。`);
}

function text(value, name, max, min = 1) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    (min > 0 && !value.trim())
  )
    throw new Error(`${name} 无效。`);
  return value;
}

function jsonValue(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new Error("JSON 嵌套过深。");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value))
    throw new Error("存储值必须是有效 JSON。");
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index))
    )
      throw new Error("存储值必须是有效 JSON 数组。");
  } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("存储值必须是普通 JSON 对象。");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key))
      throw new Error("存储值包含无效字段。");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw new Error("存储值必须是有效 JSON。");
    jsonValue(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

function storageKey(key) {
  text(key, "存储键", 100);
  if (FORBIDDEN_KEYS.has(key)) throw new Error("存储键无效。");
}

function validatePluginPackage(pkg) {
  object(pkg, ["manifest", "source"], "插件包");
  const { manifest, source } = pkg;
  object(
    manifest,
    [
      "id",
      "name",
      "description",
      "version",
      "apiVersion",
      "permissions",
      "commands",
    ],
    "插件清单",
  );
  if (
    !PLUGIN_ID_PATTERN.test(text(manifest.id, "插件 ID", 64)) ||
    manifest.id === "mcp"
  )
    throw new Error("插件 ID 无效或已保留。");
  text(manifest.name, "插件名称", 100);
  text(manifest.description, "插件描述", 2000, 0);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      text(manifest.version, "插件版本", 100),
    )
  )
    throw new Error("插件版本必须是 x.y.z 或带 prerelease 的版本。");
  if (manifest.apiVersion !== 1) throw new Error("仅支持插件 API 1。");
  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.length > PLUGIN_PERMISSIONS.length ||
    new Set(manifest.permissions).size !== manifest.permissions.length ||
    manifest.permissions.some(
      (permission) => !PLUGIN_PERMISSIONS.includes(permission),
    )
  )
    throw new Error("插件权限无效。");
  if (
    !Array.isArray(manifest.commands) ||
    manifest.commands.length < 1 ||
    manifest.commands.length > 20
  )
    throw new Error("插件必须声明 1 到 20 个命令。");
  const ids = new Set();
  for (const command of manifest.commands) {
    object(command, ["id", "title"], "插件命令");
    if (
      !COMMAND_ID_PATTERN.test(text(command.id, "命令 ID", 64)) ||
      ids.has(command.id)
    )
      throw new Error("插件命令 ID 无效或重复。");
    text(command.title, "命令名称", 100);
    ids.add(command.id);
  }
  text(source, "插件源码", MAX_SOURCE_BYTES);
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
    throw new Error("插件源码超过 256 KiB。");
  try {
    new Script(`(async () => {\n${source}\n})()`, {
      filename: `${manifest.id}.plugin.js`,
    });
  } catch {
    throw new Error("插件源码语法无效。");
  }
  jsonValue(pkg);
  return clone({ manifest, source });
}

function validateState(value) {
  object(value, ["version", "plugins"], "插件存储");
  if (
    value.version !== 1 ||
    !Array.isArray(value.plugins) ||
    value.plugins.length > MAX_PLUGINS
  )
    throw new Error("插件存储格式无效。");
  const ids = new Set();
  const plugins = value.plugins.map((entry) => {
    object(entry, ["manifest", "source", "enabled", "storage"], "插件记录");
    const pkg = validatePluginPackage({
      manifest: entry.manifest,
      source: entry.source,
    });
    if (ids.has(pkg.manifest.id) || typeof entry.enabled !== "boolean")
      throw new Error("插件记录重复或状态无效。");
    ids.add(pkg.manifest.id);
    if (
      !entry.storage ||
      Array.isArray(entry.storage) ||
      typeof entry.storage !== "object"
    )
      throw new Error("插件存储值无效。");
    jsonValue(entry.storage);
    Object.keys(entry.storage).forEach(storageKey);
    if (bytes(entry.storage) > MAX_STORAGE_BYTES)
      throw new Error("插件存储超过 64 KiB。");
    return { ...pkg, enabled: entry.enabled, storage: clone(entry.storage) };
  });
  return { version: 1, plugins };
}

class UserPluginStore {
  constructor({ userData }) {
    this.configPath = path.join(userData, "user-plugins.json");
    this.state = { version: 1, plugins: [] };
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    let handle;
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      handle = await fs.open(
        this.configPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES)
        throw new Error("插件存储文件无效或过大。");
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_STORE_BYTES)
        throw new Error("插件存储文件过大。");
      this.state = validateState(JSON.parse(content));
      await handle.chmod(0o600);
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          await this.persist(this.state);
        } catch {
          this.configurationError =
            "插件配置无法保存，请检查应用数据目录权限。";
        }
      } else {
        this.state = { version: 1, plugins: [] };
        this.configurationError =
          "插件配置损坏或无法读取；请修复或移走 user-plugins.json 后重启应用。";
      }
    } finally {
      await handle?.close();
    }
    this.initialized = true;
    return this;
  }

  list() {
    return this.state.plugins.map(({ manifest, enabled }) => ({
      manifest: clone(manifest),
      enabled,
    }));
  }

  entry(id, state = this.state) {
    const entry = state.plugins.find((plugin) => plugin.manifest.id === id);
    if (!entry) throw new Error("未知插件。");
    return entry;
  }

  get(id) {
    const { manifest, source } = this.entry(id);
    return clone({ manifest, source });
  }

  async persist(state) {
    const content = JSON.stringify(state);
    if (Buffer.byteLength(content) > MAX_STORE_BYTES)
      throw new Error("插件存储总量超过 16 MiB。");
    const temporary = path.join(
      path.dirname(this.configPath),
      `.user-plugins.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.configPath);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  mutate(action) {
    const result = this.queue.then(async () => {
      if (!this.initialized) throw new Error("插件存储尚未初始化。");
      if (this.configurationError) throw new Error(this.configurationError);
      const next = clone(this.state);
      action(next);
      await this.persist(next);
      this.state = next;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async install(pkg, { overwrite = false } = {}) {
    const normalized = validatePluginPackage(pkg);
    if (typeof overwrite !== "boolean") throw new Error("覆盖选项无效。");
    await this.mutate((state) => {
      const index = state.plugins.findIndex(
        (entry) => entry.manifest.id === normalized.manifest.id,
      );
      if (index >= 0 && !overwrite)
        throw new Error("插件已安装；更新时必须明确允许覆盖。");
      if (index < 0 && state.plugins.length >= MAX_PLUGINS)
        throw new Error("最多安装 64 个插件。");
      const next = {
        ...normalized,
        enabled: false,
        storage: index >= 0 ? state.plugins[index].storage : {},
      };
      if (index >= 0) state.plugins[index] = next;
      else state.plugins.push(next);
    });
    return this.get(normalized.manifest.id);
  }

  async remove(id) {
    await this.mutate((state) => {
      this.entry(id, state);
      state.plugins = state.plugins.filter((entry) => entry.manifest.id !== id);
    });
  }

  async setEnabled(id, enabled) {
    if (typeof enabled !== "boolean") throw new Error("插件状态无效。");
    await this.mutate((state) => {
      this.entry(id, state).enabled = enabled;
    });
  }

  async getStorage(id, key) {
    await this.queue;
    storageKey(key);
    const entry = this.entry(id);
    if (!entry.manifest.permissions.includes("storage"))
      throw new Error("插件未声明 storage 权限。");
    return Object.hasOwn(entry.storage, key) ? clone(entry.storage[key]) : null;
  }

  async setStorage(id, key, value) {
    storageKey(key);
    jsonValue(value);
    const saved = clone(value);
    await this.mutate((state) => {
      const entry = this.entry(id, state);
      if (!entry.manifest.permissions.includes("storage"))
        throw new Error("插件未声明 storage 权限。");
      entry.storage[key] = saved;
      if (bytes(entry.storage) > MAX_STORAGE_BYTES)
        throw new Error("插件存储超过 64 KiB。");
    });
  }
}

module.exports = {
  UserPluginStore,
  validatePluginPackage,
  PLUGIN_PERMISSIONS,
  PLUGIN_ID_PATTERN,
  COMMAND_ID_PATTERN,
  MAX_SOURCE_BYTES,
  MAX_STORAGE_BYTES,
  MAX_STORE_BYTES,
  MAX_PLUGINS,
};
