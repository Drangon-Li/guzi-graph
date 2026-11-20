const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createCanvasLoopback,
  createGraphCloud,
  sealer,
} = require("./cloud.cjs");
const { toolSchemas } = require("./mcp-service.cjs");

test("cloud loopback exposes exactly the local MCP tools and keeps their validation", async (t) => {
  const calls = [];
  const loopback = createCanvasLoopback(async (command, args) => {
    calls.push({ command, args });
    return { result: { ok: true, command } };
  });
  t.after(() => loopback.close());

  const tools = await loopback.list();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(toolSchemas).sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
  }

  const result = await loopback.call(
    "list_canvases",
    {},
    { signal: new AbortController().signal },
  );
  assert.deepEqual(result.structuredContent, {
    ok: true,
    command: "list_canvases",
  });
  assert.deepEqual(calls, [{ command: "list_canvases", args: {} }]);

  const invalid = await loopback.call(
    "read_canvas",
    { unexpected: true },
    { signal: new AbortController().signal },
  );
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 1, "invalid arguments never reach the canvas");
});

test("host failures become MCP tool errors instead of transport errors", async (t) => {
  const plugins = {
    execute: async () => {
      throw Object.assign(new Error("画布工作区尚未就绪。"), {
        code: "HOST_UNAVAILABLE",
      });
    },
  };
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-cloud-"));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const cloud = await createGraphCloud({
    userData,
    appVersion: "0.8.11",
    platform: "darwin",
    plugins,
    safeStorage: { isEncryptionAvailable: () => false },
    send: () => {},
  }).initialize();
  t.after(() => cloud.dispose());
  const result = await cloud.link.tools.call(
    "list_canvases",
    {},
    { signal: new AbortController().signal },
  );
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /HOST_UNAVAILABLE/);
  const stat = await fs.stat(path.join(userData, "guzi-cloud.json"));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("session tokens are sealed with safeStorage when it is available", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from([...text].reverse().join("")),
    decryptString: (buffer) => [...buffer.toString()].reverse().join(""),
  };
  const { encrypt, decrypt } = sealer(storage);
  const sealed = encrypt("gzs_secret");
  assert.ok(sealed.startsWith("safe:"));
  assert.ok(!sealed.includes("gzs_secret"));
  assert.equal(decrypt(sealed), "gzs_secret");
  const plain = sealer({ isEncryptionAvailable: () => false });
  assert.equal(plain.encrypt("gzs_secret"), "gzs_secret");
});
