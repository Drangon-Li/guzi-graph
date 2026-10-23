const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { execFileSync, spawn } = require("node:child_process");
const { _electron } = require("playwright");
const { COMMANDS } = require("../src/main/plugins.cjs");
const {
  enableMcpInSettings,
  waitForMcpReady,
} = require("./mcp-settings-ui.cjs");

const desktopDirectory = path.resolve(__dirname, "..");
const artifacts = path.resolve(
  desktopDirectory,
  "../../output/playwright/mcp-plugins-e2e",
);
const report = { steps: [], pageErrors: [], ownedPids: [], remainingPids: [] };
const owned = new Map();
let application;
let page;
let client;
let isolated;
let cleaning;
let agent;

const processes = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return (
        match && {
          pid: Number(match[1]),
          parent: Number(match[2]),
          command: match[3],
        }
      );
    })
    .filter(Boolean);
const remember = () => {
  const snapshot = processes();
  for (const pid of [application?.process()?.pid, agent?.pid]) {
    const main = snapshot.find((entry) => entry.pid === pid);
    if (main) owned.set(main.pid, main.command);
  }
  let changed;
  do {
    changed = false;
    for (const entry of snapshot) {
      if (owned.has(entry.parent) && !owned.has(entry.pid)) {
        owned.set(entry.pid, entry.command);
        changed = true;
      }
    }
  } while (changed);
};
const closeApplication = async () => {
  agent?.kill("SIGTERM");
  if (!application) return;
  remember();
  const current = application;
  const timer = setTimeout(() => current.process()?.kill("SIGKILL"), 10000);
  try {
    await client?.close().catch(() => {});
    client = null;
    await page
      ?.evaluate(() => window.desktop.setPluginHostReady(false))
      .catch(() => {});
    await current.close().catch(() => current.process()?.kill("SIGTERM"));
  } finally {
    clearTimeout(timer);
    application = null;
  }
};
const clean = () =>
  (cleaning ??= (async () => {
    await closeApplication();
    for (let attempt = 0; attempt < 20; attempt++) {
      const remaining = processes().filter(
        (entry) => owned.get(entry.pid) === entry.command,
      );
      if (!remaining.length) break;
      if (attempt === 10)
        for (const entry of remaining) process.kill(entry.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report.ownedPids = [...owned.keys()];
    report.remainingPids = processes()
      .filter((entry) => owned.get(entry.pid) === entry.command)
      .map((entry) => entry.pid);
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void clean().finally(() => process.exit(1)));
const step = (message) => {
  report.steps.push(message);
  console.log(message);
  remember();
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
const rawCall = (name, args = {}) => client.callTool({ name, arguments: args });
const call = async (name, args = {}) => {
  const response = await rawCall(name, args);
  assert.ok(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
  return (
    response.structuredContent ??
    JSON.parse(response.content.find((entry) => entry.type === "text").text)
  );
};
const launch = async (profile) => {
  application = await _electron.launch({
    executablePath: require("electron"),
    args: [desktopDirectory, `--user-data-dir=${profile}`],
    env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile },
    timeout: 60000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.getByLabel("测试版", { exact: true }).waitFor();
  remember();
};
const connect = async (service) => {
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({
    name: "guzi-plugin-development-e2e",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${service.token}` } },
    }),
  );
};
const market = async () => {
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
};
const enable = async (name) => {
  await market();
  const card = page.getByRole("article", { name, exact: true });
  await card.getByRole("switch").click();
  await card.getByText("运行中", { exact: true }).waitFor();
  return card;
};
const disable = (id) =>
  page.evaluate(
    (pluginId) => window.desktop.setUserPluginEnabled(pluginId, false),
    id,
  );
const makePlugin = (
  id,
  source,
  permissions = [],
  commands = [{ id: "run", title: "运行测试" }],
) => ({
  manifest: {
    id,
    name: id,
    description: "端到端测试插件",
    version: "1.0.0",
    apiVersion: 1,
    permissions,
    commands,
  },
  source,
});

const runCodexDevelopment = (service, directory) =>
  new Promise((resolve, reject) => {
    const prompt = `You are verifying that Codex can develop a Guzi plugin using only the guzi MCP tools. Do not use shell, file, browser or web tools. First call get_plugin_development_guide and get_plugin_api_schema. Develop your own new API 1 plugin package with id "codex-agent-plugin", name "Codex 插件示例", version "1.0.0", and command id "add-diamond" titled "插入 Codex 图形". Do not copy the guide's note example. The command must use the guzi SDK to find the initialized ordinary active canvas, read its revision and add one diamond at x=700,y=300,width=220,height=120, backgroundColor="#d0ebff", label:{text:"Codex 插件 API 验证"}, preserving default hand-drawn style. Declare the required permissions, register the async command during initialization, and perform work only when the command is run. Use a unique requestId. Call validate_plugin, fix any validation error, then install_plugin and verify with list_plugins that it remains disabled. Do not enable or run it; the test user will enable it in Market. Report its id. Make real MCP calls, do not merely describe them.`;
    const child = spawn(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        "-C",
        directory,
        "-c",
        `mcp_servers.guzi.url=${JSON.stringify(service.endpoint)}`,
        "-c",
        'mcp_servers.guzi.bearer_token_env_var="GUZI_MCP_TOKEN"',
        "-c",
        'mcp_servers.guzi.tools.install_plugin.approval_mode="approve"',
        "-c",
        'approval_policy="never"',
        prompt,
      ],
      {
        cwd: directory,
        env: { ...process.env, GUZI_MCP_TOKEN: service.token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    agent = child;
    remember();
    const sampling = setInterval(remember, 1000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearInterval(sampling);
      agent = null;
      reject(error);
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      clearInterval(sampling);
      agent = null;
      try {
        await fs.writeFile(
          path.join(artifacts, "codex-development.log"),
          output.split(service.token).join("[REDACTED]"),
        );
        assert.equal(
          code,
          0,
          "Codex development client failed; see codex-development.log",
        );
        const calls = output.split("\n").flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === "item.completed" &&
              event.item?.type === "mcp_tool_call" &&
              event.item.status === "completed"
              ? [event.item.tool]
              : [];
          } catch {
            return [];
          }
        });
        for (const name of [
          "get_plugin_development_guide",
          "get_plugin_api_schema",
          "validate_plugin",
          "install_plugin",
        ]) {
          assert.ok(
            calls.some((tool) => tool.includes(name)),
            `Codex must actually call ${name}`,
          );
        }
        report.codexTools = calls;
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp("/private/tmp/guzi-plugin-e2e-");
  const profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  await launch(profile);
  await market();
  assert.equal(
    await page.getByRole("article", { name: "Guzi MCP", exact: true }).count(),
    0,
  );
  const service = await enableMcpInSettings(page, await freePort(), {
    screenshotPath: path.join(artifacts, "mcp-settings.png"),
  });
  await connect(service);
  assert.deepEqual(
    new Set((await client.listTools()).tools.map((tool) => tool.name)),
    COMMANDS,
  );
  const guide = await call("get_plugin_development_guide");
  assert.match(guide, /guzi\.registerCommand/);
  const schema = await call("get_plugin_api_schema");
  assert.ok(schema.commands.apply_operations.inputSchema);
  const example = schema.example;
  assert.equal(
    (await call("validate_plugin", { plugin: example })).valid,
    true,
  );
  await call("install_plugin", { plugin: example });
  assert.equal((await call("list_plugins")).plugins[0].enabled, false);
  assert.equal(
    (
      await rawCall("run_plugin_command", {
        id: example.manifest.id,
        commandId: "insert-note",
      })
    ).isError,
    true,
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  step(
    "MCP settings, discovery, development schema and disabled installation passed",
  );

  const exampleCard = await enable(example.manifest.name);
  await page.screenshot({
    path: path.join(artifacts, "market.png"),
    fullPage: true,
  });
  await exampleCard
    .getByRole("button", { name: "插入手绘便签", exact: true })
    .click();
  await page.locator(".desktop-projects").waitFor({ state: "hidden" });
  const listing = await call("list_canvases");
  const documentId = listing.activeDocumentId;
  assert.ok(documentId);
  let scene;
  for (let attempt = 0; attempt < 100; attempt++) {
    scene = await call("read_canvas", { documentId });
    if (JSON.stringify(scene.elements).includes("记录一个好想法")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(JSON.stringify(scene.elements).includes("记录一个好想法"));
  await call("run_plugin_command", {
    id: example.manifest.id,
    commandId: "insert-note",
    args: { text: "MCP 插件开发成功", x: 420 },
  });
  const modified = await call("read_canvas", { documentId });
  assert.ok(JSON.stringify(modified.elements).includes("MCP 插件开发成功"));
  await call("save_canvas", { documentId });
  await page.screenshot({
    path: path.join(artifacts, "plugin-canvas.png"),
    fullPage: true,
  });
  await disable(example.manifest.id);
  step(
    "Guide example enabled in Market, ran from UI and MCP, and saved real canvas changes",
  );

  if (process.argv.includes("--codex")) {
    step("Starting real Codex plugin development through MCP");
    await runCodexDevelopment(service, drawings);
    const developed = await call("get_plugin", { id: "codex-agent-plugin" });
    const installed = (await call("list_plugins")).plugins.find(
      (entry) => entry.manifest.id === developed.manifest.id,
    );
    assert.equal(installed.enabled, false);
    await enable(developed.manifest.name);
    await call("run_plugin_command", {
      id: developed.manifest.id,
      commandId: "add-diamond",
    });
    const result = await call("read_canvas", { documentId });
    assert.ok(JSON.stringify(result.elements).includes("Codex 插件 API 验证"));
    await call("save_canvas", { documentId });
    await disable(developed.manifest.id);
    step(
      "Real Codex read development APIs, authored and installed its own plugin; its command changed the canvas",
    );
  }

  const probe = makePlugin(
    "isolation-probe",
    `guzi.registerCommand("run", async () => {
    let denied;
    try { await guzi.call("create_canvas", {title:"forbidden"}); } catch(error) { denied = error.code; }
    return { node:typeof process, require:typeof require, dom:typeof document, desktop:typeof desktop, network:typeof fetch, workers:typeof Worker, denied };
  });`,
  );
  await call("install_plugin", { plugin: probe });
  await enable(probe.manifest.name);
  const isolatedResult = (
    await call("run_plugin_command", {
      id: probe.manifest.id,
      commandId: "run",
    })
  ).result;
  assert.deepEqual(isolatedResult, {
    node: "undefined",
    require: "undefined",
    dom: "undefined",
    desktop: "undefined",
    network: "undefined",
    workers: "undefined",
    denied: "PERMISSION_DENIED",
  });
  await disable(probe.manifest.id);
  step(
    "Real isolated Worker denied Node, DOM, desktop bridge, network and undeclared canvas writes",
  );

  const storagePlugin = makePlugin(
    "storage-probe",
    `guzi.registerCommand("run", async () => {
    const count = (await guzi.storage.get("count") || 0) + 1;
    await guzi.storage.set("count", count); return {count};
  });`,
    ["storage"],
  );
  await call("install_plugin", { plugin: storagePlugin });
  await enable(storagePlugin.manifest.name);
  assert.equal(
    (
      await call("run_plugin_command", {
        id: storagePlugin.manifest.id,
        commandId: "run",
      })
    ).result.count,
    1,
  );
  const invalid = { ...storagePlugin, source: "guzi.registerCommand(" };
  assert.equal(
    (await rawCall("update_plugin", { plugin: invalid })).isError,
    true,
  );
  assert.equal(
    (await call("list_plugins")).plugins.find(
      (entry) => entry.manifest.id === storagePlugin.manifest.id,
    ).status,
    "running",
  );
  const update = {
    ...storagePlugin,
    manifest: { ...storagePlugin.manifest, version: "1.0.1" },
  };
  await call("update_plugin", { plugin: update });
  assert.equal(
    (await call("list_plugins")).plugins.find(
      (entry) => entry.manifest.id === storagePlugin.manifest.id,
    ).enabled,
    false,
  );
  await enable(storagePlugin.manifest.name);
  assert.equal(
    (
      await call("run_plugin_command", {
        id: storagePlugin.manifest.id,
        commandId: "run",
      })
    ).result.count,
    2,
  );
  step(
    "Invalid update preserved running plugin; valid update stopped it and preserved private storage",
  );

  const spin = makePlugin(
    "cancel-probe",
    'guzi.registerCommand("run", () => { while (true) {} });',
  );
  await call("install_plugin", { plugin: spin });
  const spinCard = await enable(spin.manifest.name);
  const pending = rawCall("run_plugin_command", {
    id: spin.manifest.id,
    commandId: "run",
  });
  assert.ok((await call("get_capabilities")).canvas);
  await spinCard.getByRole("switch").click();
  await spinCard.getByText("已停用", { exact: true }).waitFor();
  assert.equal((await pending).isError, true);
  step(
    "Infinite-loop plugin left workspace responsive and could be stopped in Market",
  );

  const startup = makePlugin("startup-cancel-probe", "while (true) {}");
  await call("install_plugin", { plugin: startup });
  await market();
  const startupCard = page.getByRole("article", {
    name: startup.manifest.name,
    exact: true,
  });
  await startupCard.getByRole("switch").click();
  await startupCard.getByText("启动中", { exact: true }).waitFor();
  const cancelStarted = Date.now();
  await startupCard.getByRole("switch").click();
  await startupCard.getByText("已停用", { exact: true }).waitFor();
  assert.ok(
    Date.now() - cancelStarted < 5000,
    "A hung startup must stop before its 30s timeout",
  );
  step(
    "Plugin stuck during initialization could be stopped immediately from Market",
  );

  const oldToken = service.token;
  const oldPort = service.port;
  await closeApplication();
  await launch(profile);
  const restoredService = await waitForMcpReady(page);
  assert.equal(restoredService.token, oldToken);
  assert.equal(restoredService.port, oldPort);
  await connect(restoredService);
  await page.waitForFunction(
    async () =>
      (
        await window.desktop.getUserPlugins()
      ).find((entry) => entry.manifest.id === "storage-probe")?.status ===
      "running",
  );
  assert.equal(
    (
      await call("run_plugin_command", {
        id: storagePlugin.manifest.id,
        commandId: "run",
      })
    ).result.count,
    3,
  );
  step("Restart restored enabled plugins, private storage, MCP token and port");
  await market();
  const restoredCard = page.getByRole("article", {
    name: storagePlugin.manifest.name,
    exact: true,
  });
  await restoredCard
    .getByRole("button", { name: "卸载插件", exact: true })
    .click();
  await restoredCard
    .getByRole("button", { name: "确认卸载", exact: true })
    .click();
  await restoredCard.waitFor({ state: "detached" });
  assert.ok(
    !(await call("list_plugins")).plugins.some(
      (entry) => entry.manifest.id === storagePlugin.manifest.id,
    ),
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  step("Market uninstall removed plugin and no main-window errors occurred");
}

const deadline = setTimeout(
  () => {
    report.error = "Plugin E2E exceeded its deadline";
    void clean().finally(() => process.exit(1));
  },
  process.argv.includes("--codex") ? 360000 : 180000,
);
main()
  .catch(async (error) => {
    report.error = error.stack;
    console.error(error.stack);
    await page
      ?.screenshot({
        path: path.join(artifacts, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(deadline);
    await clean();
    if (report.remainingPids.length) {
      console.error(
        `Owned processes remain: ${report.remainingPids.join(", ")}`,
      );
      process.exitCode = 1;
    }
    console.log(`Artifacts: ${artifacts}`);
  });
