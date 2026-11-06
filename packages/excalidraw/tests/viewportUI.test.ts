import { vi } from "vitest";

import { TEXT_VIEWPORT_PADDING } from "@excalidraw/common";
import { newElement } from "@excalidraw/element";

import { AppText } from "../components/App.text";
import { AppViewport } from "../components/App.viewport";
import { AnimationController } from "../renderer/animation";

import type App from "../components/App";

const setup = () => {
  const container = document.createElement("div");
  const rect = (left: number, width: number) =>
    new DOMRect(left, 50, width, 800);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(100, 1000));
  const app = {
    state: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    },
    props: {},
    ownerWindow: container.ownerDocument.defaultView!,
    isInteractionEnabled: () => true,
    requestUnfollow: vi.fn(),
    wheel: { cancelPan: vi.fn() },
    editorInterface: { formFactor: "desktop" },
    isDefaultUIEnabled: () => true,
  } as unknown as App;
  const dependencies = {
    getContainer: () => container,
    getStylesPanelMode: () => "compact" as const,
    isGestureActive: () => false,
    isPointerDown: () => false,
  };
  const viewport = new AppViewport(app, dependencies);
  app.viewport = viewport;
  const text = new AppText(app, dependencies);
  const addPanel = (name: string, left: number, width: number) => {
    const panel = container.ownerDocument.createElement("div");
    panel.dataset.viewportUi = "side";
    panel.dataset.viewportUiName = name;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(left, width));
    panel.getAnimations = () => [];
    container.append(panel);
    return panel;
  };
  return { viewport, text, addPanel, app, dependencies };
};

describe("tool dock viewport offsets", () => {
  it.each([
    [100, { left: 80, right: 0 }],
    [1020, { left: 0, right: 80 }],
  ])("measures a dock at %s for sidebar and text offsets", (left, insets) => {
    const { viewport, text, addPanel } = setup();
    addPanel("toolDock", left, 80);
    expect(viewport.getSidebarInsets()).toEqual(insets);
    expect(text.getTextViewportOffsets()).toEqual({
      top: TEXT_VIEWPORT_PADDING,
      bottom: TEXT_VIEWPORT_PADDING,
      left: insets.left + TEXT_VIEWPORT_PADDING,
      right: insets.right + TEXT_VIEWPORT_PADDING,
    });
  });

  it("measures the dock independently of the sidebar without reserving it", () => {
    const { viewport, addPanel } = setup();
    addPanel("sidebar", 800, 300);
    const dock = addPanel("toolDock", 100, 80);
    expect(viewport.getSidebarInsets()).toEqual({ left: 80, right: 300 });
    dock.remove();
    expect(viewport.getSidebarInsets()).toEqual({ left: 0, right: 300 });
    expect(
      viewport.getSideInsets(["toolDock"], { reserve: { sidebar: true } }),
    ).toEqual({ left: 0, right: 0 });
  });
});

describe("selection visibility behind the properties panel", () => {
  afterEach(() => vi.restoreAllMocks());

  const setupSelection = (x = 50, width = 100, y = 100) => {
    const result = setup();
    const { app, dependencies } = result;
    const selected = [
      newElement({ type: "rectangle", x, y, width, height: 100 }),
    ];
    app.scene = {
      getSelectedElements: () => selected,
    } as unknown as App["scene"];
    app.setState = vi.fn((update) => {
      Object.assign(
        app.state,
        typeof update === "function" ? update(app.state, app.props) : update,
      );
    }) as App["setState"];
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(app.ownerWindow, "requestAnimationFrame").mockImplementation(
      (callback) => {
        frames.set(++frameId, callback);
        return frameId;
      },
    );
    vi.spyOn(app.ownerWindow, "cancelAnimationFrame").mockImplementation(
      (id) => {
        frames.delete(id);
      },
    );
    const flushFrame = () => {
      const current = [...frames.values()];
      frames.clear();
      current.forEach((callback) => callback(0));
    };
    let finishAnimation = () => {};
    vi.spyOn(AnimationController, "start").mockImplementation(
      (_key, animation) => {
        finishAnimation = () => {
          animation({ deltaTime: 220 });
        };
      },
    );
    dependencies.isGestureActive = vi.fn(() => false);
    dependencies.isPointerDown = vi.fn(() => false);
    return {
      ...result,
      selected,
      flushFrame,
      finishAnimation: () => finishAnimation(),
    };
  };

  it.each([
    [100, 50, 1, 182],
    [884, 850, 1, -182],
    [100, 25, 2, 91],
  ])(
    "moves away from a panel at %s without changing zoom",
    (panelLeft, x, zoom, scrollX) => {
      const fixture = setupSelection(x, 100 / zoom);
      const { app, viewport, addPanel, flushFrame, finishAnimation } = fixture;
      Object.assign(app.state, {
        zoom: { value: zoom as App["state"]["zoom"]["value"] },
      });
      addPanel("stylesPanel", panelLeft, 216);
      viewport.revealSelection();
      flushFrame();
      finishAnimation();
      expect(app.state.scrollX).toBe(scrollX);
      expect(app.state.scrollY).toBe(0);
      expect(app.state.zoom.value).toBe(zoom);
      viewport.destroy();
    },
  );

  it("also measures the actual desktop properties dock", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection();
    addPanel("toolDock", 100, 280);
    viewport.revealSelection();
    flushFrame();
    finishAnimation();
    expect(app.state.scrollX).toBe(246);
    expect(app.state.zoom.value).toBe(1);
    viewport.destroy();
  });

  it("waits for a newly selected desktop panel to mount and finish its width transition", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection();
    viewport.revealSelection();
    flushFrame();
    expect(AnimationController.start).not.toHaveBeenCalled();
    const panel = addPanel("toolDock", 100, 280);
    const animations = vi
      .spyOn(panel, "getAnimations")
      .mockReturnValue([{ playState: "running" } as Animation]);
    flushFrame();
    expect(AnimationController.start).not.toHaveBeenCalled();
    animations.mockReturnValue([]);
    flushFrame();
    finishAnimation();
    expect(app.state.scrollX).toBe(246);
    viewport.destroy();
  });

  it("allows a new gesture to cancel waiting for a desktop panel transition", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection();
    const panel = addPanel("toolDock", 100, 280);
    const animations = vi
      .spyOn(panel, "getAnimations")
      .mockReturnValue([{ playState: "running" } as Animation]);
    viewport.revealSelection();
    flushFrame();
    viewport.interruptSelectionReveal();
    animations.mockReturnValue([]);
    flushFrame();
    finishAnimation();
    expect(AnimationController.start).not.toHaveBeenCalled();
    expect(app.state.scrollX).toBe(0);
    viewport.destroy();
  });

  it("moves an oversized selection only until its center reaches the available area", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection(-900, 1100);
    addPanel("stylesPanel", 100, 216);
    viewport.revealSelection();
    flushFrame();
    finishAnimation();
    expect(app.state.scrollX).toBe(582);
    expect(app.state.zoom.value).toBe(1);
    viewport.destroy();
  });

  it.each(["visible", "below-panel", "no-panel", "no-selection"])(
    "leaves a %s selection alone",
    (mode) => {
      const { app, viewport, addPanel, selected, flushFrame, finishAnimation } =
        setupSelection(
          mode === "visible" ? 400 : 50,
          100,
          mode === "below-panel" ? 900 : 100,
        );
      if (mode !== "no-panel") {
        addPanel("stylesPanel", 100, 216);
      }
      if (mode === "no-selection") {
        selected.splice(0);
      }
      viewport.revealSelection();
      flushFrame();
      finishAnimation();
      expect(app.state.scrollX).toBe(0);
      expect(AnimationController.start).not.toHaveBeenCalled();
      viewport.destroy();
    },
  );

  it.each(["loading", "read-only", "following", "locked", "gesture"])(
    "preserves the %s viewport",
    (mode) => {
      const {
        app,
        viewport,
        addPanel,
        dependencies,
        flushFrame,
        finishAnimation,
      } = setupSelection();
      addPanel("stylesPanel", 100, 216);
      if (mode === "loading") {
        Object.assign(app.state, { isLoading: true });
      }
      if (mode === "read-only") {
        Object.assign(app.state, { viewModeEnabled: true });
      }
      if (mode === "following") {
        Object.assign(app, {
          props: {
            userToFollow: { socketId: "peer", username: "peer" },
          } as App["props"],
        });
      }
      if (mode === "locked") {
        Object.assign(app.state, {
          scrollConstraints: {} as NonNullable<
            App["state"]["scrollConstraints"]
          >,
        });
      }
      if (mode === "gesture") {
        vi.mocked(dependencies.isGestureActive).mockReturnValue(true);
      }
      viewport.revealSelection();
      flushFrame();
      finishAnimation();
      expect(app.state.scrollX).toBe(0);
      expect(AnimationController.start).not.toHaveBeenCalled();
      viewport.destroy();
    },
  );

  it.each([
    [0, 80],
    [-200, 182],
  ])(
    "reveals within an X-only lock starting at %s and retains the lock",
    (x, expectedX) => {
      const { app, viewport, addPanel, flushFrame, finishAnimation } =
        setupSelection();
      const scrollConstraints = {
        x,
        y: 0,
        width: 2000,
        height: 1,
        lockScroll: "x" as const,
        lockZoom: false,
        zoom: 1,
        overscroll: 50,
        offsets: { left: 80 },
      };
      Object.assign(app.state, { scrollConstraints, scrollY: 20 });
      addPanel("stylesPanel", 100, 216);
      viewport.revealSelection();
      flushFrame();
      expect(viewport.isLockedTransitionPending).toBe(false);
      finishAnimation();
      expect(app.state.scrollX).toBe(expectedX);
      expect(app.state.scrollY).toBe(20);
      expect(app.state.scrollConstraints).toBe(scrollConstraints);
      viewport.destroy();
    },
  );

  it("rechecks updated horizontal bounds when selection reveal settles", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection();
    const scrollConstraints = {
      x: 0,
      y: 0,
      width: 2000,
      height: 1,
      lockScroll: "x" as const,
      lockZoom: false,
      zoom: 1,
      overscroll: 50,
      offsets: { left: 200 },
    };
    Object.assign(app.state, { scrollConstraints });
    addPanel("stylesPanel", 100, 216);
    viewport.revealSelection();
    flushFrame();
    const updated = { ...scrollConstraints, offsets: { left: 40 } };
    Object.assign(app.state, { scrollConstraints: updated });
    finishAnimation();
    expect(app.state.scrollX).toBe(40);
    expect(app.state.scrollConstraints).toBe(updated);
    viewport.destroy();
  });

  it("waits until the last pointer is released before moving the viewport", () => {
    const {
      app,
      viewport,
      addPanel,
      dependencies,
      flushFrame,
      finishAnimation,
    } = setupSelection();
    addPanel("stylesPanel", 100, 216);
    vi.mocked(dependencies.isPointerDown).mockReturnValue(true);
    viewport.revealSelection();
    flushFrame();
    expect(AnimationController.start).not.toHaveBeenCalled();
    expect(app.state.scrollX).toBe(0);
    vi.mocked(dependencies.isPointerDown).mockReturnValue(false);
    viewport.resumeSelectionReveal();
    flushFrame();
    finishAnimation();
    expect(app.state.scrollX).toBe(182);
    viewport.destroy();
  });

  it.each(["pointer", "translate", "navigation", "destroy"])(
    "cancels a pending reveal when interrupted by %s",
    (mode) => {
      const { app, viewport, addPanel, flushFrame } = setupSelection();
      addPanel("stylesPanel", 100, 216);
      viewport.revealSelection();
      if (mode === "pointer") {
        viewport.interruptSelectionReveal();
      }
      if (mode === "translate") {
        viewport.translate({ scrollX: 42 });
      }
      if (mode === "navigation") {
        viewport.setViewport(null);
        expect(app.wheel.cancelPan).toHaveBeenCalledTimes(1);
      }
      if (mode === "destroy") {
        viewport.destroy();
      }
      viewport.resumeSelectionReveal();
      flushFrame();
      expect(AnimationController.start).not.toHaveBeenCalled();
      expect(app.state.scrollX).toBe(mode === "translate" ? 42 : 0);
      viewport.destroy();
    },
  );

  it("does not let an interrupted animation override the user's viewport", () => {
    const { app, viewport, addPanel, flushFrame, finishAnimation } =
      setupSelection();
    addPanel("stylesPanel", 100, 216);
    viewport.revealSelection();
    flushFrame();
    viewport.interruptSelectionReveal();
    Object.assign(app.state, { scrollX: 42 });
    finishAnimation();
    expect(app.state.scrollX).toBe(42);
    expect(app.state.shouldCacheIgnoreZoom).toBe(false);
    viewport.destroy();
  });
});
