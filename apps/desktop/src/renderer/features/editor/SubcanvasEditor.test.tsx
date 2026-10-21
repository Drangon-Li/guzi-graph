import { CaptureUpdateAction, isNonDeletedElement } from "@excalidraw/element";
import { KEYS } from "@excalidraw/common";

import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  waitFor,
  unmountComponent,
} from "@excalidraw/excalidraw/tests/test-utils";
import {
  createPasteEvent,
  serializeAsClipboardJSON,
} from "@excalidraw/excalidraw/clipboard";

import { convertStickyNoteToSubcanvas } from "@excalidraw/excalidraw/subcanvasActions";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { SubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "./SubcanvasEditor";

import type { CanvasDocument } from "../workspace/workspace";

describe("desktop nested canvas lifecycle", () => {
  it("saves nested edits, releases closed editors and restores separate undo history", async () => {
    const note = API.createElement({ type: "stickynote", id: "pin" });
    const converted = convertStickyNoteToSubcanvas([note], note.id, {})!;
    const document = { title: "Parent" } as CanvasDocument;
    const save = vi.fn().mockResolvedValue(true);
    let parent!: ExcalidrawImperativeAPI;
    const view = await render(
      <SubcanvasEditor
        document={document}
        initialData={{
          elements: converted.elements,
          appState: { subscenes: converted.scenes },
        }}
        onExcalidrawAPI={(api) => {
          if (api) {
            parent = api;
          }
        }}
        desktopIntegration={{ save, open: async () => {}, localOnly: true }}
        interaction
        handleKeyboardGlobally
        langCode="zh-CN"
      />,
    );
    act(() => {
      parent.updateScene({ appState: { selectedElementIds: { pin: true } } });
    });
    fireEvent.click(await view.findByRole("button", { name: "打开子画布" }));
    await waitFor(() => expect(document.activeEditor?.()).not.toBe(parent));
    await waitFor(() =>
      expect(document.activeEditor?.()?.getAppState().isLoading).toBe(false),
    );
    const firstChild = document.activeEditor!()!;
    const shape = API.createElement({ type: "rectangle", id: "child-shape" });
    act(() =>
      firstChild.updateScene({
        elements: [shape],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() =>
      expect(
        document.getSnapshot!().appState.subscenes[converted.sceneId]
          .elements[0]?.id,
      ).toBe(shape.id),
    );
    expect(parent.getSceneElements().map((element) => element.id)).toEqual([
      "pin",
    ]);
    expect(firstChild.history.checkpoint!().undo.length).toBeGreaterThan(0);

    fireEvent.click(view.getByRole("button", { name: "收起子画布" }));
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "子画布" })).toBeNull(),
    );
    expect(firstChild.isDestroyed).toBe(true);
    expect(document.activeEditor!()).toBe(parent);
    act(() =>
      parent.updateScene({ appState: { selectedElementIds: { pin: true } } }),
    );
    fireEvent.click(view.getByRole("button", { name: "打开子画布" }));
    await waitFor(() =>
      expect(document.activeEditor?.()?.getAppState().isLoading).toBe(false),
    );
    const reopened = document.activeEditor!()!;
    expect(reopened).not.toBe(parent);
    expect(reopened.getSceneElements()[0].id).toBe(shape.id);
    await waitFor(() =>
      expect(reopened.history.checkpoint!().undo.length).toBeGreaterThan(0),
    );
    const editor = view.container.querySelector(
      ".desktop-subcanvas .excalidraw",
    )!;
    fireEvent.keyDown(editor, {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
    });
    await waitFor(() => expect(reopened.getSceneElements()).toHaveLength(0));
    expect(parent.getSceneElements()).toHaveLength(1);
    fireEvent.keyDown(editor, {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
      shiftKey: true,
    });
    await waitFor(() => expect(reopened.getSceneElements()).toHaveLength(1));
    await act(async () => {
      await reopened.desktopSave(false);
    });
    expect(save.mock.lastCall![0].elements[0].id).toBe("pin");
    expect(
      save.mock.lastCall![0].appState.subscenes[converted.sceneId].elements[0]
        .id,
    ).toBe(shape.id);

    const nestedNote = API.createElement({ type: "stickynote", id: "nested" });
    act(() =>
      reopened.updateScene({
        elements: [...reopened.getSceneElements(), nestedNote],
        appState: { selectedElementIds: { nested: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "转为子画布" }));
    fireEvent.click(
      view.getAllByRole("button", { name: "打开子画布" }).at(-1)!,
    );
    await waitFor(() => expect(document.activeEditor?.()).not.toBe(reopened));
    expect(
      view
        .getByRole("navigation", { name: "画布路径" })
        .querySelectorAll("button"),
    ).toHaveLength(3);
    fireEvent.click(view.getByRole("button", { name: "返回上一级" }));
    await waitFor(() =>
      expect(
        view
          .getByRole("navigation", { name: "画布路径" })
          .querySelectorAll("button"),
      ).toHaveLength(2),
    );
  });
});

it("preserves a pasted subtree in app state and can copy it into another canvas", async () => {
  unmountComponent();
  const sourcePin = API.createElement({
    type: "stickynote",
    id: "copy-source-pin",
  });
  const converted = convertStickyNoteToSubcanvas(
    [sourcePin],
    sourcePin.id,
    {},
  )!;
  const nestedPin = {
    ...API.createElement({ type: "stickynote", id: "nested-source-pin" }),
    customData: { subcanvas: { sceneId: "source-grandchild" } },
  };
  const fileId = "subtree-image" as FileId;
  const image = API.createElement({
    type: "image",
    id: "nested-image",
    fileId,
    width: 100,
    height: 100,
  });
  const scenes: SubcanvasScenes = {
    ...converted.scenes,
    [converted.sceneId]: {
      ...converted.scenes[converted.sceneId],
      elements: [nestedPin],
    },
    "source-grandchild": {
      version: 1,
      title: "Grandchild",
      elements: [image],
      appState: {},
    },
  };
  const files: BinaryFiles = {
    [fileId]: {
      id: fileId,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AA==" as DataURL,
      created: 1,
    },
  };
  const firstClipboard = serializeAsClipboardJSON({
    elements: converted.elements.filter(isNonDeletedElement),
    files,
    subscenes: scenes,
  });
  const mountCanvas = async () => {
    const document = { title: "Clipboard destination" } as CanvasDocument;
    let api!: ExcalidrawImperativeAPI;
    await render(
      <SubcanvasEditor
        document={document}
        initialData={{ elements: [], appState: { subscenes: {} } }}
        onExcalidrawAPI={(value) => {
          if (value) {
            api = value;
          }
        }}
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          localOnly: true,
        }}
        interaction
        handleKeyboardGlobally
        autoFocus
        langCode="en"
      />,
    );
    await waitFor(() => expect(api.getAppState().isLoading).toBe(false));
    Object.assign(globalThis.document, {
      elementFromPoint: () =>
        globalThis.document.querySelector("canvas.interactive"),
    });
    return { document, api };
  };
  const paste = async (content: string) => {
    await act(async () => {
      globalThis.document.dispatchEvent(
        createPasteEvent({ types: { "text/plain": content } }),
      );
    });
  };
  const first = await mountCanvas();
  await paste(firstClipboard);
  await waitFor(() => expect(first.api.getSceneElements()).toHaveLength(1));
  const firstId = first.api.getSceneElements()[0].customData!.subcanvas.sceneId;
  expect(firstId).not.toBe(converted.sceneId);
  expect(first.api.getAppState().subscenes[firstId]).toBeDefined();
  expect(
    first.document.getSnapshot!().appState.subscenes[firstId],
  ).toBeDefined();
  const firstNestedId =
    first.api.getAppState().subscenes[firstId].elements[0].customData!.subcanvas
      .sceneId;
  expect(firstNestedId).not.toBe("source-grandchild");
  expect(
    first.api.getAppState().subscenes[firstNestedId].elements[0],
  ).toMatchObject({ type: "image", fileId });
  const pastedPin = first.api.getSceneElements()[0];
  fireEvent.keyDown(
    globalThis.document.querySelector(".desktop-root-canvas .excalidraw")!,
    { key: "d", code: "KeyD", [KEYS.CTRL_OR_CMD]: true },
  );
  await waitFor(() => expect(first.api.getSceneElements()).toHaveLength(2));
  const duplicatedPin = first.api
    .getSceneElements()
    .find((element) => element.id !== pastedPin.id)!;
  const duplicateId = duplicatedPin.customData!.subcanvas.sceneId;
  expect(duplicateId).not.toBe(firstId);
  expect(first.api.getAppState().subscenes[duplicateId]).toBeDefined();
  expect(
    first.document.getSnapshot!().appState.subscenes[duplicateId],
  ).toBeDefined();
  const duplicateNestedId =
    first.api.getAppState().subscenes[duplicateId].elements[0].customData!
      .subcanvas.sceneId;
  expect(duplicateNestedId).not.toBe(firstNestedId);
  expect(
    first.api.getAppState().subscenes[duplicateNestedId].elements[0].id,
  ).not.toBe(first.api.getAppState().subscenes[firstNestedId].elements[0].id);
  const secondClipboard = serializeAsClipboardJSON({
    elements: [duplicatedPin],
    files: first.api.getFiles(),
    subscenes: first.api.getAppState().subscenes,
  });
  expect(JSON.parse(secondClipboard).files[fileId]).toEqual(files[fileId]);
  expect(Object.keys(JSON.parse(secondClipboard).subscenes)).toHaveLength(2);
  unmountComponent();
  const second = await mountCanvas();
  await paste(secondClipboard);
  await waitFor(() => expect(second.api.getSceneElements()).toHaveLength(1));
  const secondId =
    second.api.getSceneElements()[0].customData!.subcanvas.sceneId;
  expect(secondId).not.toBe(firstId);
  expect(second.api.getAppState().subscenes[secondId]).toBeDefined();
  expect(
    second.document.getSnapshot!().appState.subscenes[secondId],
  ).toBeDefined();
  const secondNestedId =
    second.api.getAppState().subscenes[secondId].elements[0].customData!
      .subcanvas.sceneId;
  expect(secondNestedId).not.toBe(firstNestedId);
  expect(
    second.api.getAppState().subscenes[secondNestedId].elements[0],
  ).toMatchObject({ type: "image", fileId });
  expect(second.api.getFiles()[fileId]).toEqual(files[fileId]);
});
