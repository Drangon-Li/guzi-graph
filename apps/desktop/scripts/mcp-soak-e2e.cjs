const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { _electron } = require("playwright");

const desktopDirectory = path.resolve(__dirname, "..");
const repository = path.resolve(desktopDirectory, "../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const executablePath = option("--executable", require("electron"));
const sourceArgument = option("--source");
assert.ok(
  sourceArgument && !sourceArgument.startsWith("--"),
  "--source <path> is required for an existing presentation",
);
const sourcePath = path.resolve(sourceArgument);
assert.ok(
  fsSync.statSync(sourcePath).isFile(),
  "--source must point to a file",
);
const rounds = Number(option("--rounds", 5));
const pauseMs = Number(option("--pause-ms", 75000));
const withCodex = process.argv.includes("--codex");
const runLabel = option("--run-label", "");
assert.ok(
  !runLabel || /^[a-zA-Z0-9_-]+$/.test(runLabel),
  "--run-label must be a simple directory name",
);
const pdfFault = option("--pdf-fault", "none");
assert.ok(["none", "load", "print"].includes(pdfFault));
const artifacts = path.join(repository, "output/mcp-soak-e2e", runLabel);
const report = {
  executablePath,
  sourcePath,
  rounds,
  pauseMs,
  withCodex,
  runLabel,
  pdfFault,
  startedAt: new Date().toISOString(),
  calls: [],
  fetches: [],
  scenarios: [],
  diagnostics: [],
  rendererConsole: [],
  rendererRequests: [],
  pageErrors: [],
  rendererCrashes: [],
  errors: [],
  exports: [],
  memoryMetrics: [],
  exportProgress: { count: 0, bytes: 0 },
  launchedPids: [],
};
const clients = [];
const ownedPids = new Set();
const children = new Set();
let application;
let page;
let endpoint;
let token = "";
let profile;
let fixture;
let cleaning = false;
let cleanPromise;
let diagnosticPromise;
let serial = 0;
let canScreenshot = false;
let rendererCDP;

const contentBytes = (response) =>
  (response.content || []).reduce((total, item) => {
    const encoded =
      item.type === "image"
        ? item.data
        : item.type === "resource"
        ? item.resource.blob
        : undefined;
    if (encoded)
      return (
        total +
        Math.floor((encoded.length * 3) / 4) -
        (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
      );
    if (item.type === "resource" && item.resource.text)
      return total + Buffer.byteLength(item.resource.text);
    return total;
  }, 0);

function exported(response) {
  report.exportProgress.count += 1;
  report.exportProgress.bytes += contentBytes(response);
}

async function memoryMetrics(phase, details = {}) {
  if (!rendererCDP) return;
  const metric = {
    at: new Date().toISOString(),
    phase,
    ...details,
    exports: { ...report.exportProgress },
  };
  try {
    const heap = await bounded(
      rendererCDP.send("Runtime.getHeapUsage"),
      "renderer heap metrics",
      4000,
    );
    metric.heapUsed = heap.usedSize;
    metric.heapTotal = heap.totalSize;
    metric.embedderHeapUsed = heap.embedderHeapUsedSize;
    metric.backingStorage = heap.backingStorageSize;
  } catch (error) {
    metric.error = error.message;
  }
  report.memoryMetrics.push(metric);
  log({ ...metric, stage: metric.phase, phase: "renderer.memory" });
  return metric;
}

const digest = (data) => createHash("sha256").update(data).digest("hex");
const scrub = (text) =>
  token ? String(text).split(token).join("[REDACTED]") : String(text);
const bounded = (promise, name, ms = 10000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const log = (event) =>
  fsSync.appendFileSync(
    path.join(artifacts, "timeline.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
const step = (description) => {
  report.stage = description;
  console.log(`STEP ${description}`);
  log({ phase: "stage", description });
};
const decode = (response) =>
  response.structuredContent ||
  JSON.parse(response.content.find((item) => item.type === "text").text);
const snapshot = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,stat=,etime=,command="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            parent: Number(match[2]),
            state: match[3],
            elapsed: match[4],
            command: match[5],
          }
        : null;
    })
    .filter(Boolean);
function remember() {
  if (application) ownedPids.add(application.process().pid);
  for (const child of children) if (child.pid) ownedPids.add(child.pid);
  const rows = snapshot();
  let changed;
  do {
    changed = false;
    for (const row of rows)
      if (ownedPids.has(row.parent) && !ownedPids.has(row.pid)) {
        ownedPids.add(row.pid);
        changed = true;
      }
  } while (changed);
}

async function mainSnapshot() {
  return bounded(
    application.evaluate(({ BrowserWindow }) => {
      const probe = globalThis.__mcpSoakProbe;
      const now = Date.now();
      return {
        pid: process.pid,
        memory: process.memoryUsage(),
        resourceUsage: process.resourceUsage(),
        activeRequests: process
          ._getActiveRequests()
          .map((request) => ({ type: request.constructor.name })),
        activeHandles: process
          ._getActiveHandles()
          .map((handle) => handle.constructor.name),
        activeFS: [...probe.active.values()].map((item) => ({
          ...item,
          ageMs: now - item.started,
        })),
        ioEvents: probe.io.slice(-800),
        asyncFS: [...probe.asyncFS.values()].map((item) => ({
          ...item,
          ageMs: now - item.started,
        })),
        fsCounts: probe.fsCounts,
        rendererEvents: probe.rendererEvents,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          destroyed: window.isDestroyed(),
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          focused: window.isFocused(),
          rendererPid: window.webContents.getOSProcessId(),
          loading: window.webContents.isLoading(),
        })),
      };
    }),
    "main process diagnostic",
    4000,
  );
}

async function diagnostics(reason, wake = true) {
  return (diagnosticPromise ??= (async () => {
    const item = {
      reason: scrub(reason),
      at: new Date().toISOString(),
      processes: snapshot().filter((row) => ownedPids.has(row.pid)),
    };
    item.main = await mainSnapshot().catch((error) => ({
      error: error.message,
    }));
    const failedSave = [...report.calls]
      .reverse()
      .find((entry) => entry.failure && entry.name === "save_presentation");
    if (failedSave) {
      const start = Date.now();
      item.writeLockProbe = await bounded(
        clients[1]
          .callTool({
            name: "control_canvas",
            arguments: { documentId: failedSave.documentId, action: "fit" },
          })
          .then((response) => ({
            milliseconds: Date.now() - start,
            isError: !!response.isError,
            result: decode(response),
          })),
        "fit after save timeout",
        6000,
      ).catch((error) => ({
        milliseconds: Date.now() - start,
        error: error.message,
      }));
    }
    item.renderer = await bounded(
      page.evaluate(() => {
        const ownerDocument =
          document.querySelector(".desktop-workspace")?.ownerDocument ||
          document;
        return {
          visibility: ownerDocument.visibilityState,
          readyState: ownerDocument.readyState,
          title: ownerDocument.title,
          text: ownerDocument.body?.innerText.slice(-4000),
        };
      }),
      "renderer diagnostic",
      4000,
    ).catch((error) => ({ error: error.message }));
    if (canScreenshot)
      await bounded(
        page.screenshot({
          path: path.join(
            artifacts,
            `diagnostic-${report.diagnostics.length + 1}.png`,
          ),
          fullPage: true,
        }),
        "diagnostic screenshot",
        4000,
      ).catch(() => {});
    if (wake) {
      item.wake = await bounded(
        application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().startsWith("app:"),
          );
          if (!window) return false;
          window.restore();
          window.show();
          window.focus();
          return true;
        }),
        "raise test window",
        4000,
      ).catch((error) => ({ error: error.message }));
      const start = Date.now();
      item.afterWakeRead = await bounded(
        clients[2]
          .callTool({ name: "list_canvases", arguments: {} })
          .then((response) => ({
            elapsedMs: Date.now() - start,
            isError: !!response.isError,
            result: decode(response),
          })),
        "read after wake without restart",
        6000,
      ).catch((error) => ({
        elapsedMs: Date.now() - start,
        error: error.message,
      }));
      item.mainAfterWake = await mainSnapshot().catch((error) => ({
        error: error.message,
      }));
    }
    report.diagnostics.push(item);
    fsSync.writeFileSync(
      path.join(artifacts, `diagnostic-${report.diagnostics.length}.json`),
      scrub(JSON.stringify(item, null, 2)),
    );
    log({ phase: "diagnostic", reason: item.reason });
    return item;
  })().finally(() => {
    diagnosticPromise = null;
  }));
}

async function call(index, name, args = {}) {
  const entry = {
    client: index,
    name,
    documentId: args.documentId,
    slideId: args.slideId,
    format: args.format,
    action: args.action,
    phase: report.stage,
    startedAt: new Date().toISOString(),
  };
  report.calls.push(entry);
  log({ ...entry, operationStage: entry.phase, phase: "call.start" });
  const start = Date.now();
  try {
    const response = await bounded(
      clients[index].callTool({ name, arguments: args }),
      `${name} client ${index}`,
      40000,
    );
    entry.bodyCompletedAt = new Date().toISOString();
    entry.milliseconds = Date.now() - start;
    entry.isError = !!response.isError;
    const result = decode(response);
    if (response.isError) entry.error = result.error;
    log({ ...entry, operationStage: entry.phase, phase: "call.complete" });
    if (response.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
    if (name === "export_presentation" || name === "export_canvas")
      exported(response);
    await memoryMetrics(`sdk.${name}.complete`, {
      client: index,
      format: args.format,
      documentId: args.documentId,
    });
    assert.deepEqual(report.rendererCrashes, []);
    return { response, result };
  } catch (error) {
    entry.milliseconds = Date.now() - start;
    entry.failure = scrub(error.message);
    log({ ...entry, operationStage: entry.phase, phase: "call.failed" });
    await diagnostics(entry.failure);
    throw error;
  }
}

async function saveExport(response, format, round, pages = 8) {
  const output = path.join(artifacts, `round-${round}.${format}`);
  const block = response.content.find(
    (item) => item.type === (format === "png" ? "image" : "resource"),
  );
  const bytes =
    format === "png"
      ? Buffer.from(block.data, "base64")
      : Buffer.from(block.resource.blob, "base64");
  if (format === "png")
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  else assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  await fs.writeFile(output, bytes);
  if (format === "pdf") {
    const info = execFileSync("pdfinfo", [output], { encoding: "utf8" });
    assert.equal(Number(info.match(/^Pages:\s+(\d+)/m)?.[1]), pages);
    await fs.writeFile(
      path.join(artifacts, `round-${round}-pdfinfo.txt`),
      info,
    );
  }
  report.exports.push({
    format,
    round,
    path: output,
    bytes: bytes.length,
    ...(format === "pdf" ? { pages } : {}),
  });
  await memoryMetrics("export.artifact.saved", {
    format,
    round,
    bytes: bytes.length,
  });
}

async function observeDraft(documentId, marker) {
  const filename = path.join(profile, "drafts", `${documentId}.json`);
  const start = Date.now();
  while (Date.now() - start < 12000) {
    try {
      const content = await fs.readFile(filename, "utf8");
      if (content.includes(marker)) {
        const detail = {
          documentId,
          milliseconds: Date.now() - start,
          bytes: Buffer.byteLength(content),
        };
        log({ phase: "automatic-draft.observed", ...detail });
        return detail;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for a genuine automatic recovery draft");
}

async function controlledPdfFault(documentId, slideId, markerId) {
  step(
    `Controlled one-shot PDF ${pdfFault} fault and recovery without restarting Electron`,
  );
  await memoryMetrics("pdf.fault.before");
  const baseline = await application.evaluate(({ BrowserWindow }, mode) => {
    const fault = (globalThis.__mcpSoakPdfFault = {
      mode,
      armed: true,
      stage: "armed",
      windowId: null,
      originalLoadFile: BrowserWindow.prototype.loadFile,
    });
    const original = fault.originalLoadFile;
    const hook = function (filename, ...args) {
      if (
        !fault.armed ||
        !String(filename).includes("/excalidraw-pdf-") ||
        !String(filename).endsWith("/drawing.html")
      )
        return Reflect.apply(original, this, [filename, ...args]);
      fault.armed = false;
      fault.windowId = this.id;
      fault.contents = this.webContents;
      BrowserWindow.prototype.loadFile = original;
      if (mode === "load") {
        fault.stage = "load.pending";
        fault.triggeredAt = Date.now();
        return new Promise(() => {});
      }
      fault.originalPrint = this.webContents.printToPDF;
      this.webContents.printToPDF = function () {
        fault.stage = "print.pending";
        fault.triggeredAt = Date.now();
        this.printToPDF = fault.originalPrint;
        return new Promise(() => {});
      };
      fault.stage = "print.armed";
      return Reflect.apply(original, this, [filename, ...args]);
    };
    fault.hook = hook;
    BrowserWindow.prototype.loadFile = hook;
    return {
      pid: process.pid,
      windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
    };
  }, pdfFault);
  const started = Date.now();
  const entry = {
    client: 0,
    name: "export_presentation",
    documentId,
    format: "pdf",
    expectedFault: pdfFault,
    startedAt: new Date().toISOString(),
  };
  report.calls.push(entry);
  log({ phase: "pdf.fault.call.start", ...entry });
  let response;
  try {
    response = await bounded(
      clients[0].callTool({
        name: "export_presentation",
        arguments: { documentId, format: "pdf" },
      }),
      "controlled PDF deadline",
      28000,
    );
    entry.milliseconds = Date.now() - started;
    entry.isError = !!response.isError;
    entry.error = decode(response).error;
  } finally {
    entry.milliseconds = Date.now() - started;
    entry.windowState = await bounded(
      application.evaluate(({ BrowserWindow }) => {
        const fault = globalThis.__mcpSoakPdfFault;
        if (BrowserWindow.prototype.loadFile === fault.hook)
          BrowserWindow.prototype.loadFile = fault.originalLoadFile;
        if (
          fault.contents &&
          !fault.contents.isDestroyed() &&
          fault.originalPrint
        )
          fault.contents.printToPDF = fault.originalPrint;
        return {
          pid: process.pid,
          armed: fault.armed,
          stage: fault.stage,
          windowId: fault.windowId,
          triggeredAt: fault.triggeredAt,
          windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
          faultWindowAlive: BrowserWindow.getAllWindows().some(
            (window) => window.id === fault.windowId,
          ),
        };
      }),
      "restore PDF one-shot fault observer",
      4000,
    );
    log({ phase: "pdf.fault.call.complete", ...entry });
  }
  assert.equal(
    entry.windowState.armed,
    false,
    "The controlled PDF window must actually hit the injected fault",
  );
  assert.equal(entry.windowState.stage, `${pdfFault}.pending`);
  assert.equal(
    entry.isError,
    true,
    "The controlled PDF must return a tool error",
  );
  assert.match(entry.error?.message || "", /PDF/i);
  assert.ok(
    entry.milliseconds >= 18000 && entry.milliseconds < 28000,
    "The PDF deadline must fail before the outer 30s MCP timeout",
  );
  assert.equal(
    entry.windowState.faultWindowAlive,
    false,
    "The timed-out PDF window must be destroyed",
  );
  assert.deepEqual(
    [...entry.windowState.windowIds].sort(),
    [...baseline.windowIds].sort(),
    "No hidden PDF windows may remain after the deadline",
  );
  assert.equal(entry.windowState.pid, report.electronPid);
  await memoryMetrics("pdf.fault.returned-error", {
    milliseconds: entry.milliseconds,
  });
  const scene = (await call(1, "read_canvas", { documentId, slideId })).result;
  await call(0, "apply_operations", {
    documentId,
    slideId,
    expectedRevision: scene.revision,
    requestId: `pdf-fault-recovery-${++serial}`,
    operations: [
      {
        type: "patch",
        id: markerId,
        patch: { text: "SDK PDF fault recovered in the same process" },
      },
    ],
  });
  await call(0, "save_presentation", { documentId });
  const recovered = await call(2, "export_presentation", {
    documentId,
    format: "pdf",
  });
  await saveExport(recovered.response, "pdf", "fault-recovered");
  assert.equal(application.process().pid, baseline.pid);
  report.scenarios.push({
    name: "one-shot controlled PDF deadline and same-process recovery",
    mode: pdfFault,
    error: entry.error,
    milliseconds: entry.milliseconds,
    hiddenWindowsCleaned: true,
    recoverySavedAndExported: true,
    pid: baseline.pid,
  });
}

async function clean() {
  return (cleanPromise ??= (async () => {
    cleaning = true;
    remember();
    for (const child of children) child.kill("SIGTERM");
    report.finalMain = await mainSnapshot().catch((error) => ({
      error: error.message,
    }));
    await memoryMetrics("cleanup.before-close");
    await rendererCDP?.detach().catch(() => {});
    await Promise.allSettled(
      clients.map((client) => bounded(client.close(), "client close", 5000)),
    );
    if (application) {
      await bounded(
        page?.evaluate(() => window.desktop.setPluginEnabled("mcp", false)) ||
          Promise.resolve(),
        "disable MCP",
        4000,
      ).catch(() => {});
      const child = application.process();
      const deadline = setTimeout(() => child.kill("SIGTERM"), 10000);
      try {
        await bounded(
          application.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows())
              window.destroy();
          }),
          "destroy test windows",
          4000,
        );
        await bounded(application.close(), "Electron close", 10000);
      } catch {
        child.kill("SIGTERM");
      } finally {
        clearTimeout(deadline);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const alive = snapshot().filter((row) => ownedPids.has(row.pid));
      for (const row of alive) {
        try {
          process.kill(row.pid, signal);
        } catch {}
      }
      if (alive.length)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report.launchedPids = [...ownedPids];
    report.residualPids = snapshot()
      .filter((row) => ownedPids.has(row.pid))
      .map((row) => row.pid);
    assert.deepEqual(report.residualPids, []);
    if (endpoint) {
      await assert.rejects(
        fetch(endpoint, { signal: AbortSignal.timeout(3000) }),
      );
      report.endpointReleased = true;
    }
    if (profile) {
      assert.ok(profile.startsWith(`${artifacts}${path.sep}`));
      await fs.rm(profile, { recursive: true, force: true });
      report.profileRemoved = !fsSync.existsSync(profile);
    }
  })());
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(
    signal,
    () =>
      void clean().finally(() => {
        report.errors.push(`Interrupted by ${signal}`);
        fsSync.writeFileSync(
          path.join(artifacts, "report.json"),
          scrub(JSON.stringify(report, null, 2)),
        );
        process.exit(1);
      }),
  );

async function runCodex(slideId, markerId) {
  step(
    "Codex performs five edit/save/export/close/open rounds in the same Electron process",
  );
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "-C",
    path.dirname(fixture),
    "-c",
    `mcp_servers.guzi.url="${endpoint}"`,
    "-c",
    'mcp_servers.guzi.bearer_token_env_var="GUZI_MCP_TOKEN"',
    "-c",
    'approval_policy="never"',
  ];
  for (const tool of [
    "open_canvas",
    "close_document",
    "apply_operations",
    "save_presentation",
  ])
    args.push("-c", `mcp_servers.guzi.tools.${tool}.approval_mode="approve"`);
  args.push(
    `Use ONLY guzi MCP tools, no shell/file/browser tools. This is a stability test in one existing Electron process; do not restart the app. Open the CLOSED authorized presentation ${JSON.stringify(
      fixture,
    )}. It contains 8 slides. Target slideId ${JSON.stringify(
      slideId,
    )} and the existing text element ${JSON.stringify(
      markerId,
    )}. Perform exactly FIVE sequential rounds numbered 1 through 5. In EACH round: read_canvas for a fresh revision; apply_operations with a unique requestId to PATCH the existing text element text to exactly "Codex MCP soak round N" (N is that round number); save_presentation and await success; export_presentation PNG of that slide and then PDF of the entire deck (omit slideId for PDF), awaiting both actual exports; close_document and await success; open_canvas with the exact saved path; read_presentation and read_canvas and verify 8 slides and the exact round marker. Use the new documentId after every reopen. Do not create extra slides or elements. Keep default styles. Do not print base64 or SVG. Retry ONLY REVISION_CONFLICT by rereading. Stop immediately and report any other failure honestly. Finish by reporting all five rounds and the final documentId/path.`,
  );
  const child = spawn("codex", args, {
    cwd: path.dirname(fixture),
    env: { ...process.env, GUZI_MCP_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  remember();
  const events = [];
  const pending = { stdout: "", stderr: "" };
  let screenshots = Promise.resolve();
  let observerReads = Promise.resolve();
  const observedReopens = [];
  const append = (chunk, stream) => {
    pending[stream] += chunk.toString();
    const lines = pending[stream].split("\n");
    pending[stream] = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
      const sanitizedEvent = structuredClone(event);
      for (const block of sanitizedEvent.item?.result?.content || []) {
        if (block.data) block.data = "[media omitted]";
        if (block.resource?.blob) block.resource.blob = "[media omitted]";
      }
      fsSync.appendFileSync(
        path.join(artifacts, "codex.jsonl"),
        `${scrub(JSON.stringify(sanitizedEvent))}\n`,
      );
      if (
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call"
      ) {
        const item = event.item;
        console.log(`CODEX ${item.tool} ${item.status}`);
        log({
          phase: "codex.tool",
          tool: item.tool,
          status: item.status,
          format: item.arguments.format,
        });
        if (
          item.status === "completed" &&
          !item.error &&
          !item.result?.isError &&
          !item.result?.is_error
        ) {
          if (item.tool === "export_presentation") exported(item.result);
          void memoryMetrics(`codex.${item.tool}.complete`, {
            format: item.arguments.format,
            documentId: item.arguments.documentId,
          }).catch(() => {});
        }
        if (
          item.status !== "completed" ||
          item.error ||
          item.result?.isError ||
          item.result?.is_error
        )
          child.kill("SIGTERM");
        if (item.tool === "open_canvas")
          screenshots = screenshots.then(() =>
            bounded(
              page.screenshot({
                path: path.join(artifacts, "codex-reopened.png"),
                fullPage: true,
              }),
              "Codex screenshot",
              5000,
            ).catch(() => {}),
          );
        if (
          item.tool === "open_canvas" &&
          item.status === "completed" &&
          !item.error
        ) {
          const opened =
            item.result.structured_content ||
            item.result.structuredContent ||
            JSON.parse(
              item.result.content.find((block) => block.type === "text").text,
            );
          const expectedRound = events.filter(
            (event) =>
              event.type === "item.completed" &&
              event.item?.tool === "apply_operations",
          ).length;
          observerReads = observerReads
            .then(async () => {
              const results = await Promise.allSettled([
                call(1, "read_canvas", {
                  documentId: opened.documentId,
                  slideId,
                }),
                call(2, "list_canvases"),
              ]);
              const failure = results.find(
                (result) => result.status === "rejected",
              );
              if (failure) throw failure.reason;
              if (expectedRound)
                assert.ok(
                  results[0].value.result.elements.some(
                    (element) =>
                      element.id === markerId &&
                      element.text === `Codex MCP soak round ${expectedRound}`,
                  ),
                );
              observedReopens.push({
                round: expectedRound,
                documentId: opened.documentId,
                independentlyVerified: true,
              });
            })
            .catch((error) => {
              report.errors.push(`Codex observer: ${error.message}`);
              child.kill("SIGTERM");
            });
        }
      }
    }
  };
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));
  const tracker = setInterval(remember, 1000);
  const progress = setInterval(
    () =>
      console.log(
        `CODEX ${
          events.filter(
            (event) =>
              event.item?.type === "mcp_tool_call" &&
              event.type === "item.completed",
          ).length
        } tool calls completed`,
      ),
    30000,
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 900000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
    clearInterval(tracker);
    clearInterval(progress);
    children.delete(child);
  }
  await screenshots;
  await observerReads;
  const calls = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "mcp_tool_call",
    )
    .map((event) => event.item);
  const metadata = (item) =>
    item.result.structured_content ||
    item.result.structuredContent ||
    JSON.parse(item.result.content.find((block) => block.type === "text").text);
  for (const item of calls)
    assert.ok(
      item.status === "completed" &&
        !item.error &&
        !item.result?.isError &&
        !item.result?.is_error,
      `${item.tool} failed`,
    );
  assert.equal(code, 0, "Codex CLI must finish successfully");
  assert.ok(
    !events.some((event) =>
      ["command_execution", "file_change", "web_search"].includes(
        event.item?.type,
      ),
    ),
  );
  const patches = calls.filter((item) => item.tool === "apply_operations");
  assert.equal(patches.length, 5);
  for (let round = 1; round <= 5; round++) {
    assert.ok(
      patches[round - 1].arguments.operations.some(
        (operation) =>
          operation.type === "patch" &&
          operation.id === markerId &&
          operation.patch.text === `Codex MCP soak round ${round}`,
      ),
    );
    const begin = calls.indexOf(patches[round - 1]);
    const end = round === 5 ? calls.length : calls.indexOf(patches[round]);
    const batch = calls.slice(begin, end);
    const save = batch.find((item) => item.tool === "save_presentation");
    const close = batch.find((item) => item.tool === "close_document");
    const open = batch.find((item) => item.tool === "open_canvas");
    assert.ok(save && close && open && metadata(close).closed);
    assert.ok(
      batch.indexOf(save) < batch.indexOf(close) &&
        batch.indexOf(close) < batch.indexOf(open),
    );
    assert.notEqual(metadata(open).documentId, close.arguments.documentId);
    for (const format of ["png", "pdf"]) {
      const exported = batch.find(
        (item) =>
          item.tool === "export_presentation" &&
          item.arguments.format === format,
      );
      assert.ok(exported, `Codex round ${round} must export ${format}`);
      assert.ok(
        batch.indexOf(save) < batch.indexOf(exported) &&
          batch.indexOf(exported) < batch.indexOf(close),
      );
      await saveExport(exported.result, format, `codex-${round}`);
    }
    assert.ok(
      batch.some(
        (item) =>
          item.tool === "read_canvas" &&
          item.arguments.documentId === metadata(open).documentId &&
          metadata(item).elements.some(
            (element) =>
              element.id === markerId &&
              element.text === `Codex MCP soak round ${round}`,
          ),
      ),
    );
    assert.ok(
      batch.some(
        (item) =>
          item.tool === "read_presentation" &&
          item.arguments.documentId === metadata(open).documentId &&
          metadata(item).slides.length === 8,
      ),
    );
  }
  const sanitized = structuredClone(events);
  for (const event of sanitized)
    for (const block of event.item?.result?.content || []) {
      if (block.data) block.data = "[media omitted]";
      if (block.resource?.blob) block.resource.blob = "[media omitted]";
    }
  await fs.writeFile(
    path.join(artifacts, "codex.jsonl"),
    scrub(sanitized.map((event) => JSON.stringify(event)).join("\n")),
  );
  report.codex = {
    rounds: 5,
    observedReopens,
    calls: calls.map((item) => ({
      tool: item.tool,
      status: item.status,
      format: item.arguments.format,
    })),
    finalDocumentId: metadata(
      calls.filter((item) => item.tool === "open_canvas").at(-1),
    ).documentId,
  };
  const disk = JSON.parse(await fs.readFile(fixture, "utf8"));
  assert.ok(
    disk.slides
      .find((slide) => slide.id === slideId)
      .scene.elements.some(
        (element) =>
          element.id === markerId && element.text === "Codex MCP soak round 5",
      ),
  );
}

async function main() {
  assert.ok(Number.isInteger(rounds) && rounds >= 2);
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, "timeline.jsonl"), "");
  if (withCodex) await fs.writeFile(path.join(artifacts, "codex.jsonl"), "");
  const source = await fs.readFile(sourcePath);
  report.sourceHash = digest(source);
  assert.equal(JSON.parse(source).slides.length, 8);
  const isolated = await fs.mkdtemp(path.join(artifacts, "isolated-"));
  profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile);
  await fs.mkdir(drawings);
  fixture = path.join(drawings, "八页中文稳定性副本.guzi-presentation");
  await fs.writeFile(fixture, source);
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  report.fixture = fixture;
  report.profile = profile;
  step(
    "Launch one isolated Electron process and install bounded I/O observers",
  );
  application = await _electron.launch({
    executablePath,
    args: process.argv.includes("--executable") ? [] : [desktopDirectory],
    env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile },
    timeout: 60000,
  });
  report.electronPid = application.process().pid;
  application.process().on("exit", (code, signal) => {
    if (!cleaning)
      report.errors.push(`Unexpected Electron exit ${code}/${signal}`);
  });
  remember();
  await application.evaluate(({ app }) => {
    const io = process.getBuiltinModule("fs").promises;
    const asyncHooks = process.getBuiltinModule("async_hooks");
    const probe = (globalThis.__mcpSoakProbe = {
      active: new Map(),
      io: [],
      asyncFS: new Map(),
      fsCounts: {},
      rendererEvents: [],
      next: 0,
    });
    const observe = (object, method, label = method, openedPath) => {
      const original = object[method];
      object[method] = async function (...args) {
        const item = {
          id: ++probe.next,
          method: label,
          path:
            openedPath ??
            (label.startsWith("FileHandle.")
              ? undefined
              : typeof args[0] === "string"
              ? args[0].slice(0, 300)
              : undefined),
          started: Date.now(),
        };
        probe.active.set(item.id, item);
        try {
          const value = await Reflect.apply(original, this, args);
          if (method === "open")
            for (const stage of ["writeFile", "sync", "close"])
              observe(
                value,
                stage,
                `FileHandle.${stage}`,
                typeof args[0] === "string" ? args[0].slice(0, 300) : undefined,
              );
          return value;
        } catch (error) {
          item.error = error.code || error.message;
          throw error;
        } finally {
          item.milliseconds = Date.now() - item.started;
          probe.active.delete(item.id);
          probe.io.push(item);
          if (probe.io.length > 2000) probe.io.shift();
        }
      };
    };
    for (const method of [
      "realpath",
      "mkdtemp",
      "stat",
      "open",
      "writeFile",
      "rename",
      "readFile",
      "readdir",
      "mkdir",
      "unlink",
    ])
      observe(io, method);
    probe.hook = asyncHooks
      .createHook({
        init(id, type) {
          if (type.startsWith("FSREQ")) {
            probe.fsCounts[type] = (probe.fsCounts[type] || 0) + 1;
            probe.asyncFS.set(id, { id, type, started: Date.now() });
          }
        },
        destroy(id) {
          probe.asyncFS.delete(id);
        },
      })
      .enable();
    app.on("render-process-gone", (_event, contents, details) =>
      probe.rendererEvents.push({
        at: new Date().toISOString(),
        id: contents.id,
        ...details,
      }),
    );
  });
  page = await application.firstWindow();
  rendererCDP = await page.context().newCDPSession(page);
  const initialMemory = await memoryMetrics("application.first-window");
  assert.ok(
    Number.isFinite(initialMemory.heapUsed) &&
      Number.isFinite(initialMemory.heapTotal),
    "Renderer heap metrics must be available",
  );
  page.setDefaultTimeout(20000);
  page.on("console", (message) => {
    report.rendererConsole.push({
      at: new Date().toISOString(),
      type: message.type(),
      text: scrub(message.text()).slice(0, 1200),
    });
    if (report.rendererConsole.length > 300) report.rendererConsole.shift();
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("crash", () =>
    report.rendererCrashes.push({ at: new Date().toISOString() }),
  );
  const rendererRequests = new WeakMap();
  page.on("request", (request) => {
    if (!request.url().startsWith("app:")) return;
    const entry = {
      at: new Date().toISOString(),
      url: request.url(),
      started: Date.now(),
    };
    rendererRequests.set(request, entry);
    report.rendererRequests.push(entry);
    log({ phase: "renderer.request.start", ...entry });
  });
  page.on("response", (response) => {
    const entry = rendererRequests.get(response.request());
    if (entry) {
      entry.status = response.status();
      entry.headersMs = Date.now() - entry.started;
      log({ phase: "renderer.request.headers", ...entry });
    }
  });
  page.on("requestfinished", (request) => {
    const entry = rendererRequests.get(request);
    if (entry) {
      entry.completedMs = Date.now() - entry.started;
      log({ phase: "renderer.request.complete", ...entry });
    }
  });
  page.on("requestfailed", (request) =>
    report.rendererRequests.push({
      at: new Date().toISOString(),
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  step("Enable isolated endpoint and connect three independent SDK sessions");
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await page.getByRole("spinbutton", { name: "本地端口" }).fill(String(port));
  await page.getByRole("button", { name: "应用端口", exact: true }).click();
  await page.getByRole("switch", { name: "启用插件" }).click();
  await page.getByText("运行中", { exact: true }).waitFor();
  const plugin = await page.evaluate(
    async () => (await window.desktop.getPlugins())[0],
  );
  token = plugin.token;
  endpoint = plugin.endpoint;
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  for (let index = 0; index < 3; index++) {
    const client = new Client({ name: `guzi-soak-${index}`, version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (url, init) => {
          const entry = {
            client: index,
            method: init?.method || "GET",
            at: new Date().toISOString(),
          };
          if (typeof init?.body === "string") {
            try {
              const request = JSON.parse(init.body);
              entry.requestId = request.id;
              entry.rpcMethod = request.method;
              entry.tool = request.params?.name;
            } catch {}
          }
          const start = Date.now();
          report.fetches.push(entry);
          log({ phase: "fetch.start", ...entry });
          try {
            const response = await fetch(url, init);
            entry.status = response.status;
            entry.milliseconds = Date.now() - start;
            log({ phase: "fetch.headers", ...entry });
            return response;
          } catch (error) {
            entry.error = scrub(error.message);
            entry.milliseconds = Date.now() - start;
            log({ phase: "fetch.failed", ...entry });
            throw error;
          }
        },
      }),
    );
  }
  let deck = (await call(0, "open_canvas", { path: fixture })).result;
  let documentId = deck.documentId;
  const slideId = deck.slides[0].id;
  canScreenshot = true;
  const scene = (await call(0, "read_canvas", { documentId, slideId })).result;
  const created = (
    await call(0, "apply_operations", {
      documentId,
      slideId,
      expectedRevision: scene.revision,
      requestId: `soak-create-${++serial}`,
      operations: [
        {
          type: "create",
          tempId: "marker",
          element: {
            type: "text",
            x: 60,
            y: 668,
            text: "SDK soak initialized",
            fontSize: 14,
          },
        },
      ],
    })
  ).result;
  const markerId = created.idMap.marker;
  for (let round = 1; round <= rounds; round++) {
    if (round === 2) {
      step(
        `Minimize only the test window and pause ${pauseMs}ms without app/CDP traffic`,
      );
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].minimize(),
      );
      log({ phase: "background.pause.start", pauseMs });
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
      log({ phase: "background.pause.end" });
      await memoryMetrics("background.pause.completed");
    }
    step(
      `SDK round ${round}/${rounds}: concurrent read/export, genuine automatic draft and save/reopen`,
    );
    const before = (await call(0, "read_canvas", { documentId, slideId }))
      .result;
    const marker = `SDK soak round ${round}`;
    await call(0, "apply_operations", {
      documentId,
      slideId,
      expectedRevision: before.revision,
      requestId: `soak-patch-${++serial}`,
      operations: [{ type: "patch", id: markerId, patch: { text: marker } }],
    });
    const results = await Promise.allSettled([
      call(1, "export_presentation", {
        documentId,
        format: "png",
        slideId,
      }).then(({ response }) => saveExport(response, "png", `sdk-${round}`)),
      call(2, "export_presentation", { documentId, format: "pdf" }).then(
        ({ response }) => saveExport(response, "pdf", `sdk-${round}`),
      ),
      call(1, "read_canvas", { documentId, slideId }),
      call(2, "list_canvases"),
      observeDraft(documentId, marker),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      await diagnostics(failed.reason.message);
      throw failed.reason;
    }
    report.scenarios.push({
      round,
      automaticDraft: results[4].value,
      background: round === 2,
    });
    await call(0, "save_presentation", { documentId });
    await call(0, "close_document", { documentId });
    deck = (await call(0, "open_canvas", { path: fixture })).result;
    documentId = deck.documentId;
    assert.equal(deck.slides.length, 8);
    const reopened = (await call(1, "read_canvas", { documentId, slideId }))
      .result;
    assert.ok(
      reopened.elements.some(
        (element) => element.id === markerId && element.text === marker,
      ),
    );
    report.diagnostics.push({
      at: new Date().toISOString(),
      reason: `round ${round} checkpoint`,
      main: await mainSnapshot(),
    });
    if (round === 2)
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.restore();
        window.show();
        window.focus();
      });
    remember();
  }
  if (pdfFault !== "none")
    await controlledPdfFault(documentId, slideId, markerId);
  if (withCodex) {
    await call(0, "close_document", { documentId });
    await runCodex(slideId, markerId);
  }
  report.sourceHashAfter = digest(await fs.readFile(sourcePath));
  report.sourceUnchanged = report.sourceHash === report.sourceHashAfter;
  assert.equal(report.sourceUnchanged, true);
  assert.equal(application.process().pid, report.electronPid);
  report.singleElectronProcess = true;
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.rendererCrashes, []);
  await page.screenshot({
    path: path.join(artifacts, "final.png"),
    fullPage: true,
  });
}

main()
  .catch(async (error) => {
    report.errors.push(scrub(error.stack || error.message));
    console.error(scrub(error.message));
    if (application && clients.length === 3)
      await diagnostics(error.message).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await clean().catch((error) => {
      report.errors.push(`Cleanup: ${error.message}`);
      process.exitCode = 1;
    });
    report.completedAt = new Date().toISOString();
    const heaps = report.memoryMetrics.filter((metric) =>
      Number.isFinite(metric.heapUsed),
    );
    const reopenHeaps = heaps.filter(
      (metric) => metric.phase === "codex.open_canvas.complete",
    );
    report.memorySummary = {
      samples: heaps.length,
      minHeapUsed: heaps.length
        ? Math.min(...heaps.map((metric) => metric.heapUsed))
        : null,
      maxHeapUsed: heaps.length
        ? Math.max(...heaps.map((metric) => metric.heapUsed))
        : null,
      firstHeapUsed: heaps[0]?.heapUsed,
      lastHeapUsed: heaps.at(-1)?.heapUsed,
      codexReopens: reopenHeaps.map(({ at, heapUsed, heapTotal, exports }) => ({
        at,
        heapUsed,
        heapTotal,
        exports,
      })),
      codexReopensStrictlyIncreasing:
        reopenHeaps.length > 1 &&
        reopenHeaps
          .slice(1)
          .every(
            (metric, index) => metric.heapUsed > reopenHeaps[index].heapUsed,
          ),
    };
    report.toolErrorSummary = {
      expectedPdfFaults: report.calls.filter(
        (entry) => entry.isError && entry.expectedFault,
      ).length,
      unexpected: report.calls.filter(
        (entry) => entry.isError && !entry.expectedFault,
      ).length,
    };
    report.passed = report.errors.length === 0 && process.exitCode !== 1;
    fsSync.writeFileSync(
      path.join(artifacts, "report.json"),
      scrub(JSON.stringify(report, null, 2)),
    );
    console.log(
      JSON.stringify(
        {
          report: path.join(artifacts, "report.json"),
          passed: report.passed,
          calls: report.calls.length,
          exports: report.exports.length,
          diagnostics: report.diagnostics.length,
          errors: report.errors,
          residualPids: report.residualPids,
          profileRemoved: report.profileRemoved,
        },
        null,
        2,
      ),
    );
  });
