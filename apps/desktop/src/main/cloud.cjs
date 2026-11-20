// 谷子云端 MCP：用谷子账号登录后，经 wss://mcp.guzilab.com 把 AI 客户端的工具调用转到这台电脑。
// 工具面与本地 MCP 完全相同：在主进程里用内存传输直连同一个 createCanvasServer，
// 不监听任何端口；画布命令照常经 PluginHost 转给渲染进程执行。
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");

const { createCanvasServer } = require("./mcp-service.cjs");
const { CloudLink, createFileStorage } = require("./cloud-link.mjs");
const { atomicWrite } = require("./storage.cjs");

const CALL_TIMEOUT = 110000;
const SEALED_PREFIX = "safe:";

function deviceName() {
  return (
    os
      .hostname()
      .replace(/\.local$/i, "")
      .trim() || "Mac"
  );
}

function createCanvasLoopback(execute) {
  let connecting = null;
  const connect = () => {
    connecting ??= (async () => {
      const server = createCanvasServer(execute);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "guzi-cloud-link", version: "1.0.0" });
      await client.connect(clientSide);
      return client;
    })().catch((error) => {
      connecting = null;
      throw error;
    });
    return connecting;
  };
  return {
    async list() {
      const { tools } = await (await connect()).listTools();
      return tools;
    },
    async call(name, args, { signal }) {
      return (await connect()).callTool(
        { name, arguments: args },
        { signal, timeout: CALL_TIMEOUT },
      );
    },
    async close() {
      const client = await connecting?.catch(() => null);
      connecting = null;
      await client?.close();
    },
  };
}

/** 会话 token 用系统钥匙串（Electron safeStorage）加密后再写盘。 */
function sealer(safeStorage) {
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    encrypt: (text) =>
      available()
        ? SEALED_PREFIX + safeStorage.encryptString(text).toString("base64")
        : text,
    decrypt: (text) =>
      text.startsWith(SEALED_PREFIX)
        ? safeStorage.decryptString(
            Buffer.from(text.slice(SEALED_PREFIX.length), "base64"),
          )
        : text,
  };
}

function createGraphCloud({
  userData,
  appVersion,
  platform,
  plugins,
  safeStorage,
  send,
  accountOrigin,
  mcpOrigin,
  log = () => {},
}) {
  const execute = (command, args) =>
    plugins.execute(command, args, undefined, { includeManagement: true }).then(
      (result) => ({ result }),
      (error) => ({
        error: {
          code: error.code || "HOST_UNAVAILABLE",
          message: error.message || "画布工作区不可用。",
        },
      }),
    );
  const loopback = createCanvasLoopback(execute);
  const { encrypt, decrypt } = sealer(safeStorage);
  const storage = createFileStorage({
    file: path.join(userData, "guzi-cloud.json"),
    encrypt,
    decrypt,
    writeFile: async (file, text) => {
      await atomicWrite(file, text);
      await fs.chmod(file, 0o600);
    },
  });
  const link = new CloudLink({
    app: "graph",
    appVersion,
    platform,
    deviceName,
    storage,
    tools: loopback,
    accountOrigin,
    mcpOrigin,
    log,
  });
  link.on("state", (state) => send("cloud-state", state));
  return {
    link,
    async initialize() {
      await link.initialize();
      return this;
    },
    async dispose() {
      link.dispose();
      await loopback.close();
    },
  };
}

module.exports = { createGraphCloud, createCanvasLoopback, sealer, deviceName };
