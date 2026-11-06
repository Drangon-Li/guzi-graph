import { vi } from "vitest";

import { CaptureUpdateAction } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { getNormalizedZoom } from "@excalidraw/excalidraw/scene";
import { AnimationController } from "@excalidraw/excalidraw/renderer/animation";
import {
  constrainScrollState,
  getViewportForZoomWithScrollConstraints,
} from "@excalidraw/excalidraw/viewport";
import {
  act,
  fireEvent,
  render,
  waitFor,
  GlobalTestState,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import {
  appendPaperPage,
  createPaperPage,
  createPaperTemplate,
  getPaperPages,
} from "./paper";

import type { CanvasDocument } from "../workspace/workspace";

const toolPanelLabels = {
  title: "Tool panel",
  canvas: "Canvas tools",
  properties: "Element properties",
  pin: "Pin tools",
  pinLeft: "Dock left",
  pinRight: "Dock right",
  unpin: "Unpin tools",
  collapse: "Collapse tools",
  expand: "Expand tools",
  resize: "Resize tools",
};

describe("paper page controls in the root editor", () => {
  let api: ExcalidrawImperativeAPI;
  let dispose: (() => void) | undefined;
  const pages = () => getPaperPages(api.getSceneElements());
  const middle = (clientY: number, clientX = 400) => ({
    pointerId: 1,
    pointerType: "mouse",
    button: 1,
    buttons: 4,
    clientX,
    clientY,
  });
  const setup = async (dock?: "left" | "right") => {
    dispose?.();
    const { unmount } = await render(
      <SubcanvasEditor
        document={{ title: "Paper" } as CanvasDocument}
        initialData={createPaperTemplate("ruled", "portrait")}
        desktopIntegration={
          dock
            ? {
                save: async () => true,
                open: async () => {},
                toolPanel: {
                  pinned: false,
                  dock,
                  onDockChange: () => {},
                  onPinnedChange: () => {},
                  labels: toolPanelLabels,
                },
              }
            : undefined
        }
        onExcalidrawAPI={(value) => {
          if (value) {
            api = value;
          }
        }}
      />,
    );
    dispose = unmount;
    await waitFor(() => expect(api.getAppState().isLoading).toBe(false));
    act(() =>
      API.setAppState({
        width: 1200,
        height: 800,
        zoom: { value: getNormalizedZoom(1) },
      }),
    );
    act(() => {
      const state = api.getAppState();
      api.updateScene({
        appState: {
          scrollY:
            (state.height - (api.getViewportOffsets().bottom ?? 24)) /
              state.zoom.value -
            pages()[0].height +
            30,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  };

  const setCenteredZoom = (value: number) => {
    act(() => {
      const state = api.getAppState();
      const zoom = { value: getNormalizedZoom(value) };
      API.setAppState(
        constrainScrollState({
          ...state,
          zoom,
          scrollX: state.width / (2 * value) - pages()[0].width / 2,
          scrollY: state.height / (2 * value) - pages()[0].height / 2,
        }),
      );
    });
  };

  beforeEach(() => setup());
  afterEach(() => {
    dispose = undefined;
  });

  it.each(["left", "right"] as const)(
    "animates the camera as selection opens and closes a %s dock, including reversal",
    async (dock) => {
      await setup(dock);
      setCenteredZoom(2);
      const ink = API.createElement({ type: "rectangle", x: 200, y: 250 });
      act(() =>
        api.updateScene({
          elements: [...api.getSceneElementsIncludingDeleted(), ink],
        }),
      );
      const start = api.getAppState().scrollX;
      const direction = dock === "left" ? 1 : -1;
      const cameraDelta = () => (api.getAppState().scrollX - start) * direction;
      API.setSelectedElements([ink]);
      await waitFor(
        () => {
          expect(cameraDelta()).toBeGreaterThan(0);
          expect(cameraDelta()).toBeLessThan(65);
        },
        { interval: 10 },
      );
      const openingFrame = api.getAppState().scrollX;
      API.setSelectedElements([]);
      expect(api.getAppState().scrollX).toBe(openingFrame);
      await waitFor(() => expect(cameraDelta()).toBeCloseTo(0));

      API.setSelectedElements([ink]);
      await waitFor(() => expect(cameraDelta()).toBeGreaterThanOrEqual(69));
      const opened = api.getAppState().scrollX;
      API.setSelectedElements([]);
      expect(api.getAppState().scrollX).toBe(opened);
      await waitFor(() => expect(cameraDelta()).toBeCloseTo(0));
    },
  );

  it("settles a sidebar change immediately with reduced motion", async () => {
    await setup("left");
    setCenteredZoom(2);
    const ink = API.createElement({ type: "rectangle", x: 200, y: 250 });
    act(() =>
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ink],
      }),
    );
    const { ownerWindow, viewport } = window.h.app;
    const media = ownerWindow.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = vi.spyOn(ownerWindow, "matchMedia").mockReturnValue({
      ...media,
      matches: true,
    });
    try {
      const start = api.getAppState().scrollX;
      API.setSelectedElements([ink]);
      await waitFor(() =>
        expect(api.getAppState().scrollX - start).toBeGreaterThanOrEqual(69),
      );
      expect(
        AnimationController.running(viewport.scrollConstraintsAnimationKey),
      ).toBe(false);
    } finally {
      reduced.mockRestore();
    }
  });

  it.each([
    ["scrollX", 1],
    ["scrollX", -1],
    ["scrollY", 1],
    ["scrollY", -1],
  ] as const)(
    "resists and returns from the %s edge (%s) of a short PDF",
    async (axis, direction) => {
      const page = pages()[0];
      act(() =>
        api.updateScene({
          elements: api.getSceneElementsIncludingDeleted().map((element) =>
            element.id === page.id
              ? {
                  ...element,
                  customData: { guziPaper: { version: 1, kind: "pdf" } },
                }
              : element,
          ),
        }),
      );
      setCenteredZoom(0.3);
      const start = api.getAppState()[axis];
      const position = (distance: number) =>
        axis === "scrollX"
          ? middle(300, 400 + distance * direction)
          : middle(300 + distance * direction);
      const displacement = () =>
        (api.getAppState()[axis] - start) * direction * 0.3;
      fireEvent.pointerDown(GlobalTestState.interactiveCanvas, position(0));
      let previous = 0;
      let previousTravel = 40;
      for (const distance of [40, 80, 120, 160]) {
        fireEvent.pointerMove(
          GlobalTestState.interactiveCanvas,
          position(distance),
        );
        const current = displacement();
        const travel = current - previous;
        expect(travel).toBeGreaterThan(0);
        expect(travel).toBeLessThan(previousTravel);
        previousTravel = travel;
        previous = current;
      }
      fireEvent.pointerMove(GlobalTestState.interactiveCanvas, position(2400));
      const stretched = displacement();
      expect(stretched).toBeGreaterThan(70);
      expect(stretched).toBeLessThan(80);
      fireEvent.pointerMove(GlobalTestState.interactiveCanvas, position(2388));
      expect(stretched - displacement()).toBeCloseTo(12);
      fireEvent.pointerUp(window, { ...position(2388), buttons: 0 });
      expect(displacement()).toBeGreaterThan(0);
      await waitFor(() => expect(api.getAppState()[axis]).toBeCloseTo(start));
      expect(pages()).toHaveLength(1);
    },
  );

  it.each(["pointer", "wheel"] as const)(
    "disarms a %s pull after retreating below the reset threshold",
    async (source) => {
      const canvas = GlobalTestState.interactiveCanvas;
      if (source === "pointer") {
        fireEvent.pointerDown(canvas, middle(300));
        fireEvent.pointerMove(canvas, middle(190));
      } else {
        act(() => API.setAppState({ inputDevice: "trackpad" }));
        fireEvent.wheel(canvas, { deltaY: 120 });
        fireEvent.wheel(canvas, { deltaY: 80 });
      }
      const hint = () =>
        canvas.ownerDocument.querySelector(".desktop-paper-pull-hint");
      expect(hint()).toHaveClass("is-ready");
      if (source === "pointer") {
        fireEvent.pointerMove(canvas, middle(220));
        expect(hint()).not.toHaveClass("is-ready");
        fireEvent.pointerUp(window, { ...middle(220), buttons: 0 });
      } else {
        fireEvent.wheel(canvas, { deltaY: -30 });
        expect(hint()).not.toHaveClass("is-ready");
      }
      await waitFor(() =>
        expect(api.getAppState().scrollY).toBeCloseTo(
          constrainScrollState(api.getAppState()).scrollY,
        ),
      );
      expect(pages()).toHaveLength(1);
    },
  );

  it("waits for a real release, adds one ruled sheet, then undoes and redoes it atomically", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    expect(pages()).toHaveLength(1);
    const viewport = api.getAppState();
    const trace: number[] = [];
    const unsubscribe = api.onChange((_elements, state) => {
      if (pages().length === 2) {
        trace.push(state.scrollY);
      }
    });
    fireEvent.pointerUp(window, { ...middle(180), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(trace[0]).toBe(viewport.scrollY);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });
    unsubscribe();
    expect(trace.every((scrollY) => scrollY === viewport.scrollY)).toBe(true);
    expect(api.getAppState()).toMatchObject({
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
      zoom: viewport.zoom,
    });
    expect(pages()[1].customData?.guziPaper.kind).toBe("ruled");
    act(() => api.history.undo!());
    await waitFor(() => expect(pages()).toHaveLength(1));
    act(() => api.history.redo!());
    await waitFor(() => expect(pages()).toHaveLength(2));
  });

  it.each(["wheel", "pointer"] as const)(
    "lets fresh %s take over a running paper spring at its current frame",
    async (source) => {
      act(() => API.setAppState({ inputDevice: "trackpad" }));
      const canvas = GlobalTestState.interactiveCanvas;
      const { viewport } = window.h.app;
      fireEvent.pointerDown(canvas, middle(300));
      fireEvent.pointerMove(canvas, middle(180));
      fireEvent.keyDown(window, { key: "Escape" });
      const held = api.getAppState().scrollY;
      fireEvent.pointerUp(window, { ...middle(180), buttons: 0 });
      await waitFor(
        () => {
          expect(
            AnimationController.running(viewport.snapBackAnimationKey),
          ).toBe(true);
          expect(api.getAppState().scrollY).toBeGreaterThan(held + 0.1);
        },
        { interval: 10 },
      );
      const before = api.getAppState();
      const edge = constrainScrollState(before).scrollY;
      const distance = (edge - before.scrollY) * before.zoom.value + 9;
      if (source === "wheel") {
        fireEvent.wheel(canvas, { deltaY: -distance });
      } else {
        fireEvent.pointerDown(canvas, middle(300));
        expect(api.getAppState().scrollY).toBe(before.scrollY);
        fireEvent.pointerMove(canvas, middle(300 + distance));
        fireEvent.pointerUp(window, { ...middle(300 + distance), buttons: 0 });
      }
      const destination = before.scrollY + distance / before.zoom.value;
      expect(api.getAppState().scrollY).toBeCloseTo(destination);
      expect(AnimationController.running(viewport.snapBackAnimationKey)).toBe(
        false,
      );
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 240));
      });
      expect(api.getAppState().scrollY).toBeCloseTo(destination);
      expect(pages()).toHaveLength(1);
    },
  );

  it("keeps Escape cancelled through later moves, then permits a fresh drag", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(100));
    fireEvent.pointerUp(window, { ...middle(100), buttons: 0 });
    expect(pages()).toHaveLength(1);
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(220));
    fireEvent.pointerUp(window, { ...middle(220), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
  });

  it("uses each wheel position when ticks commit together and ignores horizontal snapback", async () => {
    act(() => API.setAppState({ inputDevice: "trackpad" }));
    const canvas = GlobalTestState.interactiveCanvas;
    act(() => {
      for (const deltaY of [120, 64]) {
        canvas.dispatchEvent(
          new window.WheelEvent("wheel", { bubbles: true, deltaY }),
        );
      }
    });
    expect(pages()).toHaveLength(1);
    expect(
      canvas.ownerDocument.querySelector(".desktop-paper-pull-hint"),
    ).toHaveClass("is-ready");
    const viewport = api.getAppState();
    // The elastic x boundary can settle while the same wheel stream idles.
    act(() =>
      api.updateScene({
        appState: { scrollX: viewport.scrollX + 1 },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(api.getAppState().scrollY).toBe(viewport.scrollY);
    expect(api.getAppState().zoom).toEqual(viewport.zoom);
  });

  const dispatchWheel = (deltaY: number, momentum = false) => {
    const canvas = GlobalTestState.interactiveCanvas;
    const event = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
    });
    // jsdom's WheelEvent is older than Chromium's momentum field.
    Object.defineProperty(event, "momentum", { value: momentum });
    canvas.dispatchEvent(event);
  };

  it("commits one page before applying the first and subsequent momentum deltas from the same batch", async () => {
    act(() => API.setAppState({ inputDevice: "trackpad" }));
    const trace: { pages: number; scrollY: number }[] = [];
    const unsubscribe = api.onChange((_elements, state) => {
      trace.push({ pages: pages().length, scrollY: state.scrollY });
    });
    act(() => {
      dispatchWheel(120);
      dispatchWheel(64);
      dispatchWheel(23, true);
      dispatchWheel(7, true);
    });
    await waitFor(() => expect(pages()).toHaveLength(2));
    const previous = trace.filter((entry) => entry.pages === 1).at(-1)!;
    const appended = trace.find((entry) => entry.pages === 2)!;
    expect(appended.scrollY).toBe(previous.scrollY);
    expect(api.getAppState().scrollY).toBeCloseTo(appended.scrollY - 30);
    act(() => {
      dispatchWheel(6000, true);
      dispatchWheel(800, true);
      dispatchWheel(-600, true);
    });
    await waitFor(() => {
      const state = api.getAppState();
      const edge = constrainScrollState({
        ...state,
        scrollY: -Infinity,
      }).scrollY;
      expect(state.scrollY).toBeCloseTo(edge);
    });
    expect(pages()).toHaveLength(2);
    unsubscribe();
  });

  it("applies pure momentum within the page and never creates a continuation", async () => {
    act(() => API.setAppState({ inputDevice: "trackpad" }));
    const start = api.getAppState().scrollY;
    act(() => dispatchWheel(8, true));
    expect(api.getAppState().scrollY).toBeCloseTo(start - 8);
    act(() => {
      dispatchWheel(400, true);
      dispatchWheel(400, true);
      dispatchWheel(-50, true);
    });
    await waitFor(() => {
      const state = api.getAppState();
      expect(state.scrollY).toBeCloseTo(
        constrainScrollState({ ...state, scrollY: -Infinity }).scrollY,
      );
    });
    expect(pages()).toHaveLength(1);
  });

  it.each([
    { retreat: -12, momentum: true },
    { retreat: -90, momentum: false },
  ])(
    "clears long pull intent on $retreat pixels of reverse input before release",
    async ({ retreat, momentum }) => {
      act(() => API.setAppState({ inputDevice: "trackpad" }));
      act(() => {
        dispatchWheel(120);
        dispatchWheel(1000);
      });
      const canvas = GlobalTestState.interactiveCanvas;
      const hint = () =>
        canvas.ownerDocument.querySelector(".desktop-paper-pull-hint");
      expect(hint()).toHaveClass("is-ready");
      const stretched = api.getAppState().scrollY;
      const hardEnd = constrainScrollState(api.getAppState()).scrollY;
      act(() => dispatchWheel(retreat));
      expect(api.getAppState().scrollY).toBeCloseTo(stretched - retreat);
      expect(hint()).not.toHaveClass("is-ready");
      if (retreat === -90) {
        expect(api.getAppState().scrollY).toBeGreaterThan(hardEnd);
      }
      if (momentum) {
        act(() => dispatchWheel(1000, true));
      }
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 240));
      });
      expect(pages()).toHaveLength(1);
    },
  );

  it.each([1, 1.8])(
    "preserves the screen rubberband through focal ctrl-wheel zoom from %s without replacing the lock",
    (zoom) => {
      setCenteredZoom(zoom);
      const canvas = GlobalTestState.interactiveCanvas;
      const constraint = api.getAppState().scrollConstraints;
      const edge = constrainScrollState({
        ...api.getAppState(),
        scrollX: Infinity,
      });
      act(() =>
        API.setAppState({
          scrollX: edge.scrollX + 40 / zoom,
        }),
      );
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 380 });
      fireEvent.wheel(canvas, { deltaY: -10, ctrlKey: true });
      const state = api.getAppState();
      expect(state.zoom.value).toBeGreaterThan(zoom);
      expect(
        (state.scrollX - constrainScrollState(state).scrollX) *
          state.zoom.value,
      ).toBeCloseTo(40);
      expect(state.scrollConstraints).toBe(constraint);
    },
  );

  it.each(["jump", "fit"] as const)(
    "cancels a running snapback before %s and keeps constraint ownership through resize",
    async (action) => {
      act(() => {
        const next = appendPaperPage(api.getSceneElementsIncludingDeleted())!;
        api.updateScene({
          elements: next.elements,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      });
      const ownerDocument = GlobalTestState.interactiveCanvas.ownerDocument;
      const ownerWindow = ownerDocument.defaultView!;
      const app = ownerWindow.h.app;
      const constraint = api.getAppState().scrollConstraints;
      const resting = constrainScrollState(api.getAppState());
      act(() =>
        API.setAppState({
          scrollX: resting.scrollX + 40 / api.getAppState().zoom.value,
        }),
      );
      act(() => app.viewport.releaseOverscroll());
      expect(
        AnimationController.running(app.viewport.snapBackAnimationKey),
      ).toBe(true);
      if (action === "jump") {
        const input = ownerDocument.querySelector<HTMLInputElement>(
          ".desktop-paper-page-controls input",
        )!;
        fireEvent.change(input, { target: { value: "2" } });
        fireEvent.keyDown(input, { key: "Enter" });
      } else {
        fireEvent.click(
          Array.from(ownerDocument.querySelectorAll("button")).find(
            (button) => button.textContent === "适合页宽",
          )!,
        );
      }
      const destination = api.getAppState();
      expect(
        AnimationController.running(app.viewport.snapBackAnimationKey),
      ).toBe(false);
      expect(destination.scrollConstraints).toBe(constraint);
      expect(destination.scrollX).toBe(
        constrainScrollState(destination).scrollX,
      );
      await act(async () => {
        await new Promise((resolve) => ownerWindow.setTimeout(resolve, 60));
      });
      expect(api.getAppState().scrollX).toBe(destination.scrollX);
      act(() => API.setAppState({ width: 1000 }));
      expect(api.getAppState().scrollConstraints).not.toBe(constraint);
      expect(api.getAppState().scrollConstraints).toMatchObject({
        lockScroll: true,
        width: pages()[0].width,
      });
      expect(api.getAppState().scrollX).toBe(
        constrainScrollState(api.getAppState()).scrollX,
      );
    },
  );

  it("bounds both axes by paper frames and centers a short document at low zoom", async () => {
    const initial = api.getAppState();
    expect(initial.scrollConstraints).toMatchObject({
      lockScroll: true,
      lockZoom: false,
      width: pages()[0].width,
      height: pages()[0].height,
      overscroll: 80,
      offsets: {
        left: (api.getViewportOffsets().left ?? 0) + 48,
        right: (api.getViewportOffsets().right ?? 0) + 48,
      },
    });
    const wider = createPaperPage({
      x: -100,
      y: 2000,
      width: 1400,
      height: 900,
      name: "PDF",
    });
    wider[wider.length - 1] = {
      ...wider.at(-1)!,
      customData: { guziPaper: { version: 1, kind: "pdf" } },
    };
    const ink = API.createElement({
      type: "rectangle",
      x: -5000,
      y: -6000,
      width: 20,
      height: 20,
    });
    act(() =>
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...wider, ink],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() =>
      expect(api.getAppState().scrollConstraints?.width).toBe(1400),
    );
    expect(api.getAppState().scrollConstraints?.x).toBe(-100);
    expect(api.getAppState().scrollConstraints?.y).toBe(0);
    expect(api.getAppState().scrollConstraints?.height).toBe(2900);
    expect(api.getAppState().scrollY).toBe(
      constrainScrollState(api.getAppState()).scrollY,
    );
    act(() =>
      API.setAppState(
        getViewportForZoomWithScrollConstraints(
          {
            nextZoom: getNormalizedZoom(0.5),
            viewportX: 0,
            viewportY: 0,
          },
          api.getAppState(),
        ),
      ),
    );
    await waitFor(() => {
      const state = api.getAppState();
      const left = state.scrollConstraints!.offsets!.left!;
      const right = state.scrollConstraints!.offsets!.right!;
      expect((600 + state.scrollX) * state.zoom.value).toBeCloseTo(
        (left + state.width - right) / 2,
      );
    });
    expect(api.getAppState().scrollY).toBe(
      constrainScrollState(api.getAppState()).scrollY,
    );
    expect(
      GlobalTestState.interactiveCanvas.ownerDocument.querySelector(
        ".desktop-paper-pull-hint",
      ),
    ).toBeNull();
  });

  it("ends an off-page wheel stream and permits a new stream back at the page end", async () => {
    act(() => API.setAppState({ inputDevice: "trackpad", scrollY: -3000 }));
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 120 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 230));
    });
    expect(pages()).toHaveLength(1);
    act(() =>
      api.updateScene({
        appState: {
          scrollY:
            api.getAppState().height -
            (api.getViewportOffsets().bottom ?? 24) -
            pages()[0].height -
            30,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 120 });
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 64 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 230));
    });
    expect(pages()).toHaveLength(2);
  });

  it("clamps page jumps and fit width to the full mixed-width paper bounds immediately", async () => {
    const narrow = createPaperPage({
      x: 0,
      y: 2000,
      width: 400,
      height: 800,
      name: "Narrow PDF",
    });
    const wide = createPaperPage({
      x: 0,
      y: 3000,
      width: 1800,
      height: 1000,
      name: "Wide PDF",
    });
    for (const page of [narrow, wide]) {
      page[page.length - 1] = {
        ...page.at(-1)!,
        customData: { guziPaper: { version: 1, kind: "pdf" } },
      };
    }
    act(() =>
      api.updateScene({
        elements: [
          ...api.getSceneElementsIncludingDeleted(),
          ...narrow,
          ...wide,
        ],
        appState: { zoom: { value: getNormalizedZoom(0.5) } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    const ownerDocument = GlobalTestState.interactiveCanvas.ownerDocument;
    const input = ownerDocument.querySelector<HTMLInputElement>(
      ".desktop-paper-page-controls input",
    )!;
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("2");
    expect(api.getAppState().scrollX).toBe(
      constrainScrollState(api.getAppState()).scrollX,
    );
    fireEvent.click(
      Array.from(ownerDocument.querySelectorAll("button")).find(
        (button) => button.textContent === "适合页宽",
      )!,
    );
    expect(api.getAppState().scrollX).toBe(
      constrainScrollState(api.getAppState()).scrollX,
    );
  });

  it("does not replace constraints installed by another feature", async () => {
    const other = {
      ...api.getAppState().scrollConstraints!,
      lockScroll: true as const,
      width: 2000,
    };
    act(() =>
      api.updateScene({
        appState: { scrollConstraints: other },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    act(() => API.setAppState({ zoom: { value: getNormalizedZoom(0.75) } }));
    expect(api.getAppState().scrollConstraints).toBe(other);
    act(() =>
      api.updateScene({
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    await waitFor(() =>
      expect(api.getAppState().scrollConstraints).toBe(other),
    );
  });

  it("lets an animated external navigation replace the owned paper constraint", async () => {
    const paper = api.getAppState().scrollConstraints;
    act(() =>
      api.setViewport({
        target: { x: 10000, y: 10000, width: 2500, height: 2500 },
        fit: "none",
        lock: { scroll: true },
        animation: { duration: 100 },
      }),
    );
    expect(api.getAppState().scrollConstraints).toBe(paper);
    await waitFor(() =>
      expect(api.getAppState().scrollConstraints).toMatchObject({
        x: 10000,
        y: 10000,
        lockScroll: true,
      }),
    );
    expect(api.getAppState().scrollConstraints?.elasticPan).toBeUndefined();
  });

  it("clears its own constraint when switching to an infinite canvas", async () => {
    expect(api.getAppState().scrollConstraints?.lockScroll).toBe(true);
    act(() =>
      api.updateScene({
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    await waitFor(() => expect(api.getAppState().scrollConstraints).toBeNull());
  });

  it("keeps a long pull armed at the visual resistance limit", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(-650));
    fireEvent.pointerUp(window, { ...middle(-650), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
  });

  it("pulls from the centered stop of a short page and settles against the new bounds", async () => {
    setCenteredZoom(0.3);
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(220));
    fireEvent.pointerUp(window, { ...middle(220), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
    await waitFor(() =>
      expect(api.getAppState().scrollY).toBeCloseTo(
        constrainScrollState(api.getAppState()).scrollY,
      ),
    );
  });

  it("does not begin continuation from empty space after the old page bottom leaves the screen", () => {
    act(() => API.setAppState({ scrollY: -3000 }));
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    fireEvent.pointerUp(window, { ...middle(180), buttons: 0 });
    expect(pages()).toHaveLength(1);
  });

  it("offers click continuation while the last page bottom is visible at low zoom", async () => {
    setCenteredZoom(0.3);
    const button =
      GlobalTestState.interactiveCanvas.ownerDocument.querySelector(
        ".desktop-paper-add-page",
      );
    expect(button).not.toBeNull();
    const viewport = api.getAppState();
    fireEvent.click(button!);
    await waitFor(() => expect(pages()).toHaveLength(2));
    expect(api.getAppState()).toMatchObject({
      scrollX: viewport.scrollX,
      scrollY: constrainScrollState(api.getAppState()).scrollY,
      zoom: viewport.zoom,
    });
  });

  it("discards an armed drag on pointer cancellation", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(150));
    fireEvent.pointerCancel(window, middle(150));
    fireEvent.pointerUp(window, { ...middle(150), buttons: 0 });
    expect(pages()).toHaveLength(1);
  });

  it("discards an armed drag when another touch starts", () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(150));
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, {
      ...middle(150),
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerUp(window, { ...middle(150), buttons: 0 });
    fireEvent.pointerUp(window, {
      ...middle(150),
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      buttons: 0,
    });
    expect(pages()).toHaveLength(1);
  });

  it("fits width using the page rather than its full-height bounds", async () => {
    const state = api.getAppState();
    const expected =
      (state.width -
        (api.getViewportOffsets().left ?? 24) -
        (api.getViewportOffsets().right ?? 24) -
        96) /
      pages()[0].width;
    const button = Array.from(
      GlobalTestState.interactiveCanvas.ownerDocument.querySelectorAll(
        "button",
      ),
    ).find((node) => node.textContent === "适合页宽")!;
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.getAppState().zoom.value).toBeCloseTo(expected),
    );
    expect(pages()).toHaveLength(1);
  });

  it("jumps by page number and navigates to the adjacent pages", async () => {
    act(() => {
      const second = appendPaperPage(api.getSceneElementsIncludingDeleted())!;
      const third = appendPaperPage(second.elements)!;
      api.updateScene({
        elements: third.elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    const ownerDocument = GlobalTestState.interactiveCanvas.ownerDocument;
    const input = ownerDocument.querySelector<HTMLInputElement>(
      ".desktop-paper-page-controls input",
    )!;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("3"));
    fireEvent.click(
      ownerDocument.querySelector('button[aria-label="上一页"]')!,
    );
    await waitFor(() => expect(input.value).toBe("2"));
    fireEvent.click(
      ownerDocument.querySelector('button[aria-label="下一页"]')!,
    );
    await waitFor(() => expect(input.value).toBe("3"));
  });

  it.each(["escape", "zoom", "viewport", "fit"])(
    "cancels pending wheel continuation when interrupted by %s",
    async (interruption) => {
      act(() => API.setAppState({ inputDevice: "trackpad" }));
      fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 120 });
      fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 80 });
      expect(pages()).toHaveLength(1);
      if (interruption === "escape") {
        fireEvent.keyDown(window, { key: "Escape" });
      } else if (interruption === "zoom") {
        fireEvent.wheel(GlobalTestState.interactiveCanvas, {
          deltaY: 10,
          ctrlKey: true,
        });
      } else if (interruption === "viewport") {
        act(() =>
          api.updateScene({
            appState: { scrollY: api.getAppState().scrollY - 10 },
            captureUpdate: CaptureUpdateAction.NEVER,
          }),
        );
      } else {
        fireEvent.click(
          Array.from(
            GlobalTestState.interactiveCanvas.ownerDocument.querySelectorAll(
              "button",
            ),
          ).find((button) => button.textContent === "适合页宽")!,
        );
      }
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 230));
      });
      expect(pages()).toHaveLength(1);
    },
  );
});
