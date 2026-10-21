import { getStrokeWidthByKey } from "@excalidraw/common";
import { getTableMember, getTableRoot } from "@excalidraw/element/table";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { TableCellDefaults } from "@excalidraw/element/table";

import type { AppState } from "../../types";

export const getTableDefaults = (state: AppState): TableCellDefaults => ({
  fontFamily: state.currentItemFontFamily,
  fontSize: state.currentItemFontSize,
  textAlign: state.currentItemTextAlign,
  textColor: state.currentItemStrokeColor,
  strokeColor: state.currentItemStrokeColor,
  strokeWidth: getStrokeWidthByKey(
    "rectangle",
    state.currentItemStrokeWidthKey,
  ),
  strokeStyle: state.currentItemStrokeStyle,
  backgroundColor: state.currentItemBackgroundColor,
});

export const getSelectedTableRoot = (
  elements: readonly ExcalidrawElement[],
  selectedElementIds: AppState["selectedElementIds"],
) => {
  const first = elements.find(
    (element) => !element.isDeleted && selectedElementIds[element.id],
  );
  const root = getTableRoot(first, elements);
  if (!root) {
    return null;
  }
  for (const element of elements) {
    if (
      !element.isDeleted &&
      selectedElementIds[element.id] &&
      element.id !== root.id &&
      (!getTableMember(element) || element.groupIds[0] !== root.groupIds[0])
    ) {
      return null;
    }
  }
  return root;
};
