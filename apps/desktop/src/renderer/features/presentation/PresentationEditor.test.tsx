import { useEffect } from "react";

import { KEYS, FONT_FAMILY } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  newElementWith,
  isTextElement,
} from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { getNormalizedZoom } from "@excalidraw/excalidraw/scene/normalize";
import { convertStickyNoteToSubcanvas } from "@excalidraw/excalidraw/subcanvasActions";

import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { useWorkspace } from "../workspace/workspace";

import { createPresentation } from "./model";
import { PresentationEditor } from "./PresentationEditor";

import type { DesktopAPI } from "../../../shared/desktop-api";
import type { CanvasDocument, Workspace } from "../workspace/workspace";
import type { Presentation } from "./model";

vi.mock("./PresentationLayout", () => ({
  PresentationLayout: ({
    presentation,
    onSelect,
    onAdd,
    beforePresent,
    onPresent,
    children,
  }: Parameters<
    typeof import("./PresentationLayout").PresentationLayout
  >[0]) => (
    <div>
      {presentation.slides.map((slide) => (
        <button key={slide.id} onClick={() => onSelect(slide.id)}>
          Select {slide.title}
        </button>
      ))}
      <button onClick={onAdd}>Add slide</button>
      <button
        onClick={() => {
          beforePresent();
          onPresent?.(true);
        }}
      >
        Present
      </button>
      <button onClick={() => onPresent?.(false)}>Stop presenting</button>
      {children}
    </div>
  ),
}));

describe("presentation editor lifecycle", () => {
  let root: HTMLDivElement;
  let workspace: Workspace;
  let canvasDocument: CanvasDocument;
  let resizeTransition: () => void;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(node: Element) {
          if (node.classList.contains("desktop-presentation-canvas")) {
            resizeTransition = () =>
              this.callback([], this as unknown as ResizeObserver);
          }
        }
        unobserve() {}
        disconnect() {}
      },
    );
    root.ownerDocument.defaultView!.desktop = {
      getSettings: vi.fn().mockResolvedValue({
        rootDirectory: "/drawings",
        language: "en",
        theme: "light",
      }),
      listProjects: vi.fn().mockResolvedValue({
        rootDirectory: "/drawings",
        files: [],
        folders: [],
        history: [],
      }),
      getSession: vi.fn().mockResolvedValue({ paths: [], activePath: null }),
      setSession: vi.fn().mockResolvedValue(undefined),
      listDrafts: vi.fn().mockResolvedValue([]),
      takePendingFiles: vi.fn().mockResolvedValue([]),
      onCommand: vi.fn(() => () => {}),
      onFilesOpened: vi.fn(() => () => {}),
      writeDraft: vi.fn().mockResolvedValue(undefined),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
      editText: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopAPI;
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const mount = async (
    deck = createPresentation("first", "First"),
    onInitialize?: (api: ExcalidrawImperativeAPI) => void,
  ) => {
    const Harness = () => {
      workspace = useWorkspace(root);
      useEffect(() => {
        if (!workspace.loading && !workspace.documents.length) {
          const created = workspace.newPresentation()!;
          created.presentation = deck;
          created.activeSlideId = deck.slides[0].id;
          created.initialData = deck.slides[0].scene;
        }
      });
      const current = workspace.documents[0];
      if (!current) {
        return null;
      }
      canvasDocument = current;
      return (
        <PresentationEditor
          document={current}
          workspace={workspace}
          ownerDocument={root.ownerDocument}
          initialData={current.initialData}
          onExcalidrawAPI={(api) => {
            current.api = api;
          }}
          onInitialize={(api) => {
            workspace.initialize(current, api);
            onInitialize?.(api);
          }}
          onChange={(elements, appState, files) =>
            workspace.capture(current, { elements, appState, files })
          }
          desktopIntegration={{
            localOnly: true,
            open: async () => {},
            save: (snapshot, saveAs) =>
              workspace.editorSave(current, snapshot, saveAs),
          }}
          interaction
          handleKeyboardGlobally
          langCode="en"
        />
      );
    };
    const view = await render(<Harness />);
    await waitFor(() => expect(canvasDocument.initialized).toBe(true));
    return view;
  };

  const readyApi = async (previous?: ExcalidrawImperativeAPI) => {
    await waitFor(() => {
      expect(canvasDocument.api).toBeTruthy();
      expect(canvasDocument.api).not.toBe(previous);
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false);
    });
    return canvasDocument.api!;
  };

  const undo = (editor: Element, redo = false) =>
    fireEvent.keyDown(editor, {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
      shiftKey: redo,
    });

  const ids = (api: ExcalidrawImperativeAPI) =>
    api.getSceneElements().map((element) => element.id);

  it("fits new pages before initialization and restores the saved camera on return", async () => {
    const deck = createPresentation("first", "First");
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const initializedCameras: unknown[] = [];
    const camera = (api: ExcalidrawImperativeAPI) => {
      const { scrollX, scrollY, zoom } = api.getAppState();
      return { scrollX, scrollY, zoom };
    };
    const view = await mount(deck, (api) =>
      initializedCameras.push(camera(api)),
    );
    const first = await readyApi();
    expect(initializedCameras[0]).toEqual(camera(first));
    act(() =>
      first.updateScene({
        appState: {
          scrollX: 123,
          scrollY: 456,
          zoom: { value: getNormalizedZoom(0.75) },
        },
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Select Second" }));
    const second = await readyApi(first);
    expect(initializedCameras[1]).toEqual(camera(second));
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    const returned = await readyApi(second);
    expect(camera(returned)).toEqual({
      scrollX: 123,
      scrollY: 456,
      zoom: { value: 0.75 },
    });
  });

  it("retains the old canvas through rapid switches and resize until the target frame is ready", async () => {
    const deck = createPresentation("first", "First");
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    deck.slides.push({ id: "third", title: "Third", scene: {} });
    const view = await mount(deck);
    const first = await readyApi();
    const overlay = view.container.querySelector<HTMLDivElement>(
      ".desktop-presentation-slide-transition",
    )!;
    const original = view.container.querySelector<HTMLCanvasElement>(
      ".desktop-root-canvas canvas.static",
    )!;
    original.width = 1000;
    original.height = 700;
    await waitFor(() => expect(overlay.hidden).toBe(true));
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const ownerWindow = root.ownerDocument.defaultView!;
    vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation(
      (callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
    );
    vi.spyOn(ownerWindow, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const drawFrame = () => {
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach((callback) => callback(0)));
    };
    fireEvent.click(view.getByRole("button", { name: "Select Second" }));
    const second = await readyApi(first);
    expect(overlay.hidden).toBe(false);
    const copy = overlay.querySelector("canvas")!;
    expect(copy).not.toBe(original);
    expect(copy.width).toBe(original.width);
    expect(copy.height).toBe(original.height);
    drawFrame();
    expect(overlay.hidden).toBe(false);
    const staleFrames = [...frames.values()];
    fireEvent.click(view.getByRole("button", { name: "Select Third" }));
    await readyApi(second);
    act(() => staleFrames.forEach((callback) => callback(0)));
    expect(overlay.querySelector("canvas")).toBe(copy);
    expect(overlay.hidden).toBe(false);
    drawFrame();
    act(() => resizeTransition());
    drawFrame();
    expect(overlay.hidden).toBe(false);
    drawFrame();
    expect(overlay.hidden).toBe(true);
    expect(overlay.childElementCount).toBe(0);

    const currentCanvas = view.container.querySelector<HTMLCanvasElement>(
      ".desktop-root-canvas canvas.static",
    )!;
    currentCanvas.width = 1000;
    currentCanvas.height = 700;
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    await readyApi();
    expect(overlay.hidden).toBe(false);
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it("undoes page edits and slide creation in document order across page switches", async () => {
    const view = await mount();
    const first = await readyApi();
    act(() =>
      first.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "first-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Add slide" }));
    const secondId = canvasDocument.activeSlideId!;
    const second = await readyApi(first);
    act(() =>
      second.updateScene({
        elements: [API.createElement({ type: "ellipse", id: "second-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(3);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(second)).toEqual([]));
    expect(second.getSceneElementsIncludingDeleted()).toMatchObject([
      { id: "second-shape", isDeleted: true },
    ]);
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    let current = await readyApi(second);
    expect(ids(current)).toEqual(["first-shape"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() =>
      expect(canvasDocument.presentation!.slides).toHaveLength(1),
    );
    expect(ids(current)).toEqual(["first-shape"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(current)).toEqual([]));
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() => expect(ids(current)).toEqual(["first-shape"]));
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    current = await readyApi(current);
    expect(canvasDocument.activeSlideId).toBe(secondId);
    expect(ids(current)).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    current = await readyApi(current);
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    current = await readyApi(current);
    await waitFor(() => expect(ids(current)).toEqual(["second-shape"]));
    expect(canvasDocument.activeSlideId).toBe(secondId);
    expect(canvasDocument.presentationHistory!.redo).toHaveLength(0);
  });

  it("switches to the edited page and excludes selection and viewport history", async () => {
    const deck = createPresentation("first", "First");
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const view = await mount(deck);
    const first = await readyApi();
    act(() =>
      first.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    act(() =>
      first.updateScene({
        appState: { selectedElementIds: { shape: true }, scrollX: 100 },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(1);
    act(() => workspace.selectSlide(canvasDocument, "second"));
    const second = await readyApi(first);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    const reopened = await readyApi(second);
    await waitFor(() => expect(ids(reopened)).toEqual([]));
    expect(canvasDocument.activeSlideId).toBe("first");
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() => expect(ids(reopened)).toEqual(["shape"]));
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    act(() =>
      reopened.updateScene({
        appState: { viewBackgroundColor: "#ff0000" },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    expect(canvasDocument.presentationHistory!.redo).toHaveLength(0);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() =>
      expect(reopened.getAppState().viewBackgroundColor).toBe("#ffffff"),
    );
    expect(ids(reopened)).toEqual([]);
  });

  it("restores a deleted current slide with image files and child scenes", async () => {
    const note = API.createElement({ type: "stickynote", id: "pin" });
    const converted = convertStickyNoteToSubcanvas([note], note.id, {})!;
    const file: BinaryFiles[string] = {
      id: "image-file" as BinaryFiles[string]["id"],
      dataURL:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" as BinaryFiles[string]["dataURL"],
      mimeType: "image/png",
      created: 1,
    };
    const image = API.createElement({
      type: "image",
      id: "image",
      fileId: file.id,
    });
    const deck = createPresentation("first", "First", {
      elements: [...converted.elements, image],
      appState: { subscenes: converted.scenes },
      files: { [file.id]: file },
    });
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const view = await mount(deck);
    const first = await readyApi();
    const children = first.getAppState().subscenes;
    act(() => workspace.deleteSlide(canvasDocument, "first"));
    const second = await readyApi(first);
    expect(
      canvasDocument.presentation!.slides.map((slide) => slide.id),
    ).toEqual(["second"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    const restored = await readyApi(second);
    expect(canvasDocument.activeSlideId).toBe("first");
    expect(ids(restored)).toEqual(["pin", "image"]);
    expect(restored.getFiles()[file.id]).toEqual(file);
    expect(restored.getAppState().subscenes).toEqual(children);
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await readyApi(restored);
    expect(
      canvasDocument.presentation!.slides.map((slide) => slide.id),
    ).toEqual(["second"]);
  });

  it("keeps child scene contents and child undo/redo history across page switches", async () => {
    const note = API.createElement({ type: "stickynote", id: "pin" });
    const converted = convertStickyNoteToSubcanvas([note], note.id, {})!;
    const deck: Presentation = createPresentation("first", "First", {
      elements: converted.elements,
      appState: { subscenes: converted.scenes },
    });
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const view = await mount(deck);
    const openChild = async () => {
      act(() =>
        canvasDocument.api!.updateScene({
          appState: { selectedElementIds: { pin: true } },
        }),
      );
      fireEvent.click(
        await view.findByRole("button", { name: "Open subcanvas" }),
      );
      await waitFor(() => {
        expect(canvasDocument.activeEditor?.()).not.toBe(canvasDocument.api);
        expect(canvasDocument.activeEditor?.()?.getAppState().isLoading).toBe(
          false,
        );
      });
      return canvasDocument.activeEditor!()!;
    };
    const firstRoot = await readyApi();
    const child = await openChild();
    act(() =>
      child.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "child-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() =>
      expect(
        canvasDocument.getSnapshot!().appState.subscenes[converted.sceneId]
          .elements[0]?.id,
      ).toBe("child-shape"),
    );
    fireEvent.click(view.getByRole("button", { name: "Select Second" }));
    const second = await readyApi(firstRoot);
    expect(child.isDestroyed).toBe(true);
    act(() =>
      second.updateScene({
        elements: [API.createElement({ type: "ellipse", id: "second-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    const reopenedRoot = await readyApi(second);
    expect(reopenedRoot.getAppState().viewModeEnabled).toBe(false);
    expect(ids(reopenedRoot)).toEqual(["pin"]);
    expect(reopenedRoot.getSceneElements()[0].customData).toMatchObject({
      subcanvas: { sceneId: converted.sceneId },
    });
    expect(
      reopenedRoot.getAppState().subscenes[converted.sceneId],
    ).toBeDefined();
    const reopenedChild = await openChild();
    expect(ids(reopenedChild)).toEqual(["child-shape"]);
    undo(view.container.querySelector(".desktop-subcanvas .excalidraw")!);
    await waitFor(() => expect(ids(reopenedChild)).toEqual([]));
    expect(ids(reopenedRoot)).toEqual(["pin"]);

    fireEvent.click(view.getByRole("button", { name: "Select Second" }));
    const returnedSecond = await readyApi(reopenedRoot);
    expect(ids(returnedSecond)).toEqual(["second-shape"]);
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    await readyApi(returnedSecond);
    const redoChild = await openChild();
    expect(ids(redoChild)).toEqual([]);
    expect(redoChild.getSceneElementsIncludingDeleted()).toMatchObject([
      { id: "child-shape", isDeleted: true },
    ]);
    undo(view.container.querySelector(".desktop-subcanvas .excalidraw")!, true);
    await waitFor(() => expect(ids(redoChild)).toEqual(["child-shape"]));
  });

  it("undoes duplicate, reorder and rename in sequence and returns to the saved state", async () => {
    const deck = createPresentation("first", "First");
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const view = await mount(deck);
    const first = await readyApi();
    root.ownerDocument.defaultView!.desktop.saveFile = vi.fn(
      async (request) => ({
        path: "/drawings/presentation.guzi-presentation",
        content: request.content,
        modifiedAt: 123,
        size: request.content.length,
      }),
    );
    await act(async () => {
      expect(await workspace.requestSave(canvasDocument)).toBe(true);
    });
    expect(canvasDocument.dirty).toBe(false);
    act(() => workspace.renameSlide(canvasDocument, "first", "Renamed"));
    act(() => workspace.moveSlide(canvasDocument, "first", 1));
    act(() => workspace.addSlide(canvasDocument, "first"));
    const duplicate = await readyApi(first);
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(3);
    expect(canvasDocument.dirty).toBe(true);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    const reopened = await readyApi(duplicate);
    expect(
      canvasDocument.presentation!.slides.map((slide) => slide.title),
    ).toEqual(["Second", "Renamed"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    expect(
      canvasDocument.presentation!.slides.map((slide) => slide.title),
    ).toEqual(["Renamed", "Second"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    expect(
      canvasDocument.presentation!.slides.map((slide) => slide.title),
    ).toEqual(["First", "Second"]);
    expect(canvasDocument.dirty).toBe(false);
    expect(reopened.isDestroyed).toBe(false);
    expect(canvasDocument.presentationHistory!.redo).toHaveLength(3);
  });

  it("retains child contents and local history through undo and redo of an inserted slide", async () => {
    const view = await mount();
    const first = await readyApi();
    fireEvent.click(view.getByRole("button", { name: "Add slide" }));
    const second = await readyApi(first);
    const secondId = canvasDocument.activeSlideId;
    const note = API.createElement({ type: "stickynote", id: "new-pin" });
    const converted = convertStickyNoteToSubcanvas([note], note.id, {})!;
    act(() =>
      second.updateScene({
        elements: converted.elements,
        appState: {
          subscenes: converted.scenes,
          selectedElementIds: { "new-pin": true },
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Open subcanvas" }),
    );
    await waitFor(() =>
      expect(canvasDocument.activeEditor?.()?.getAppState().isLoading).toBe(
        false,
      ),
    );
    const child = canvasDocument.activeEditor!()!;
    act(() =>
      child.updateScene({
        elements: [
          API.createElement({ type: "rectangle", id: "retained-child" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Collapse subcanvas" }));
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(second)).toEqual([]));
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    const returnedFirst = await readyApi(second);
    expect(canvasDocument.presentation!.slides).toHaveLength(1);
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    const returnedSecond = await readyApi(returnedFirst);
    expect(canvasDocument.activeSlideId).toBe(secondId);
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() => expect(ids(returnedSecond)).toEqual(["new-pin"]));
    expect(
      returnedSecond.getAppState().subscenes[converted.sceneId].elements[0].id,
    ).toBe("retained-child");
    act(() =>
      returnedSecond.updateScene({
        appState: { selectedElementIds: { "new-pin": true } },
      }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Open subcanvas" }),
    );
    await waitFor(() =>
      expect(canvasDocument.activeEditor?.()?.getAppState().isLoading).toBe(
        false,
      ),
    );
    const reopenedChild = canvasDocument.activeEditor!()!;
    expect(ids(reopenedChild)).toEqual(["retained-child"]);
    undo(view.container.querySelector(".desktop-subcanvas .excalidraw")!);
    await waitFor(() => expect(ids(reopenedChild)).toEqual([]));
  });

  it("undoes a deck font replacement as one action and preserves later child content and viewport", async () => {
    const note = API.createElement({ type: "stickynote", id: "pin" });
    const converted = convertStickyNoteToSubcanvas([note], note.id, {})!;
    const text = (id: string) =>
      API.createElement({
        type: "text",
        id,
        text: "original",
        fontFamily: FONT_FAMILY.Excalifont,
      });
    converted.scenes[converted.sceneId] = {
      ...converted.scenes[converted.sceneId],
      elements: [text("child-text")],
    };
    const deck = createPresentation("first", "First", {
      elements: [...converted.elements, text("root-text")],
      appState: { subscenes: converted.scenes },
    });
    deck.slides.push({
      id: "second",
      title: "Second",
      scene: { elements: [text("hidden-text")] },
    });
    const view = await mount(deck);
    const rootApi = await readyApi();
    await act(async () => {
      await workspace.applyFontToOpenDocuments(FONT_FAMILY.Nunito);
    });
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(1);
    expect(
      rootApi.getSceneElements().find((element) => element.id === "root-text"),
    ).toMatchObject({ fontFamily: FONT_FAMILY.Nunito });
    act(() =>
      rootApi.updateScene({ appState: { selectedElementIds: { pin: true } } }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Open subcanvas" }),
    );
    await waitFor(() => {
      expect(canvasDocument.activeEditor?.()).not.toBe(rootApi);
      expect(canvasDocument.activeEditor?.()?.getAppState().isLoading).toBe(
        false,
      );
    });
    const child = canvasDocument.activeEditor!()!;
    await waitFor(() => expect(child.getAppState().isLoading).toBe(false));
    const childText = child.getSceneElements()[0];
    if (!isTextElement(childText)) {
      throw new Error("Expected the child text element");
    }
    act(() =>
      child.updateScene({
        elements: [
          newElementWith(childText, {
            text: "updated child text",
            originalText: "updated child text",
            locked: true,
          }),
          API.createElement({ type: "rectangle", id: "later-child-shape" }),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Collapse subcanvas" }));
    act(() =>
      rootApi.updateScene({
        appState: {
          scrollX: 123,
          scrollY: 456,
          zoom: { value: getNormalizedZoom(0.75) },
        },
      }),
    );
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() =>
      expect(
        rootApi
          .getSceneElements()
          .find((element) => element.id === "root-text"),
      ).toMatchObject({ fontFamily: FONT_FAMILY.Excalifont }),
    );
    expect(rootApi.getAppState()).toMatchObject({
      scrollX: 123,
      scrollY: 456,
      zoom: { value: 0.75 },
    });
    const restoredChild = rootApi.getAppState().subscenes[converted.sceneId];
    expect(restoredChild.elements.map((element) => element.id)).toEqual([
      "child-text",
      "later-child-shape",
    ]);
    expect(restoredChild.elements[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Excalifont,
      originalText: "updated child text",
      text: "updated child text",
      locked: true,
    });
    expect(
      canvasDocument.presentation!.slides[1].scene.elements![0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Excalifont });
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() =>
      expect(
        rootApi
          .getSceneElements()
          .find((element) => element.id === "root-text"),
      ).toMatchObject({ fontFamily: FONT_FAMILY.Nunito }),
    );
    expect(
      rootApi.getAppState().subscenes[converted.sceneId].elements[0],
    ).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
      originalText: "updated child text",
    });
    expect(
      rootApi.getAppState().subscenes[converted.sceneId].elements[1].id,
    ).toBe("later-child-shape");
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(1);
  });

  it("disables editor shortcuts and slide mutation while presenting", async () => {
    const view = await mount();
    const first = await readyApi();
    act(() =>
      first.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "first-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Add slide" }));
    const second = await readyApi(first);
    act(() =>
      second.updateScene({
        elements: [API.createElement({ type: "ellipse", id: "second-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    const slideId = canvasDocument.activeSlideId;
    fireEvent.click(view.getByRole("button", { name: "Present" }));
    expect(canvasDocument.presenting).toBe(true);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    expect(ids(second)).toEqual(["second-shape"]);
    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    fireEvent.click(view.getByRole("button", { name: "Add slide" }));
    expect(canvasDocument.activeSlideId).toBe(slideId);
    expect(canvasDocument.presentation!.slides).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Stop presenting" }));
    expect(canvasDocument.presenting).toBe(false);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(second)).toEqual([]));
  });
});
