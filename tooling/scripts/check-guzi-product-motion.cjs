const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  `<main data-site>
  <svg class="page-drawing"><g data-trails></g><g data-pencils></g></svg>
  <button class="motion-toggle" hidden><span data-motion-label></span></button>
  <div class="hero"></div>
  <details class="canvas-detail"><summary>Preview</summary><div>Canvas</div></details>
  <div class="faq-list">
  <details id="faq-one"><summary>Question one</summary><p id="faq-anchor">Answer one</p></details>
  <details id="faq-two"><summary>Question two</summary><p>Answer two</p></details>
  </div>
  <svg data-drawing id="scene"><path data-draw data-start="0" data-end=".6" data-pen-route="you"/><path data-draw data-start=".2" data-end=".8" data-pen-route="ai"/><g data-reveal=".3"/><g data-scene-pen="you"/><g data-scene-pen="ai"/></svg>
  <svg class="final-art" data-drawing data-finale><path data-draw/><g data-reveal=".4"/></svg>
  </main>`,
  { runScripts: "outside-only" },
);
const { window: win } = dom;
const doc = win.document;
const root = doc.querySelector("[data-site]");
const detail = root.querySelector("details");
const summary = detail.querySelector("summary");
const scene = root.querySelector("#scene");
const surface = root.querySelector(".page-drawing");
const pending = new Map();
const animations = [];
const liveAnimations = new Map();
let nextFrame = 0;
let scroll = 0;
let width = 1280;
let height = 3000;
let footerTop = 2500;
let layoutReads = 0;
let samples = 0;
let lengths = 0;
let resize;
let preferenceChange;
let liveAnimation = null;
const preference = {
  matches: false,
  addEventListener(type, listener) {
    preferenceChange = listener;
  },
};
Object.defineProperties(win, {
  scrollY: { get: () => scroll },
  innerHeight: { value: 800 },
});
Object.defineProperties(root, {
  clientWidth: { get: () => width },
  scrollHeight: { get: () => height },
});
Object.defineProperty(doc, "fonts", { value: { ready: Promise.resolve() } });
win.matchMedia = () => preference;
win.requestAnimationFrame = (listener) => {
  pending.set(++nextFrame, listener);
  return nextFrame;
};
win.cancelAnimationFrame = (id) => pending.delete(id);
win.ResizeObserver = class {
  constructor(listener) {
    resize = listener;
  }
  observe() {}
};
win.SVGElement.prototype.getTotalLength = function () {
  assert.ok(
    this.hasAttribute("data-draw"),
    "decorative routes use no SVG geometry",
  );
  lengths++;
  return 100;
};
win.SVGElement.prototype.getPointAtLength = function (distance) {
  samples++;
  return { x: distance, y: distance / 2 };
};
root.querySelector(".hero").getBoundingClientRect = () => {
  layoutReads++;
  return { left: 180 };
};
scene.getBoundingClientRect = () => ({ top: 1000 - scroll, height: 400 });
root.querySelector(".final-art").getBoundingClientRect = () => ({
  top: footerTop - scroll,
  height: 300,
});
root.querySelectorAll("details").forEach((element) => {
  element.getBoundingClientRect = () => ({
    height: liveAnimations.has(element)
      ? liveAnimations.get(element).currentHeight
      : element === detail
      ? element.open
        ? 440
        : 100
      : element.open
      ? 250
      : 70,
  });
  element.animate = (keyframes, options) => {
    const animation = {
      keyframes,
      options,
      currentHeight: parseFloat(keyframes[0].height),
      onfinish: null,
      canceled: false,
      cancel() {
        this.canceled = true;
        if (liveAnimations.get(element) === this) {
          liveAnimations.delete(element);
        }
        if (liveAnimation === this) {
          liveAnimation = null;
        }
      },
    };
    liveAnimations.set(element, animation);
    if (element === detail) {
      liveAnimation = animation;
    }
    animations.push(animation);
    return animation;
  };
});
function flush() {
  const callbacks = [...pending.values()];
  pending.clear();
  callbacks.forEach((listener) => listener());
}
function clickSummary(target = summary) {
  const event = new win.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  assert.ok(event.defaultPrevented);
}
function assertContentInert(element, inert) {
  [...element.children]
    .filter((child) => child.tagName !== "SUMMARY")
    .forEach((child) => assert.equal(child.inert, inert));
  assert.notEqual(element.querySelector("summary").inert, true);
}
function scrollTo(value) {
  scroll = value;
  win.dispatchEvent(new win.Event("scroll"));
}
function assertLatestScrollPaint(scrollPosition) {
  assert.equal(surface.getAttribute("viewBox"), "0 0 1280 800");
  const pencil = root.querySelector("[data-pencils] g");
  const [, , y] = /^translate\(([^ ]+) ([^)]+)\)/.exec(
    pencil.getAttribute("transform"),
  );
  const target =
    158 + (800 * 0.59 - 158) * Math.min(1, scrollPosition / (800 * 0.65));
  assert.ok(Math.abs(Number(y) - target) < 1e-9, "paint reads latest scrollY");
}

async function main() {
  vm.runInContext(
    fs.readFileSync("sites/guzi-product/drawing.js", "utf8"),
    dom.getInternalVMContext(),
  );
  await Promise.resolve();
  flush();
  assert.equal(samples, 162, "AI pen routes are sampled exactly once");
  assert.equal(lengths, 5, "only scene paths request native SVG lengths");
  assert.equal(surface.getAttribute("viewBox"), "0 0 1280 800");

  scrollTo(100);
  scroll = 180;
  flush();
  assertLatestScrollPaint(180);

  const beforeResizeReads = layoutReads;
  clickSummary();
  const opening = animations.at(-1);
  assert.equal(
    JSON.stringify(opening.keyframes),
    JSON.stringify([{ height: "100px" }, { height: "440px" }]),
  );
  assert.equal(detail.open, true);
  assertContentInert(detail, false);
  opening.currentHeight = 260;
  resize();
  resize();
  scrollTo(240);
  flush();
  assert.equal(
    layoutReads,
    beforeResizeReads,
    "accordion frames do not remeasure routes",
  );
  assertLatestScrollPaint(240);
  clickSummary();
  const closing = animations.at(-1);
  assertContentInert(detail, true);
  assert.equal(opening.canceled, true);
  assert.equal(opening.onfinish, null);
  assert.equal(
    JSON.stringify(closing.keyframes),
    JSON.stringify([{ height: "260px" }, { height: "100px" }]),
  );
  assert.equal(
    detail.open,
    true,
    "closing keeps native content until completion",
  );
  closing.onfinish();
  assert.equal(detail.open, false);
  assertContentInert(detail, false);
  assert.equal(detail.style.overflow, "");
  assert.equal(detail.style.boxSizing, "");
  flush();
  assert.equal(
    layoutReads,
    beforeResizeReads + 1,
    "routes refresh once after completion",
  );

  const firstRoute = root.querySelector("[data-trails] path");
  function assertUpperWave() {
    const upperPath = firstRoute.getAttribute("d").split(" ").slice(0, -1);
    for (const command of upperPath) {
      const [x, y] = command.slice(1).split(",").map(Number);
      assert.ok(
        Math.abs(x - (86.4 + Math.sin((y + scroll - 158) / 235) * 20)) < 0.006,
      );
      assert.ok(
        y >= -70 && y < 800,
        "trail geometry stays local to the viewport",
      );
    }
  }
  assertUpperWave();
  height += 600;
  footerTop += 600;
  resize();
  flush();
  // Extending the page changes sample spacing, while the upper waveform stays fixed.
  assertUpperWave();
  assert.equal(samples, 162, "layout changes do not resample SVG routes");

  scrollTo(4000);
  flush();
  const sceneChanges = new win.MutationObserver(() => {});
  sceneChanges.observe(scene, { subtree: true, attributes: true });
  scrollTo(4001);
  flush();
  assert.equal(
    sceneChanges.takeRecords().length,
    0,
    "completed scenes receive no repeated writes",
  );

  clickSummary();
  assert.ok(liveAnimation);
  root.querySelector(".motion-toggle").click();
  assert.equal(
    detail.open,
    true,
    "disabling motion settles the current target",
  );
  assert.equal(liveAnimation, null);
  assert.equal(pending.size, 0);
  assert.equal(surface.style.display, "none");
  assert.equal(scene.querySelector("[data-draw]").style.strokeDashoffset, "0");
  assert.equal(scene.querySelector("[data-reveal]").style.opacity, "1");
  const scenePens = [...scene.querySelectorAll("[data-scene-pen]")];
  function assertStaticPens() {
    scenePens.forEach((pen) => {
      assert.equal(
        pen.style.opacity,
        "1",
        "static scenes keep both pens visible",
      );
      assert.match(pen.getAttribute("transform"), /^translate\(100 50\)/);
    });
  }
  assertStaticPens();
  scrollTo(0);
  resize();
  assert.equal(
    pending.size,
    0,
    "motion off queues no scroll or observer frames",
  );
  const countBeforeInstant = animations.length;
  clickSummary();
  assert.equal(detail.open, false);
  assert.equal(animations.length, countBeforeInstant);

  preference.matches = true;
  preferenceChange({ matches: true });
  root.querySelector(".motion-toggle").click();
  flush();
  assert.equal(scenePens[0].style.opacity, "1");
  assert.equal(
    scenePens[1].style.opacity,
    "0",
    "an upcoming AI stroke hides its pen",
  );
  scenePens.forEach((pen) => {
    assert.match(pen.getAttribute("transform"), /^translate\(0 0\)/);
  });
  root.querySelector(".motion-toggle").click();
  assertStaticPens();
  assert.equal(pending.size, 0, "static pens do not require animation frames");
  root.querySelector(".motion-toggle").click();
  flush();
  assert.equal(scenePens[0].style.opacity, "1");
  assert.equal(scenePens[1].style.opacity, "0");
  scenePens.forEach((pen) => {
    assert.match(pen.getAttribute("transform"), /^translate\(0 0\)/);
  });
  clickSummary();
  assert.equal(detail.open, true);
  assert.equal(
    animations.length,
    countBeforeInstant,
    "reduced motion keeps details instantaneous",
  );
  preference.matches = false;
  preferenceChange({ matches: false });
  flush();
  clickSummary();
  width = 800;
  win.dispatchEvent(new win.Event("resize"));
  flush();
  assert.equal(
    detail.open,
    false,
    "resize settles the target before layout measurement",
  );
  assert.equal(liveAnimation, null);
  assert.equal(
    [...root.querySelector("[data-pencils]").children].filter(
      (pen) => pen.style.display !== "none",
    ).length,
    2,
  );
  assert.equal(samples, 162);
  detail.open = true;
  win.dispatchEvent(new win.Event("resize"));
  flush();
  assert.equal(detail.open, true, "resize preserves a native open change");
  clickSummary();
  assert.equal(
    animations.at(-1).keyframes[1].height,
    "100px",
    "click closes a natively opened details element",
  );
  animations.at(-1).onfinish();
  flush();
  assert.equal(detail.open, false);
  detail.open = true;
  win.dispatchEvent(new win.Event("resize"));
  flush();
  detail.open = false;
  root.querySelector(".motion-toggle").click();
  assert.equal(detail.open, false, "motion changes preserve a native close");
  assert.equal(
    pending.size,
    0,
    "no animation or RAF remains after final paint",
  );

  root.querySelector(".motion-toggle").click();
  flush();
  const faqOne = root.querySelector("#faq-one");
  const faqTwo = root.querySelector("#faq-two");
  const faqOneSummary = faqOne.querySelector("summary");
  const faqTwoSummary = faqTwo.querySelector("summary");
  const beforeConcurrentReads = layoutReads;
  clickSummary(faqOneSummary);
  const firstFaqOpening = liveAnimations.get(faqOne);
  firstFaqOpening.currentHeight = 130;
  clickSummary(faqTwoSummary);
  const secondFaqOpening = liveAnimations.get(faqTwo);
  secondFaqOpening.currentHeight = 160;
  clickSummary();
  const canvasOpening = liveAnimations.get(detail);
  assert.equal(
    liveAnimations.size,
    3,
    "FAQ and canvas can animate concurrently",
  );
  resize();
  scrollTo(4200);
  flush();
  assert.equal(layoutReads, beforeConcurrentReads);
  firstFaqOpening.onfinish();
  scrollTo(4201);
  flush();
  assert.equal(faqOne.open, true);
  assert.equal(
    layoutReads,
    beforeConcurrentReads,
    "one completion cannot measure while others animate",
  );
  clickSummary(faqTwoSummary);
  const secondFaqClosing = liveAnimations.get(faqTwo);
  assertContentInert(faqTwo, true);
  assert.equal(secondFaqOpening.canceled, true);
  assert.equal(secondFaqClosing.keyframes[0].height, "160px");
  assert.equal(secondFaqClosing.keyframes[1].height, "70px");
  secondFaqClosing.currentHeight = 120;
  canvasOpening.onfinish();
  scrollTo(4202);
  flush();
  assert.equal(layoutReads, beforeConcurrentReads);
  clickSummary(faqTwoSummary);
  const secondFaqReopening = liveAnimations.get(faqTwo);
  assertContentInert(faqTwo, false);
  assert.equal(secondFaqClosing.canceled, true);
  assert.equal(secondFaqReopening.keyframes[0].height, "120px");
  assert.equal(secondFaqReopening.keyframes[1].height, "250px");
  secondFaqReopening.onfinish();
  flush();
  assert.equal(
    layoutReads,
    beforeConcurrentReads + 1,
    "measure waits for all disclosures to finish",
  );
  assert.equal(faqOne.open, true);
  assert.equal(faqTwo.open, true, "FAQ items remain independently open");
  [detail, faqOne, faqTwo].forEach((element) =>
    assertContentInert(element, false),
  );

  faqOne.open = false;
  win.location.hash = "#faq-anchor";
  // JSDOM does not implement fragment-driven native details expansion.
  faqOne.open = true;
  faqOne.dispatchEvent(new win.Event("toggle"));
  win.dispatchEvent(new win.Event("resize"));
  flush();
  assert.equal(
    faqOne.open,
    true,
    "native fragment expansion survives a resize",
  );
  clickSummary(faqOneSummary);
  assertContentInert(faqOne, true);
  assert.equal(liveAnimations.get(faqOne).keyframes[1].height, "70px");
  liveAnimations.get(faqOne).onfinish();
  flush();
  assert.equal(faqOne.open, false, "click closes a natively expanded FAQ");
  assertContentInert(faqOne, false);

  clickSummary(faqOneSummary);
  clickSummary(faqTwoSummary);
  assertContentInert(faqOne, false);
  assertContentInert(faqTwo, true);
  root.querySelector(".motion-toggle").click();
  assert.equal(faqOne.open, true, "manual motion off settles an opening FAQ");
  assert.equal(faqTwo.open, false, "manual motion off settles a closing FAQ");
  assert.equal(liveAnimations.size, 0);
  assert.equal(pending.size, 0);
  [detail, faqOne, faqTwo].forEach((element) =>
    assertContentInert(element, false),
  );
  const beforeInstantFaqs = animations.length;
  clickSummary(faqOneSummary);
  clickSummary(faqTwoSummary);
  assert.equal(faqOne.open, false);
  assert.equal(faqTwo.open, true);
  assertContentInert(faqOne, false);
  assertContentInert(faqTwo, false);
  assert.equal(
    animations.length,
    beforeInstantFaqs,
    "manual motion off makes FAQ clicks immediate",
  );
  faqTwo.open = false;
  root.querySelector(".motion-toggle").click();
  flush();
  assert.equal(
    faqTwo.open,
    false,
    "motion toggles preserve a natively closed FAQ",
  );

  preference.matches = true;
  preferenceChange({ matches: true });
  clickSummary(faqOneSummary);
  clickSummary(faqTwoSummary);
  assert.equal(faqOne.open, true);
  assert.equal(faqTwo.open, true);
  assertContentInert(faqOne, false);
  assertContentInert(faqTwo, false);
  assert.equal(
    animations.length,
    beforeInstantFaqs,
    "reduced motion makes every FAQ click immediate",
  );
  preference.matches = false;
  preferenceChange({ matches: false });
  flush();
  clickSummary(faqOneSummary);
  clickSummary(faqTwoSummary);
  assertContentInert(faqOne, true);
  assertContentInert(faqTwo, true);
  win.dispatchEvent(new win.Event("resize"));
  flush();
  assert.equal(faqOne.open, false);
  assert.equal(faqTwo.open, false);
  assert.equal(
    liveAnimations.size,
    0,
    "resize cancels and cleans every disclosure animation",
  );
  assert.equal(pending.size, 0);
  [detail, faqOne, faqTwo].forEach((element) => {
    assert.equal(element.style.height, "");
    assert.equal(element.style.overflow, "");
    assert.equal(element.style.boxSizing, "");
    assertContentInert(element, false);
  });
  dom.window.close();
  console.log(
    "PASS: canvas/FAQ concurrent reversal, cleanup/native expansion, latest scroll, deferred layout, geometry sampling, scene write cache, motion/reduced-motion, responsive pencils",
  );
}
main().catch((error) => {
  dom.window.close();
  console.error(error);
  process.exitCode = 1;
});
