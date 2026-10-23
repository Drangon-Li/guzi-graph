const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Script } = require("node:vm");
const {
  UserPluginStore,
  validatePluginPackage,
  MAX_SOURCE_BYTES,
  MAX_STORAGE_BYTES,
  MAX_STORE_BYTES,
} = require("./user-plugin-store.cjs");
const {
  EXAMPLE_PLUGIN,
  getPluginApiSchema,
  getPluginDevelopmentGuide,
  PLUGIN_COMMAND_PERMISSIONS,
  DEVELOPMENT_COMMANDS,
} = require("./plugin-development.cjs");

const pkg = (id = "my-plugin") => ({
  manifest: {
    id,
    name: "My plugin",
    description: "A plugin",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["canvas:read", "storage"],
    commands: [{ id: "read.scene", title: "Read scene" }],
  },
  source: 'guzi.registerCommand("read.scene", async () => ({ ok: true }));',
});

async function fixture(t) {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), "guzi-user-plugins-"),
  );
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const store = await new UserPluginStore({ userData }).initialize();
  return {
    store,
    userData,
    configPath: path.join(userData, "user-plugins.json"),
  };
}

test("install and update persist a private package, disabled by default, with cloned results", async (t) => {
  const { store, configPath, userData } = await fixture(t);
  const original = pkg();
  await store.install(original);
  original.manifest.name = "mutated";
  assert.equal(store.list()[0].manifest.name, "My plugin");
  assert.equal(store.list()[0].enabled, false);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(userData), ["user-plugins.json"]);
  await store.setEnabled("my-plugin", true);
  const list = store.list();
  list[0].manifest.commands[0].id = "other";
  const first = store.get("my-plugin");
  first.manifest.permissions.push("canvas:write");
  assert.deepEqual(store.get("my-plugin"), pkg());
  await assert.rejects(store.install(pkg()), /已安装/);
  const update = pkg();
  update.manifest.version = "1.1.0-beta.1";
  await store.install(update, { overwrite: true });
  assert.equal(store.list()[0].enabled, false);
  const loaded = await new UserPluginStore({ userData }).initialize();
  assert.deepEqual(loaded.get("my-plugin"), update);
  assert.equal(loaded.list()[0].enabled, false);
});

test("validation rejects unknown fields, reserved names, invalid permissions and source without running it", () => {
  const variants = [
    (value) => {
      value.path = "/tmp/plugin.js";
    },
    (value) => {
      value.manifest.entrypoint = "./code.js";
    },
    (value) => {
      value.manifest.id = "mcp";
    },
    (value) => {
      value.manifest.id = "../other";
    },
    (value) => {
      value.manifest.id = "MyPlugin";
    },
    (value) => {
      value.manifest.apiVersion = 2;
    },
    (value) => {
      value.manifest.version = "01.2.3";
    },
    (value) => {
      value.manifest.permissions = ["network"];
    },
    (value) => {
      value.manifest.permissions = ["storage", "storage"];
    },
    (value) => {
      value.manifest.commands = [];
    },
    (value) => {
      value.manifest.commands.push({ ...value.manifest.commands[0] });
    },
    (value) => {
      value.manifest.commands[0].extra = true;
    },
    (value) => {
      value.source = "function {";
    },
    (value) => {
      value.source = " ";
    },
    (value) => {
      value.source = "//" + "字".repeat(MAX_SOURCE_BYTES / 2);
    },
  ];
  for (const modify of variants) {
    const value = pkg();
    modify(value);
    assert.throws(() => validatePluginPackage(value));
  }
  const value = pkg();
  value.source =
    'throw new Error("must never execute"); await Promise.resolve();';
  assert.deepEqual(validatePluginPackage(value), value);
  const getter = pkg();
  Object.defineProperty(getter, "source", {
    get() {
      throw new Error("getter executed");
    },
  });
  assert.throws(() => validatePluginPackage(getter), /插件包 字段无效/);
});

test("invalid update and failed persistence leave the old enabled package and disk intact", async (t) => {
  const { store, configPath } = await fixture(t);
  await store.install(pkg());
  await store.setEnabled("my-plugin", true);
  const old = await fs.readFile(configPath, "utf8");
  const invalid = pkg();
  invalid.source = "{ syntax";
  await assert.rejects(store.install(invalid, { overwrite: true }));
  assert.equal(store.list()[0].enabled, true);
  const persist = store.persist;
  store.persist = async () => {
    throw new Error("disk full");
  };
  const update = pkg();
  update.manifest.version = "2.0.0";
  await assert.rejects(store.install(update, { overwrite: true }), /disk full/);
  await assert.rejects(store.setEnabled("my-plugin", false), /disk full/);
  await assert.rejects(store.remove("my-plugin"), /disk full/);
  await assert.rejects(
    store.setStorage("my-plugin", "key", "value"),
    /disk full/,
  );
  assert.equal(store.list()[0].enabled, true);
  assert.deepEqual(store.get("my-plugin"), pkg());
  assert.equal(await store.getStorage("my-plugin", "key"), null);
  assert.equal(await fs.readFile(configPath, "utf8"), old);
  store.persist = persist;
  await store.setEnabled("my-plugin", false);
  assert.equal(store.list()[0].enabled, false);
});

test("concurrent writes serialize without losing packages, state, or storage", async (t) => {
  const { store, userData } = await fixture(t);
  await Promise.all([store.install(pkg("alpha")), store.install(pkg("beta"))]);
  await Promise.all([
    store.setEnabled("alpha", true),
    store.setStorage("alpha", "first", 1),
    store.setStorage("alpha", "second", [2]),
    store.setStorage("beta", "first", 3),
  ]);
  const loaded = await new UserPluginStore({ userData }).initialize();
  assert.equal(loaded.list().length, 2);
  assert.equal(loaded.list()[0].enabled, true);
  assert.equal(await loaded.getStorage("alpha", "first"), 1);
  assert.deepEqual(await loaded.getStorage("alpha", "second"), [2]);
  assert.equal(await loaded.getStorage("beta", "first"), 3);
});

test("storage is cloned, bounded across keys, private, retained on update and removed on uninstall", async (t) => {
  const { store } = await fixture(t);
  await store.install(pkg());
  await store.install(pkg("other"));
  const value = { text: ["hello"] };
  await store.setStorage("my-plugin", "item", value);
  value.text[0] = "mutated";
  const saved = await store.getStorage("my-plugin", "item");
  assert.deepEqual(saved, { text: ["hello"] });
  saved.text.push("more");
  assert.deepEqual(await store.getStorage("my-plugin", "item"), {
    text: ["hello"],
  });
  assert.equal(await store.getStorage("other", "item"), null);
  await store.install(pkg(), { overwrite: true });
  assert.deepEqual(await store.getStorage("my-plugin", "item"), {
    text: ["hello"],
  });
  await store.setStorage(
    "my-plugin",
    "large",
    "a".repeat(MAX_STORAGE_BYTES / 2),
  );
  await assert.rejects(
    store.setStorage("my-plugin", "another", "a".repeat(MAX_STORAGE_BYTES / 2)),
    /64 KiB/,
  );
  assert.equal(await store.getStorage("my-plugin", "another"), null);
  await store.remove("my-plugin");
  await store.install(pkg());
  assert.equal(await store.getStorage("my-plugin", "item"), null);
});

test("storage rejects unsafe keys, non-JSON values, deep nesting and undeclared permission", async (t) => {
  const { store } = await fixture(t);
  await store.install(pkg());
  const unsupported = [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    new Map(),
    [, 1],
    JSON.parse('{"__proto__":1}'),
  ];
  const cycle = {};
  cycle.self = cycle;
  unsupported.push(cycle);
  let deep = {};
  for (let index = 0; index < 70; index++) deep = { deep };
  unsupported.push(deep);
  for (const value of unsupported)
    await assert.rejects(store.setStorage("my-plugin", "item", value));
  for (const key of [
    "",
    "a".repeat(101),
    "__proto__",
    "prototype",
    "constructor",
  ])
    await assert.rejects(store.setStorage("my-plugin", key, 1));
  const noStorage = pkg("no-storage");
  noStorage.manifest.permissions = [];
  await store.install(noStorage);
  await assert.rejects(store.getStorage("no-storage", "item"), /storage 权限/);
  await assert.rejects(
    store.setStorage("no-storage", "item", 1),
    /storage 权限/,
  );
});

test("corrupt and oversized configuration is preserved and blocks every mutation", async (t) => {
  const { userData, configPath } = await fixture(t);
  for (const content of [
    "{bad",
    JSON.stringify({
      version: 1,
      plugins: [{ ...pkg(), enabled: "true", storage: {} }],
    }),
    " ".repeat(MAX_STORE_BYTES + 1),
  ]) {
    await fs.writeFile(configPath, content);
    const store = await new UserPluginStore({ userData }).initialize();
    assert.match(store.configurationError, /损坏或无法读取/);
    assert.deepEqual(store.list(), []);
    await assert.rejects(store.install(pkg()), /损坏或无法读取/);
    assert.equal(await fs.readFile(configPath, "utf8"), content);
  }
});

test("configuration symlink is not read or overwritten", async (t) => {
  const { userData, configPath } = await fixture(t);
  const outside = path.join(userData, "outside.json");
  const content = JSON.stringify({
    version: 1,
    plugins: [{ ...pkg(), enabled: true, storage: {} }],
  });
  await fs.writeFile(outside, content);
  await fs.unlink(configPath);
  await fs.symlink(outside, configPath);
  const store = await new UserPluginStore({ userData }).initialize();
  assert.ok(store.configurationError);
  assert.deepEqual(store.list(), []);
  await assert.rejects(store.install(pkg()));
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, "utf8"), content);
});

test("atomic write failure preserves old disk state and removes temporary files", async (t) => {
  const { store, userData, configPath } = await fixture(t);
  await store.install(pkg());
  const savedPath = `${configPath}.saved`;
  await fs.rename(configPath, savedPath);
  await fs.mkdir(configPath);
  await assert.rejects(store.setEnabled("my-plugin", true));
  assert.equal(store.list()[0].enabled, false);
  assert.deepEqual((await fs.readdir(userData)).sort(), [
    "user-plugins.json",
    "user-plugins.json.saved",
  ]);
  await fs.rmdir(configPath);
  await fs.rename(savedPath, configPath);
  const loaded = await new UserPluginStore({ userData }).initialize();
  assert.equal(loaded.list()[0].enabled, false);
});

test("development guide exposes the supported permission map and valid example as independent values", () => {
  assert.deepEqual(validatePluginPackage(EXAMPLE_PLUGIN), EXAMPLE_PLUGIN);
  const schema = getPluginApiSchema();
  assert.equal(schema.apiVersion, 1);
  assert.equal(schema.packageSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(schema.commands).sort(),
    Object.keys(PLUGIN_COMMAND_PERMISSIONS).sort(),
  );
  assert.equal(schema.commands.apply_operations.permission, "canvas:write");
  assert.equal(DEVELOPMENT_COMMANDS.length, 8);
  for (const command of [
    "open_canvas",
    "save_canvas",
    "export_canvas",
    "close_document",
  ])
    assert.equal(schema.commands[command], undefined);
  schema.example.manifest.name = "mutated";
  assert.equal(getPluginApiSchema().example.manifest.name, "手绘便签");
  const guide = getPluginDevelopmentGuide();
  for (const text of [
    "activeDocumentId",
    "REVISION_CONFLICT",
    "requestId",
    "Market",
    "guzi.storage",
    "默认关闭",
  ])
    assert.ok(guide.includes(text), text);
});

test("example selects the active canvas, falls back or creates, and uses the read revision", async () => {
  for (const mode of ["active", "fallback", "create", "conflict"]) {
    const calls = [];
    let handler;
    const guzi = {
      registerCommand(id, callback) {
        assert.equal(id, "insert-note");
        handler = callback;
      },
      async call(command, args) {
        calls.push({ command, args });
        if (command === "list_canvases")
          return {
            activeDocumentId: mode === "active" ? "active" : "presentation",
            canvases:
              mode === "create"
                ? []
                : [
                    {
                      documentId: "presentation",
                      kind: "presentation",
                      initialized: true,
                    },
                    { documentId: "first", kind: "canvas", initialized: true },
                    { documentId: "active", kind: "canvas", initialized: true },
                  ],
            files: [],
          };
        if (command === "create_canvas") return { documentId: "created" };
        if (command === "read_canvas") return { revision: 7, elements: [] };
        if (command === "apply_operations") {
          if (mode === "conflict")
            throw Object.assign(new Error("changed"), {
              code: "REVISION_CONFLICT",
            });
          return { revision: 8 };
        }
        assert.fail(command);
      },
    };
    await new Script(
      `(async () => {${EXAMPLE_PLUGIN.source}\n})()`,
    ).runInNewContext({ guzi });
    if (mode === "conflict")
      await assert.rejects(handler({}), { code: "REVISION_CONFLICT" });
    else await handler({ text: "A test note", x: 30, y: 40 });
    const write = calls.find((item) => item.command === "apply_operations");
    assert.equal(write.args.expectedRevision, 7);
    assert.equal(
      write.args.documentId,
      mode === "active" ? "active" : mode === "create" ? "created" : "first",
    );
    assert.match(write.args.requestId, /^note-/);
    assert.equal(write.args.operations[0].element.type, "stickynote");
    assert.equal(
      write.args.operations[0].element.label.text,
      mode === "conflict" ? "记录一个好想法" : "A test note",
    );
    assert.equal(
      Object.hasOwn(write.args.operations[0].element, "text"),
      false,
    );
    assert.equal(
      calls.filter((item) => item.command === "apply_operations").length,
      1,
    );
  }
});
