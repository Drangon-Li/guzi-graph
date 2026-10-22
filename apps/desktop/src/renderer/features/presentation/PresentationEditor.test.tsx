import { useEffect } from "react";

import { KEYS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { convertStickyNoteToSubcanvas } from "@excalidraw/excalidraw/subcanvasActions";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

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

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
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

  afterEach(() => root.remove());

  const mount = async (deck = createPresentation("first", "First")) => {
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
          onInitialize={(api) => workspace.initialize(current, api)}
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

  it("round trips two slides with independent undo and redo, retaining undone elements", async () => {
    const view = await mount();
    const first = await readyApi();
    act(() =>
      first.updateScene({
        elements: [API.createElement({ type: "rectangle", id: "first-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() => expect(ids(first)).toEqual(["first-shape"]));
    fireEvent.click(view.getByRole("button", { name: "Add slide" }));
    const secondId = canvasDocument.activeSlideId!;
    const second = await readyApi(first);
    expect(first.isDestroyed).toBe(true);
    act(() =>
      second.updateScene({
        elements: [API.createElement({ type: "ellipse", id: "second-shape" })],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(second)).toEqual([]));
    expect(second.getSceneElementsIncludingDeleted()).toMatchObject([
      { id: "second-shape", isDeleted: true },
    ]);

    fireEvent.click(view.getByRole("button", { name: "Select First" }));
    const reopenedFirst = await readyApi(second);
    expect(ids(reopenedFirst)).toEqual(["first-shape"]);
    undo(view.container.querySelector(".desktop-root-canvas .excalidraw")!);
    await waitFor(() => expect(ids(reopenedFirst)).toEqual([]));
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() => expect(ids(reopenedFirst)).toEqual(["first-shape"]));

    act(() => workspace.selectSlide(canvasDocument, secondId));
    const reopenedSecond = await readyApi(reopenedFirst);
    expect(ids(reopenedSecond)).toEqual([]);
    expect(reopenedSecond.getSceneElementsIncludingDeleted()).toMatchObject([
      { id: "second-shape", isDeleted: true },
    ]);
    undo(
      view.container.querySelector(".desktop-root-canvas .excalidraw")!,
      true,
    );
    await waitFor(() => expect(ids(reopenedSecond)).toEqual(["second-shape"]));
    expect(canvasDocument.presentation!.slides[0].scene.elements).toMatchObject(
      [{ id: "first-shape", isDeleted: false }],
    );
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
