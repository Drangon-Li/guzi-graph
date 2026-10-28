(function initDrawing(root) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const svgNS = "http://www.w3.org/2000/svg";
  const surface = root.querySelector(".page-drawing");
  const trails = surface.querySelector("[data-trails]");
  const pencils = surface.querySelector("[data-pencils]");
  const toggle = root.querySelector(".motion-toggle");
  const label = toggle.querySelector("[data-motion-label]");
  const disclosures = [
    ...root.querySelectorAll(".canvas-detail, .faq-list details"),
  ].map((element) => ({
    element,
    summary: element.querySelector("summary"),
    content: [...element.children].filter(
      (child) => child.tagName !== "SUMMARY",
    ),
    animation: null,
    targetOpen: element.open,
  }));
  const animatingDisclosures = new Set();
  const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const colors = [
    "var(--pencil-blue, #1971c2)",
    "var(--pencil-green, #2f9e44)",
    "var(--pencil-ochre, #c88a24)",
    "var(--pencil-red, #e03131)",
  ];
  let enabled = !preference.matches;
  let viewport = 0;
  let width = 0;
  let maxScroll = 0;
  let frame = 0;
  let measureNeeded = true;

  const routes = colors.map((color, index) => {
    const path = doc.createElementNS(svgNS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", index < 2 ? "1.8" : "1.4");
    path.setAttribute("stroke-linecap", "round");
    trails.append(path);
    const pencil = doc.createElementNS(svgNS, "g");
    pencil.style.color = color;
    const drawing = doc.createElementNS(svgNS, "use");
    drawing.setAttribute("href", "#pencil");
    pencil.append(drawing);
    pencils.append(pencil);
    return { path, pencil, samples: [], visible: true };
  });

  const scenes = [...root.querySelectorAll("[data-drawing]")].map(
    (element) => ({
      element,
      start: 0,
      end: 1,
      progress: -1,
      strokes: [...element.querySelectorAll("[data-draw]")].map((path) => {
        const length = path.getTotalLength();
        path.style.strokeDasharray = `${length} ${length}`;
        return {
          path,
          length,
          start: Number(path.dataset.start || 0),
          end: Number(path.dataset.end || 1),
          drawn: -1,
        };
      }),
      reveals: [...element.querySelectorAll("[data-reveal]")].map(
        (element) => ({
          element,
          start: Number(element.dataset.reveal),
          opacity: -1,
        }),
      ),
      pens: [...element.querySelectorAll("[data-scene-pen]")].map((pen) => {
        const path = element.querySelector(
          `[data-pen-route="${pen.dataset.scenePen}"]`,
        );
        const length = path.getTotalLength();
        return {
          element: pen,
          start: Number(path.dataset.start || 0),
          end: Number(path.dataset.end || 1),
          drawn: -1,
          tilt: pen.dataset.scenePen === "ai" ? 17 : -15,
          samples: Array.from({ length: 81 }, (_, index) => {
            const point = path.getPointAtLength((index / 80) * length);
            return { x: point.x, y: point.y };
          }),
        };
      }),
    }),
  );

  function measure() {
    viewport = win.innerHeight;
    width = root.clientWidth;
    const scrollPosition = win.scrollY;
    const height = root.scrollHeight;
    const mobile = width <= 900;
    const wrap = root.querySelector(".hero").getBoundingClientRect();
    const footer = root.querySelector(".final-art").getBoundingClientRect();
    const finish = footer.top + scrollPosition + footer.height * 0.53;
    const left = mobile ? 10 : Math.max(22, wrap.left * 0.48);
    const right = width - left;
    maxScroll = Math.max(1, height - viewport);
    const bounds = scenes.map((scene) => scene.element.getBoundingClientRect());
    surface.setAttribute("viewBox", `0 0 ${width} ${viewport}`);

    routes.forEach((route, index) => {
      const isLeft = index % 2 === 0;
      const direction = isLeft ? 1 : -1;
      const inner = index >= 2;
      const start = inner ? Math.min(viewport * 0.72, 630) : 158;
      const base = (isLeft ? left : right) + (inner ? direction * 24 : 0);
      const wave = mobile ? 6 : 20;
      const endX = mobile
        ? base
        : width / 2 + direction * (inner ? -185 : -355);
      const count = Math.max(1, Math.ceil((finish - start) / 64));
      route.samples = Array.from({ length: count + 1 }, (_, sample) => {
        const y = start + ((finish - start) * sample) / count;
        const blend = clamp((y - (finish - 600)) / 600);
        const join = blend * blend * (3 - 2 * blend);
        const x =
          (base + Math.sin((y - start) / 235) * wave * direction) * (1 - join) +
          endX * join;
        return { x, y };
      });
      route.start = start;
      route.viewportTarget = inner ? 0.79 : 0.59;
      route.scale = mobile ? 0.48 : 0.83;
      route.visible = !mobile || !inner;
      route.path.style.display = route.visible ? "" : "none";
      route.pencil.style.display = route.visible ? "" : "none";
    });
    scenes.forEach((scene, index) => {
      const boundsForScene = bounds[index];
      const top = boundsForScene.top + scrollPosition;
      scene.start = top - viewport * 0.9;
      scene.end = Math.max(
        scene.start + 1,
        Math.min(
          maxScroll,
          top + boundsForScene.height * 0.6 - viewport * 0.15,
        ),
      );
    });
    measureNeeded = false;
  }

  function renderScene(scene, progress) {
    if (progress === scene.progress) {
      return;
    }
    scene.progress = progress;
    scene.strokes.forEach((stroke) => {
      const drawn = clamp(
        (progress - stroke.start) / (stroke.end - stroke.start),
      );
      if (drawn !== stroke.drawn) {
        stroke.path.style.strokeDashoffset = stroke.length * (1 - drawn);
        stroke.drawn = drawn;
      }
    });
    scene.reveals.forEach((reveal) => {
      const opacity = clamp(
        (progress - reveal.start) / Math.min(0.1, 1 - reveal.start),
      );
      if (opacity !== reveal.opacity) {
        reveal.element.style.opacity = opacity;
        reveal.opacity = opacity;
      }
    });
    scene.pens.forEach((pen) => {
      const drawn = clamp((progress - pen.start) / (pen.end - pen.start));
      if (drawn === pen.drawn) {
        return;
      }
      pen.drawn = drawn;
      const position = drawn * (pen.samples.length - 1);
      const index = Math.min(Math.floor(position), pen.samples.length - 2);
      const fraction = position - index;
      const before = pen.samples[index];
      const after = pen.samples[index + 1];
      const x = before.x + (after.x - before.x) * fraction;
      const y = before.y + (after.y - before.y) * fraction;
      pen.element.setAttribute(
        "transform",
        `translate(${x} ${y}) rotate(${pen.tilt})`,
      );
      pen.element.style.opacity = progress >= pen.start ? "1" : "0";
    });
  }

  function render() {
    frame = 0;
    if (!enabled) {
      return;
    }
    if (measureNeeded && (!animatingDisclosures.size || !viewport)) {
      measure();
    }
    // Read at paint time so wheel/trackpad events cannot leave the pens a frame behind.
    const scrollPosition = win.scrollY;
    routes.forEach((route) => {
      if (!route.visible) {
        return;
      }
      const targetY =
        scrollPosition +
        route.start +
        (viewport * route.viewportTarget - route.start) *
          clamp(scrollPosition / (viewport * 0.65));
      const points = route.samples;
      let low = 0;
      let high = points.length - 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (points[middle].y <= targetY) {
          low = middle;
        } else {
          high = middle;
        }
      }
      const before = points[low];
      const after = points[high];
      const fraction = clamp((targetY - before.y) / (after.y - before.y));
      const x = before.x + (after.x - before.x) * fraction;
      const y = before.y + (after.y - before.y) * fraction;
      // Clip the trail before painting: offscreen page-length dashes otherwise
      // have to be rasterized again on every scroll frame.
      const first = Math.max(
        0,
        Math.floor(
          (scrollPosition - 2 - points[0].y) / (points[1].y - points[0].y),
        ),
      );
      const visible = points.slice(first, low + 1);
      visible.push({ x, y });
      route.path.setAttribute(
        "d",
        visible
          .map(
            (point, index) =>
              `${index ? "L" : "M"}${point.x.toFixed(2)},${(
                point.y - scrollPosition
              ).toFixed(2)}`,
          )
          .join(" "),
      );
      const angle =
        (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI -
        90;
      route.pencil.setAttribute(
        "transform",
        `translate(${x} ${y - scrollPosition}) rotate(${angle}) scale(${
          route.scale
        })`,
      );
    });
    scenes.forEach((scene) => {
      renderScene(
        scene,
        clamp((scrollPosition - scene.start) / (scene.end - scene.start)),
      );
    });
  }

  function schedule() {
    if (enabled && !frame) {
      frame = win.requestAnimationFrame(render);
    }
  }

  function refresh() {
    measureNeeded = true;
    if (!animatingDisclosures.size) {
      schedule();
    }
  }

  function settleDisclosure(disclosure) {
    const detail = disclosure.element;
    if (disclosure.animation) {
      disclosure.animation.onfinish = null;
      disclosure.animation.cancel();
      disclosure.animation = null;
      detail.open = disclosure.targetOpen;
    } else {
      disclosure.targetOpen = detail.open;
    }
    animatingDisclosures.delete(disclosure);
    detail.style.height = "";
    detail.style.overflow = "";
    detail.style.boxSizing = "";
    disclosure.content.forEach((element) => {
      element.inert = false;
    });
    refresh();
  }

  disclosures.forEach((disclosure) => {
    const detail = disclosure.element;
    disclosure.summary.addEventListener("click", (event) => {
      event.preventDefault();
      const currentHeight = detail.getBoundingClientRect().height;
      disclosure.targetOpen = !(disclosure.animation
        ? disclosure.targetOpen
        : detail.open);
      disclosure.content.forEach((element) => {
        element.inert = !disclosure.targetOpen;
      });
      if (!enabled || preference.matches || !detail.animate) {
        detail.open = disclosure.targetOpen;
        settleDisclosure(disclosure);
        return;
      }
      if (disclosure.animation) {
        disclosure.animation.onfinish = null;
        disclosure.animation.cancel();
      }
      detail.style.height = "";
      detail.open = disclosure.targetOpen;
      const targetHeight = detail.getBoundingClientRect().height;
      // Keep native content present until a closing animation reaches the summary.
      detail.open = true;
      detail.style.overflow = "hidden";
      detail.style.boxSizing = "border-box";
      disclosure.animation = detail.animate(
        [{ height: `${currentHeight}px` }, { height: `${targetHeight}px` }],
        { duration: 280, easing: "cubic-bezier(.22,.68,.2,1)", fill: "both" },
      );
      animatingDisclosures.add(disclosure);
      disclosure.animation.onfinish = () => settleDisclosure(disclosure);
      measureNeeded = true;
    });
  });

  function setMotion(value) {
    enabled = value;
    disclosures.forEach(settleDisclosure);
    toggle.setAttribute("aria-pressed", String(enabled));
    label.textContent = `绘画动效：${enabled ? "开" : "关"}`;
    root.dataset.motion = enabled ? "on" : "off";
    surface.style.display = enabled ? "" : "none";
    if (!enabled) {
      if (frame) {
        win.cancelAnimationFrame(frame);
        frame = 0;
      }
      scenes.forEach((scene) => {
        // Motion can change while a scene is already fully drawn.
        scene.progress = -1;
        scene.pens.forEach((pen) => {
          pen.drawn = -1;
        });
        renderScene(scene, 1);
      });
    } else {
      scenes.forEach((scene) => {
        scene.progress = -1;
        scene.pens.forEach((pen) => {
          pen.drawn = -1;
        });
      });
      schedule();
    }
  }

  win.addEventListener("scroll", schedule, { passive: true });
  win.addEventListener(
    "resize",
    () => {
      disclosures.forEach(settleDisclosure);
      refresh();
    },
    { passive: true },
  );
  win.addEventListener("pageshow", refresh);
  preference.addEventListener("change", (event) => setMotion(!event.matches));
  toggle.addEventListener("click", () => setMotion(!enabled));
  const observer = new win.ResizeObserver(refresh);
  observer.observe(root);
  doc.fonts.ready.then(refresh);
  toggle.hidden = false;
  setMotion(enabled);
})(document.querySelector("[data-site]"));
