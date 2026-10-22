const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const repository = path.resolve(desktopDirectory, "../..");
const clientNames = ["codex", "claude"].filter(
  (name) =>
    process.argv.includes("--clients") || process.argv.includes(`--${name}`),
);
const packagedIndex = process.argv.indexOf("--executable");
const artifacts = path.join(
  repository,
  "output/playwright",
  `mcp-e2e${packagedIndex >= 0 ? "-packaged" : ""}${
    clientNames.length ? `-${clientNames.join("-")}` : ""
  }`,
);
const executablePath =
  packagedIndex >= 0 ? process.argv[packagedIndex + 1] : require("electron");
const children = new Set();
let application;
let page;
let client;
let token = "";
let endpoint = "";
let cleanup;

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

const clean = () =>
  (cleanup ??= (async () => {
    for (const child of children) child.kill("SIGTERM");
    const process = application?.process();
    const deadline = setTimeout(() => process?.kill("SIGKILL"), 15000);
    try {
      await client?.close().catch(() => {});
      if (application) {
        await page
          ?.evaluate(() => window.desktop.setPluginEnabled("mcp", false))
          .catch(() => {});
        await application.close().catch(() => process?.kill("SIGTERM"));
      }
    } finally {
      clearTimeout(deadline);
    }
  })());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void clean().finally(() => process.exit(1)));
}

const runCli = (name, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(name, args, {
      cwd,
      env: { ...process.env, GUZI_MCP_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    let events = "";
    const append = (chunk) => {
      output += chunk.toString();
      events += chunk.toString();
      const lines = events.split("\n");
      events = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (
            event.type === "item.completed" &&
            event.item?.type === "mcp_tool_call"
          ) {
            console.log(`${name}: ${event.item.tool} ${event.item.status}`);
          }
        } catch {}
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      children.delete(child);
      reject(error);
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      children.delete(child);
      await fs.writeFile(
        path.join(artifacts, `${name}.log`),
        output.split(token).join("[REDACTED]"),
      );
      if (code !== 0)
        reject(new Error(`${name} exited ${code}; see its integration log`));
      else resolve(output);
    });
  });

const drawingPrompt = (name) =>
  `You are verifying the Guzi MCP integration. Use only the guzi MCP tools, never shell or file tools. Perform real calls, do not merely describe them. Create a new canvas titled "${name}". Read its revision. Use apply_operations to create two rectangles (180 by 100, at x=0 and x=320, y=0), labels "Input" and "Output", and an arrow connecting them using temporary IDs. Read the canvas again. In a separate apply_operations call with the current expectedRevision, patch the Output rectangle backgroundColor to "#b2f2bb" and y to 80 using the real element ID. Save the canvas with save_canvas. Read it again to verify. Report the documentId, file path and whether the saved canvas has the changed rectangle. Retry only a revision conflict by reading again; report any other error honestly. Every apply_operations requires a unique requestId. Operations use {type:"create",tempId:"input",element:{type:"rectangle",x:0,y:0,width:180,height:100,label:{text:"Input"}}} and {type:"patch",id:"real-id",patch:{backgroundColor:"#b2f2bb",y:80}}. An arrow skeleton uses start:{id:"input"}, end:{id:"output"}, x:180,y:50,width:140,height:0.`;

const assertHandDrawn = (elements) => {
  for (const element of elements.filter((element) => !element.isDeleted)) {
    assert.equal(element.roughness, 1);
    assert.equal(element.strokeWidth, 2);
    if (element.type === "rectangle") {
      assert.deepEqual(element.roundness, { type: 3 });
    } else if (element.type === "arrow") {
      assert.deepEqual(element.roundness, { type: 2 });
    } else if (element.type === "text") {
      assert.equal(element.fontFamily, 5);
    }
  }
};

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const isolated = await fs.mkdtemp("/private/tmp/guzi-mcp-e2e-");
  const drawings = path.join(isolated, "drawings");
  const profile = path.join(isolated, "profile");
  await fs.mkdir(drawings);
  await fs.mkdir(profile);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  application = await _electron.launch({
    executablePath,
    args: packagedIndex >= 0 ? [] : [desktopDirectory],
    env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile },
    timeout: 60000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const port = await freePort();
  await page.getByRole("spinbutton", { name: "本地端口" }).fill(String(port));
  await page.getByRole("button", { name: "应用端口", exact: true }).click();
  await page.getByRole("switch", { name: "启用插件" }).click();
  await page.getByText("运行中", { exact: true }).waitFor();
  const plugin = await page.evaluate(
    async () => (await window.desktop.getPlugins())[0],
  );
  assert.equal(plugin.status, "running", plugin.error || plugin.status);
  token = plugin.token;
  endpoint = plugin.endpoint;
  assert.equal(endpoint, `http://127.0.0.1:${port}/mcp`);
  await page.screenshot({
    path: path.join(artifacts, "market.png"),
    fullPage: true,
  });
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://untrusted.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({ name: "guzi-electron-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
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
    ].sort(),
  );
  assert.match(client.getInstructions(), /hand-drawn/i);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return (
      result.structuredContent ||
      JSON.parse(result.content.find((entry) => entry.type === "text").text)
    );
  };
  const created = await call("create_canvas", {
    title: "SDK MCP verification",
  });
  const before = await call("read_canvas", { documentId: created.documentId });
  const batch = {
    documentId: created.documentId,
    expectedRevision: before.revision,
    requestId: "sdk-create-1",
    operations: [
      {
        type: "create",
        tempId: "a",
        element: {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 180,
          height: 100,
          label: { text: "Input" },
        },
      },
      {
        type: "create",
        tempId: "b",
        element: {
          type: "rectangle",
          x: 320,
          y: 0,
          width: 180,
          height: 100,
          label: { text: "Output" },
        },
      },
      {
        type: "create",
        tempId: "link",
        element: {
          type: "arrow",
          x: 180,
          y: 50,
          width: 140,
          height: 0,
          start: { id: "a" },
          end: { id: "b" },
        },
      },
    ],
  };
  const applied = await call("apply_operations", batch);
  const replay = await call("apply_operations", batch);
  assert.deepEqual(replay.idMap, applied.idMap);
  const current = await call("read_canvas", { documentId: created.documentId });
  assert.equal(
    current.elements.filter((element) => !element.isDeleted).length,
    5,
  );
  const conflict = await client.callTool({
    name: "apply_operations",
    arguments: {
      ...batch,
      requestId: "stale",
      operations: [{ type: "patch", id: applied.idMap.b, patch: { y: 500 } }],
    },
  });
  assert.equal(conflict.isError, true);
  await call("apply_operations", {
    documentId: created.documentId,
    expectedRevision: current.revision,
    requestId: "sdk-patch-1",
    operations: [
      {
        type: "patch",
        id: applied.idMap.b,
        patch: { y: 80, backgroundColor: "#b2f2bb" },
      },
    ],
  });
  const image = await client.callTool({
    name: "export_canvas",
    arguments: { documentId: created.documentId, format: "png" },
  });
  const png = image.content.find((entry) => entry.type === "image");
  assert.ok(png);
  await fs.writeFile(
    path.join(artifacts, "drawing.png"),
    Buffer.from(png.data, "base64"),
  );
  await call("save_canvas", { documentId: created.documentId });
  const saved = await call("read_canvas", { documentId: created.documentId });
  assert.equal(saved.dirty, false);
  const disk = JSON.parse(await fs.readFile(saved.path, "utf8"));
  assertHandDrawn(disk.elements);
  const listed = await call("list_canvases");
  assert.ok(
    listed.canvases.some((canvas) => canvas.documentId === created.documentId),
  );
  const reopened = await call("open_canvas", { path: saved.path });
  assert.equal(reopened.documentId, created.documentId);
  assert.equal(
    disk.elements.find((element) => element.id === applied.idMap.b)
      .backgroundColor,
    "#b2f2bb",
  );
  await page.screenshot({
    path: path.join(artifacts, "sdk-canvas.png"),
    fullPage: true,
  });
  const report = {
    isolated,
    executablePath,
    electronPid: application.process().pid,
    endpoint,
    sdk: {
      path: saved.path,
      elements: disk.elements.length,
      tools: tools.tools.map((tool) => tool.name),
    },
    clients: [],
  };
  if (clientNames.length) {
    const config = path.join(isolated, "mcp.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          guzi: {
            type: "http",
            url: endpoint,
            headers: { Authorization: "Bearer ${GUZI_MCP_TOKEN}" },
          },
        },
      }),
      { mode: 0o600 },
    );
    if (clientNames.includes("codex"))
      await runCli(
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
          drawings,
          "-c",
          `mcp_servers.guzi.url="${endpoint}"`,
          "-c",
          'mcp_servers.guzi.bearer_token_env_var="GUZI_MCP_TOKEN"',
          "-c",
          'mcp_servers.guzi.tools.apply_operations.approval_mode="approve"',
          "-c",
          'approval_policy="never"',
          drawingPrompt("Codex MCP verification"),
        ],
        drawings,
      );
    if (clientNames.includes("claude"))
      await runCli(
        "claude",
        [
          "-p",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--mcp-config",
          config,
          "--setting-sources",
          "",
          "--tools",
          "",
          "--allowedTools",
          "mcp__guzi__*",
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "stream-json",
          "--verbose",
          drawingPrompt("Claude MCP verification"),
        ],
        drawings,
      );
    for (const name of clientNames.map(
      (entry) => `${entry === "codex" ? "Codex" : "Claude"} MCP verification`,
    )) {
      const files = await fs.readdir(drawings);
      const file = files.find(
        (entry) => entry.startsWith(name) && entry.endsWith(".excalidraw"),
      );
      assert.ok(file, `${name} must save a real file`);
      const content = JSON.parse(
        await fs.readFile(path.join(drawings, file), "utf8"),
      );
      assertHandDrawn(content.elements);
      assert.ok(
        content.elements.some(
          (element) =>
            element.type === "rectangle" &&
            element.backgroundColor === "#b2f2bb" &&
            element.y === 80,
        ),
      );
      assert.ok(
        content.elements.some(
          (element) =>
            element.type === "arrow" &&
            element.startBinding &&
            element.endBinding,
        ),
      );
      report.clients.push({
        name,
        path: path.join(drawings, file),
        elements: content.elements.length,
      });
    }
    await page.screenshot({
      path: path.join(artifacts, "client-canvas.png"),
      fullPage: true,
    });
  }
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await clean();
  await assert.rejects(fetch(endpoint));
  console.log("MCP stopped and port released.");
}

main().catch(async (error) => {
  console.error(error);
  await page
    ?.screenshot({ path: path.join(artifacts, "failure.png"), timeout: 5000 })
    .catch(() => {});
  await clean();
  process.exitCode = 1;
});
