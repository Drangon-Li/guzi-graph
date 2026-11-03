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

describe("paper page controls in the root editor", () => {
  let api: ExcalidrawImperativeAPI;
  const pages = () => getPaperPages(api.getSceneElements());
  const middle = (clientY: number) => ({
    pointerId: 1,
    pointerType: "mouse",
    button: 1,
    buttons: 4,
    clientX: 400,
    clientY,
  });
  beforeEach(async () => {
    await render(
      <SubcanvasEditor
        document={{ title: "Paper" } as CanvasDocument}
        initialData={createPaperTemplate("ruled", "portrait")}
        onExcalidrawAPI={(value) => {
          if (value) {
            api = value;
          }
        }}
      />,
    );
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
            pages()[0].height -
            30,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  });

  it("waits for a real release, adds one ruled sheet, then undoes and redoes it atomically", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    expect(pages()).toHaveLength(1);
    const viewport = api.getAppState();
    fireEvent.pointerUp(window, { ...middle(180), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
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

  it("continues after one uninterrupted wheel stream and ignores horizontal snapback", async () => {
    act(() => API.setAppState({ inputDevice: "trackpad" }));
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 120 });
    expect(pages()).toHaveLength(1);
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 64 });
    const viewport = api.getAppState();
    // The elastic x boundary can settle while the same wheel stream idles.
    act(() =>
      api.updateScene({
        appState: { scrollX: viewport.scrollX + 1 },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 230));
    });
    expect(pages()).toHaveLength(2);
    expect(api.getAppState().scrollY).toBe(viewport.scrollY);
    expect(api.getAppState().zoom).toEqual(viewport.zoom);
  });

  it("preserves screen rubberband distance through ctrl-wheel zoom without reinstalling paper constraints", () => {
    const constraint = api.getAppState().scrollConstraints;
    const resting = constrainScrollState(api.getAppState());
    act(() =>
      API.setAppState({
        scrollX: resting.scrollX + 40 / api.getAppState().zoom.value,
      }),
    );
    fireEvent.wheel(GlobalTestState.interactiveCanvas, {
      deltaY: -10,
      ctrlKey: true,
    });
    const state = api.getAppState();
    expect(state.zoom.value).toBeGreaterThan(1);
    expect(
      (state.scrollX - constrainScrollState(state).scrollX) * state.zoom.value,
    ).toBeCloseTo(40);
    expect(state.scrollConstraints).toBe(constraint);
  });

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
        lockScroll: "x",
        width: pages()[0].width,
      });
      expect(api.getAppState().scrollX).toBe(
        constrainScrollState(api.getAppState()).scrollX,
      );
    },
  );

  it("uses paper frames for x boundaries, preserves vertical position and centers at low zoom", async () => {
    const initial = api.getAppState();
    expect(initial.scrollConstraints).toMatchObject({
      lockScroll: "x",
      lockZoom: false,
      width: pages()[0].width,
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
      y: 0,
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
    expect(api.getAppState().scrollY).toBe(initial.scrollY);
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
    expect(api.getAppState().scrollY).toBe(initial.scrollY);
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

  it("clears its own x constraint when switching to an infinite canvas", async () => {
    expect(api.getAppState().scrollConstraints?.lockScroll).toBe("x");
    act(() =>
      api.updateScene({
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    await waitFor(() => expect(api.getAppState().scrollConstraints).toBeNull());
  });

  it("keeps an armed long pull when the previous page bottom leaves the screen", async () => {
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(-650));
    fireEvent.pointerUp(window, { ...middle(-650), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
  });

  it("pulls from a visible page end at low zoom without a hidden distance limit", async () => {
    act(() =>
      API.setAppState({ zoom: { value: getNormalizedZoom(0.3) }, scrollY: 0 }),
    );
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(220));
    fireEvent.pointerUp(window, { ...middle(220), buttons: 0 });
    await waitFor(() => expect(pages()).toHaveLength(2));
  });

  it("does not begin continuation from empty space after the old page bottom leaves the screen", () => {
    act(() => API.setAppState({ scrollY: -3000 }));
    fireEvent.pointerDown(GlobalTestState.interactiveCanvas, middle(300));
    fireEvent.pointerMove(GlobalTestState.interactiveCanvas, middle(180));
    fireEvent.pointerUp(window, { ...middle(180), buttons: 0 });
    expect(pages()).toHaveLength(1);
  });

  it("offers click continuation while the last page bottom is visible at low zoom", async () => {
    act(() =>
      API.setAppState({ zoom: { value: getNormalizedZoom(0.3) }, scrollY: 0 }),
    );
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
      scrollY: viewport.scrollY,
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
