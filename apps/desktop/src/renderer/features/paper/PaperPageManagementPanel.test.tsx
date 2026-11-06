import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import { CaptureUpdateAction, newElement } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { UI } from "@excalidraw/excalidraw/tests/helpers/ui";
import { getNormalizedZoom } from "@excalidraw/excalidraw/scene";
import {
  act,
  fireEvent,
  GlobalTestState,
  render,
  screen,
  waitFor,
  within,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { FileId } from "@excalidraw/element/types";
import type {
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import {
  A4,
  createPaperPage,
  getPaperPages,
  paperScene,
  PAPER_GAP,
} from "./paper";
import { renderPaperPageThumbnail } from "./paperPageThumbnail";

import type { CanvasDocument } from "../workspace/workspace";

vi.mock("./paperPageThumbnail", () => ({
  renderPaperPageThumbnail: vi.fn(),
}));

describe("paper page management panel", () => {
  const intersections = new Map<Element, (isIntersecting: boolean) => void>();
  let api: ExcalidrawImperativeAPI;
  const pages = () => getPaperPages(api.getSceneElements());
  const toggle = () => screen.getByRole("button", { name: "页面管理" });
  const panel = () => within(screen.getByRole("region", { name: "页面管理" }));
  const button = (name: string) => panel().getByRole("button", { name });
  const rows = () => panel().getAllByRole("listitem");
  const preview = () =>
    document.querySelector<HTMLDivElement>(".desktop-paper-page-drag-preview");
  const pointer = (clientX: number, clientY: number, buttons = 1) => ({
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons,
    clientX,
    clientY,
  });
  const setListGeometry = (visibleHeight = 132) => {
    const list = panel().getByRole("list");
    let scroll = 0;
    const initialRows = rows();
    Object.defineProperty(list, "scrollTop", {
      get: () => scroll,
      set: (top: number) => {
        scroll = Math.max(
          0,
          Math.min(initialRows.length * 66 - visibleHeight, top),
        );
      },
    });
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(20, 10, 250, visibleHeight),
    );
    initialRows.forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(20, 10 + index * 66 - list.scrollTop, 250, 66),
      );
    });
    return list;
  };
  const blankPages = (count: number) =>
    paperScene(
      Array.from({ length: count }, (_, index) =>
        createPaperPage({
          ...A4,
          y: index * (A4.height + PAPER_GAP),
          name: String(index + 1),
        }),
      ).flat(),
    );
  const start = async (initialData: ExcalidrawInitialDataState) => {
    await render(
      <SubcanvasEditor
        document={{ title: "Paper" } as CanvasDocument}
        initialData={initialData}
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
        height: 700,
        zoom: { value: getNormalizedZoom(1) },
      }),
    );
  };

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        private targets = new Set<Element>();
        observe(target: Element) {
          this.targets.add(target);
          intersections.set(target, (isIntersecting) =>
            this.callback(
              [{ target, isIntersecting } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
          );
        }
        disconnect() {
          this.targets.forEach((target) => intersections.delete(target));
        }
      },
    );
  });

  afterEach(() => {
    intersections.clear();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("edits actual unframed ink with its page, cancels a drag, and records one undo per operation", async () => {
    const offPage = newElement({
      type: "ellipse",
      x: -140,
      y: 90,
      width: 40,
      height: 40,
    });
    await start(
      paperScene([...createPaperPage({ ...A4, name: "A4" }), offPage]),
    );
    const [first] = pages();
    const point = sceneCoordsToViewportCoords(
      { sceneX: first.x + 170, sceneY: first.y + 180 },
      api.getAppState(),
    );
    const ink = UI.createElement("rectangle", { ...point, size: 75 }).get();
    expect(ink.frameId).toBeNull();
    expect(ink.y).toBeCloseTo(first.y + 180);

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(button("删除第 1 页")).toBeDisabled();
    fireEvent.click(button("在当前页后插入空白页"));
    await waitFor(() => expect(pages()).toHaveLength(2));
    const [, blank] = pages();
    expect(button("第 2 页")).toHaveAttribute("aria-current", "page");
    expect(api.getAppState().toast?.message).toContain("跨页或页外元素");

    setListGeometry();
    const [source, target] = rows();
    const thumbnail = source.querySelector(".desktop-paper-page-preview")!;
    fireEvent.pointerDown(thumbnail, pointer(50, 40));
    fireEvent.pointerMove(window, pointer(52, 42));
    expect(preview()).toBeNull();
    fireEvent.pointerUp(window, pointer(52, 42, 0));
    fireEvent.click(button("第 1 页"), { detail: 1 });
    expect(button("第 1 页")).toHaveAttribute("aria-current", "page");

    fireEvent.pointerDown(thumbnail, pointer(50, 40));
    fireEvent.pointerMove(window, pointer(55, 55));
    expect(preview()?.style.transform).toBe("translate3d(25px, 25px, 0)");
    expect(preview()).toHaveTextContent("第 1 页");
    expect(source).toHaveAttribute("data-drag-source", "true");
    fireEvent.pointerMove(window, pointer(64, 112));
    expect(preview()?.style.transform).toBe("translate3d(34px, 82px, 0)");
    expect(target).toHaveAttribute("data-drop-target", "after");
    fireEvent.keyDown(button("第 1 页"), { key: "Escape" });
    fireEvent.pointerUp(window, pointer(64, 112, 0));
    expect(pages().map(({ id }) => id)).toEqual([first.id, blank.id]);
    expect(preview()).toBeNull();
    expect(source).not.toHaveAttribute("data-drag-source");
    expect(target).not.toHaveAttribute("data-drop-target");
    fireEvent.click(button("第 2 页"), { detail: 0 });
    expect(button("第 2 页")).toHaveAttribute("aria-current", "page");

    fireEvent.pointerDown(button("第 1 页"), pointer(50, 40));
    fireEvent.pointerMove(window, pointer(64, 112));
    fireEvent.pointerUp(window, pointer(64, 112, 0));
    expect(pages().map(({ id }) => id)).toEqual([blank.id, first.id]);
    const findInk = () =>
      api.getSceneElements().find(({ id }) => id === ink.id);
    expect(findInk()?.y).toBeCloseTo(ink.y + A4.height + PAPER_GAP);
    expect(api.getSceneElements().find(({ id }) => id === offPage.id)?.y).toBe(
      offPage.y,
    );

    act(() => api.history.undo!());
    expect(pages().map(({ id }) => id)).toEqual([first.id, blank.id]);
    expect(findInk()?.y).toBeCloseTo(ink.y);
    act(() => api.history.redo!());
    expect(pages().map(({ id }) => id)).toEqual([blank.id, first.id]);

    const moveUp = button("上移第 2 页");
    fireEvent.pointerDown(moveUp, pointer(220, 112));
    fireEvent.pointerMove(window, pointer(64, 40));
    fireEvent.pointerUp(window, pointer(64, 40, 0));
    expect(preview()).toBeNull();
    expect(pages().map(({ id }) => id)).toEqual([blank.id, first.id]);
    fireEvent.click(moveUp);
    expect(pages().map(({ id }) => id)).toEqual([first.id, blank.id]);
    act(() => api.history.undo!());
    expect(pages().map(({ id }) => id)).toEqual([blank.id, first.id]);

    fireEvent.click(button("第 2 页"));
    fireEvent.click(button("删除第 2 页"));
    expect(panel().getByRole("alert")).toHaveTextContent("可撤销此操作");
    fireEvent.click(button("取消"));
    expect(findInk()).toBeDefined();
    fireEvent.click(button("删除第 2 页"));
    fireEvent.click(button("确认删除"));
    expect(pages().map(({ id }) => id)).toEqual([blank.id]);
    expect(button("第 1 页")).toHaveAttribute("aria-current", "page");
    expect(findInk()).toBeUndefined();
    expect(button("删除第 1 页")).toBeDisabled();

    act(() => api.history.undo!());
    expect(pages().map(({ id }) => id)).toEqual([blank.id, first.id]);
    expect(findInk()?.y).toBeCloseTo(ink.y + A4.height + PAPER_GAP);
    act(() => api.history.redo!());
    expect(pages()).toHaveLength(1);
    expect(findInk()).toBeUndefined();

    fireEvent.click(button("收起页面面板"));
    expect(screen.queryByRole("region", { name: "页面管理" })).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("cancels a drop outside the list and closes on outside pointerdown without swallowing the click", async () => {
    const ink = newElement({
      type: "ellipse",
      x: 80,
      y: 90,
      width: 40,
      height: 40,
    });
    await start(paperScene([...blankPages(2).elements!, ink]));
    const [first, second] = pages();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    fireEvent.pointerDown(toggle(), pointer(300, 200));
    fireEvent.click(toggle());
    setListGeometry();
    fireEvent.pointerDown(button("第 1 页"), pointer(50, 40));
    fireEvent.pointerMove(window, pointer(65, 112));
    expect(preview()).not.toBeNull();
    fireEvent.pointerDown(document.body, {
      ...pointer(500, 112),
      pointerId: 2,
    });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerMove(window, pointer(500, 112));
    expect(rows()[1]).not.toHaveAttribute("data-drop-target");
    fireEvent.pointerUp(window, pointer(500, 112, 0));
    expect(preview()).toBeNull();
    expect(pages().map(({ id }) => id)).toEqual([first.id, second.id]);

    fireEvent.pointerDown(button("删除第 1 页"), pointer(245, 45));
    fireEvent.click(button("删除第 1 页"));
    expect(panel().getByRole("alert")).toBeVisible();
    const canvas = GlobalTestState.interactiveCanvas;
    const canvasDown = vi.fn((event: Event) =>
      expect(event.defaultPrevented).toBe(false),
    );
    canvas.addEventListener("pointerdown", canvasDown);
    fireEvent.pointerDown(canvas, pointer(500, 320));
    fireEvent.pointerUp(canvas, pointer(500, 320, 0));
    expect(canvasDown).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).not.toHaveFocus();
    expect(api.getSceneElements().some(({ id }) => id === ink.id)).toBe(true);

    const handlers = add.mock.calls.filter(
      ([name, listener, capture]) =>
        name === "pointerdown" &&
        typeof listener === "function" &&
        listener.name === "dismiss" &&
        capture === true,
    );
    expect(handlers.length).toBeGreaterThan(0);
    for (const args of handlers) {
      expect(remove).toHaveBeenCalledWith(...args);
    }

    fireEvent.pointerDown(toggle(), pointer(300, 200));
    fireEvent.click(toggle());
    expect(panel().queryByRole("alert")).toBeNull();
    fireEvent.pointerDown(toggle(), pointer(300, 200));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("scrolls at the list edge and stops dragging when the panel closes", async () => {
    await start(blankPages(8));
    fireEvent.click(toggle());
    const list = setListGeometry();
    const order = pages().map(({ id }) => id);
    fireEvent.pointerDown(button("第 1 页"), pointer(50, 40));
    fireEvent.pointerMove(window, pointer(64, 140));
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(66));
    expect(
      rows().findIndex((row) => row.hasAttribute("data-drop-target")),
    ).toBeGreaterThan(1);
    expect(preview()).not.toBeNull();

    fireEvent.click(button("收起页面面板"));
    expect(preview()).toBeNull();
    const scroll = list.scrollTop;
    fireEvent.pointerMove(window, pointer(64, 140));
    fireEvent.pointerUp(window, pointer(64, 140, 0));
    expect(list.scrollTop).toBe(scroll);
    expect(pages().map(({ id }) => id)).toEqual(order);
    expect(toggle()).toHaveFocus();
  });

  it("keeps page links usable in view mode with reordering and edit buttons disabled", async () => {
    await start(blankPages(2));
    act(() => API.setAppState({ viewModeEnabled: true }));
    fireEvent.click(toggle());
    expect(panel().queryByRole("button", { name: "上移第 2 页" })).toBeNull();
    expect(rows()[0]).not.toHaveAttribute("data-reorderable");
    setListGeometry();
    fireEvent.pointerDown(button("第 2 页"), pointer(50, 112));
    fireEvent.pointerMove(window, pointer(54, 40));
    fireEvent.pointerUp(window, pointer(54, 40, 0));
    expect(preview()).toBeNull();
    fireEvent.click(button("第 2 页"), { detail: 0 });
    expect(button("第 2 页")).toHaveAttribute("aria-current", "page");
    fireEvent.keyDown(button("第 2 页"), { key: "Escape" });
    expect(toggle()).toHaveFocus();
  });

  it("does not enable automatic continuation after a blank sheet is added to PDF paper", async () => {
    const image = {
      id: "source" as FileId,
      dataURL: "data:image/png;base64,AAAA" as DataURL,
      mimeType: "image/png" as const,
      created: 1,
    };
    await start(
      paperScene(
        createPaperPage({ width: 600, height: 680, name: "1", image }),
        { [image.id]: image },
      ),
    );
    fireEvent.click(toggle());
    fireEvent.click(button("在当前页后插入空白页"));
    const [, blank] = pages();
    fireEvent.click(button("收起页面面板"));
    const state = api.getAppState();
    act(() =>
      api.updateScene({
        appState: {
          scrollY:
            state.height / state.zoom.value - blank.y - blank.height - 24,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    expect(screen.queryByRole("button", { name: "+ 新建一页" })).toBeNull();
    fireEvent.wheel(GlobalTestState.interactiveCanvas, { deltaY: 400 });
    expect(pages()).toHaveLength(2);
  });

  it("honors explicit navigation when multiple small pages are visible", async () => {
    const height = 130;
    await start(
      paperScene([
        ...createPaperPage({ width: 90, height, name: "1" }),
        ...createPaperPage({
          width: 90,
          height,
          y: height + PAPER_GAP,
          name: "2",
        }),
      ]),
    );
    const [first, second] = pages();
    fireEvent.click(toggle());
    fireEvent.click(button("第 1 页"));
    expect(button("第 1 页")).toHaveAttribute("aria-current", "page");
    fireEvent.click(button("在当前页后插入空白页"));
    expect(pages()).toHaveLength(3);
    expect(pages()[0].id).toBe(first.id);
    expect(pages()[2].id).toBe(second.id);
  });

  it("only starts visible previews and releases outstanding work on close", async () => {
    vi.mocked(renderPaperPageThumbnail).mockImplementation(
      () => new Promise(() => {}),
    );
    await start(
      paperScene([
        ...createPaperPage({ ...A4, name: "1" }),
        ...createPaperPage({ ...A4, y: A4.height + PAPER_GAP, name: "2" }),
      ]),
    );
    fireEvent.click(toggle());
    expect(renderPaperPageThumbnail).not.toHaveBeenCalled();
    const [first, second] = [...intersections.values()];
    act(() => first(true));
    await waitFor(() =>
      expect(renderPaperPageThumbnail).toHaveBeenCalledTimes(1),
    );
    const [actualApi, id, doc, theme, cancelled] = vi.mocked(
      renderPaperPageThumbnail,
    ).mock.calls[0];
    expect(actualApi).toBe(api);
    expect(id).toBe(pages()[0].id);
    expect(doc).toBe(GlobalTestState.interactiveCanvas.ownerDocument);
    expect(theme).toBe(api.getAppState().theme);
    expect(cancelled()).toBe(false);
    act(() => first(false));
    expect(cancelled()).toBe(true);
    act(() => second(true));
    fireEvent.click(button("收起页面面板"));
    expect(intersections.size).toBe(0);
    expect(renderPaperPageThumbnail).toHaveBeenCalledTimes(1);
  });
});
