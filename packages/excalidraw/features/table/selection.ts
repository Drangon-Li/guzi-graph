import {
  getTableCellAt,
  getTableMember,
  isTableRoot,
  updateTableColors,
} from "@excalidraw/element/table";

import type {
  TableCell,
  TableCellColors,
  TableData,
  TableRange,
  TableRoot,
} from "@excalidraw/element/table";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { atom } from "../../editor-jotai";

import { getSelectedTableRoot } from "./helpers";

import type { AppClassProperties, AppState } from "../../types";

type TableColorScope =
  | { type: "table" | "cell" | "range" }
  | { type: "row" | "column"; index: number };

type TableSelection = {
  rootId: string;
  canvasMemberIds: readonly string[] | null;
  operation: TableRange;
  anchor: TableRange;
  color: TableColorScope;
};

const createSelectionAtom = () => atom<TableSelection | null>(null);
const selectionAtoms = new WeakMap<
  AppClassProperties,
  ReturnType<typeof createSelectionAtom>
>();

export const getTableSelectionAtom = (app: AppClassProperties) => {
  let selection = selectionAtoms.get(app);
  if (!selection) {
    selection = createSelectionAtom();
    selectionAtoms.set(app, selection);
  }
  return selection;
};

export const tableCellRange = (cell: TableCell): TableRange => ({
  row: cell.row,
  column: cell.column,
  endRow: cell.row + cell.rowSpan - 1,
  endColumn: cell.column + cell.columnSpan - 1,
});

const matchesSelection = (
  selection: TableSelection | null,
  rootId: string | undefined,
  selectedIds: AppState["selectedElementIds"],
): selection is TableSelection => {
  if (!rootId || selection?.rootId !== rootId) {
    return false;
  }
  const { canvasMemberIds } = selection;
  if (selectedIds[rootId]) {
    return canvasMemberIds === null;
  }
  return (
    canvasMemberIds !== null &&
    canvasMemberIds.length === Object.keys(selectedIds).length &&
    canvasMemberIds.every((id) => selectedIds[id])
  );
};

export const resolveTableSelection = (
  selection: TableSelection | null,
  root: TableRoot,
  data: TableData,
  elements: readonly ExcalidrawElement[],
  selectedIds: AppState["selectedElementIds"],
): TableSelection => {
  if (matchesSelection(selection, root.id, selectedIds)) {
    return selection;
  }
  const canvasMemberIds = selectedIds[root.id]
    ? null
    : Object.keys(selectedIds);
  const member = canvasMemberIds
    ? elements.find(
        (element) =>
          !element.isDeleted &&
          selectedIds[element.id] &&
          element.groupIds[0] === root.groupIds[0] &&
          getTableMember(element),
      )
    : undefined;
  const position = member && getTableMember(member);
  const operation = tableCellRange(
    getTableCellAt(data, position?.row ?? 0, position?.column ?? 0)!,
  );
  return {
    rootId: root.id,
    canvasMemberIds,
    operation,
    anchor: operation,
    color: { type: position ? "cell" : "table" },
  };
};

export const setTableSelection = (
  app: AppClassProperties,
  selection: TableSelection,
) => {
  const selectionAtom = getTableSelectionAtom(app);
  if (!app.editorStore.get(selectionAtom)) {
    // Keep tracking the selection after the compact popover or dialog closes.
    let selectedIds = app.state.selectedElementIds;
    app.api.onStateChange({
      predicate: (state) => {
        if (state.selectedElementIds === selectedIds) {
          return false;
        }
        selectedIds = state.selectedElementIds;
        return !matchesSelection(
          selection,
          getSelectedTableRoot(
            app.scene.getElementsIncludingDeleted(),
            selectedIds,
          )?.id,
          selectedIds,
        );
      },
      callback: () => app.editorStore.set(selectionAtom, null),
      once: true,
    });
  }
  app.editorStore.set(selectionAtom, selection);
};

export const clampTableRange = (range: TableRange, data: TableData) => ({
  row: Math.min(range.row, data.rows.length - 1),
  column: Math.min(range.column, data.columns.length - 1),
  endRow: Math.min(range.endRow, data.rows.length - 1),
  endColumn: Math.min(range.endColumn, data.columns.length - 1),
});

export const getTableColorRange = (
  selection: TableSelection,
  data: TableData,
): TableRange | null => {
  const { color } = selection;
  switch (color.type) {
    case "table":
      return null;
    case "row": {
      const row = Math.min(color.index, data.rows.length - 1);
      return {
        row,
        endRow: row,
        column: 0,
        endColumn: data.columns.length - 1,
      };
    }
    case "column": {
      const column = Math.min(color.index, data.columns.length - 1);
      return {
        row: 0,
        endRow: data.rows.length - 1,
        column,
        endColumn: column,
      };
    }
    default:
      return clampTableRange(selection.operation, data);
  }
};

const getSelectedTableRoots = (
  elements: readonly ExcalidrawElement[],
  selectedIds: AppState["selectedElementIds"],
) => {
  const groups = new Set(
    elements
      .filter(
        (element) =>
          !element.isDeleted &&
          selectedIds[element.id] &&
          (isTableRoot(element) || getTableMember(element)),
      )
      .map((element) => element.groupIds[0]),
  );
  return groups.size
    ? elements.filter(
        (element): element is TableRoot =>
          isTableRoot(element) && groups.has(element.groupIds[0]),
      )
    : [];
};

export const updateSelectedTableColors = (
  app: AppClassProperties,
  appState: AppState,
  elements: readonly ExcalidrawElement[],
  root: TableRoot,
  style: TableCellColors,
) => {
  const data = root.customData.table;
  return updateTableColors(
    elements,
    root,
    getTableColorRange(
      resolveTableSelection(
        app.editorStore.get(getTableSelectionAtom(app)),
        root,
        data,
        elements,
        appState.selectedElementIds,
      ),
      data,
    ),
    style,
  );
};

export const updateTableColorsFromSelection = (
  app: AppClassProperties,
  appState: AppState,
  elements: readonly ExcalidrawElement[],
  property: "strokeColor" | "backgroundColor",
  color: string,
) => {
  const tables = getSelectedTableRoots(elements, appState.selectedElementIds);
  if (!tables.length) {
    return elements;
  }
  const table = getSelectedTableRoot(elements, appState.selectedElementIds);
  if (table) {
    return updateSelectedTableColors(app, appState, elements, table, {
      [property]: color,
    });
  }
  const style =
    property === "strokeColor"
      ? { strokeColor: color, textColor: color }
      : { backgroundColor: color };
  return tables.reduce(
    (next, root) => updateTableColors(next, root, null, style),
    elements,
  );
};
