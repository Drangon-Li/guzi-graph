const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { _electron } = require("playwright");
const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const host = process.argv[2] ?? "lsl";
const port = Number(process.argv[3] ?? 27832);
assert.match(host, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(desktop, "../../output/playwright/mcp-ssh");
const endpoint = "http://127.0.0.1:" + port + "/mcp";
const report = {
  passed: false,
  host,
  mac: { platform: process.platform, arch: process.arch },
  endpoint,
  steps: {},
};
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ControlPath=none",
  "-o",
  "ClearAllForwardings=no",
  "-o",
  "StrictHostKeyChecking=yes",
];
const children = new Set();
const owned = new Map();
let isolated;
let profile;
let launching;
let application;
let electronPid;
let tunnel;
let token;
let cleanupTask;
let stopped = false;

// This function runs either here or under Node on the remote Linux host.
async function mcpPhase({
  port,
  token,
  phase,
  documentId,
  linuxMarker,
  macMarker,
}) {
  const assert = require("node:assert/strict");
  const { randomUUID } = require("node:crypto");
  const os = require("node:os");
  const protocolVersion = "2025-11-25";
  const endpoint = "http://127.0.0.1:" + port + "/mcp";
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  let id = 0;
  const responses = {};
  const request = async (method, params = {}, { notification, auth } = {}) => {
    const requestId = notification ? undefined : ++id;
    const response = await fetch(endpoint, {
      method: "POST",
      headers:
        auth === undefined
          ? headers
          : { ...headers, Authorization: "Bearer " + auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const status = response.status;
    const type = response.headers.get("content-type") ?? "";
    if (auth !== undefined || notification) {
      await response.body?.cancel();
      return status;
    }
    assert.equal(status, 200, method + " HTTP status");
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    let result;
    if (type.startsWith("application/json")) {
      result = await response.json();
    } else {
      assert.ok(type.startsWith("text/event-stream"), method + " content type");
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      try {
        while (!result) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          for (;;) {
            const end = /\r?\n\r?\n/.exec(buffer);
            if (!end) break;
            const data = buffer
              .slice(0, end.index)
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            buffer = buffer.slice(end.index + end[0].length);
            if (!data) continue;
            const message = JSON.parse(data);
            if (message.id === requestId) {
              result = message;
              break;
            }
          }
        }
      } finally {
        await reader.cancel();
      }
    }
    assert.ok(
      result?.id === requestId && !result.error,
      method + " JSON-RPC result",
    );
    responses[params.name ?? method] = { status, type };
    return result.result;
  };
  const call = async (name, args = {}) => {
    const result = await request("tools/call", { name, arguments: args });
    assert.ok(!result.isError, name + " returned an MCP tool error");
    return (
      result.structuredContent ??
      JSON.parse(result.content.find((entry) => entry.type === "text").text)
    );
  };
  const invalid =
    phase === "linux-write"
      ? await request("initialize", {}, { auth: "invalid-e2e-token" })
      : undefined;
  if (invalid !== undefined) assert.equal(invalid, 401);
  const init = await request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "guzi-ssh-e2e-" + phase, version: "1.0.0" },
  });
  assert.equal(init.serverInfo.name, "guzi-canvas");
  assert.equal(init.protocolVersion, protocolVersion);
  headers["Mcp-Protocol-Version"] = init.protocolVersion;
  assert.equal(
    await request("notifications/initialized", {}, { notification: true }),
    202,
  );
  const append = async (canvas, marker, y) => {
    const applied = await call("apply_operations", {
      documentId,
      expectedRevision: canvas.revision,
      requestId: randomUUID(),
      operations: [
        {
          type: "create",
          tempId: "marker",
          element: {
            type: "text",
            x: 80,
            y,
            fontSize: 32,
            text: marker,
          },
        },
      ],
    });
    assert.ok(applied.idMap.marker, "Missing new marker ID");
  };
  const read = () => call("read_canvas", { documentId });
  const platform = {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    node: process.version,
  };
  if (phase === "linux-write") {
    assert.equal(platform.platform, "linux");
    const tools = (await request("tools/list")).tools
      .map(({ name }) => name)
      .sort();
    for (const required of [
      "create_canvas",
      "read_canvas",
      "apply_operations",
      "save_canvas",
    ]) {
      assert.ok(tools.includes(required), "Missing tool: " + required);
    }
    documentId = (await call("create_canvas", { title: "SSH MCP Round Trip" }))
      .documentId;
    const before = await read();
    assert.equal(before.elements.length, 0);
    await append(before, linuxMarker, 80);
    await call("save_canvas", { documentId });
    const saved = await read();
    assert.equal(saved.dirty, false);
    const marker = saved.elements.find(
      (element) => !element.isDeleted && element.text === linuxMarker,
    );
    assert.ok(marker, "Linux write is missing from saved canvas");
    return {
      platform,
      init: init.serverInfo,
      protocolVersion: init.protocolVersion,
      invalid,
      tools,
      documentId,
      marker: marker.text,
      path: saved.path,
      responses,
    };
  }
  if (phase === "mac-write") {
    const before = await read();
    assert.ok(
      before.elements.some(
        (element) => !element.isDeleted && element.text === linuxMarker,
      ),
      "Mac could not read the Linux marker",
    );
    await append(before, macMarker, 158);
    await call("save_canvas", { documentId });
    return { marker: macMarker, responses };
  }
  assert.equal(phase, "linux-read");
  assert.equal(platform.platform, "linux");
  const saved = await read();
  const markers = saved.elements
    .filter((element) => !element.isDeleted)
    .map((element) => element.text);
  assert.deepEqual(markers, [linuxMarker, macMarker]);
  assert.equal(saved.dirty, false);
  return { platform, markers, dirty: saved.dirty, responses };
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const socket = require("node:net").connect(port, "127.0.0.1");
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => resolve(error.code));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Loopback probe timed out"));
    });
  });
}

const remote = async (script, input) => {
  const command = "node -e '" + script.replaceAll("'", "'\\''") + "'";
  const child = startSsh([...sshOptions, "-T", host, command], input);
  const timer = setTimeout(() => child.kill("SIGTERM"), 55_000);
  try {
    const [code, signal] = await child.closed;
    assert.equal(
      code,
      0,
      "Linux probe exited " + (signal ?? code) + ": " + child.stderrText(),
    );
    return JSON.parse(child.stdoutText());
  } finally {
    clearTimeout(timer);
  }
};

const remoteProbe = () =>
  remote(
    "(" + probe + ")(" + port + ").then(x => console.log(JSON.stringify(x)))",
  );
const remotePhase = (args) =>
  remote(
    "let input=''; process.stdin.setEncoding('utf8').on('data', c => input+=c).on('end', async () => {" +
      "try { console.log(JSON.stringify(await (" +
      mcpPhase +
      ")(JSON.parse(input)))); }" +
      "catch (error) { console.error(error.message); process.exitCode=1; } });",
    args,
  );

function startSsh(args, input) {
  assert.ok(!stopped, "Run interrupted");
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (data) => {
    out += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    err += data;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  child.closed = once(child, "close");
  child.closed.catch(() => {});
  child.once("close", () => children.delete(child));
  child.stdoutText = () => out;
  child.stderrText = () => err;
  return child;
}

async function stopSsh(child) {
  if (!child || !children.has(child)) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await child.closed;
  } finally {
    clearTimeout(timer);
  }
}

function scanOwned() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: 3000,
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              command: match[3],
            },
          ]
        : [];
    });
  let pids = new Set(
    rows
      .filter(
        ({ pid, command }) =>
          (pid === electronPid && !owned.has(pid)) ||
          (profile &&
            command.split(" ").includes("--user-data-dir=" + profile)) ||
          owned.get(pid) === command,
      )
      .map(({ pid }) => pid),
  );
  for (;;) {
    const previous = pids.size;
    for (const { pid, parent } of rows) if (pids.has(parent)) pids.add(pid);
    if (previous === pids.size) break;
  }
  return rows.filter(({ pid, command }) => {
    if (!pids.has(pid)) return false;
    owned.set(pid, command);
    return true;
  });
}

async function until(read, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function closeElectron() {
  await launching?.catch(() => {});
  scanOwned();
  if (application) {
    let timer;
    try {
      await Promise.race([
        application.close(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } catch {
      // Processes identified below are still cleaned up if Playwright has disconnected.
    } finally {
      clearTimeout(timer);
    }
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const { pid } of scanOwned()) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (
      await until(
        () => !scanOwned().length,
        "Electron still running",
        2000,
      ).catch(() => false)
    )
      return;
  }
  assert.equal(
    scanOwned().length,
    0,
    "Electron processes remained after cleanup",
  );
}

const redact = (message) =>
  token ? message.replaceAll(token, "[REDACTED]") : message;

function cleanup() {
  cleanupTask ??= (async () => {
    const results = await Promise.allSettled([
      ...[...children].map(stopSsh),
      closeElectron(),
    ]);
    const errors = results
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => redact(String(reason)));
    const remaining = scanOwned().map(({ pid }) => pid);
    if (isolated) {
      await fs
        .rm(isolated, { recursive: true, force: true })
        .catch((error) => errors.push(String(error)));
    }
    report.cleanup = {
      electronPids: [...owned.keys()],
      remainingElectronPids: remaining,
      remainingSshPids: [...children].map(({ pid }) => pid),
      remoteFilesCreated: false,
      temporaryProfileRemoved: isolated
        ? await fs.access(isolated).then(
            () => false,
            () => true,
          )
        : null,
      errors,
    };
    if (remaining.length || children.size || errors.length)
      report.passed = false;
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  })();
  return cleanupTask;
}

function interrupt(reason) {
  if (stopped) return;
  stopped = true;
  report.error = reason;
  report.passed = false;
  void cleanup().finally(() => process.exit(1));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => interrupt("Interrupted by " + signal));
}

async function main() {
  report.steps.macPortBefore = await probe(port);
  assert.equal(
    report.steps.macPortBefore,
    "ECONNREFUSED",
    "Mac loopback port must be free",
  );
  report.steps.linuxPortBefore = await remoteProbe();
  assert.equal(
    report.steps.linuxPortBefore,
    "ECONNREFUSED",
    "Linux loopback port must be free",
  );

  isolated = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "guzi-mcp-ssh-"),
  );
  profile = path.join(isolated, "profile");
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
  assert.ok(!stopped, "Run interrupted");
  launching = _electron
    .launch({
      executablePath: require("electron"),
      args: [desktop, "--user-data-dir=" + profile],
      env: {
        ...process.env,
        EXCALIDRAW_DESKTOP_USER_DATA: profile,
        EXCALIDRAW_DESKTOP_DEV_URL: "",
      },
      timeout: 30000,
    })
    .then((current) => {
      application = current;
      electronPid = current.process().pid;
      scanOwned();
      return current;
    });
  await launching;
  assert.ok(!stopped, "Run interrupted");
  const runtime = await application.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1320, 850);
    return { profile: app.getPath("userData"), version: app.getVersion() };
  });
  assert.equal(runtime.profile, profile);
  report.mac.version = runtime.version;
  report.mac.electronPid = electronPid;
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  const plugin = await enableMcpInSettings(page, port);
  assert.equal(plugin.endpoint, endpoint);
  const config = JSON.parse(
    await fs.readFile(path.join(profile, "plugins.json"), "utf8"),
  );
  token = config.plugins.mcp.token;
  assert.ok(/^[a-f0-9]{64}$/.test(token), "Isolated MCP credential format");
  report.steps.macService = "running";

  const reverse = "127.0.0.1:" + port + ":127.0.0.1:" + port;
  tunnel = startSsh([
    ...sshOptions,
    "-vNT",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-R",
    reverse,
    host,
  ]);
  report.tunnel = { pid: tunnel.pid, reverse };
  await until(
    () => {
      if (!children.has(tunnel))
        throw new Error("SSH tunnel exited: " + tunnel.stderrText());
      return tunnel.stderrText().includes("remote forward success for:");
    },
    "SSH did not confirm reverse forwarding",
    15000,
  );
  report.steps.linuxPortDuring = await remoteProbe();
  assert.equal(report.steps.linuxPortDuring, "connected");
  console.log("Reverse loopback tunnel confirmed on Linux");

  const id = randomUUID().slice(0, 8);
  const args = {
    port,
    token,
    linuxMarker: "Linux SSH wrote " + id,
    macMarker: "Mac replied " + id,
  };
  const written = await remotePhase({ ...args, phase: "linux-write" });
  const { documentId, path: savedPath, ...evidence } = written;
  report.steps.linuxWrite = {
    ...evidence,
    documentId,
    filename: path.basename(savedPath),
  };
  assert.equal(path.dirname(savedPath), drawings);
  const disk = JSON.parse(await fs.readFile(savedPath, "utf8"));
  assert.ok(disk.elements.some((element) => element.text === args.linuxMarker));
  report.steps.linuxWrite.diskVerifiedOnMac = true;
  await page
    .locator("canvas.excalidraw__canvas")
    .first()
    .waitFor({ state: "visible" });
  await page.keyboard.press("Shift+1");
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: path.join(artifacts, "linux-write-on-mac.png"),
    animations: "disabled",
  });
  report.steps.linuxWrite.screenshot = "linux-write-on-mac.png";
  console.log(
    "Linux listed tools, created, edited and saved a canvas; Mac disk verified",
  );

  report.steps.macWrite = await mcpPhase({
    ...args,
    documentId,
    phase: "mac-write",
  });
  report.steps.linuxReadBack = await remotePhase({
    ...args,
    documentId,
    phase: "linux-read",
  });
  await page.keyboard.press("Shift+1");
  await page.screenshot({
    path: path.join(artifacts, "round-trip-on-mac.png"),
    animations: "disabled",
  });
  report.steps.linuxReadBack.screenshot = "round-trip-on-mac.png";
  console.log("Linux read both markers after the local Mac edit");

  await stopSsh(tunnel);
  report.steps.linuxPortAfter = await remoteProbe();
  assert.equal(
    report.steps.linuxPortAfter,
    "ECONNREFUSED",
    "Linux port remained reachable after stopping the tunnel",
  );
  report.steps.linuxHttpAfter = await remote(
    "fetch(" +
      JSON.stringify(endpoint) +
      ", { method: 'POST', signal: AbortSignal.timeout(3000) })" +
      ".then(r => console.log(JSON.stringify(r.status)), e => console.log(JSON.stringify(e.cause?.code ?? e.name)))",
  );
  assert.equal(report.steps.linuxHttpAfter, "ECONNREFUSED");
  report.steps.macPortWithTunnelClosed = await probe(port);
  assert.equal(report.steps.macPortWithTunnelClosed, "connected");
  report.passed = true;
}

const watchdog = setTimeout(
  () => interrupt("SSH MCP acceptance exceeded 150 seconds"),
  150000,
);
void (async () => {
  try {
    await main();
  } catch (error) {
    report.error = redact(error.stack || String(error));
    console.error(report.error);
  } finally {
    clearTimeout(watchdog);
    await cleanup();
    if (!stopped) {
      if (!report.passed) process.exitCode = 1;
      console.log("Report: " + path.join(artifacts, "report.json"));
    }
  }
})();
