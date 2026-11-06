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
  evidenceBoundary: "Playwright exercises real renderer mouse, wheel and keyboard input. The momentum-specific cases inject DOM WheelEvent instances with Chromium’s momentum flag. They validate the application’s phase handling but do not reproduce the macOS touchpad or physical finger release.",
};
const owned = new Map();
let application, page, client, isolated, profile, launching, stopping;
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
    if (profile && item.command.split(" ").includes(`--user-data-dir=${profile}`)) owned.set(item.pid, item.command);
  }
  let changed;
  do {
    changed = false;
    for (const item of table) if (table.some((parent) => parent.pid === item.parent && owned.get(parent.pid) === parent.command) && !owned.has(item.pid)) {
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
    const zoom = state.zoom.value;
    const constraints = state.scrollConstraints;
    const patch = { selectedElementIds: {} };
    const offsets = constraints.offsets;
    const minX = state.width / zoom - constraints.x - constraints.width - (offsets.right ?? 0) / zoom;
    const maxX = -constraints.x + (offsets.left ?? 0) / zoom;
    const minY = state.height / zoom - constraints.y - constraints.height - (offsets.bottom ?? 0) / zoom;
    const maxY = -constraints.y + (offsets.top ?? 0) / zoom;
    const clamp = (value, min, max) => min > max ? (min + max) / 2 : Math.max(min, Math.min(max, value));
    if (command.position === "end" || command.position === "below") {
      patch.scrollY = clamp(minY, minY, maxY);
      if (command.position === "below") patch.scrollY -= (state.height + 200) / zoom;
    }
    if (command.position === "top") patch.scrollY = clamp(maxY, minY, maxY) - (command.inside ?? 0) / zoom;
    if (command.position === "left") patch.scrollX = clamp(maxX, minX, maxX) + (command.overBy ?? 0) / zoom;
    if (command.position === "right") patch.scrollX = clamp(minX, minX, maxX);
    if (command.position === "center") {
      patch.scrollX = (minX + maxX) / 2;
      patch.scrollY = clamp(state.scrollY, minY, maxY);
    }
    model.api.updateScene({ appState: patch });
  }
  const read = () => {
    const state = app.state;
    return {
    t: mounted.ownerDocument.defaultView.performance.now(),
    scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
    width: state.width, height: state.height, constraints: state.scrollConstraints,
    offsets: model.api.getViewportOffsets(), animating: app.viewport.isAnimating,
    reducedMotion: mounted.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches,
    papers: papers().map(({ id, x, y, width, height, customData }) => ({ id, x, y, width, height, kind: customData.guziPaper.kind })),
    };
  };
  const view = mounted.ownerDocument.defaultView;
  if (command.probeMomentum) {
    const defaults = new view.WheelEvent("wheel");
    const direct = new view.WheelEvent("wheel", { momentum: false });
    const inertia = new view.WheelEvent("wheel", { momentum: true });
    return {
      exposed: "momentum" in defaults,
      defaultMomentum: defaults.momentum,
      direct: direct.momentum,
      inertia: inertia.momentum,
      userAgent: view.navigator.userAgent,
    };
  }
  if (command.wheelInput) {
    const canvas = mounted.querySelector("canvas.interactive");
    const box = canvas.getBoundingClientRect();
    const trace = [];
    for (const input of command.wheelInput) {
      const before = read();
      const event = new view.WheelEvent("wheel", {
        bubbles: true, cancelable: true,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
        deltaX: input.x ?? 0, deltaY: input.y ?? 0, momentum: input.momentum,
      });
      canvas.dispatchEvent(event);
      await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
      trace.push({
        input,
        momentum: event.momentum,
        trusted: event.isTrusted,
        consumed: event.defaultPrevented,
        before, after: read(),
      });
    }
    return trace;
  }
  if (command.startSpringTrace) {
    const frames = [];
    const trace = () => {
      frames.push(read());
      if (frames.length < 180) view.__paperSpring.frame = view.requestAnimationFrame(trace);
    };
    view.__paperSpring = { frames, frame: view.requestAnimationFrame(trace) };
  }
  if (command.takeSpringTrace) {
    const recording = view.__paperSpring;
    view.cancelAnimationFrame(recording.frame);
    delete view.__paperSpring;
    return recording.frames;
  }
  if (command.startContinuationTrace) {
    view.__paperContinuation?.unsubscribe();
    const frames = [];
    const unsubscribe = model.api.onChange(() => {
      if (papers().length === command.startContinuationTrace) frames.push(read());
    });
    view.__paperContinuation = { frames, unsubscribe };
  }
  if (command.takeContinuationTrace) {
    const recording = view.__paperContinuation;
    recording.unsubscribe();
    delete view.__paperContinuation;
    return recording.frames;
  }
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
// Ring buffer of viewport changes and pointer input. An intermittent horizontal
// lock jump was seen between two samples, so a failure must show what happened
// in between rather than only the sampled result.
const installFrameTrace = () => page.locator(".desktop-editor-pane.is-active").evaluate((mounted) => {
  const owner = (node) => node?.[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))];
  let app;
  for (let fiber = owner(mounted.querySelector(".excalidraw")); fiber; fiber = fiber.return) {
    if (fiber.stateNode?.viewport && fiber.stateNode?.scene) { app = fiber.stateNode; break; }
  }
  if (!app) throw new Error("Cannot locate mounted production editor");
  const view = mounted.ownerDocument.defaultView;
  const trace = (view.__paperNavigationTrace = []);
  const push = (entry) => { trace.push({ t: Math.round(view.performance.now()), ...entry }); if (trace.length > 400) trace.shift(); };
  let last = "";
  const frame = () => {
    const state = app.state;
    const key = JSON.stringify([state.scrollX, state.scrollY, state.width, state.offsetLeft, state.offsetTop, state.scrollConstraints?.offsets]);
    if (key !== last) {
      last = key;
      push({ kind: "viewport", scrollX: state.scrollX, scrollY: state.scrollY, width: state.width, offsetLeft: state.offsetLeft, offsetTop: state.offsetTop, constraintOffsets: state.scrollConstraints?.offsets ?? null });
    }
    view.requestAnimationFrame(frame);
  };
  frame();
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    view.addEventListener(type, (event) => push({ kind: type, x: event.clientX, y: event.clientY, buttons: event.buttons }), { capture: true, passive: true });
  }
  view.addEventListener("wheel", (event) => push({
    kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY,
    momentum: event.momentum, trusted: event.isTrusted,
  }), { capture: true, passive: true });
  view.addEventListener("resize", () => push({ kind: "resize", innerWidth: view.innerWidth, innerHeight: view.innerHeight }));
});
const sample = async (label) => {
  const state = await editor();
  report.evidence[label] = state;
  return state;
};
const screenshot = async (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
const close = (actual, expected, message, tolerance = 1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const hard = (state, axis, value = axis === "x" ? state.scrollX : state.scrollY) => {
  const lock = state.constraints;
  assert.equal(lock?.lockScroll, true, "paper constrains both axes");
  assert.equal(lock.elasticPan, true);
  assert.equal(lock.lockZoom, false);
  const [size, start, end] = axis === "x" ? ["width", "left", "right"] : ["height", "top", "bottom"];
  const max = -lock[axis] + (lock.offsets?.[start] ?? 0) / state.zoom;
  const min = state[size] / state.zoom - lock[axis] - lock[size] - (lock.offsets?.[end] ?? 0) / state.zoom;
  return { min, max, target: min > max ? (min + max) / 2 : Math.max(min, Math.min(max, value)) };
};
const hardX = (state) => hard(state, "x");
const stable = async () => {
  // Wheel-only input still uses an idle fallback before spring motion can start.
  await delay(300);
  return until(async () => {
    const state = await editor();
    return !state.animating && state;
  }, "paper viewport settles", 5000);
};
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
const visibleNewPage = (state) => {
  const sheet = state.papers.at(-1);
  const offsets = state.constraints.offsets;
  const pageTop = (sheet.y + state.scrollY) * state.zoom;
  const pageBottom = pageTop + sheet.height * state.zoom;
  return Math.max(0, Math.min(state.height - (offsets.bottom ?? 0), pageBottom) - Math.max(offsets.top ?? 0, pageTop));
};
const checkContinuation = async (label, held, { expectBoundarySpring = false } = {}) => {
  await count(held.papers.length + 1);
  const finish = await stable();
  const frames = await editor({ takeContinuationTrace: true });
  assert.ok(frames.length >= 1, `${label}: captured the appended viewport`);
  const targetY = expectBoundarySpring ? hard(finish, "y", held.scrollY).target : held.scrollY;
  report.evidence[label] = { held, frames, finish, targetY, visiblePixels: visibleNewPage(finish) };
  close((frames[0].scrollY - held.scrollY) * held.zoom, 0, `${label}: append is atomic before any spring`, 0.02);
  if (expectBoundarySpring) {
    assert.ok(Math.abs(targetY - held.scrollY) * held.zoom > 0.2, "The low-zoom fixture is outside the new boundary at append");
    assert.ok(frames.some(({ animating, scrollY }) => animating &&
      scrollY > Math.min(held.scrollY, targetY) && scrollY < Math.max(held.scrollY, targetY)),
    "Out-of-bounds continuation returns through intermediate spring frames");
    for (let index = 1; index < frames.length; index++) {
      const previousDistance = Math.abs(frames[index - 1].scrollY - targetY);
      const distance = Math.abs(frames[index].scrollY - targetY);
      assert.ok((distance - previousDistance) * held.zoom < 0.02, "Every spring frame approaches the new boundary");
    }
    close((finish.scrollY - targetY) * finish.zoom, 0, `${label}: settles exactly at the new boundary`, 0.02);
  }
  for (const frame of [...frames, finish]) {
    assert.ok(
      frame.scrollY >= Math.min(held.scrollY, targetY) - 0.02 &&
      frame.scrollY <= Math.max(held.scrollY, targetY) + 0.02,
      `${label}: no camera motion beyond the held and legal boundary positions`,
    );
    close(frame.scrollX, held.scrollX, `${label}: horizontal camera stays in place`, 0.02);
    close(frame.zoom, held.zoom, `${label}: zoom stays in place`, 0.0001);
  }
  const expectedVisible = visibleNewPage({ ...held, papers: frames[0].papers });
  close(visibleNewPage(frames[0]), expectedVisible, `${label}: newly visible area follows the continuous geometry`, 0.05);
  return finish;
};
const injectWheel = async (inputs) => {
  const samples = await editor({ wheelInput: inputs });
  for (const sample of samples) {
    assert.equal(sample.trusted, false, "Momentum cases use explicitly injected DOM events");
    assert.equal(sample.momentum, sample.input.momentum);
    assert.equal(sample.consumed, true, "Injected wheel reaches the production canvas listener");
  }
  return samples;
};
const momentum = (y) => ({ y, momentum: true });
const direct = (y) => ({ y, momentum: false });

async function checkWheelPhases() {
  const probe = await editor({ probeMomentum: true });
  report.evidence.momentumFeature = probe;
  assert.equal(probe.exposed, true, "The packaged Chromium exposes WheelEvent.momentum");
  assert.equal(probe.defaultMomentum, false);
  assert.equal(probe.direct, false);
  assert.equal(probe.inertia, true);

  const hint = page.getByText("松手新建一页", { exact: true });
  await zoomTo(0.3);
  for (const [label, initial] of [["inertia-only", []], ["unarmed-direct-to-inertia", [direct(15), direct(15)]]]) {
    const before = await atEnd();
    const inputs = [...initial, momentum(180), momentum(120), momentum(65)];
    const trace = await injectWheel(inputs);
    const after = await stable();
    report.evidence[label] = { before, trace, after };
    assert.ok(trace.every(({ after }) => after.papers.length === before.papers.length), `${label}: inertial travel cannot arm continuation`);
    assert.equal(after.papers.length, before.papers.length);
    assert.equal(await hint.count(), 0);
  }

  const before = await atEnd();
  const arming = await injectWheel([direct(44), direct(44), direct(44)]);
  const held = arming.at(-1).after;
  await hint.waitFor();
  assert.equal(held.papers.length, before.papers.length);
  await editor({ startContinuationTrace: before.papers.length + 1 });
  const transition = await injectWheel([momentum(34)]);
  assert.equal(transition[0].before.papers.length, before.papers.length, "The idle fallback did not append before momentum arrived");
  const first = transition[0].after;
  close((held.scrollY - first.scrollY) * first.zoom, 34, "The first inertia delta is consumed after the atomic append", 1);
  assert.equal(first.papers.length, before.papers.length + 1, "The first momentum event finishes an armed gesture once");
  const commits = await editor({ takeContinuationTrace: true });
  assert.ok(commits.length >= 1, "Capture the appended camera before inertia advances it");
  for (const axis of ["scrollX", "scrollY", "zoom"]) {
    close(commits[0][axis], held[axis], `append commits at the held ${axis}`, 0.02);
  }
  assert.ok(visibleNewPage(commits[0]) > 0, "The appended sheet intersects the viewport on the commit frame");

  const tail = await injectWheel([momentum(35), momentum(22), momentum(10)]);
  for (const { input, before, after } of tail) {
    assert.equal(after.papers.length, first.papers.length);
    close((before.scrollY - after.scrollY) * after.zoom, input.y, "OS momentum pans one for one within the new sheet", 1);
    close(after.scrollX, held.scrollX, "inertia does not alter horizontal viewport", 0.01);
    close(after.zoom, held.zoom, "inertia does not alter zoom", 0.0001);
  }
  const settled = await stable();
  const last = tail.at(-1).after;
  close(settled.scrollY, last.scrollY, "No extra motion or alignment after the last momentum delta", 0.02);
  assert.equal(settled.papers.length, first.papers.length);
  assert.ok(visibleNewPage(settled) > visibleNewPage(commits[0]));
  report.evidence["armed-direct-to-inertia"] = { before, arming, held, transition, commits, tail, settled };
  await screenshot("momentum-entered-new-page");
  report.checks.push("Chromium momentum feature detected; injected inertia alone or after an unarmed pull cannot append; first inertia after arming appends once at the held camera, and later inertia moves one for one with no synthetic travel");
}

async function checkSpring() {
  await zoomTo(1.8);
  const release = async ({ slow }) => {
    await atEnd();
    await editor({ position: "left" });
    const edge = await editor();
    const point = await pointerBegin();
    await page.mouse.move(point.x + 48, point.y, { steps: 4 });
    await editor({ startSpringTrace: true });
    await page.mouse.move(point.x + 104, point.y, { steps: 4 });
    if (slow) await delay(180);
    await pointerEnd();
    const settled = await stable();
    const frames = await editor({ takeSpringTrace: true });
    const spring = frames.filter(({ animating }) => animating);
    assert.ok(spring.length > 3, "A release produces multiple spring frames");
    close(settled.scrollX, edge.scrollX, "spring returns to its boundary", 0.1);
    close(settled.scrollY, edge.scrollY, "spring leaves the other axis unchanged", 0.01);
    const velocities = spring.slice(1).map((frame, index) => (
      (frame.scrollX - spring[index].scrollX) * frame.zoom * 1000 / (frame.t - spring[index].t)
    ));
    assert.ok(velocities.every(Number.isFinite), "Each spring frame supplies a finite velocity sample");
    return { edge, frames, spring, velocities, settled, duration: spring.at(-1).t - spring[0].t };
  };
  const slow = await release({ slow: true });
  const fast = await release({ slow: false });
  report.evidence.springReleases = { slow, fast };
  close(slow.spring[0].scrollX * slow.spring[0].zoom, fast.spring[0].scrollX * fast.spring[0].zoom, "Slow and fast release start at the same held viewport", 0.5);
  const initialDifference = Math.abs(slow.velocities[0] - fast.velocities[0]);
  assert.ok(initialDifference > 5, "Stationary and moving releases produce distinguishable spring starts");
  assert.ok(Math.abs(slow.duration - fast.duration) > 5 || initialDifference > 15, "Spring is not a fixed-duration replay of the same path");

  await atEnd();
  await editor({ position: "left" });
  const point = await pointerBegin();
  await page.mouse.move(point.x + 150, point.y, { steps: 6 });
  await pointerEnd();
  const moving = await until(async () => {
    const frame = await editor();
    return frame.animating && frame;
  }, "spring begins before new direct input");
  const takeover = await injectWheel([{ x: 16, momentum: false }]);
  const { before, after } = takeover[0];
  assert.equal(before.animating, true, "The next direct gesture starts during the old spring");
  assert.equal(after.animating, false, "Direct input cancels the old spring immediately");
  assert.ok(after.scrollX < before.scrollX, "The new inward input moves from the current frame");
  close(after.scrollY, before.scrollY, "spring takeover leaves Y unchanged", 0.001);
  report.evidence.springTakeover = { moving, takeover, settled: await stable() };
  report.checks.push("Native slow and fast releases record different spring trajectories; new direct wheel input immediately takes over mid-spring");
}
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
    assert.equal(state.constraints.lockScroll, true);
    const sheet = mode === "fit-width" ? state.papers.at(-1) : state.papers[0];
    const offsets = state.constraints.offsets;
    const available = state.width - (offsets.left ?? 0) - (offsets.right ?? 0);
    const targetX = ((offsets.left ?? 0) + available / 2) / state.zoom - sheet.x - sheet.width / 2;
    close(state.scrollX, targetX, `${mode} does not inherit old elastic X`, 0.1);
    const targetY = (offsets.top ?? 24) / state.zoom - sheet.y;
    close(state.scrollY, hard(state, "y", targetY).target, `${mode} stays at the requested page within the hard bounds`, 0.1);
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
  for (const [side, axis, distance] of [["left", "x", 320], ["right", "x", -320], ["top", "y", 320], ["end", "y", -320]]) {
    await editor({ position: side }); await delay(80);
    const before = await sample(`${prefix}-${side}-before`);
    const get = axis === "x" ? "scrollX" : "scrollY";
    const orthogonal = axis === "x" ? "scrollY" : "scrollX";
    const bounds = hard(before, axis);
    assert.ok(bounds.min < bounds.max, "zoomed paper must exceed the available viewport");
    const start = await pointerBegin();
    const move = async (delta) => page.mouse.move(
      start.x + (axis === "x" ? delta : 0),
      start.y + (axis === "y" ? delta : 0),
      { steps: 5 },
    );
    await move(Math.sign(distance) * 40); await delay(40);
    const first = (await editor())[get];
    await move(Math.sign(distance) * 80); await delay(40);
    const second = (await editor())[get];
    const firstTravel = (first - before[get]) * before.zoom * Math.sign(distance);
    const secondTravel = (second - before[get]) * before.zoom * Math.sign(distance);
    assert.ok(firstTravel > 0 && firstTravel < 40, `${side} begins to resist movement`);
    assert.ok(secondTravel > firstTravel && secondTravel < 2 * firstTravel, `${side} incremental resistance grows`);
    await move(distance); await delay(40);
    const during = await sample(`${prefix}-${side}-elastic`);
    assert.ok(Math.abs(during[get] - hard(during, axis).target) * during.zoom < 80, `${side} elastic cap`);
    await screenshot(`${prefix}-${side}-elastic`);
    if (side === "end" && prefix === "a4") await page.keyboard.press("Escape");
    await pointerEnd(); await delay(60);
    const middle = await sample(`${prefix}-${side}-pointer-middle`);
    const end = await stable();
    report.evidence[`${prefix}-${side}-settled`] = end;
    assert.ok(Math.abs(middle[get] - end[get]) < Math.abs(during[get] - end[get]), `${side} rebound moves toward the edge`);
    close(end[get], bounds.target, `${side} returns to the original hard boundary`);
    close(end[orthogonal], during[orthogonal], `${side} rebound preserves the other axis`, 0.001);
    assert.equal(end.papers.length, before.papers.length);
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
  report.checks.push(`${prefix}: narrow page centered; all four edges resist nonlinearly, stay within 80px, and rebound on release; horizontal wheel also returns on idle`);
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

    await editor({ position: "top", inside: 4 }); await delay(60);
    const inside = await sample("wheel-top-inside");
    await wheel(0, -2);
    const near = await sample("wheel-top-near-edge");
    await wheel(0, -4);
    const crossing = await sample("wheel-top-crossing-edge");
    close((near.scrollY - inside.scrollY) * inside.zoom, 2, "the interior still pans one for one", 0.1);
    close((crossing.scrollY - near.scrollY) * inside.zoom, 4, "the first two elastic pixels enter the curve without a velocity cliff", 0.2);
    await stable();

    const runs = [];
    for (const deltas of [[40, 40, 40, 40], [160]]) {
      await editor({ position: "top" }); await delay(60);
      const before = await editor();
      const samples = [];
      for (const delta of deltas) {
        await page.mouse.wheel(0, -delta);
        samples.push(await editor());
      }
      const travel = (samples.at(-1).scrollY - before.scrollY) * before.zoom;
      runs.push({ before, samples, travel });
      await stable();
    }
    report.evidence.wheelStepComparison = runs;
    close(runs[0].travel, runs[1].travel, "the same wheel distance yields the same camera stretch whether split into steps or applied once", 0.2);
    assert.ok(runs[0].travel > 45 && runs[0].travel < 65, "wheel steps produced a nonzero elastic stretch");

    await editor({ position: "left", overBy: 110 }); await delay(60);
    const takeOver = await sample("wheel-takeover-before");
    await wheel(-1, 0);
    const outward = await sample("wheel-takeover-outward");
    close(outward.scrollX, takeOver.scrollX, "taking over outside a moved bound does not jump on a tiny outward tick", 0.001);
    await wheel(12, 0);
    const inward = await sample("wheel-takeover-inward");
    const retracted = (outward.scrollX - inward.scrollX) * inward.zoom;
    assert.ok(retracted > 0 && retracted <= 12.2, "the first inward tick starts from the current frame without jumping");
    await stable();
    report.checks.push("Native vertical wheel stays smooth through the hard edge and composes equal total travel, while input can take over a camera already outside a moved bound");
  }
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  isolated = await fs.mkdtemp(path.join(os.tmpdir(), "guzi-paper-navigation-"));
  profile = path.join(isolated, "profile");
  const drawings = path.join(isolated, "drawings");
  await fs.mkdir(profile); await fs.mkdir(drawings);
  await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({ rootDirectory: drawings, language: "zh-CN", theme: progressOnly ? "dark" : "light", toolPanelDock: "left", toolPanelPinned: false }));
  const electronDirectory = path.dirname(require.resolve("electron/package.json"));
  const executablePath = path.resolve(electronDirectory, "dist", (await fs.readFile(path.join(electronDirectory, "path.txt"), "utf8")).trim());
  launching = _electron.launch({ executablePath, args: [desktop, `--user-data-dir=${profile}`], env: { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile, EXCALIDRAW_DESKTOP_DEV_URL: process.env.EXCALIDRAW_DESKTOP_DEV_URL ?? "" }, timeout: 30000 });
  application = await launching; launching = undefined;
  remember(); report.pid = application.process().pid; report.profile = profile; report.project = drawings;
  report.runtime = await application.evaluate(({ app }) => ({
    electron: process.versions.electron, chromium: process.versions.chrome, userData: app.getPath("userData"),
  }));
  assert.equal(report.runtime.userData, profile);
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
  await zoomTo(0.9);
  await installFrameTrace();
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
  await page.mouse.move(point.x, point.y - 64, { steps: 4 });
  await progress("a4-progress-pulled-back", Math.round((64 - 12) / 64 * 100));
  assert.equal(await page.getByText("松手新建一页", { exact: true }).count(), 0, "a short retreat below 56px disarms saturated intent");
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await progress("a4-progress-cleared-at-origin", 0);
  assert.equal(await page.locator(".desktop-paper-next-outline").count(), 0);
  const returned = await editor();
  const inside = Math.max(0, (returned.scrollY - hard(returned, "y").min) * returned.zoom);
  await page.mouse.move(point.x, point.y - inside - 76, { steps: 8 });
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await progress("a4-armed-before-release", 100);
  const armed = await sample("pointer-armed-before-release");
  await editor({ startContinuationTrace: 2 });
  await pointerEnd();
  const appended = await checkContinuation("pointer-append-motion", armed);
  const armedTravel = (initial.scrollY - armed.scrollY) * initial.zoom;
  assert.ok(armedTravel > 0 && armedTravel < 76, "the raw 76px pull arms through visual resistance");
  await screenshot("a4-created-after-release");
  assert.equal(appended.papers[1].y, appended.papers[0].y + appended.papers[0].height + 48);
  report.checks.push("Native Space drag shows a 6px horizontal bar at 50%, saturates at 100%, disarms on a short retreat, clears at the origin and rearms; incomplete release and held full progress never append");
  report.checks.push("Native Space drag arms after 64px, commits the page in the held frame, and stays at the held viewport until subsequent input");
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
  const freshArmed = await sample("fresh-after-cancel-armed");
  await editor({ startContinuationTrace: 3 });
  await pointerEnd();
  await checkContinuation("fresh-after-cancel-motion", freshArmed);
  assert.ok(freshBefore.scrollY > freshArmed.scrollY);
  report.checks.push("After Escape and release, a fresh 76px drag appends normally without automatic viewport motion");

  await delay(850);
  await zoomTo(0.3); await atEnd();
  const wheelPageCount = (await editor()).papers.length;
  await editor({ startContinuationTrace: wheelPageCount + 1 });
  const box = await canvasBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const wheelTrace = [];
  for (let index = 0; index < 4; index++) {
    await page.mouse.wheel(0, 40); await delay(25);
    wheelTrace.push(await editor());
  }
  report.evidence.continuousWheel = wheelTrace;
  const nativeInputs = await page.locator(".desktop-editor-pane.is-active").evaluate(
    (mounted) => mounted.ownerDocument.defaultView.__paperNavigationTrace
      .filter((event) => event.kind === "wheel")
      .slice(-4),
  );
  assert.equal(nativeInputs.length, 4);
  assert.ok(nativeInputs.every((event) => event.trusted && event.momentum === false && event.deltaY === 40));
  report.evidence.nativeWheelInputs = nativeInputs;
  assert.ok(wheelTrace.every((state) => state.papers.length === wheelPageCount), "one wheel segment must wait for idle before appending");
  let lastWheelTravel = 40;
  for (let index = 1; index < wheelTrace.length; index++) {
    const previous = wheelTrace[index - 1], next = wheelTrace[index];
    const travel = (previous.scrollY - next.scrollY) * next.zoom;
    assert.ok(travel > 0 && travel < lastWheelTravel, "successive equal wheel deltas have decreasing visual travel beyond the bound");
    lastWheelTravel = travel;
    close(next.scrollX, previous.scrollX, "wheel append preserves X", 0.001);
    close(next.zoom, previous.zoom, "wheel append preserves zoom", 0.0001);
  }
  const wheelArmed = wheelTrace.at(-1);
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await screenshot("a4-wheel-armed");
  await checkContinuation("wheel-appended-after-idle", wheelArmed);
  await screenshot("a4-continuous-wheel");
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
  await editor({ startContinuationTrace: longStart.papers.length + 1 });
  await wheel(0, 85, 18);
  const longArmed = await sample("long-wheel-armed");
  assert.equal(longArmed.papers.length, longStart.papers.length, "long wheel still waits for release");
  const longTravel = (longStart.scrollY - longArmed.scrollY) * longStart.zoom;
  assert.ok(longTravel > 70 && longTravel < 80, "long pulls stay below the visual cap while still armed");
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await screenshot("a4-long-wheel-armed");
  await checkContinuation("long-wheel-created", longArmed);
  report.checks.push("A long valid wheel pull stays armed near the visual cap and creates one page on idle without a viewport jump");

  await delay(850); await atEnd();
  const retreatStart = await sample("wheel-retreat-start");
  await wheel(0, 130, 12);
  const beforeRetreat = await sample("wheel-retreat-stretched");
  await page.getByText("松手新建一页", { exact: true }).waitFor();
  await wheel(0, -12);
  const firstRetreat = await sample("wheel-retreat-first-tick");
  const firstReverse = (firstRetreat.scrollY - beforeRetreat.scrollY) * firstRetreat.zoom;
  assert.ok(firstReverse > 0 && firstReverse <= 12.2, "deep stretch reverses immediately without overshooting the input");
  assert.equal(await page.getByText("松手新建一页", { exact: true }).count(), 0, "a short reverse tick disarms even after a long saturated pull");
  await wheel(0, -100, 2);
  assert.equal(await page.getByText("松手新建一页", { exact: true }).count(), 0, "continued retreat disarms the pending page");
  assert.equal((await stable()).papers.length, retreatStart.papers.length, "retreat before wheel idle doesn't create a page");
  report.checks.push("A deep native wheel stretch responds visibly to the first reverse tick, then disarms and returns without creating a page");

  await checkWheelPhases();
  await checkSpring();

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
  const demoPath = saved.path;
  await call("close_document", { documentId }); await call("open_canvas", { path: saved.path }); await count(total); await stable();
  report.checks.push("Native keyboard undo/redo and save/reopen preserve continued paper pages");
  await boundaries("a4");
  await jumpDuringRebound("fit-width");
  await jumpDuringRebound("page-one");

  const editorPane = page.locator(".desktop-editor-pane.is-active");
  const expandDock = editorPane.getByRole("button", { name: "展开工具侧栏", exact: true });
  const collapseDock = editorPane.getByRole("button", { name: "收起工具侧栏", exact: true });
  const selectDocument = (await current()).documentId;
  for (const side of ["left", "right"]) {
    if (side === "right") {
      await expandDock.click();
      await editorPane.getByRole("button", { name: "放到右侧", exact: true }).click();
      await collapseDock.click();
      await stable();
    }
    await zoomTo(2); await atEnd();
    const before = await sample(`selection-dock-${side}-before`);
    const canvas = await canvasBox();
    const point = { x: before.width * 0.53, y: before.height * (side === "left" ? 0.44 : 0.55) };
    const scene = await call("read_canvas", { documentId: selectDocument });
    await call("apply_operations", {
      documentId: selectDocument,
      expectedRevision: scene.revision,
      requestId: `camera-dock-${side}`,
      operations: [{
        type: "create",
        element: {
          type: "rectangle",
          x: point.x / before.zoom - before.scrollX - 40,
          y: point.y / before.zoom - before.scrollY - 24,
          width: 80,
          height: 48,
          backgroundColor: "#dbe4ff",
          fillStyle: "solid",
        },
      }],
    });
    const [opening] = await Promise.all([
      editor({ frames: 26 }),
      page.mouse.click(canvas.x + point.x, canvas.y + point.y),
    ]);
    report.evidence[`selection-dock-${side}-opening`] = opening;
    await collapseDock.waitFor();
    const opened = await stable();
    const signedDistance = (opened.scrollX - before.scrollX) * (side === "left" ? 1 : -1);
    assert.ok(signedDistance > 10, `${side} dock moves the camera toward the available area`);
    const between = (from, to, value) =>
      value > Math.min(from, to) + 1 && value < Math.max(from, to) - 1;
    assert.ok(opening.some((frame) => between(before.scrollX, opened.scrollX, frame.scrollX)), "opening has an intermediate camera frame");
    await screenshot(`a4-selection-${side}-open`);
    const [closing] = await Promise.all([
      editor({ frames: 26 }),
      page.keyboard.press("Escape"),
    ]);
    report.evidence[`selection-dock-${side}-closing`] = closing;
    await expandDock.waitFor();
    const closed = await stable();
    assert.ok(closing.some((frame) => between(opened.scrollX, closed.scrollX, frame.scrollX)), "closing has an intermediate camera frame");
    close(closed.scrollX, before.scrollX, `${side} closing returns the camera to the original high zoom view`, 0.2);
    close(closed.scrollY, before.scrollY, `${side} selection preserves the vertical position`, 0.2);
    await screenshot(`a4-selection-${side}-closed`);
  }
  report.checks.push("At high zoom, native selection and Escape animate the left and right docks in both directions, including intermediate camera frames");

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
  await stable();
  const buttonBefore = await atEnd();
  await page.locator(".desktop-editor-pane.is-active .desktop-paper-add-page").click(); await count(3);
  const buttonAfter = await sample("add-page-button");
  close(buttonAfter.scrollX, buttonBefore.scrollX, "add page button preserves X", 0.001);
  close(buttonAfter.scrollY, buttonBefore.scrollY, "add page button preserves Y", 0.001);
  close(buttonAfter.zoom, buttonBefore.zoom, "add page button preserves zoom", 0.0001);
  report.checks.push("Page-end add button appends a ruled page without moving the viewport");

  await newDocument("blank"); await zoomTo(0.1); await atEnd();
  const tiny = await sample("low-zoom-before-wheel");
  const tinyCanvas = await canvasBox();
  await page.mouse.move(tinyCanvas.x + tinyCanvas.width / 2, tinyCanvas.y + tinyCanvas.height / 2);
  await editor({ startContinuationTrace: 2 });
  const fallbackTail = [];
  for (const delta of [300, 220, 160, 100, 64, 48, 24, 12, 4]) {
    await page.mouse.wheel(0, delta);
    const frame = await editor();
    assert.equal(frame.papers.length, 1, "wheel release waits through the decreasing tail");
    fallbackTail.push({ delta, scrollY: frame.scrollY });
  }
  report.evidence.lowZoomWheelTail = fallbackTail;
  const lowHeld = await sample("low-zoom-wheel-held");
  assert.ok(lowHeld.scrollY < tiny.scrollY);
  const lowFinished = await checkContinuation("low-zoom-wheel-motion", lowHeld, { expectBoundarySpring: true });
  assert.equal(lowFinished.papers.length, 2, "the whole wheel stream appends one page");
  assert.ok(visibleNewPage(lowFinished) > 0, "The low-zoom newly appended page is already in view");
  assert.ok(lowFinished.scrollY <= lowHeld.scrollY, "short sheets absorb the held stretch without pulling the camera backwards");
  report.checks.push("At 10% zoom the wheel tail waits for idle, adds one page at the held position, and springs only as far as the new centered boundary");

  await newDocument("infinite");
  const infiniteStart = await sample("infinite-before");
  assert.ok(!infiniteStart.constraints, "ordinary infinite canvas has no paper scroll constraints");
  const free = await pointerBegin(); await page.mouse.move(free.x + 280, free.y - 130, { steps: 6 }); await pointerEnd();
  const infiniteEnd = await stable(); report.evidence["infinite-after"] = infiniteEnd;
  close((infiniteEnd.scrollX - infiniteStart.scrollX) * infiniteEnd.zoom, 280, "infinite canvas horizontal pan stays free", 3);
  assert.equal(infiniteEnd.papers.length, 0);
  const [infiniteInertia] = await injectWheel([momentum(44)]);
  close((infiniteInertia.before.scrollY - infiniteInertia.after.scrollY) * infiniteInertia.after.zoom, 44, "infinite canvas retains normal momentum displacement", 1);
  assert.equal(infiniteInertia.after.papers.length, 0);
  report.evidence.infiniteInertia = infiniteInertia;
  report.checks.push("Infinite canvas has no horizontal lock, paper controls or continuation");

  const source = path.join(isolated, "navigation.pdf"); await fs.writeFile(source, fixturePdf());
  await application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, source);
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.getByRole("button", { name: "导入 PDF", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入 PDF", exact: true });
  await importer.getByRole("button", { name: "选择 PDF 文件", exact: true }).click(); await importer.waitFor({ state: "hidden" });
  await until(async () => (await current())?.title === "navigation" && (await current()).initialized, "PDF ready"); await stable();
  await boundaries("pdf"); await atEnd(); await wheel(0, 120, 3);
  report.evidence.pdfMomentum = await injectWheel([momentum(150), momentum(100), momentum(40)]);
  await stable();
  const pdf = await sample("pdf-no-continuation"); assert.equal(pdf.papers.length, 1); assert.equal(pdf.papers[0].kind, "pdf");
  assert.equal(await page.locator(".desktop-editor-pane.is-active .desktop-paper-add-page").count(), 0);
  report.checks.push("Imported PDF shares four elastic bounds and never auto-appends A4 pages");
  await screenshot("pdf-no-continuation");
  assert.deepEqual(report.errors, [], "renderer emitted no uncaught page errors");
  report.manualDemo = "manual-demo.excalidraw";
  await fs.copyFile(demoPath, path.join(artifacts, report.manualDemo));
  report.passed = true;
}

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await launching?.catch(() => {});
    await bounded(client?.close() ?? Promise.resolve(), 5000, "MCP client close").catch(() => {});
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
    if (isolated && report.cleanupPassed) await fs.rm(isolated, { recursive: true, force: true });
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
  report.frameTrace = await page?.evaluate(() => window.__paperNavigationTrace ?? null).catch(() => null);
  await page?.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
}).finally(stop);
