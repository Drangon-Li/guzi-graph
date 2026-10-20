import "@excalidraw/element";
import { newStickyNoteElement, newImageElement } from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
  syncTableData,
} from "@excalidraw/element/table";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { FileId } from "@excalidraw/element/types";

import { createSceneTracker } from "./document";

import type { SceneSnapshot } from "./document";

it("caches persistent subcanvas signatures during pointer changes and detects child image replacement", () => {
  const fontRegistryJSON = vi.fn(() => ({}));
  const note = newStickyNoteElement({
    type: "stickynote",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    customData: { subcanvas: { sceneId: "child" } },
  });
  const fileId = "nested-image" as FileId;
  const image = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fileId,
  });
  const scene: SceneSnapshot = {
    elements: [note],
    appState: {
      ...getDefaultAppState(),
      width: 1000,
      height: 800,
      offsetTop: 0,
      offsetLeft: 0,
      subscenes: {
        child: {
          version: 1,
          title: "Child",
          elements: [image],
          appState: { fontRegistry: { toJSON: fontRegistryJSON } as any },
        },
      },
    },
    files: {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA" as any,
        created: 1,
      },
    },
  };
  const track = createSceneTracker();
  const first = track(scene);
  fontRegistryJSON.mockClear();
  expect(
    track({
      ...scene,
      appState: { ...scene.appState, scrollX: 20, cursorButton: "down" },
    }),
  ).toBe(first);
  expect(fontRegistryJSON).not.toHaveBeenCalled();
  const replaced = track({
    ...scene,
    files: {
      [fileId]: {
        ...scene.files[fileId],
        dataURL: "data:image/png;base64,BBBB" as any,
      },
    },
  });
  expect(replaced).not.toBe(first);
  expect(JSON.parse(replaced).files[fileId].dataURL).toBe(
    "data:image/png;base64,BBBB",
  );
  const edited = track({
    ...scene,
    appState: {
      ...scene.appState,
      subscenes: {
        child: {
          ...scene.appState.subscenes.child,
          title: "Renamed",
          elements: [{ ...image, version: image.version + 1 }],
        },
      },
    },
  });
  expect(JSON.parse(edited).appState.subscenes.child.title).toBe("Renamed");
});

it("keeps table persistence snapshots stable across API reads and onChange normalization", () => {
  const table = createTableElements(createTableData(1, 1), 0, 0);
  const elements = table.elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          originalText: "Native cell edit",
          text: "Native cell edit",
          version: element.version + 1,
        }
      : element,
  );
  const state: SceneSnapshot = {
    elements,
    appState: {
      ...getDefaultAppState(),
      width: 1000,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
    },
    files: {},
  };
  const track = createSceneTracker();
  const saved = track(state);
  for (let index = 0; index < 3; index++) {
    expect(track({ ...state, elements: syncTableData(elements) })).toBe(saved);
    expect(track(state)).toBe(saved);
  }
  const editedAgain = elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          originalText: "Second edit",
          text: "Second edit",
          version: element.version + 1,
        }
      : element,
  );
  const changed = track({ ...state, elements: editedAgain });
  expect(changed).not.toBe(saved);
  expect(changed).toContain("Second edit");
});
