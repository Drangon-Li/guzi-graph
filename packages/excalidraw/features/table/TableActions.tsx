import { useCallback, useState } from "react";

import { getFontSizePresets, reduceToCommonValue } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  fixBindingsAfterDeletion,
  isArrowElement,
  isNonDeletedElement,
  newElementWith,
  updateBoundElements,
} from "@excalidraw/element";
import {
  canMergeTableCells,
  getTableCellAt,
  isTableRoot,
  mergeTableCells,
  readTableData,
  splitTableCells,
  styleTableCells,
  tableCellIntersectsRange,
  TABLE_MIN_COLUMN_WIDTH,
  TABLE_MIN_ROW_HEIGHT,
  updateTableElements,
} from "@excalidraw/element/table";

import type {
  TableCell,
  TableCellColors,
  TableRange,
  TableRoot,
} from "@excalidraw/element/table";
import type { CaptureUpdateActionType } from "@excalidraw/element";

import { getLanguage } from "../../i18n";
import { useAtomValue } from "../../editor-jotai";
import { useStableCallback } from "../../hooks/useStableCallback";
import { UIAppStateContext } from "../../context/ui-appState";

import { ColorPicker } from "../../components/ColorPicker/ColorPicker";
import { Dialog } from "../../components/Dialog";
import { activeEyeDropperAtom } from "../../components/EyeDropper";
import { IconButton } from "../../components/IconButton";
import { PreferenceConfigureButton } from "../../components/PreferenceConfigureButton";
import { RadioSelection } from "../../components/RadioSelection";
import { Tooltip } from "../../components/Tooltip";
import {
  FontSizeSmallIcon,
  FontSizeMediumIcon,
  FontSizeLargeIcon,
  FontSizeExtraLargeIcon,
  TextAlignLeftIcon,
  TextAlignCenterIcon,
  TextAlignRightIcon,
} from "../../components/icons";
import {
  useExcalidrawActionManager,
  useExcalidrawAppState,
  useExcalidrawElements,
} from "../../components/App";

import { getSelectedTableRoot as resolveSelectedTableRoot } from "./helpers";
import {
  clampTableRange,
  getTableColorRange,
  getTableSelectionAtom,
  resolveTableSelection,
  setTableSelection,
  tableCellRange,
  updateSelectedTableColors,
} from "./selection";

import "./TableActions.scss";

import type { ActionManager } from "../../actions/manager";
import type { AppClassProperties, UIAppState } from "../../types";

const labels = {
  "zh-CN": {
    table: "表格",
    details: "表格详细设置",
    selectCells: "选择单元格（Shift 多选）",
    merged: "（已合并）",
    hint: "Shift 点击选择区域；双击单元格编辑文字。",
    text: "单元格文字",
    merge: "合并单元格",
    split: "拆分单元格",
    addRow: "添加行",
    insertRow: "在上方插入行",
    deleteRow: "删除行",
    addColumn: "添加列",
    insertColumn: "在左侧插入列",
    deleteColumn: "删除列",
    fill: "背景",
    textColor: "文字颜色",
    borderColor: "边框颜色",
    colorScope: "着色范围",
    wholeTable: "整表",
    selectRow: "选整行",
    selectColumn: "选整列",
    fontSize: "字号",
    align: "对齐",
    left: "左对齐",
    center: "居中",
    right: "右对齐",
    justify: "两端对齐",
    rowHeight: "行高",
    columnWidth: "列宽",
    sizeHint: "尺寸应用于所选行列，行高会适应文字内容。",
  },
  en: {
    table: "Table",
    details: "Table details",
    selectCells: "Select cells (Shift for multiple)",
    merged: " (merged)",
    hint: "Shift-click to select a range; double-click a cell to edit text.",
    text: "Cell text",
    merge: "Merge cells",
    split: "Split cells",
    addRow: "Add row",
    insertRow: "Insert row above",
    deleteRow: "Delete row",
    addColumn: "Add column",
    insertColumn: "Insert column before",
    deleteColumn: "Delete column",
    fill: "Background",
    textColor: "Text color",
    borderColor: "Border color",
    colorScope: "Color scope",
    wholeTable: "Whole table",
    selectRow: "Select row",
    selectColumn: "Select column",
    fontSize: "Font size",
    align: "Alignment",
    left: "Left",
    center: "Center",
    right: "Right",
    justify: "Justify",
    rowHeight: "Row height",
    columnWidth: "Column width",
    sizeHint:
      "Sizes apply to selected rows and columns. Rows adjust to fit text.",
  },
};

const operationIcon = (operation: "row" | "column" | "merge" | "split") => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="16" rx="1" />
    {operation === "row" ? (
      <path d="M3 12h18M12 7v10M9 10h6" />
    ) : operation === "column" ? (
      <path d="M12 4v16M6 12h12M15 9v6" />
    ) : operation === "merge" ? (
      <path d="M7 8l4 4-4 4m10-8-4 4 4 4" />
    ) : (
      <path d="M12 4v16M9 8l-4 4 4 4m6-8 4 4-4 4" />
    )}
  </svg>
);

export const getSelectedTableRoot = (
  app: AppClassProperties,
  appState: UIAppState,
) =>
  appState.editingTextElement
    ? null
    : resolveSelectedTableRoot(
        app.scene.getElementsIncludingDeleted(),
        appState.selectedElementIds,
      );

export const applyTableChange = (
  app: AppClassProperties,
  root: TableRoot,
  transform: Parameters<typeof updateTableElements>[2],
  options: {
    captureUpdate?: CaptureUpdateActionType;
    previous?: Parameters<typeof updateTableElements>[0];
    preserveOrigin?: boolean;
    leadingAxis?: "row" | "column";
    preserveSelection?: boolean;
  } = {},
) => {
  const previous = options.previous ?? app.scene.getElementsIncludingDeleted();
  let elements = updateTableElements(
    previous,
    root,
    transform,
    app.renderEnvironment,
  );
  if (options.preserveOrigin) {
    const nextRoot = elements.find((element) => element.id === root.id)!;
    const halfWidth = (nextRoot.width - root.width) / 2;
    const halfHeight = (nextRoot.height - root.height) / 2;
    const cos = Math.cos(root.angle);
    const sin = Math.sin(root.angle);
    const offset = {
      x: options.leadingAxis === "column" ? -halfWidth * 2 : 0,
      y: options.leadingAxis === "row" ? -halfHeight * 2 : 0,
    };
    const x =
      (cos - 1) * halfWidth -
      sin * halfHeight +
      cos * offset.x -
      sin * offset.y;
    const y =
      sin * halfWidth +
      (cos - 1) * halfHeight +
      sin * offset.x +
      cos * offset.y;
    elements = elements.map((element) =>
      element.groupIds[0] === root.groupIds[0]
        ? newElementWith(element, { x: element.x + x, y: element.y + y })
        : element,
    );
  }
  const nextById = new Map(elements.map((element) => [element.id, element]));
  const deleted = previous.filter(
    (element) => !element.isDeleted && nextById.get(element.id)?.isDeleted,
  );
  if (deleted.length) {
    const deletedIds = new Set(deleted.map((element) => element.id));
    elements = elements.map((element) =>
      isArrowElement(element) &&
      ((element.startBinding &&
        deletedIds.has(element.startBinding.elementId)) ||
        (element.endBinding && deletedIds.has(element.endBinding.elementId)))
        ? { ...element }
        : element,
    );
    fixBindingsAfterDeletion(elements, deleted);
  }
  app.scene.replaceAllElements(elements);
  for (const element of elements) {
    if (
      isNonDeletedElement(element) &&
      element.groupIds[0] === root.groupIds[0] &&
      element.boundElements?.some(({ type }) => type === "arrow")
    ) {
      updateBoundElements(element, app.scene);
    }
  }
  app.syncActionResult({
    elements,
    appState: {
      selectedElementIds: options.preserveSelection
        ? app.state.selectedElementIds
        : Object.fromEntries(
            elements
              .filter(
                (element) =>
                  !element.isDeleted &&
                  element.groupIds[0] === root.groupIds[0] &&
                  element.type !== "text",
              )
              .map((element) => [element.id, true]),
          ),
    },
    captureUpdate: options.captureUpdate ?? CaptureUpdateAction.IMMEDIATELY,
  });
};

const TableEditor = ({
  app,
  appState,
  root,
  renderAction,
  detailed = false,
  popoverContainer,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  root: TableRoot;
  renderAction?: ActionManager["renderAction"];
  detailed?: boolean;
  popoverContainer?: HTMLDivElement | null;
}) => {
  const english = getLanguage().code === "en";
  const label = labels[english ? "en" : "zh-CN"];
  const activeSelection = useAtomValue(getTableSelectionAtom(app));
  const elements = app.scene.getElementsIncludingDeleted();
  const data = readTableData(root, elements);
  const tableSelection = resolveTableSelection(
    activeSelection,
    root,
    data,
    elements,
    appState.selectedElementIds,
  );
  const selection = clampTableRange(tableSelection.operation, data);
  const colorRange = getTableColorRange(tableSelection, data);
  const colorCells = colorRange
    ? data.cells.filter((cell) => tableCellIntersectsRange(cell, colorRange))
    : data.cells;
  const position = (row: number, column: number) =>
    english ? `R${row + 1}C${column + 1}` : `第${row + 1}行第${column + 1}列`;
  const colorScopeLabel = () => {
    if (!colorRange) {
      return label.wholeTable;
    }
    const { row, column, endRow, endColumn } = colorRange;
    switch (tableSelection.color.type) {
      case "row":
        return english ? `Row ${row + 1}` : `第${row + 1}行`;
      case "column":
        return english ? `Column ${column + 1}` : `第${column + 1}列`;
      case "range":
        return `${position(row, column)} – ${position(endRow, endColumn)}`;
      default:
        return position(row, column);
    }
  };
  const cell = getTableCellAt(data, selection.row, selection.column)!;
  const chooseRange = (next: TableRange, shiftKey: boolean) => {
    const anchor = shiftKey
      ? clampTableRange(tableSelection.anchor, data)
      : next;
    setTableSelection(app, {
      ...tableSelection,
      anchor,
      operation: {
        row: Math.min(anchor.row, next.row),
        column: Math.min(anchor.column, next.column),
        endRow: Math.max(anchor.endRow, next.endRow),
        endColumn: Math.max(anchor.endColumn, next.endColumn),
      },
      color: { type: shiftKey ? "range" : "cell" },
    });
  };
  const apply = (transform: Parameters<typeof updateTableElements>[2]) =>
    applyTableChange(app, root, transform);
  const style = useStableCallback(
    (value: Parameters<typeof styleTableCells>[2]) =>
      apply((data) => styleTableCells(data, selection, value)),
  );
  const applyColor = useStableCallback((value: TableCellColors) => {
    const current = app.scene.getElementsIncludingDeleted();
    const selected = resolveSelectedTableRoot(
      current,
      app.state.selectedElementIds,
    );
    if (selected?.id !== root.id || app.state.editingTextElement) {
      return;
    }
    const next = updateSelectedTableColors(
      app,
      app.state,
      current,
      selected,
      value,
    );
    if (next !== current) {
      app.syncActionResult({
        elements: next,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  });
  const mergeDisabled =
    !canMergeTableCells(data, selection) ||
    (selection.row === selection.endRow &&
      selection.column === selection.endColumn);
  const splitDisabled = !data.cells.some(
    (item) =>
      item.row <= selection.endRow &&
      item.row + item.rowSpan > selection.row &&
      item.column <= selection.endColumn &&
      item.column + item.columnSpan > selection.column &&
      (item.rowSpan > 1 || item.columnSpan > 1),
  );
  const presets = getFontSizePresets(
    app.props.desktopIntegration?.fontSizePresets,
  );
  return (
    <fieldset
      className={`table-actions${detailed ? " table-actions--details" : ""}`}
    >
      {!detailed && <legend>{label.table}</legend>}
      <small className="table-color-scope" aria-live="polite">
        {label.colorScope} · {colorScopeLabel()}
      </small>
      <Tooltip label={label.hint} long delay>
        <div
          className="table-cell-grid"
          style={{
            gridTemplateColumns: `repeat(${data.columns.length}, minmax(24px, 1fr))`,
          }}
          aria-label={label.selectCells}
        >
          {data.rows.flatMap((_, row) =>
            data.columns.map((_, column) => {
              const current = getTableCellAt(data, row, column)!;
              const selected =
                !!colorRange && tableCellIntersectsRange(current, colorRange);
              const title = `${
                english
                  ? `Row ${row + 1}, column ${column + 1}`
                  : `第${row + 1}行，第${column + 1}列`
              }${
                current.rowSpan > 1 || current.columnSpan > 1
                  ? label.merged
                  : ""
              }`;
              return (
                <button
                  key={`${row}:${column}`}
                  type="button"
                  title={title}
                  aria-label={title}
                  aria-pressed={selected}
                  onClick={(event) =>
                    chooseRange(tableCellRange(current), event.shiftKey)
                  }
                >
                  {current.row === row && current.column === column
                    ? current.text.slice(0, 3) || `${row + 1},${column + 1}`
                    : "↖"}
                </button>
              );
            }),
          )}
        </div>
      </Tooltip>
      <div
        className="table-color-scopes"
        role="group"
        aria-label={label.colorScope}
      >
        <button
          type="button"
          aria-pressed={!colorRange}
          onClick={() =>
            setTableSelection(app, {
              ...tableSelection,
              color: { type: "table" },
            })
          }
        >
          {label.wholeTable}
        </button>
        {(["row", "column"] as const).map((axis) => (
          <button
            key={axis}
            type="button"
            aria-pressed={tableSelection.color.type === axis}
            onClick={() =>
              setTableSelection(app, {
                ...tableSelection,
                color: { type: axis, index: selection[axis] },
              })
            }
          >
            {axis === "row" ? label.selectRow : label.selectColumn}
          </button>
        ))}
      </div>
      {(
        [
          [label.borderColor, "strokeColor", "elementStroke"],
          [label.fill, "backgroundColor", "elementBackground"],
          [label.textColor, "textColor", "tableText"],
        ] as const
      ).map(([title, key, type]) => (
        <fieldset key={key}>
          <legend>{title}</legend>
          <ColorPicker
            type={type}
            color={reduceToCommonValue(colorCells, (cell) => cell[key])}
            label={title}
            elements={elements}
            appState={appState}
            onChange={(color) => applyColor({ [key]: color })}
            updateData={(value) =>
              app.syncActionResult({
                appState: value,
                captureUpdate: CaptureUpdateAction.NEVER,
              })
            }
            customizableTopPicks={
              type === "elementBackground"
                ? "elementBackground"
                : "elementStroke"
            }
            popoverContainer={popoverContainer}
          />
        </fieldset>
      ))}
      <div className="table-structure-actions">
        <IconButton
          type="button"
          size="small"
          aria-label={label.addRow}
          title={label.addRow}
          icon={operationIcon("row")}
          onClick={() =>
            apply({ type: "insert", axis: "row", index: selection.endRow + 1 })
          }
        />
        <IconButton
          type="button"
          size="small"
          aria-label={label.addColumn}
          title={label.addColumn}
          icon={operationIcon("column")}
          onClick={() =>
            apply({
              type: "insert",
              axis: "column",
              index: selection.endColumn + 1,
            })
          }
        />
        <IconButton
          type="button"
          size="small"
          aria-label={label.merge}
          title={label.merge}
          disabled={mergeDisabled}
          icon={operationIcon("merge")}
          onClick={() => apply((data) => mergeTableCells(data, selection))}
        />
        <IconButton
          type="button"
          size="small"
          aria-label={label.split}
          title={label.split}
          disabled={splitDisabled}
          icon={operationIcon("split")}
          onClick={() => apply((data) => splitTableCells(data, selection))}
        />
      </div>
      {detailed ? (
        <>
          <div className="table-details-fields">
            <label>
              {label.text}
              <textarea
                aria-label={label.text}
                value={cell.text}
                rows={3}
                onChange={(event) =>
                  apply((data) => ({
                    ...data,
                    cells: data.cells.map((item) =>
                      item.row === cell.row && item.column === cell.column
                        ? {
                            ...item,
                            text: event.target.value,
                            richText: undefined,
                          }
                        : item,
                    ),
                  }))
                }
              />
            </label>
            <div className="table-details-row">
              <button
                type="button"
                onClick={() =>
                  apply({ type: "insert", axis: "row", index: selection.row })
                }
              >
                {label.insertRow}
              </button>
              <button
                type="button"
                disabled={data.rows.length <= 1}
                onClick={() =>
                  apply({ type: "delete", axis: "row", index: selection.row })
                }
              >
                {label.deleteRow}
              </button>
              <button
                type="button"
                onClick={() =>
                  apply({
                    type: "insert",
                    axis: "column",
                    index: selection.column,
                  })
                }
              >
                {label.insertColumn}
              </button>
              <button
                type="button"
                disabled={data.columns.length <= 1}
                onClick={() =>
                  apply({
                    type: "delete",
                    axis: "column",
                    index: selection.column,
                  })
                }
              >
                {label.deleteColumn}
              </button>
              <label>
                {label.rowHeight}
                <input
                  type="number"
                  aria-label={label.rowHeight}
                  min={TABLE_MIN_ROW_HEIGHT}
                  value={Math.round(data.rows[selection.row])}
                  onChange={(event) => {
                    const height = Number(event.target.value);
                    if (
                      Number.isFinite(height) &&
                      height >= TABLE_MIN_ROW_HEIGHT
                    ) {
                      apply({
                        type: "resizeRows",
                        row: selection.row,
                        endRow: selection.endRow,
                        height,
                      });
                    }
                  }}
                />
              </label>
              <label>
                {label.columnWidth}
                <input
                  type="number"
                  aria-label={label.columnWidth}
                  min={TABLE_MIN_COLUMN_WIDTH}
                  value={Math.round(data.columns[selection.column])}
                  onChange={(event) => {
                    const width = Number(event.target.value);
                    if (
                      Number.isFinite(width) &&
                      width >= TABLE_MIN_COLUMN_WIDTH
                    ) {
                      apply((data) => ({
                        ...data,
                        columns: data.columns.map((value, index) =>
                          index >= selection.column &&
                          index <= selection.endColumn
                            ? width
                            : value,
                        ),
                      }));
                    }
                  }}
                />
              </label>
            </div>
            <small>{label.sizeHint}</small>
          </div>
          <div className="selected-shape-actions shape-actions-theme-scope table-details-appearance">
            {renderAction?.("changeStrokeWidth")}
            {renderAction?.("changeStrokeStyle")}
            {renderAction?.("changeSloppiness")}
          </div>
        </>
      ) : (
        <>
          {renderAction?.("changeFontFamily")}
          <fieldset>
            <legend>{label.fontSize}</legend>
            <div className="buttonList">
              <RadioSelection
                group="table-fontSize"
                options={[
                  {
                    value: presets.sm,
                    text: `S (${presets.sm})`,
                    icon: FontSizeSmallIcon,
                  },
                  {
                    value: presets.md,
                    text: `M (${presets.md})`,
                    icon: FontSizeMediumIcon,
                  },
                  {
                    value: presets.lg,
                    text: `L (${presets.lg})`,
                    icon: FontSizeLargeIcon,
                  },
                  {
                    value: presets.xl,
                    text: `XL (${presets.xl})`,
                    icon: FontSizeExtraLargeIcon,
                  },
                ]}
                value={cell.fontSize}
                onChange={(fontSize) => style({ fontSize })}
              />
              {app.props.desktopIntegration?.onConfigurePreferences && (
                <PreferenceConfigureButton section="fontSizes" />
              )}
            </div>
          </fieldset>
          <fieldset>
            <legend>{label.align}</legend>
            <div className="buttonList">
              <RadioSelection<TableCell["textAlign"]>
                group="table-textAlign"
                options={[
                  { value: "left", text: label.left, icon: TextAlignLeftIcon },
                  {
                    value: "center",
                    text: label.center,
                    icon: TextAlignCenterIcon,
                  },
                  {
                    value: "right",
                    text: label.right,
                    icon: TextAlignRightIcon,
                  },
                  {
                    value: "justify",
                    text: label.justify,
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                      </svg>
                    ),
                  },
                ]}
                value={cell.textAlign}
                onChange={(textAlign) => style({ textAlign })}
              />
            </div>
          </fieldset>
        </>
      )}
    </fieldset>
  );
};

export const TableActions = ({
  app,
  appState,
  renderAction,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  renderAction?: ActionManager["renderAction"];
}) => {
  const root = getSelectedTableRoot(app, appState);
  return root ? (
    <TableEditor
      key={root.id}
      app={app}
      appState={appState}
      root={root}
      renderAction={renderAction}
    />
  ) : null;
};

export const TablePropertiesDialog = ({
  app,
  rootId,
  onClose,
}: {
  app: AppClassProperties;
  rootId: string;
  onClose: () => void;
}) => {
  const appState = useExcalidrawAppState();
  const eyeDropper = useAtomValue(activeEyeDropperAtom);
  const [popoverContainer, setPopoverContainer] =
    useState<HTMLDivElement | null>(null);
  const setDialogContent = useCallback((node: HTMLDivElement | null) => {
    setPopoverContainer(
      (node?.closest(".Modal")?.parentElement as HTMLDivElement | undefined) ??
        null,
    );
  }, []);
  const { renderAction } = useExcalidrawActionManager();
  const elements = useExcalidrawElements();
  const root = elements.find((element) => element.id === rootId);
  if (!isTableRoot(root)) {
    return null;
  }
  const label = labels[getLanguage().code === "en" ? "en" : "zh-CN"];
  return (
    <UIAppStateContext.Provider value={appState}>
      <Dialog
        title={<span id="dialog-title">{label.details}</span>}
        className={eyeDropper ? "table-details--sampling" : undefined}
        size="small"
        onCloseRequest={onClose}
      >
        <div ref={setDialogContent}>
          <TableEditor
            key={root.id}
            app={app}
            appState={appState}
            root={root}
            renderAction={renderAction}
            popoverContainer={popoverContainer}
            detailed
          />
        </div>
      </Dialog>
    </UIAppStateContext.Provider>
  );
};
