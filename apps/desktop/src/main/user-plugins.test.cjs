const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { UserPlugins } = require("./user-plugins.cjs");
const { UserPluginStore } = require("./user-plugin-store.cjs");
const { toolSchemas } = require("./mcp-service.cjs");
const { PLUGIN_COMMAND_PERMISSIONS } = require("./plugin-development.cjs");

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Management operation blocked by startup")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const plugin = (id = "sample", permissions = []) => ({
  manifest: {
    id,
    name: "Sample plugin",
    description: "A local test plugin",
    version: "1.0.0",
    apiVersion: 1,
    permissions,
    commands: [{ id: "example.run", title: "Run example" }],
  },
  source: 'guzi.registerCommand("example.run", async (args) => args);',
});

async function fixture(t, options = {}) {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), "guzi-user-plugin-manager-"),
  );
  const runtimes = [];
  const events = [];
  const calls = [];
  const store = await new UserPluginStore({ userData }).initialize();
  const manager = new UserPlugins({
    store,
    createRuntime: ({ onCall, onError }) => {
      const controllers = new Set();
      const runtime = {
        started: null,
        stopped: false,
        runs: [],
        onError,
        async start(pkg) {
          this.started = pkg;
          if (options.start) await options.start(this, pkg);
        },
        async run(commandId, args = {}) {
          this.runs.push({ commandId, args });
          return options.run
            ? options.run(this, commandId, args)
            : { commandId, args };
        },
        call(command, args = {}) {
          const controller = new AbortController();
          controllers.add(controller);
          const cancelled = new Promise((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("Plugin stopped"), {
                    code: "CANCELLED",
                  }),
                ),
              { once: true },
            );
          });
          const request = Promise.resolve().then(() =>
            onCall(command, args, controller.signal),
          );
          return Promise.race([request, cancelled]).finally(() =>
            controllers.delete(controller),
          );
        },
        rawCall(command, args = {}, signal = new AbortController().signal) {
          return onCall(command, args, signal);
        },
        stop() {
          this.stopped = true;
          for (const controller of controllers) controller.abort();
          controllers.clear();
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
    execute: async (command, args, signal) => {
      calls.push({ command, args, signal });
      return options.execute
        ? options.execute(command, args, signal)
        : command === "list_canvases"
        ? {
            canvases: [
              { documentId: "canvas", kind: "canvas" },
              { documentId: "deck", kind: "presentation" },
            ],
          }
        : { command, args };
    },
    send: (state) => events.push(state),
  });
  t.after(async () => {
    await manager.setReady(false);
    await fs.rm(userData, { recursive: true, force: true });
  });
  return { manager, store, userData, runtimes, events, calls };
}

test("install stays disabled without creating a runtime, then enable starts and run forwards arguments", async (t) => {
  const { manager, store, runtimes, events } = await fixture(t);
  await manager.setReady(true);
  await manager.install(plugin());
  assert.equal(runtimes.length, 0);
  assert.equal(manager.list()[0].enabled, false);
  assert.equal(manager.list()[0].status, "disabled");
  await assert.rejects(manager.run("sample", "example.run"), {
    code: "PLUGIN_DISABLED",
  });
  assert.equal(store.list()[0].enabled, false);
  await manager.setEnabled("sample", true);
  assert.equal(runtimes.length, 1);
  assert.deepEqual(runtimes[0].started, plugin());
  assert.equal(manager.list()[0].status, "running");
  const args = { text: "hello", x: 50 };
  assert.deepEqual(await manager.run("sample", "example.run", args), {
    commandId: "example.run",
    args,
  });
  assert.deepEqual(runtimes[0].runs, [{ commandId: "example.run", args }]);
  await assert.rejects(manager.run("sample", "undeclared"), {
    code: "UNKNOWN_COMMAND",
  });
  assert.equal(runtimes[0].runs.length, 1);
  assert.ok(events.some((state) => state[0]?.status === "running"));
  await manager.setEnabled("sample", false);
  assert.equal(runtimes[0].stopped, true);
  await assert.rejects(manager.run("sample", "example.run"), {
    code: "PLUGIN_DISABLED",
  });
});

test("host commands deny undeclared permissions and filesystem or management commands", async (t) => {
  const { manager, runtimes, calls } = await fixture(t);
  await manager.install(plugin());
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  for (const [command, args] of [
    ["list_canvases", {}],
    ["read_canvas", { documentId: "canvas" }],
    ["create_canvas", { title: "new" }],
    ["storage.get", { key: "test" }],
    ["storage.set", { key: "test", value: true }],
    ["open_canvas", { path: "/tmp/outside.excalidraw" }],
    ["save_canvas", { documentId: "canvas" }],
    ["export_canvas", { documentId: "canvas", format: "png" }],
    ["close_document", { documentId: "canvas" }],
    ["install_plugin", { plugin: plugin("other") }],
    ["constructor", {}],
    ["unknown", {}],
  ])
    await assert.rejects(runtimes[0].call(command, args), {
      code: "PERMISSION_DENIED",
    });
  assert.equal(calls.length, 0);
});

test("allowed host arguments are parsed and write request IDs are private to each plugin", async (t) => {
  const { manager, runtimes, calls } = await fixture(t);
  await manager.install(plugin("alpha", ["canvas:read", "canvas:write"]));
  await manager.install(plugin("beta", ["canvas:read", "canvas:write"]));
  await manager.setReady(true);
  await manager.setEnabled("alpha", true);
  await manager.setEnabled("beta", true);
  assert.deepEqual(await runtimes[0].call("list_canvases", {}), {
    canvases: [
      { documentId: "canvas", kind: "canvas" },
      { documentId: "deck", kind: "presentation" },
    ],
  });
  for (const args of [null, [], "text", { unexpected: true }])
    await assert.rejects(runtimes[0].call("list_canvases", args), {
      code: "INVALID_ARGUMENTS",
    });
  await assert.rejects(runtimes[0].call("read_canvas", {}), {
    code: "INVALID_ARGUMENTS",
  });
  const args = {
    documentId: "canvas",
    expectedRevision: 3,
    requestId: "same-client-id",
    operations: [
      { type: "create", element: { type: "rectangle", x: 0, y: 0 } },
    ],
  };
  await runtimes[0].call("apply_operations", args);
  await runtimes[1].call("apply_operations", args);
  assert.deepEqual(
    calls
      .filter((call) => call.command === "apply_operations")
      .map((call) => call.args.requestId),
    ["alpha:same-client-id", "beta:same-client-id"],
  );
  assert.equal(args.requestId, "same-client-id");
  assert.equal(calls[1].signal.aborted, false);
  await assert.rejects(
    runtimes[0].call("read_canvas", { documentId: "deck", slideId: "slide" }),
    { code: "PERMISSION_DENIED" },
  );
});

test("presentation source and slide operations require the corresponding extra permission", async (t) => {
  const { manager, runtimes, calls } = await fixture(t);
  await manager.install(plugin("deck-writer", ["presentation:write"]));
  await manager.install(
    plugin("all-access", [
      "canvas:read",
      "canvas:write",
      "presentation:read",
      "presentation:write",
    ]),
  );
  await manager.setReady(true);
  await manager.setEnabled("deck-writer", true);
  await manager.setEnabled("all-access", true);
  await runtimes[0].call("create_presentation", { title: "empty" });
  await assert.rejects(
    runtimes[0].call("create_presentation", {
      title: "copy",
      sourceDocumentId: "canvas",
    }),
    { code: "PERMISSION_DENIED" },
  );
  const copy = {
    documentId: "deck",
    expectedRevision: 0,
    requestId: "copy-1",
    operation: {
      type: "copy_from",
      sourceDocumentId: "other-deck",
      sourceSlideId: "slide",
    },
  };
  await assert.rejects(runtimes[0].call("update_presentation", copy), {
    code: "PERMISSION_DENIED",
  });
  await runtimes[1].call("update_presentation", copy);
  await runtimes[1].call("read_canvas", {
    documentId: "deck",
    slideId: "slide",
  });
  assert.equal(calls[1].args.requestId, "all-access:copy-1");
  assert.equal(calls[2].command, "list_canvases");
  assert.equal(calls[3].command, "read_canvas");
});

test("canvas commands check presentation permissions for explicit and implicit current slides", async (t) => {
  const commands = [
    ["read_canvas", "read", {}],
    [
      "apply_operations",
      "write",
      {
        expectedRevision: 0,
        requestId: "edit-slide",
        operations: [{ type: "canvas", patch: { gridModeEnabled: true } }],
      },
    ],
    ["control_canvas", "write", { action: "fit" }],
  ];
  for (const [command, access, args] of commands) {
    await t.test(command, async (t) => {
      const { manager, runtimes, calls } = await fixture(t);
      await manager.install(plugin("canvas-only", [`canvas:${access}`]));
      await manager.install(
        plugin("slide-access", [`canvas:${access}`, `presentation:${access}`]),
      );
      await manager.setReady(true);
      await manager.setEnabled("canvas-only", true);
      await manager.setEnabled("slide-access", true);
      for (const slide of [{}, { slideId: "slide" }]) {
        await assert.rejects(
          runtimes[0].call(command, { documentId: "deck", ...args, ...slide }),
          {
            code: "PERMISSION_DENIED",
            message: `插件未声明 presentation:${access} 权限。`,
          },
        );
      }
      assert.deepEqual(
        calls.map((call) => call.command),
        ["list_canvases", "list_canvases"],
      );
      const canvasArgs = { documentId: "canvas", ...args };
      const canvasResult = await runtimes[0].call(command, canvasArgs);
      assert.equal(canvasResult.command, command);
      assert.equal(canvasResult.args.documentId, "canvas");
      for (const slide of [{}, { slideId: "slide" }]) {
        const slideResult = await runtimes[1].call(command, {
          documentId: "deck",
          ...args,
          ...slide,
        });
        assert.equal(slideResult.command, command);
        assert.equal(slideResult.args.documentId, "deck");
        assert.equal(slideResult.args.slideId, slide.slideId);
        if (command === "apply_operations") {
          assert.equal(slideResult.args.requestId, "slide-access:edit-slide");
          assert.equal(args.requestId, "edit-slide");
        }
      }
      for (let index = 2; index < calls.length; index += 2) {
        assert.equal(calls[index].command, "list_canvases");
        assert.equal(calls[index + 1].command, command);
        assert.equal(calls[index].signal, calls[index + 1].signal);
      }
    });
  }
});

test("presentation goto only requires its declared write permission", async (t) => {
  const { manager, runtimes, calls } = await fixture(t);
  await manager.install(plugin("deck-writer", ["presentation:write"]));
  await manager.setReady(true);
  await manager.setEnabled("deck-writer", true);
  const args = { documentId: "deck", action: "goto", slideId: "slide" };
  assert.deepEqual(await runtimes[0].call("control_presentation", args), {
    command: "control_presentation",
    args,
  });
  assert.deepEqual(
    calls.map((call) => call.command),
    ["control_presentation"],
  );
});

test("storage calls stay private per plugin and reject undeclared keys or extra arguments", async (t) => {
  const { manager, store, runtimes, calls } = await fixture(t);
  await manager.install(plugin("alpha", ["storage"]));
  await manager.install(plugin("beta", ["storage"]));
  await manager.setReady(true);
  await manager.setEnabled("alpha", true);
  await manager.setEnabled("beta", true);
  await runtimes[0].call("storage.set", {
    key: "settings",
    value: { color: "red" },
  });
  assert.deepEqual(await runtimes[0].call("storage.get", { key: "settings" }), {
    color: "red",
  });
  assert.equal(
    await runtimes[1].call("storage.get", { key: "settings" }),
    null,
  );
  await runtimes[1].call("storage.set", {
    key: "settings",
    value: { color: "blue" },
  });
  assert.deepEqual(await store.getStorage("alpha", "settings"), {
    color: "red",
  });
  await assert.rejects(
    runtimes[0].call("storage.get", { key: "settings", pluginId: "beta" }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(
    runtimes[0].call("storage.set", {
      key: "settings",
      value: false,
      id: "beta",
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(runtimes[0].call("storage.get", { key: "__proto__" }));
  assert.equal(calls.length, 0);
});

test("failed update preserves enabled package and runtime; valid update stops it and retains storage", async (t) => {
  const { manager, store, runtimes, userData } = await fixture(t);
  const original = plugin("sample", ["storage"]);
  await manager.install(original);
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  await runtimes[0].call("storage.set", { key: "retained", value: [1, 2] });
  const invalid = plugin("sample", ["storage"]);
  invalid.source = "syntax {";
  await assert.rejects(async () => manager.install(invalid, true));
  assert.equal(runtimes[0].stopped, false);
  assert.equal(manager.list()[0].status, "running");
  const updated = plugin("sample", ["storage"]);
  updated.manifest.version = "2.0.0";
  const persist = store.persist;
  store.persist = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(manager.install(updated, true), /disk full/);
  assert.equal(runtimes[0].stopped, false);
  assert.equal(manager.list()[0].enabled, true);
  assert.deepEqual(store.get("sample"), original);
  store.persist = persist;
  await manager.install(updated, true);
  assert.equal(runtimes[0].stopped, true);
  assert.equal(runtimes.length, 1);
  assert.equal(manager.list()[0].enabled, false);
  assert.equal(manager.list()[0].status, "disabled");
  assert.deepEqual(store.get("sample"), updated);
  assert.deepEqual(await store.getStorage("sample", "retained"), [1, 2]);
  const reloaded = await new UserPluginStore({ userData }).initialize();
  assert.equal(reloaded.list()[0].enabled, false);
  assert.deepEqual(await reloaded.getStorage("sample", "retained"), [1, 2]);
  await assert.rejects(manager.run("sample", "example.run"), {
    code: "PLUGIN_DISABLED",
  });
});

test("an update queued after removal fails without reinstalling the plugin", async (t) => {
  const { manager, store, userData, runtimes } = await fixture(t);
  await manager.install(plugin());
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  const updated = plugin();
  updated.manifest.version = "2.0.0";
  const removal = manager.remove("sample");
  const update = assert.rejects(
    manager.handleCommand("update_plugin", { plugin: updated }),
    { code: "NOT_FOUND" },
  );
  assert.deepEqual(await removal, []);
  await update;
  assert.equal(runtimes[0].stopped, true);
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(store.list(), []);
  const loaded = await new UserPluginStore({ userData }).initialize();
  assert.deepEqual(loaded.list(), []);
});

test("closing the workspace aborts in-flight host calls and rejects calls from stale runtimes", async (t) => {
  let entered;
  const called = new Promise((resolve) => {
    entered = resolve;
  });
  const { manager, runtimes } = await fixture(t, {
    execute(_command, _args, signal) {
      entered(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("cancelled"), { code: "CANCELLED" }),
            ),
          { once: true },
        );
      });
    },
  });
  await manager.install(plugin("sample", ["canvas:read"]));
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  const pending = runtimes[0].call("list_canvases", {});
  const rejection = assert.rejects(pending, { code: "CANCELLED" });
  const signal = await called;
  const stopped = manager.setReady(false);
  assert.equal(runtimes[0].stopped, true);
  assert.equal(signal.aborted, true);
  await stopped;
  await rejection;
  await assert.rejects(runtimes[0].rawCall("list_canvases", {}), {
    code: "CANCELLED",
  });
  await assert.rejects(manager.run("sample", "example.run"), {
    code: "PLUGIN_DISABLED",
  });
  await manager.setReady(true);
  assert.equal(runtimes.length, 2);
  await assert.rejects(runtimes[0].rawCall("list_canvases", {}), {
    code: "CANCELLED",
  });
  assert.equal(manager.list()[0].status, "running");
});

test("persisted enabled plugins start only after the next workspace becomes ready", async (t) => {
  const { manager, store, userData } = await fixture(t);
  await manager.install(plugin());
  await manager.setEnabled("sample", true);
  assert.equal(manager.list()[0].status, "starting");
  const loaded = await new UserPluginStore({ userData }).initialize();
  const starts = [];
  const second = new UserPlugins({
    store: loaded,
    createRuntime: () => ({
      start: async (pkg) => starts.push(pkg.manifest.id),
      run: async () => "ok",
      stop() {},
    }),
    execute: async () => null,
    send() {},
  });
  t.after(() => second.setReady(false));
  assert.equal(starts.length, 0);
  await second.setReady(true);
  assert.deepEqual(starts, ["sample"]);
  assert.equal(second.list()[0].enabled, true);
  assert.equal(second.list()[0].status, "running");
  assert.equal(await second.run("sample", "example.run"), "ok");
  assert.equal(store.list()[0].enabled, true);
});

test("pending enable startup does not block disabling and persisting the plugin", async (t) => {
  const startup = deferred();
  const entered = deferred();
  const { manager, runtimes, store, userData } = await fixture(t, {
    start() {
      entered.resolve();
      return startup.promise;
    },
  });
  await manager.install(plugin("sample", ["canvas:read"]));
  await manager.setReady(true);
  const enabling = manager.setEnabled("sample", true);
  try {
    await within(entered.promise);
    const enabled = await within(enabling);
    assert.equal(enabled[0].enabled, true);
    assert.equal(enabled[0].status, "starting");
    await within(manager.setEnabled("sample", false));
    assert.equal(runtimes[0].stopped, true);
    assert.equal(store.list()[0].enabled, false);
    const persisted = JSON.parse(
      await fs.readFile(path.join(userData, "user-plugins.json"), "utf8"),
    );
    assert.equal(persisted.plugins[0].enabled, false);
    await assert.rejects(runtimes[0].rawCall("list_canvases"), {
      code: "CANCELLED",
    });
    startup.resolve();
    await turn();
    assert.equal(manager.list()[0].status, "disabled");
  } finally {
    startup.resolve();
    await enabling;
  }
});

test("multiple pending workspace startups do not block disabling any plugin", async (t) => {
  const startups = [];
  const { manager, runtimes, store } = await fixture(t, {
    start() {
      const startup = deferred();
      startups.push(startup);
      return startup.promise;
    },
  });
  for (const id of ["alpha", "beta"]) {
    await manager.install(plugin(id));
    await manager.setEnabled(id, true);
  }
  const preparing = manager.setReady(true);
  try {
    await within(preparing);
    assert.equal(startups.length, 2);
    assert.equal(
      runtimes.every((runtime) => !runtime.stopped),
      true,
    );
    for (const id of ["alpha", "beta"]) {
      await within(manager.setEnabled(id, false));
      assert.equal(manager.instances.has(id), false);
    }
    assert.equal(
      runtimes.every((runtime) => runtime.stopped),
      true,
    );
    assert.equal(
      store.list().every((entry) => !entry.enabled),
      true,
    );
    for (const startup of startups) startup.resolve();
    await turn();
    assert.equal(
      manager.list().every((entry) => entry.status === "disabled"),
      true,
    );
  } finally {
    for (const startup of startups) startup.resolve();
    await preparing;
  }
});

test("reload stops pending startups synchronously and ignores their late success, error and onError", async (t) => {
  const startups = [];
  const { manager, runtimes } = await fixture(t, {
    start() {
      const startup = deferred();
      startups.push(startup);
      return startup.promise;
    },
  });
  for (const id of ["alpha", "beta"]) {
    await manager.install(plugin(id));
    await manager.setEnabled(id, true);
  }
  const preparing = manager.setReady(true);
  try {
    await within(preparing);
    assert.equal(startups.length, 2);
    const closing = manager.setReady(false);
    assert.equal(manager.instances.size, 0);
    assert.equal(
      runtimes.every((runtime) => runtime.stopped),
      true,
    );
    await within(closing);
    await within(manager.setReady(true));
    assert.equal(startups.length, 4);
    startups[0].resolve();
    startups[1].reject(new Error("Stale startup rejected"));
    runtimes[0].onError(new Error("Stale renderer crashed"));
    await turn();
    assert.equal(
      manager.list().every((entry) => entry.status === "starting"),
      true,
    );
    assert.equal(runtimes[2].stopped, false);
    assert.equal(runtimes[3].stopped, false);
    startups[2].resolve();
    startups[3].resolve();
    await turn();
    assert.equal(
      manager.list().every((entry) => entry.status === "running"),
      true,
    );
  } finally {
    for (const startup of startups) startup.resolve();
    await preparing;
  }
});

test("runtime factory and synchronous or asynchronous startup failures are handled without blocking management", async (t) => {
  for (const mode of ["factory", "synchronous", "asynchronous"]) {
    await t.test(mode, async (t) => {
      const { manager, runtimes } = await fixture(t);
      const createRuntime = manager.createRuntime;
      manager.createRuntime = (callbacks) => {
        if (mode === "factory") throw new Error("Factory failed");
        const runtime = createRuntime(callbacks);
        runtime.start = () => {
          if (mode === "synchronous") throw new Error("Startup failed");
          return Promise.reject(new Error("Startup rejected"));
        };
        return runtime;
      };
      await manager.install(plugin());
      await manager.setReady(true);
      await within(manager.setEnabled("sample", true));
      await turn();
      assert.equal(manager.list()[0].status, "error");
      assert.match(manager.list()[0].error, /failed|rejected/);
      if (mode !== "factory") assert.equal(runtimes[0].stopped, true);
      await within(manager.setEnabled("sample", false));
      assert.equal(manager.list()[0].status, "disabled");
    });
  }
});

test("onError during startup cannot be overwritten by a later ready result", async (t) => {
  const { manager } = await fixture(t, {
    start(runtime) {
      runtime.onError(new Error("Renderer failed during startup"));
    },
  });
  await manager.install(plugin());
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  await turn();
  assert.equal(manager.list()[0].status, "error");
  assert.equal(manager.list()[0].error, "Renderer failed during startup");
});

test("runtime startup errors surface in state and do not permit running commands", async (t) => {
  const { manager, runtimes } = await fixture(t, {
    start: async () => {
      throw new Error("registration failed");
    },
  });
  await manager.install(plugin());
  await manager.setReady(true);
  await manager.setEnabled("sample", true);
  await turn();
  assert.equal(manager.list()[0].status, "error");
  assert.match(manager.list()[0].error, /registration failed/);
  assert.equal(runtimes[0].stopped, true);
  await assert.rejects(manager.run("sample", "example.run"), {
    code: "PLUGIN_DISABLED",
  });
});

test("MCP development routes provide schemas, validate without running and require Market enable before run", async (t) => {
  const { manager, store, runtimes } = await fixture(t);
  const route = (command, args = {}) =>
    manager.handleCommand(command, toolSchemas[command].parse(args));
  await manager.setReady(true);
  const guide = await route("get_plugin_development_guide");
  assert.match(guide, /guzi.registerCommand/);
  const schema = await route("get_plugin_api_schema");
  assert.equal(schema.apiVersion, 1);
  for (const command of Object.keys(PLUGIN_COMMAND_PERMISSIONS)) {
    assert.equal(schema.commands[command].inputSchema.type, "object");
    assert.ok(schema.commands[command].inputSchema.properties);
  }
  assert.equal(
    schema.commands.read_canvas.inputSchema.properties.documentId.type,
    "string",
  );
  assert.deepEqual(await route("list_plugins"), { plugins: [] });
  const pkg = plugin();
  const validation = await route("validate_plugin", { plugin: pkg });
  assert.equal(validation.valid, true);
  assert.equal(validation.sourceBytes, Buffer.byteLength(pkg.source));
  assert.equal(store.list().length, 0);
  assert.equal(runtimes.length, 0);
  const installed = await route("install_plugin", { plugin: pkg });
  assert.equal(installed.plugins[0].enabled, false);
  assert.deepEqual(await route("get_plugin", { id: "sample" }), pkg);
  assert.equal((await route("list_plugins")).plugins[0].status, "disabled");
  await assert.rejects(
    route("run_plugin_command", { id: "sample", commandId: "example.run" }),
    { code: "PLUGIN_DISABLED" },
  );
  assert.equal(store.list()[0].enabled, false);
  assert.equal(runtimes.length, 0);
  await assert.rejects(route("install_plugin", { plugin: pkg }), /已安装/);
  await assert.rejects(
    route("update_plugin", { plugin: plugin("missing") }),
    /未知插件/,
  );
  await manager.setEnabled("sample", true);
  const args = { text: "from MCP" };
  assert.deepEqual(
    await route("run_plugin_command", {
      id: "sample",
      commandId: "example.run",
      args,
    }),
    { result: { commandId: "example.run", args } },
  );
  await assert.rejects(
    route("run_plugin_command", { id: "sample", commandId: "undeclared" }),
    { code: "UNKNOWN_COMMAND" },
  );
  const updated = plugin();
  updated.manifest.version = "1.1.0";
  const result = await route("update_plugin", { plugin: updated });
  assert.equal(result.plugins[0].enabled, false);
  assert.equal(runtimes[0].stopped, true);
  await assert.rejects(
    route("run_plugin_command", { id: "sample", commandId: "example.run" }),
    { code: "PLUGIN_DISABLED" },
  );
  await assert.rejects(manager.handleCommand("unknown", {}), {
    code: "UNKNOWN_COMMAND",
  });
});
