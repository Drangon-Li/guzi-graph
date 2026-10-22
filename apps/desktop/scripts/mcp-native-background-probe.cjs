const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomBytes, createHash } = require("node:crypto");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

const repository = path.resolve(__dirname, "../../..");
const artifacts = path.join(repository, "output/mcp-native-background-probe");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const executable = option(
  "--executable",
  path.join(
    repository,
    "apps/desktop/release/mac-arm64/Excalidraw-Guzi.app/Contents/MacOS/Excalidraw-Guzi",
  ),
);
const sourceArgument = option("--source");
assert.ok(
  sourceArgument && !sourceArgument.startsWith("--"),
  "--source <path> is required for an existing presentation",
);
const source = path.resolve(sourceArgument);
assert.ok(fsSync.statSync(source).isFile(), "--source must point to a file");
const rounds = Number(option("--rounds", 3));
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3);
const report = {
  startedAt: new Date().toISOString(),
  executable,
  source,
  rounds,
  calls: [],
  exports: [],
  diagnostics: [],
  errors: [],
  ownedPids: [],
};
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (data) => createHash("sha256").update(data).digest("hex");
let runDirectory;
let application;
let client;
let endpoint;
let token;
let documentId;
let serial = 0;
let cleaning;
const owned = new Map();
const scrub = (value) =>
  token ? String(value).split(token).join("[REDACTED]") : String(value);
const log = (event) => {
  const entry = { at: new Date().toISOString(), ...event };
  console.log(JSON.stringify(entry));
  if (runDirectory)
    fsSync.appendFileSync(
      path.join(runDirectory, "timeline.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
};
const bounded = (promise, label, milliseconds) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const processes = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), command };
    });
const remember = () => {
  const snapshot = processes();
  if (application?.pid) {
    const main = snapshot.find((item) => item.pid === application.pid);
    if (main) owned.set(main.pid, main.command);
  }
  let changed;
  do {
    changed = false;
    for (const item of snapshot)
      if (owned.has(item.parent) && !owned.has(item.pid)) {
        owned.set(item.pid, item.command);
        changed = true;
      }
  } while (changed);
  return snapshot.filter((item) => owned.get(item.pid) === item.command);
};
const decode = (response) =>
  response.structuredContent ||
  JSON.parse(response.content.find((item) => item.type === "text").text);
async function call(name, args = {}, allowError = false) {
  remember();
  const start = performance.now();
  log({
    phase: "start",
    name,
    documentId: args.documentId,
    format: args.format,
  });
  try {
    const response = await bounded(
      client.callTool({ name, arguments: args }),
      name,
      40000,
    );
    const result = decode(response);
    const entry = {
      name,
      milliseconds: Math.round(performance.now() - start),
      isError: !!response.isError,
      revision: result.revision,
      ...(response.isError ? { error: result.error } : {}),
    };
    report.calls.push(entry);
    log({ phase: "finish", ...entry });
    if (response.isError && !allowError)
      throw Object.assign(
        new Error(`${name}: ${JSON.stringify(result.error)}`),
        { toolError: result.error },
      );
    return { response, result };
  } catch (error) {
    log({
      phase: "failure",
      name,
      milliseconds: Math.round(performance.now() - start),
      message: scrub(error.message),
    });
    throw error;
  } finally {
    remember();
  }
}
async function diagnose(reason) {
  log({ phase: "diagnose", reason });
  const snapshot = remember();
  await fs.writeFile(
    path.join(runDirectory, "processes.json"),
    JSON.stringify(snapshot, null, 2),
  );
  const targets = [
    application?.pid,
    ...snapshot
      .filter((item) => /Renderer|Helper/.test(item.command))
      .map((item) => item.pid),
  ]
    .filter(Boolean)
    .slice(0, 4);
  for (const pid of targets) {
    const output = path.join(runDirectory, `sample-${pid}.txt`);
    try {
      await promisify(execFile)(
        "/usr/bin/sample",
        [String(pid), "3", "1", "-file", output],
        { timeout: 8000 },
      );
      report.diagnostics.push({ pid, sample: output });
    } catch (error) {
      report.diagnostics.push({ pid, error: scrub(error.message) });
    }
  }
  log({ phase: "diagnose-complete", pids: targets });
}
async function clean() {
  return (cleaning ??= (async () => {
    await bounded(
      client?.close() || Promise.resolve(),
      "client close",
      3000,
    ).catch(() => {});
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const alive = remember();
      for (const item of alive.reverse()) {
        try {
          process.kill(item.pid, signal);
        } catch {}
      }
      if (alive.length) await sleep(signal === "SIGTERM" ? 1200 : 300);
    }
    report.ownedPids = [...owned.keys()];
    report.residualPids = remember().map((item) => item.pid);
    report.sourceUnchanged =
      digest(await fs.readFile(source)) === report.sourceHash;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(runDirectory, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await fs.writeFile(
      path.join(artifacts, "latest-report.json"),
      JSON.stringify(report, null, 2),
    );
    log({
      phase: "cleanup",
      residualPids: report.residualPids,
      sourceUnchanged: report.sourceUnchanged,
      report: path.join(runDirectory, "report.json"),
    });
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    report.errors.push(signal);
    void clean().finally(() => process.exit(1));
  });

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  runDirectory = await fs.mkdtemp(path.join(artifacts, "run-"));
  report.runDirectory = runDirectory;
  const profile = path.join(runDirectory, "profile");
  const drawings = path.join(runDirectory, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  const original = await fs.readFile(source);
  assert.equal(JSON.parse(original).slides.length, 8);
  report.sourceHash = digest(original);
  const fixture = path.join(drawings, "八页中文原生串行副本.guzi-presentation");
  await fs.writeFile(fixture, original);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  token = randomBytes(32).toString("hex");
  endpoint = `http://127.0.0.1:${port}/mcp`;
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  await fs.writeFile(
    path.join(profile, "session.json"),
    JSON.stringify({ paths: [fixture], activePath: fixture }),
  );
  await fs.writeFile(
    path.join(profile, "plugins.json"),
    JSON.stringify({
      version: 1,
      plugins: { mcp: { enabled: true, port, token } },
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const output = fsSync.openSync(
    path.join(runDirectory, "application.log"),
    "a",
    0o600,
  );
  application = spawn(executable, [], {
    env,
    stdio: ["ignore", output, output],
  });
  fsSync.closeSync(output);
  application.on("error", (error) =>
    log({ phase: "spawn-error", message: scrub(error.message) }),
  );
  log({
    phase: "launched",
    pid: application.pid,
    runDirectory,
    port,
    debugging: false,
  });
  const startup = performance.now();
  while (performance.now() - startup < 20000) {
    if (application.exitCode !== null)
      throw new Error(`Application exited ${application.exitCode}`);
    const listening = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(200);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) break;
    await sleep(250);
  }
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  client = new Client({
    name: "guzi-native-background-probe",
    version: "1.0.0",
  });
  await bounded(
    client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    ),
    "MCP startup",
    Math.max(1, 20000 - (performance.now() - startup)),
  );
  log({
    phase: "connected",
    milliseconds: Math.round(performance.now() - startup),
  });
  let listed = (await call("list_canvases")).result;
  let opened = listed.canvases.find(
    (item) => item.path === fixture && item.initialized,
  );
  if (!opened) opened = (await call("open_canvas", { path: fixture })).result;
  documentId = opened.documentId;
  for (let round = 1; round <= rounds; round++) {
    log({ phase: "round", round });
    const deck = (await call("read_presentation", { documentId })).result;
    assert.equal(deck.slides.length, 8);
    const slideId = deck.slides[(round - 1) % deck.slides.length].id;
    await call("update_presentation", {
      documentId,
      expectedRevision: deck.revision,
      requestId: `select-${++serial}`,
      operation: { type: "select", slideId },
    });
    const scene = (await call("read_canvas", { documentId, slideId })).result;
    await call("apply_operations", {
      documentId,
      slideId,
      expectedRevision: scene.revision,
      requestId: `edit-${++serial}`,
      operations: [
        {
          type: "create",
          tempId: `native-marker-${round}`,
          element: {
            type: "text",
            x: 32,
            y: 678,
            text: `原生串行对照 第${round}轮`,
            fontSize: 14,
          },
        },
      ],
    });
    await sleep(1000);
    const saved = (await call("save_presentation", { documentId })).result;
    assert.equal(saved.dirty, false);
    for (const format of ["png", "pdf"]) {
      const { response, result } = await call("export_presentation", {
        documentId,
        format,
        ...(format === "png" ? { slideId } : {}),
      });
      const embedded = response.content.find(
        (item) =>
          item.type === "image" ||
          (item.type === "resource" && item.resource?.blob),
      );
      const base64 =
        embedded?.type === "image"
          ? embedded.data
          : embedded?.resource?.blob || result.file?.data || result.image?.data;
      assert.ok(base64, `Missing ${format} resource`);
      const buffer = Buffer.from(base64, "base64");
      const target = path.join(runDirectory, `round-${round}.${format}`);
      await fs.writeFile(target, buffer);
      report.exports.push({
        round,
        format,
        bytes: buffer.length,
        path: target,
      });
      log({ phase: "export-written", round, format, bytes: buffer.length });
    }
    await call("close_document", { documentId });
    const reopened = (await call("open_canvas", { path: saved.path })).result;
    assert.notEqual(reopened.documentId, documentId);
    documentId = reopened.documentId;
    assert.equal(
      (await call("read_presentation", { documentId })).result.slides.length,
      8,
    );
    report.completedRounds = round;
    if (round < rounds) {
      log({ phase: "idle-start", milliseconds: 60000 });
      await sleep(60000);
      log({ phase: "idle-end" });
    }
  }
  report.passed = true;
}
main()
  .catch(async (error) => {
    report.errors.push(scrub(error.stack || error));
    log({ phase: "probe-failed", message: scrub(error.message) });
    if (client && documentId) {
      try {
        const read = await call("read_presentation", { documentId }, true);
        report.readAfterFailure = {
          isError: !!read.response.isError,
          revision: read.result.revision,
          slides: read.result.slides?.length,
        };
        log({ phase: "read-after-failure", ...report.readAfterFailure });
      } catch (failure) {
        report.readAfterFailure = { error: scrub(failure.message) };
      }
    }
    await diagnose(error.message);
    process.exitCode = 1;
  })
  .finally(clean);
