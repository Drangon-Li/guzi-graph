const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright");
const { enableMcpInSettings } = require("./mcp-settings-ui.cjs");

const desktop = path.resolve(__dirname, "..");
const progressOnly = process.argv.includes("--progress-only");
const artifacts = path.resolve(desktop, `../../output/playwright/${progressOnly ? "paper-progress" : "paper-navigation"}`);
const report = {
  passed: false, checks: [], evidence: {}, errors: [],
  evidenceBoundary: "Playwright sends native renderer mouse, wheel and keyboard events. Physical macOS touchpad finger release, OS momentum phases and actual two-finger system gestures require manual verification and are not claimed by this test.",
};
const owned = new Map();
let application, page, client, isolated, stopping;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, ms, label) => {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  })]).finally(() => clearTimeout(timeout));
};
const until = async (test, label = "condition", ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await test();
    if (result) return result;
    await delay(35);
  }
  throw new Error(`Timed out: ${label}`);
};
const processTable = () => execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  .trim().split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
const remember = () => {
  const table = processTable();
  const main = table.find((item) => item.pid === application?.process()?.pid);
  if (main) owned.set(main.pid, main.command);
  for (const item of table) {
    if (item.parent === process.pid && item.command.includes(desktop) && /[Ee]lectron/.test(item.command)) owned.set(item.pid, item.command);
  }
  let changed;
  do {
    changed = false;
    for (const item of table) if (owned.has(item.parent) && !owned.has(item.pid)) {
      owned.set(item.pid, item.command); changed = true;
    }
  } while (changed);
};
const remaining = () => processTable().filter((item) => owned.get(item.pid) === item.command);
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address(); server.close(() => resolve(port));
  });
});
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const value = response.structuredContent || JSON.parse(response.content.find((item) => item.type === "text").text);
  assert.ok(!response.isError, JSON.stringify(value)); return value;
};
const current = async () => {
  const state = await call("list_canvases");
  return state.canvases.find((item) => item.documentId === state.activeDocumentId);
};

// Fixture positioning uses the mounted public API; behavior under test uses input events.
const editor = async (operation = {}) => page.locator(".desktop-editor-pane.is-active").evaluate(async (mounted, command) => {
  const owner = (node) => node?.[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))];
  let model, app;
  for (let fiber = owner(mounted); fiber; fiber = fiber.return) {
    if (fiber.memoizedProps?.document?.api) { model = fiber.memoizedProps.document; break; }
  }
  for (let fiber = owner(mounted.querySelector(".excalidraw")); fiber; fiber = fiber.return) {
    if (fiber.stateNode?.viewport && fiber.stateNode?.scene) { app = fiber.stateNode; break; }
  }
  if (!model || !app) throw new Error("Cannot locate mounted production editor");
  const papers = () => app.scene.getNonDeletedElements().filter((item) => item.customData?.guziPaper).sort((a, b) => a.y - b.y || a.x - b.x);
  if (command.position) {
    app.viewport.interruptSelectionReveal();
    const state = app.state;
    const sheet = papers().at(-1);
    const zoom = state.zoom.value;
    const constraints = state.scrollConstraints;
    const offsets = model.api.getViewportOffsets();
    const patch = { selectedElementIds: {} };
    if (command.position === "end" || command.position === "below") {
      patch.scrollY = (state.height - (offsets.bottom ?? 24)) / zoom - sheet.y - sheet.height;
      if (command.position === "below") patch.scrollY -= (state.height + 200) / zoom;
    }
    if (command.position === "left") patch.scrollX = -constraints.x + (constraints.offsets?.left ?? 0) / zoom;
    if (command.position === "right") patch.scrollX = state.width / zoom - (constraints.x + constraints.width) - (constraints.offsets?.right ?? 0) / zoom;
    if (command.position === "center") {
      const max = -constraints.x + (constraints.offsets?.left ?? 0) / zoom;
      const min = state.width / zoom - constraints.x - constraints.width - (constraints.offsets?.right ?? 0) / zoom;
      patch.scrollX = min > max ? (min + max) / 2 : Math.max(min, Math.min(max, state.scrollX));
    }
    model.api.updateScene({ appState: patch });
  }
  const read = () => {
    const state = app.state;
    return {
    scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
    width: state.width, height: state.height, constraints: state.scrollConstraints,
    offsets: model.api.getViewportOffsets(), animating: app.viewport.isAnimating,
    reducedMotion: mounted.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches,
    papers: papers().map(({ id, x, y, width, height, customData }) => ({ id, x, y, width, height, kind: customData.guziPaper.kind })),
    };
  };
  if (command.frames) {
    const trace = [];
    for (let index = 0; index < command.frames; index++) {
      await new Promise((resolve) => mounted.ownerDocument.defaultView.requestAnimationFrame(resolve));
      trace.push(read());
    }
    return trace;
  }
  return read();
}, operation);
const sample = async (label) => {
  const state = await editor();
  report.evidence[label] = state;
  return state;
};
const screenshot = async (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
const close = (actual, expected, message, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const hardX = (state) => {
  const lock = state.constraints;
  assert.equal(lock?.lockScroll, "x", "paper must expose a horizontal-only lock");
  assert.equal(lock.lockZoom, false);
  const max = -lock.x + (lock.offsets?.left ?? 0) / state.zoom;
  const min = state.width / state.zoom - lock.x - lock.width - (lock.offsets?.right ?? 0) / state.zoom;
  return { min, max, target: min > max ? (min + max) / 2 : Math.max(min, Math.min(max, state.scrollX)) };
};
const stable = async () => { await delay(550); return editor(); };
const canvasBox = async () => page.locator(".desktop-editor-pane.is-active canvas.interactive").boundingBox();
const pointerBegin = async () => {
  const box = await canvasBox();
  const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 100, 430) };
  await page.mouse.move(point.x, point.y); await page.keyboard.down("Space"); await page.mouse.down();
  return point;
};
const pointerEnd = async () => { await page.mouse.up(); await page.keyboard.up("Space"); };
const atEnd = async () => { await editor({ position: "end" }); await delay(60); return editor(); };
const wheel = async (dx, dy, ticks = 1) => {
  for (let index = 0; index < ticks; index++) { await page.mouse.wheel(dx, dy); await delay(25); }
};
const count = async (number) => until(async () => (await editor()).papers.length === number, `${number} paper pages`);
const newDocument = async (template = "blank", orientation = "portrait") => {
  await page.locator(".desktop-titlebar-new").click();
  const chooser = page.getByRole("dialog", { name: "新建画布", exact: true });
  await chooser.getByRole("button", { name: template === "ruled" ? "A4 横线" : template === "blank" ? "A4 空白" : "无限画布", exact: true }).click();
  if (template !== "infinite") await chooser.getByLabel(orientation === "portrait" ? "纵向" : "横向", { exact: true }).check();
  await chooser.getByRole("button", { name: "创建", exact: true }).click();
  await until(async () => (await current())?.initialized, "new canvas ready");
  await stable();
};
const zoomTo = async (zoom) => { await call("control_canvas", { documentId: (await current()).documentId, action: "zoom", zoom }); await delay(35); await editor({ position: "center" }); await stable(); };

function fixturePdf() {
  const stream = "0.1 0.3 0.8 rg 50 600 200 80 re f BT /F1 24 Tf 50 550 Td (Navigation PDF) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.2756 841.8898] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let output = "%PDF-1.7\n"; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function jumpDuringRebound(mode) {
  await zoomTo(1.8); await atEnd(); await editor({ position: "left" }); await delay(60);
  const point = await pointerBegin();
  await page.mouse.move(point.x + 320, point.y, { steps: 8 }); await pointerEnd(); await delay(40);
  const moving = await sample(`rebound-${mode}-before-click`);
  assert.ok(moving.animating, "navigation must be clicked while the old rebound is still animating");
  if (mode === "fit-width") {
    await page.getByRole("button", { name: "适合页宽", exact: true }).filter({ visible: true }).click();
  } else {
    const input = page.locator(".desktop-editor-pane.is-active .desktop-paper-page-controls input");
    await input.fill("1"); await input.press("Enter");
  }
  const trace = await editor({ frames: 5 }); report.evidence[`rebound-${mode}-frames`] = trace;
  for (const state of trace) {
    assert.equal(state.constraints.lockScroll, "x");
    const sheet = mode === "fit-width" ? state.papers.at(-1) : state.papers[0];
    const offsets = state.constraints.offsets;
    const available = state.width - (offsets.left ?? 0) - (offsets.right ?? 0);
    const targetX = ((offsets.left ?? 0) + available / 2) / state.zoom - sheet.x - sheet.width / 2;
    close(state.scrollX, targetX, `${mode} does not inherit old elastic X`, 0.1);
    close(state.scrollY, (state.offsets.top ?? 24) / state.zoom - sheet.y, `${mode} stays at the requested page top`, 0.1);
  }
  const end = await stable(); report.evidence[`rebound-${mode}-settled`] = end;
  close(end.scrollX, trace[0].scrollX, `${mode} target stays stable after old animation duration`, 0.1);
  close(end.scrollY, trace[0].scrollY, `${mode} Y stays stable after old animation duration`, 0.1);
  report.checks.push(`${mode} clicked during native rebound cancels old motion and keeps five animation frames at the requested viewport`);
}

async function boundaries(prefix) {
  await zoomTo(0.4); await atEnd();
  const centered = await sample(`${prefix}-small-before`);
  close(centered.scrollX, hardX(centered).target, "small page centered");
  const centerPoint = await pointerBegin();
  await page.mouse.move(centerPoint.x + 300, centerPoint.y, { steps: 8 });
  const pulled = await sample(`${prefix}-small-elastic`);
  assert.ok((pulled.scrollX - centered.scrollX) * pulled.zoom > 1, "native pan must show elastic motion");
  assert.ok(Math.abs(pulled.scrollX - hardX(pulled).target) * pulled.zoom <= 81, "elastic motion capped at 80 screen px");
  await screenshot(`${prefix}-small-elastic`);
  await pointerEnd();
  await delay(60);
  const middle = await sample(`${prefix}-small-pointer-middle`);
  const settled = await stable();
  report.evidence[`${prefix}-small-settled`] = settled;
  close(settled.scrollX, hardX(settled).target, "small page returned to center");
  close(settled.scrollY, pulled.scrollY, "horizontal pointer rebound preserves Y", 0.001);
  if (!settled.reducedMotion) assert.ok(Math.abs(middle.scrollX - settled.scrollX) < Math.abs(pulled.scrollX - settled.scrollX), "pointer rebound has an intermediate frame");
  await screenshot(`${prefix}-small-settled`);

  await zoomTo(1.8); await atEnd();
  for (const [side, dx] of [["left", 320], ["right", -320]]) {
    await editor({ position: side }); await delay(80);
    const before = await sample(`${prefix}-${side}-before`);
    assert.ok(hardX(before).min < hardX(before).max, "zoomed paper must be wider than available viewport");
    const start = await pointerBegin();
    await page.mouse.move(start.x + dx, start.y, { steps: 8 });
    const during = await sample(`${prefix}-${side}-elastic`);
    assert.ok(Math.abs(during.scrollX - hardX(during).target) * during.zoom <= 81, "wide paper elastic cap");
    await screenshot(`${prefix}-${side}-elastic`);
    await pointerEnd(); await delay(60); await sample(`${prefix}-${side}-pointer-middle`);
    const end = await stable();
    report.evidence[`${prefix}-${side}-settled`] = end;
    close(end.scrollX, hardX(end).target, `${side} edge reachable after pointer release`);
    close(end.scrollY, during.scrollY, `${side} rebound preserves Y`, 0.001);
  }
  await editor({ position: "left" }); await delay(60);
  const wheelStart = await sample(`${prefix}-wheel-before`);
  const box = await canvasBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wheel(-240, 0, 2);
  const wheelPull = await sample(`${prefix}-wheel-elastic`);
  assert.ok(Math.abs(wheelPull.scrollX - hardX(wheelPull).target) * wheelPull.zoom <= 81, "wheel cap");
  await delay(210); await sample(`${prefix}-wheel-middle`);
  const wheelEnd = await stable(); report.evidence[`${prefix}-wheel-settled`] = wheelEnd;
  close(wheelEnd.scrollX, hardX(wheelEnd).target, "wheel idle returns to hard edge");
  close(wheelEnd.scrollY, wheelStart.scrollY, "horizontal wheel rebound preserves Y", 0.001);
  await screenshot(`${prefix}-wide-settled`);
  report.checks.push(`${prefix}: narrow page centered; wide paper both edges accessible; native pointer/wheel elastic cap and rebound preserve vertical viewport`);
  if (prefix === "a4") {
    await editor({ position: "left" }); await delay(60);
    await page.mouse.wheel(-240, 0); await delay(25);
    const elasticBefore = await sample("elastic-zoom-before");
    const screenBefore = (elasticBefore.scrollX - hardX(elasticBefore).target) * elasticBefore.zoom;
    assert.ok(screenBefore > 10, "native horizontal wheel creates a visible elastic offset before zoom");
    await page.keyboard.down("Control"); await page.mouse.wheel(0, -10); await page.keyboard.up("Control");
    await delay(35);
    const elasticAfter = await sample("elastic-zoom-after");
    const screenAfter = (elasticAfter.scrollX - hardX(elasticAfter).target) * elasticAfter.zoom;
    assert.ok(elasticAfter.zoom > elasticBefore.zoom, "Ctrl wheel changes zoom while elastic");
    close(screenAfter, screenBefore, "zoom preserves existing elastic displacement in screen pixels", 2);
    await screenshot("a4-elastic-zoom");
    await delay(210); await sample("elastic-zoom-middle");
    const elasticSettled = await stable(); report.evidence["elastic-zoom-settled"] = elasticSettled;
    close(elasticSettled.scrollX, hardX(elasticSettled).target, "elastic zoom rebounds smoothly to its new edge");
    close(elasticSettled.scrollY, elasticAfter.scrollY, "elastic zoom rebound preserves its resulting Y", 0.001);
    report.checks.push("Ctrl wheel during horizontal elasticity preserves screen displacement and then rebounds at the new zoom without Y movement");
  }
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-paper-navigation-"));
  const profile = path.join(isolated, "profile"), drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile); await fs.mkdir(drawings);
  await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ rootDirectory: drawings, language: "zh-CN", theme: progressOnly ? "dark" : "light" }));
  const electronDirectory = path.dirname(require.resolve("electron/package.json"));
  const executablePath = path.resolve(electronDirectory, "dist", (await fs.readFile(path.join(electronDirectory, "path.txt"), "utf8")).trim());
  application = await _electron.launch({ executablePath, args: [desktop], env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile, EXCALIDRAW_DESKTOP_DEV_URL: "" }, timeout: 30000 });
  remember(); report.pid = application.process().pid; report.profile = profile; report.project = drawings;
  page = await application.firstWindow(); page.setDefaultTimeout(20000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  const service = await enableMcpInSettings(page, await freePort());
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  client = new Client({ name: "guzi-paper-navigation-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }));
  process.stdout.write(`Electron ready ${report.pid}\n`);

  await newDocument();
  await zoomTo(0.6);
  const initial = await atEnd();
  const progress = async (label, expected) => {
    const bar = page.locator(".desktop-editor-pane.is-active [role=progressbar]");
    await until(async () => Number(await bar.getAttribute("aria-valuenow")) === expected, `${label} accessible progress`);
    await until(async () => bar.evaluate((node, target) => {
      const view = node.ownerDocument.defaultView;
      const fill = node.querySelector(".desktop-paper-pull-progress-fill");
      const scale = new view.DOMMatrixReadOnly(view.getComputedStyle(fill).transform).a;
      return Math.abs(scale - target / 100) < 0.01;
    }, expected), `${label} rendered progress settles`);
    const visual = await bar.evaluate((node) => {
      const fill = node.querySelector(".desktop-paper-pull-progress-fill");
      const view = node.ownerDocument.defaultView;
      const style = view.getComputedStyle(fill);
      const matrix = new view.DOMMatrixReadOnly(style.transform);
      const bounds = node.getBoundingClientRect();
      return {
        value: Number(node.getAttribute("aria-valuenow")),
        min: node.getAttribute("aria-valuemin"), max: node.getAttribute("aria-valuemax"),
        scaleX: matrix.a, width: bounds.width, height: bounds.height,
        text: node.closest(".desktop-paper-pull-hint").textContent,
      };
    });
    close(visual.scaleX, expected / 100, `${label} visual fill tracks accessible progress`, 0.02);
    assert.equal(visual.min, "0"); assert.equal(visual.max, "100");
    assert.ok(visual.width >= 200 && visual.width <= 300, "progress is a compact horizontal bar");
    close(visual.height, 6, "progress track is 6px high", 0.1);
    assert.equal((await editor()).papers.length, 1, `${label} held pointer must not append`);
    report.evidence[label] = { ...await editor(), progress: visual };
    await screenshot(label);
    if (label === "a4-progress" || label === "a4-armed-before-release") {
      await page.locator(".desktop-editor-pane.is-active .desktop-paper-pull-hint").screenshot({
        path: path.join(artifacts, label === "a4-progress" ? "hint-half.png" : "hint-ready.png"),
      });
    }
  };
  const incomplete = await pointerBegin();
  await page.mouse.move(incomplete.x, incomplete.y - 32, { steps: 4 });
  await progress("a4-incomplete-before-release", 50);
  await pointerEnd(); await stable();
  assert.equal((await editor()).papers.length, 1, "half-progress release must not append");
  await screenshot("a4-incomplete-after-release");
  await atEnd();
  const point = await pointerBegin();
  await page.mouse.move(point.x, point.y - 32, { steps: 4 });
  await progress("a4-progress", 50);
  await page.mouse.move(point.x, point.y - 76, { steps: 4 });
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await progress("a4-full-before-pullback", 100);
  await page.mouse.move(point.x, point.y - 32, { steps: 4 });
  await progress("a4-progress-pulled-back", 50);
  assert.equal(await page.getByText("松手新建一页", { exact: true }).count(), 0, "pullback below threshold disarms the gesture");
  await page.mouse.move(point.x, point.y - 76, { steps: 4 });
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await progress("a4-armed-before-release", 100);
  const armed = await sample("pointer-armed-before-release");
  await pointerEnd(); await count(2);
  const appended = await sample("pointer-appended-after-release");
  close(appended.zoom, initial.zoom, "append keeps zoom", 0.0001);
  close(appended.scrollX, initial.scrollX, "append keeps X", 0.001);
  close(appended.scrollY, initial.scrollY - 76 / initial.zoom, "append keeps the continuously dragged Y", 2);
  close(appended.scrollY, armed.scrollY, "append preserves armed viewport", 0.001);
  await screenshot("a4-created-after-release"); await stable();
  const releaseBefore = await editor();
  close(releaseBefore.scrollY, appended.scrollY, "release does not jump to new page top", 0.001);
  assert.equal(appended.papers[1].y, appended.papers[0].y + appended.papers[0].height + 48);
  report.checks.push("Native Space drag shows a 6px horizontal bar at 50%, fills at 100%, disarms back to 50%, and rearms at 100%; incomplete release and held full progress never append");
  report.checks.push("Native Space drag arms after 64px, appends only on release and preserves continuous viewport; new paper gap is 48");
  if (progressOnly) {
    assert.deepEqual(report.errors, [], "renderer emitted no uncaught page errors");
    report.passed = true;
    return;
  }

  await atEnd();
  const cancelPoint = await pointerBegin();
  await page.mouse.move(cancelPoint.x, cancelPoint.y - 76, { steps: 4 });
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.move(cancelPoint.x, cancelPoint.y - 200, { steps: 8 });
  assert.equal((await editor()).papers.length, 2, "Escape cancels the whole pointer gesture including subsequent move");
  await screenshot("a4-escape-pointer"); await pointerEnd(); await stable();
  report.checks.push("Escape cancels the whole pointer gesture; later movement before release cannot rebuild it");
  const freshBefore = await sample("fresh-after-cancel-before");
  const fresh = await pointerBegin();
  await page.mouse.move(fresh.x, fresh.y - 76, { steps: 5 });
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await pointerEnd(); await count(3);
  const freshAfter = await sample("fresh-after-cancel-created");
  close(freshAfter.scrollY, freshBefore.scrollY - 76 / freshBefore.zoom, "fresh gesture in original viewport resumes continuation", 2);
  report.checks.push("After Escape and release, a fresh 76px drag in the unchanged view appends normally without repositioning");

  await delay(850);
  await zoomTo(0.3); await atEnd();
  const wheelPageCount = (await editor()).papers.length;
  const box = await canvasBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const wheelTrace = [];
  for (let index = 0; index < 4; index++) {
    await page.mouse.wheel(0, 40); await delay(25);
    wheelTrace.push(await editor());
  }
  report.evidence.continuousWheel = wheelTrace;
  assert.ok(wheelTrace.every((state) => state.papers.length === wheelPageCount), "one wheel segment must wait for idle before appending");
  for (let index = 1; index < wheelTrace.length; index++) {
    const previous = wheelTrace[index - 1], next = wheelTrace[index];
    close(next.scrollY, previous.scrollY - 40 / next.zoom, "wheel append preserves vertical delta", 3);
    close(next.scrollX, previous.scrollX, "wheel append preserves X", 0.001);
    close(next.zoom, previous.zoom, "wheel append preserves zoom", 0.0001);
  }
  const wheelArmed = wheelTrace.at(-1);
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await screenshot("a4-wheel-armed");
  await count(wheelPageCount + 1);
  const wheelCreated = await sample("wheel-appended-after-idle");
  close(wheelCreated.scrollY, wheelArmed.scrollY, "wheel idle append preserves Y", 0.001);
  close(wheelCreated.scrollX, wheelArmed.scrollX, "wheel idle append preserves X", 0.001);
  close(wheelCreated.zoom, wheelArmed.zoom, "wheel idle append preserves zoom", 0.0001);
  await stable(); await screenshot("a4-continuous-wheel");
  await delay(850);
  const beforeEscapeWheel = (await atEnd()).papers.length;
  await wheel(0, 40, 3);
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await wheel(0, 100, 5);
  assert.equal((await editor()).papers.length, beforeEscapeWheel, "Escape cancels subsequent ticks in the active wheel segment");
  await stable();
  assert.equal((await editor()).papers.length, beforeEscapeWheel, "cancelled wheel segment cannot append on idle");
  report.checks.push("One continuous native wheel segment reaches the boundary and appends one page on idle without viewport resets; Escape suppresses remaining ticks and idle append");
  await delay(850); await atEnd();
  const longStart = await editor();
  await wheel(0, 85, 18);
  const longArmed = await sample("long-wheel-armed");
  assert.equal(longArmed.papers.length, longStart.papers.length, "long wheel still waits for release");
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await screenshot("a4-long-wheel-armed");
  await count(longStart.papers.length + 1);
  const longCreated = await sample("long-wheel-created");
  close(longCreated.scrollY, longArmed.scrollY, "long pull creates without Y jump", 0.001);
  close(longCreated.scrollX, longArmed.scrollX, "long pull creates without X jump", 0.001);
  await stable();
  report.checks.push("A long valid wheel pull stays armed after the old page bottom leaves view and creates one page on idle without a viewport jump");

  await editor({ position: "below" }); await delay(60);
  const blankBefore = await sample("blank-start-before");
  const blank = await pointerBegin(); await page.mouse.move(blank.x, blank.y - 100, { steps: 5 }); await pointerEnd(); await stable();
  assert.equal((await editor()).papers.length, blankBefore.papers.length, "a fresh gesture starting in blank space after the old page is offscreen must not append");
  report.checks.push("A fresh gesture beginning with the old page bottom offscreen does not auto-append");

  const documentId = (await current()).documentId;
  const total = (await editor()).papers.length;
  await call("read_canvas", { documentId });
  await page.keyboard.press("Meta+z"); await count(total - 1);
  await page.keyboard.press("Meta+Shift+z"); await count(total);
  const saved = await call("save_canvas", { documentId });
  await call("close_document", { documentId }); await call("open_canvas", { path: saved.path }); await count(total); await stable();
  report.checks.push("Native keyboard undo/redo and save/reopen preserve continued paper pages");
  await boundaries("a4");
  await jumpDuringRebound("fit-width");
  await jumpDuringRebound("page-one");

  await zoomTo(0.4); await atEnd();
  const sidebarBefore = await sample("sidebar-before");
  const collapse = page.getByRole("button", { name: "收起工具侧栏", exact: true }).filter({ visible: true });
  if (await collapse.count()) await collapse.click();
  else await page.getByRole("button", { name: "展开工具侧栏", exact: true }).filter({ visible: true }).click();
  await stable(); const sidebarAfter = await sample("sidebar-after");
  close(sidebarAfter.scrollX, hardX(sidebarAfter).target, "sidebar change recenters narrow paper");
  close(sidebarAfter.scrollY, sidebarBefore.scrollY, "sidebar change preserves Y", 0.001);
  await page.getByRole("button", { name: "适合页宽", exact: true }).filter({ visible: true }).click(); await stable();
  const fitted = await sample("fit-width"); close(fitted.scrollX, hardX(fitted).target, "fit width respects bounds");
  assert.ok(fitted.zoom > 0.4, "fit width changes zoom");
  await screenshot("a4-fit-width-sidebar");
  report.checks.push("Sidebar changes recenter narrow paper without Y movement; fit-width button preserves the paper boundary contract");
  const zoomBox = await canvasBox(); await page.mouse.move(zoomBox.x + zoomBox.width / 2, zoomBox.y + zoomBox.height / 2);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -120); await page.keyboard.up("Control");
  const nativeZoom = await stable(); report.evidence["native-ctrl-wheel-zoom"] = nativeZoom;
  assert.ok(nativeZoom.zoom > fitted.zoom, "native Ctrl wheel zoom remains enabled under horizontal lock");
  close(nativeZoom.scrollX, hardX(nativeZoom).target, "native zoom settles within horizontal paper bounds");
  report.checks.push("Native Ctrl wheel zoom remains available and settles inside paper bounds");

  await newDocument("ruled", "landscape"); await atEnd();
  const ruled = await pointerBegin(); await page.mouse.move(ruled.x, ruled.y - 90, { steps: 6 }); await pointerEnd(); await count(2);
  assert.ok((await editor()).papers.every((paper) => paper.kind === "ruled"));
  report.checks.push("Landscape ruled A4 uses the same native continuation path");
  const buttonBefore = await atEnd();
  await page.locator(".desktop-editor-pane.is-active .desktop-paper-add-page").click(); await count(3);
  const buttonAfter = await sample("add-page-button");
  close(buttonAfter.scrollX, buttonBefore.scrollX, "add page button preserves X", 0.001);
  close(buttonAfter.scrollY, buttonBefore.scrollY, "add page button preserves Y", 0.001);
  close(buttonAfter.zoom, buttonBefore.zoom, "add page button preserves zoom", 0.0001);
  report.checks.push("Page-end add button appends a ruled page without moving the viewport");

  await newDocument("infinite");
  const infiniteStart = await sample("infinite-before");
  assert.ok(!infiniteStart.constraints, "ordinary infinite canvas has no paper scroll constraints");
  const free = await pointerBegin(); await page.mouse.move(free.x + 280, free.y - 130, { steps: 6 }); await pointerEnd();
  const infiniteEnd = await stable(); report.evidence["infinite-after"] = infiniteEnd;
  close((infiniteEnd.scrollX - infiniteStart.scrollX) * infiniteEnd.zoom, 280, "infinite canvas horizontal pan stays free", 3);
  assert.equal(infiniteEnd.papers.length, 0);
  report.checks.push("Infinite canvas has no horizontal lock, paper controls or continuation");

  const source = path.join(isolated, "navigation.pdf"); await fs.writeFile(source, fixturePdf());
  await application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, source);
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.getByRole("button", { name: "导入 PDF", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入 PDF", exact: true });
  await importer.getByRole("button", { name: "选择 PDF 文件", exact: true }).click(); await importer.waitFor({ state: "hidden" });
  await until(async () => (await current())?.title === "navigation" && (await current()).initialized, "PDF ready"); await stable();
  await boundaries("pdf"); await atEnd(); await wheel(0, 120, 6); await stable();
  const pdf = await sample("pdf-no-continuation"); assert.equal(pdf.papers.length, 1); assert.equal(pdf.papers[0].kind, "pdf");
  assert.equal(await page.locator(".desktop-editor-pane.is-active .desktop-paper-add-page").count(), 0);
  report.checks.push("Imported PDF shares horizontal bounds and never auto-appends A4 pages");
  await screenshot("pdf-no-continuation");
  assert.deepEqual(report.errors, [], "renderer emitted no uncaught page errors");
  report.passed = true;
}

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await client?.close().catch(() => {});
    remember();
    if (application) {
      await bounded(application.evaluate(({ app }) => app.exit(0)), 5000, "isolated app exit").catch(() => {});
      await bounded(application.close(), 5000, "Electron close").catch(() => {});
      await until(() => remaining().length === 0, "owned process exit", 3000).catch(() => {});
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      for (const item of remaining()) { try { process.kill(item.pid, signal); } catch {} }
      await until(() => remaining().length === 0, "owned process termination", 3000).catch(() => {});
    }
    report.ownedProcesses = [...owned].map(([pid, command]) => ({ pid, command }));
    report.remainingProcesses = remaining(); report.cleanupPassed = report.remainingProcesses.length === 0;
    if (!report.cleanupPassed) { report.passed = false; process.exitCode = 1; }
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  report.failure = `Interrupted by ${signal}`; report.passed = false;
  void stop().finally(() => process.exit(1));
});
bounded(main(), 300000, "paper navigation regression").catch(async (error) => {
  report.failure = error.stack; process.exitCode = 1;
  await page?.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
}).finally(stop);
