import { useState } from "react";

import { getFontSizePresets } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  fixBindingsAfterDeletion,
  isArrowElement,
  isNonDeletedElement,
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
  updateTableElements,
} from "@excalidraw/element/table";

import type {
  TableCell,
  TableRange,
  TableRoot,
} from "@excalidraw/element/table";

import { getLanguage } from "../../i18n";
import { useStableCallback } from "../../hooks/useStableCallback";
import { UIAppStateContext } from "../../context/ui-appState";

import { ColorPicker } from "../../components/ColorPicker/ColorPicker";
import { Dialog } from "../../components/Dialog";
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
    fontSize: "Font size",
    align: "Alignment",
    left: "Left",
    center: "Center",
    right: "Right",
    justify: "Justify",
    rowHeight: "Row height",
    columnWidth: "Column width",
    sizeHint:
      "Sizes apply to selected rows and columns. Rows expand to fit text.",
  },
};

const selectedRanges = new WeakMap<
  AppClassProperties,
  Map<string, TableRange>
>();

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

const TableEditor = ({
  app,
  appState,
  root,
  renderAction,
  detailed = false,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  root: TableRoot;
  renderAction?: ActionManager["renderAction"];
  detailed?: boolean;
}) => {
  const english = getLanguage().code === "en";
  const label = labels[english ? "en" : "zh-CN"];
  const [range, setRange] = useState<TableRange>(
    () =>
      selectedRanges.get(app)?.get(root.id) ?? {
        row: 0,
        column: 0,
        endRow: 0,
        endColumn: 0,
      },
  );
  const elements = app.scene.getElementsIncludingDeleted();
  const data = readTableData(root, elements);
  const selection = {
    row: Math.min(range.row, data.rows.length - 1),
    column: Math.min(range.column, data.columns.length - 1),
    endRow: Math.min(range.endRow, data.rows.length - 1),
    endColumn: Math.min(range.endColumn, data.columns.length - 1),
  };
  const cell = getTableCellAt(data, selection.row, selection.column)!;
  const chooseRange = (next: TableRange) => {
    const ranges = selectedRanges.get(app) ?? new Map<string, TableRange>();
    ranges.set(root.id, next);
    selectedRanges.set(app, ranges);
    setRange(next);
  };
  const apply = (transform: Parameters<typeof updateTableElements>[2]) => {
    const previous = app.scene.getElementsIncludingDeleted();
    let elements = updateTableElements(
      previous,
      root,
      transform,
      app.renderEnvironment,
    );
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
        selectedElementIds: Object.fromEntries(
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
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };
  const style = useStableCallback(
    (value: Parameters<typeof styleTableCells>[2]) =>
      apply((data) => styleTableCells(data, selection, value)),
  );
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
                row >= selection.row &&
                row <= selection.endRow &&
                column >= selection.column &&
                column <= selection.endColumn;
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
                    chooseRange(
                      event.shiftKey
                        ? {
                            row: Math.min(selection.row, row),
                            column: Math.min(selection.column, column),
                            endRow: Math.max(selection.row, row),
                            endColumn: Math.max(selection.column, column),
                          }
                        : {
                            row: current.row,
                            column: current.column,
                            endRow: current.row + current.rowSpan - 1,
                            endColumn: current.column + current.columnSpan - 1,
                          },
                    )
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
                  min={24}
                  value={Math.round(data.rows[selection.row])}
                  onChange={(event) => {
                    const height = Number(event.target.value);
                    if (Number.isFinite(height) && height >= 24) {
                      apply((data) => ({
                        ...data,
                        rows: data.rows.map((value, index) =>
                          index >= selection.row && index <= selection.endRow
                            ? height
                            : value,
                        ),
                      }));
                    }
                  }}
                />
              </label>
              <label>
                {label.columnWidth}
                <input
                  type="number"
                  aria-label={label.columnWidth}
                  min={40}
                  value={Math.round(data.columns[selection.column])}
                  onChange={(event) => {
                    const width = Number(event.target.value);
                    if (Number.isFinite(width) && width >= 40) {
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
          {renderAction?.("changeStrokeWidth")}
          {renderAction?.("changeStrokeStyle")}
          {renderAction?.("changeSloppiness")}
        </>
      ) : (
        <>
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
                color={cell[key]}
                label={title}
                elements={elements}
                appState={appState}
                onChange={(color) => style({ [key]: color })}
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
              />
            </fieldset>
          ))}
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
        size="small"
        onCloseRequest={onClose}
      >
        <TableEditor
          key={root.id}
          app={app}
          appState={appState}
          root={root}
          renderAction={renderAction}
          detailed
        />
      </Dialog>
    </UIAppStateContext.Provider>
  );
};
