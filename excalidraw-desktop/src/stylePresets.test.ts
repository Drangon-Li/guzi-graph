import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  applyStylePreset,
  DEFAULT_STYLE_PRESETS,
  getStyleShortcut,
} from "./stylePresets";

it("activates the preset tool and defaults when there is no selection", () => {
  const updateScene = vi.fn();
  const setActiveTool = vi.fn();
  const api = {
    getAppState: () => getDefaultAppState(),
    getSceneElements: () => [],
    updateScene,
    setActiveTool,
  } as unknown as ExcalidrawImperativeAPI;
  applyStylePreset(api, DEFAULT_STYLE_PRESETS[1]);
  expect(setActiveTool).toHaveBeenCalledWith({ type: "arrow" });
  expect(updateScene).toHaveBeenCalledWith(
    expect.objectContaining({
      appState: expect.objectContaining({ currentItemStrokeStyle: "dashed" }),
      captureUpdate: CaptureUpdateAction.NEVER,
    }),
  );
});

it("changes the selected shape in one undo capture and preserves locked shapes and selection", () => {
  const shape = API.createElement({ type: "rectangle" });
  const locked = API.createElement({ type: "rectangle", locked: true });
  const state = {
    ...getDefaultAppState(),
    selectedElementIds: { [shape.id]: true, [locked.id]: true },
  };
  const updateScene = vi.fn();
  const setActiveTool = vi.fn();
  const api = {
    getAppState: () => state,
    getSceneElements: () => [shape, locked],
    getSceneElementsIncludingDeleted: () => [shape, locked],
    updateScene,
    setActiveTool,
  } as unknown as ExcalidrawImperativeAPI;
  applyStylePreset(api, DEFAULT_STYLE_PRESETS[1]);
  expect(setActiveTool).not.toHaveBeenCalled();
  const update = updateScene.mock.calls[0][0];
  expect(update.captureUpdate).toBe(CaptureUpdateAction.IMMEDIATELY);
  expect(update.elements[0]).toMatchObject({
    id: shape.id,
    type: "rectangle",
    strokeStyle: "dashed",
    strokeWidth: 2,
  });
  expect(update.elements[1]).toBe(locked);
  expect(state.selectedElementIds).toEqual({
    [shape.id]: true,
    [locked.id]: true,
  });
});

it("normalizes Option digit shortcuts using the physical key and does not interrupt text editing", () => {
  expect(
    getStyleShortcut({
      key: "™",
      code: "Digit2",
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }),
  ).toBe("Alt+2");
  const api = {
    getAppState: () => ({
      ...getDefaultAppState(),
      editingTextElement: API.createElement({ type: "text", text: "Editing" }),
    }),
    updateScene: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
  applyStylePreset(api, DEFAULT_STYLE_PRESETS[1]);
  expect(api.updateScene).not.toHaveBeenCalled();
});
