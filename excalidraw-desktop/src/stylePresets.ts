import { getStrokeWidthByKey } from "@excalidraw/common";
import { isArrowElement, newElementWith } from "@excalidraw/element";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { hasStrokeStyle } from "@excalidraw/excalidraw/scene";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { StylePreset } from "./shared";

export const DEFAULT_STYLE_PRESETS: StylePreset[] = [
  {
    id: "solid-arrow",
    name: "实线箭头",
    shortcut: "Alt+1",
    tool: "arrow",
    strokeStyle: "solid",
    strokeWidth: 2,
    strokeColor: "#1e1e1e",
    endArrowhead: "arrow",
  },
  {
    id: "dashed-arrow",
    name: "虚线箭头",
    shortcut: "Alt+2",
    tool: "arrow",
    strokeStyle: "dashed",
    strokeWidth: 2,
    strokeColor: "#1e1e1e",
    endArrowhead: "arrow",
  },
];

export const getStyleShortcut = (
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
) => {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    return "";
  }
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit\d$/.test(event.code)
    ? event.code.slice(5)
    : event.key.length === 1
    ? event.key.toUpperCase()
    : event.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) {
    return "";
  }
  return [
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.metaKey ? ["Meta"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
};

export const isReservedStyleShortcut = (shortcut: string) =>
  /^(Ctrl|Meta)\+(Shift\+)?(S|O|N|W|Q|Z|X|C|V|A|F|P)$/.test(shortcut);

export const applyStylePreset = (
  api: ExcalidrawImperativeAPI,
  preset: StylePreset,
) => {
  const state = api.getAppState();
  if (
    state.viewModeEnabled ||
    state.editingTextElement ||
    state.selectedLinearElement?.isEditing
  ) {
    return;
  }
  const widthKey =
    preset.strokeWidth === 1
      ? "thin"
      : preset.strokeWidth === 4
      ? "bold"
      : "medium";
  const selected = api
    .getSceneElements()
    .filter((element) => state.selectedElementIds[element.id]);
  const appState = {
    currentItemStrokeColor: preset.strokeColor,
    currentItemStrokeStyle: preset.strokeStyle,
    currentItemStrokeWidthKey: widthKey,
    currentItemEndArrowhead:
      preset.tool === "arrow"
        ? preset.endArrowhead ?? null
        : state.currentItemEndArrowhead,
  } as const;
  if (!selected.length) {
    api.updateScene({ appState, captureUpdate: CaptureUpdateAction.NEVER });
    api.setActiveTool({ type: preset.tool });
    return;
  }
  const editable = new Set(
    selected
      .filter((element) => !element.locked && hasStrokeStyle(element.type))
      .map((element) => element.id),
  );
  if (!editable.size) {
    return;
  }
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((element) => {
      if (!editable.has(element.id)) {
        return element;
      }
      return newElementWith(element, {
        strokeColor: preset.strokeColor,
        strokeStyle: preset.strokeStyle,
        strokeWidth: getStrokeWidthByKey(element.type, widthKey),
        ...(isArrowElement(element) && preset.tool === "arrow"
          ? { endArrowhead: preset.endArrowhead ?? null }
          : {}),
      });
    }),
    appState,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};
