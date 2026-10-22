const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PluginHost, COMMANDS } = require("./plugins.cjs");

async function fixture(t, options = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-plugins-"));
  const children = [];
  const events = [];
  const configuration = {
    userData,
    fork: () => {
      const child = new EventEmitter();
      child.sent = [];
      child.postMessage = (message) => child.sent.push(message);
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("exit", 0));
      };
      children.push(child);
      return child;
    },
    send: (channel, value) => events.push({ channel, value }),
    ...options,
  };
  const host = await new PluginHost(configuration).initialize();
  t.after(async () => {
    await host.stop();
    await fs.rm(userData, { recursive: true, force: true });
  });
  return { host, userData, children, events, configuration };
}

test("built-in MCP is disabled by default and persists its private token separately", async (t) => {
  const { host, userData, configuration, children } = await fixture(t);
  assert.equal(host.list()[0].enabled, false);
  assert.equal(host.list()[0].port, 43123);
  assert.match(host.list()[0].token, /^[a-f0-9]{64}$/);
  assert.equal(
    (await fs.stat(path.join(userData, "plugins.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await new PluginHost(configuration).initialize()).list()[0].token,
    host.list()[0].token,
  );
  assert.equal(children.length, 0);
  assert.deepEqual(await fs.readdir(userData), ["plugins.json"]);
});

test("enable waits for workspace, reload kills child and clears requests, next workspace restarts", async (t) => {
  const { host, children, events } = await fixture(t);
  await host.setEnabled("mcp", true);
  assert.equal(children.length, 0);
  await host.setReady(true);
  const child = children[0];
  assert.equal(child.sent[0].type, "initialize");
  child.emit("message", { type: "ready" });
  assert.equal(host.list()[0].status, "running");
  child.emit("message", {
    type: "request",
    requestId: "one",
    command: "read_canvas",
    arguments: { documentId: "a" },
  });
  assert.equal(events.at(-1).channel, "plugin-request");
  await host.setReady(false);
  assert.equal(child.killed, true);
  assert.equal(child.sent.at(-1).error.code, "HOST_UNAVAILABLE");
  assert.equal(host.pending.size, 0);
  host.respond({ requestId: "one", result: {} });
  child.emit("message", { type: "ready" });
  assert.equal(host.list()[0].status, "starting");
  await host.setReady(true);
  assert.equal(children.length, 2);
  await host.setEnabled("mcp", false);
  assert.equal(children[1].killed, true);
  assert.equal(host.list()[0].status, "disabled");
});

test("invalid commands, oversized input and queue overflow never reach renderer", async (t) => {
  const { host, children, events } = await fixture(t);
  await host.setEnabled("mcp", true);
  await host.setReady(true);
  const child = children[0];
  child.emit("message", {
    type: "request",
    requestId: "evil",
    command: "eval",
    arguments: {},
  });
  assert.equal(child.sent.at(-1).error.code, "INVALID_ARGUMENTS");
  child.emit("message", {
    type: "request",
    requestId: "large",
    command: "read_canvas",
    arguments: { data: "a".repeat(2 * 1024 * 1024) },
  });
  assert.equal(child.sent.at(-1).error.code, "INVALID_ARGUMENTS");
  assert.equal(
    events.filter((event) => event.channel === "plugin-request").length,
    0,
  );
  for (let index = 0; index < 33; index++) {
    child.emit("message", {
      type: "request",
      requestId: `${index}`,
      command: "list_canvases",
      arguments: {},
    });
  }
  assert.equal(child.sent.at(-1).error.code, "BUSY");
  assert.equal(host.pending.size, 32);
});

test("responses time out, valid response completes once, and occupied port becomes actionable state", async (t) => {
  const { host, children } = await fixture(t, { requestTimeout: 10 });
  await host.setEnabled("mcp", true);
  await host.setReady(true);
  const child = children[0];
  child.emit("message", {
    type: "request",
    requestId: "timeout",
    command: "list_canvases",
    arguments: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.sent.at(-1).error.code, "TIMEOUT");
  child.emit("message", {
    type: "request",
    requestId: "ok",
    command: "list_canvases",
    arguments: {},
  });
  host.respond({ requestId: "ok", result: { canvases: [] } });
  assert.equal(child.sent.at(-1).result.canvases.length, 0);
  const count = child.sent.length;
  host.respond({ requestId: "ok", result: {} });
  assert.equal(child.sent.length, count);
  child.emit("message", { type: "error", code: "EADDRINUSE" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(host.list()[0].status, "error");
  assert.match(host.list()[0].error, /端口/);
});

test("configuration rejects invalid plugin/ports and preserves token across restart", async (t) => {
  const { host, children, configuration } = await fixture(t);
  assert.throws(() => host.setEnabled("unknown", true), /未知/);
  assert.throws(() => host.configure("mcp", { port: 80 }), /端口/);
  assert.throws(
    () => host.configure("mcp", { port: 40000, token: "replacement" }),
    /端口/,
  );
  await host.setEnabled("mcp", true);
  await host.setReady(true);
  await host.configure("mcp", { port: 43210 });
  assert.equal(children[0].killed, true);
  assert.equal(children[1].sent[0].port, 43210);
  const restored = await new PluginHost(configuration).initialize();
  assert.equal(restored.list()[0].port, 43210);
  assert.equal(restored.list()[0].enabled, true);
  assert.equal(restored.list()[0].token, host.list()[0].token);
});

test("built-in manifest registry isolates configuration, processes and capabilities per plugin", async (t) => {
  const registry = ["one", "two"].map((id, index) => ({
    id,
    name: id,
    version: "1",
    description: id,
    commands: index ? ["read_canvas"] : ["list_canvases"],
    defaultPort: 43123 + index,
    entrypoint: `/builtin/${id}.cjs`,
  }));
  const { host, children, configuration, userData } = await fixture(t, {
    registry,
  });
  await host.setReady(true);
  await host.setEnabled("one", true);
  await host.setEnabled("two", true);
  assert.equal(children.length, 2);
  children[0].emit("message", {
    type: "request",
    requestId: "cross",
    command: "read_canvas",
    arguments: {},
  });
  assert.equal(children[0].sent.at(-1).error.code, "INVALID_ARGUMENTS");
  await host.configure("one", { port: 44001 });
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, undefined);
  await host.setEnabled("one", false);
  assert.equal(children[1].killed, undefined);
  const restored = (await new PluginHost(configuration).initialize()).list();
  assert.equal(restored[0].enabled, false);
  assert.equal(restored[0].port, 44001);
  assert.equal(restored[1].enabled, true);
  assert.equal(restored[1].port, 43124);
  assert.notEqual(restored[0].token, restored[1].token);
  const saved = JSON.parse(
    await fs.readFile(path.join(userData, "plugins.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(saved.plugins), ["one", "two"]);
});

test(
  "rapid toggles and port changes wait for asynchronous exit and identical toggles are idempotent",
  { timeout: 5000 },
  async (t) => {
    const { host, children } = await fixture(t);
    await host.setReady(true);
    await host.setEnabled("mcp", true);
    const first = children[0];
    let confirmFirstKill;
    const firstKilled = new Promise((resolve) => {
      confirmFirstKill = resolve;
    });
    first.kill = () => {
      first.killed = true;
      confirmFirstKill();
    };
    await host.setEnabled("mcp", true);
    assert.equal(children.length, 1);
    const disable = host.setEnabled("mcp", false);
    const enable = host.setEnabled("mcp", true);
    await firstKilled;
    assert.equal(children.length, 1);
    assert.equal(first.killed, true);
    first.emit("exit", 0);
    await Promise.all([disable, enable]);
    assert.equal(children.length, 2);
    const second = children[1];
    let confirmSecondKill;
    const secondKilled = new Promise((resolve) => {
      confirmSecondKill = resolve;
    });
    second.kill = () => {
      second.killed = true;
      confirmSecondKill();
    };
    const reconfigure = host.configure("mcp", { port: 44000 });
    await secondKilled;
    assert.equal(children.length, 2);
    second.emit("exit", 0);
    await reconfigure;
    assert.equal(children.length, 3);
    assert.equal(children[2].sent[0].port, 44000);
  },
);

test("a child that does not exit prevents another fork after bounded shutdown", async (t) => {
  const { host, children } = await fixture(t, { stopTimeout: 15 });
  await host.setReady(true);
  await host.setEnabled("mcp", true);
  const child = children[0];
  child.kill = () => {
    child.killed = true;
  };
  const configure = host.configure("mcp", { port: 44000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await configure;
  assert.equal(children.length, 1);
  assert.equal(host.list()[0].status, "error");
  child.emit("exit", 0);
});

test("corrupt plugin configuration preserves evidence and does not stop the application", async (t) => {
  const { host, configuration, userData } = await fixture(t);
  const damaged = "{damaged plugin settings";
  await fs.writeFile(path.join(userData, "plugins.json"), damaged);
  const recovered = await new PluginHost(configuration).initialize();
  assert.equal(recovered.list()[0].status, "error");
  await recovered.setReady(true);
  await assert.rejects(recovered.setEnabled("mcp", true), /配置损坏/);
  assert.equal(
    await fs.readFile(path.join(userData, "plugins.json"), "utf8"),
    damaged,
  );
  assert.equal(host.list()[0].enabled, false);
});

test("built-in presentation commands are whitelisted while external paths are not added by the host", async (t) => {
  const { host, children, events } = await fixture(t);
  await host.setEnabled("mcp", true);
  await host.setReady(true);
  const child = children[0];
  for (const command of [
    "get_capabilities",
    "close_document",
    "control_canvas",
    "create_presentation",
    "read_presentation",
    "update_presentation",
    "control_presentation",
    "export_presentation",
    "save_presentation",
  ]) {
    assert.equal(COMMANDS.has(command), true);
    assert.equal(host.list()[0].capabilities.includes(command), true);
    child.emit("message", {
      type: "request",
      requestId: command,
      command,
      arguments: { documentId: "deck" },
    });
    assert.equal(events.at(-1).channel, "plugin-request");
    assert.deepEqual(events.at(-1).value.arguments, { documentId: "deck" });
    host.respond({ requestId: command, result: {} });
  }
  child.emit("message", {
    type: "request",
    requestId: "grant",
    command: "grant_path",
    arguments: { path: "/external" },
  });
  assert.equal(child.sent.at(-1).error.code, "INVALID_ARGUMENTS");
});
