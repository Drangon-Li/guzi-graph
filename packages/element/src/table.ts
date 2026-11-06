import {
  colorToHex,
  FONT_FAMILY,
  TABLE_CELL_PADDING,
  getFontString,
  getLineHeight,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import { newElement, newTextElement } from "./newElement";
import { newElementWith } from "./mutateElement";
import { isTextElement } from "./typeChecks";
import { wrapText } from "./textWrapping";
import { getTextHeight } from "./textMeasurements";
import {
  layoutRichText,
  richTextFromPlainText,
  richTextToPlainText,
} from "./richText";

import type { RichTextDocument, RichTextRun } from "./richText";
import type { RenderEnvironment } from "./renderEnvironment";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
} from "./types";

export type TableCell = {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  richText?: RichTextDocument;
  backgroundColor: string;
  textColor: string;
  strokeColor: string;
  strokeWidth: number;
  strokeStyle?: ExcalidrawElement["strokeStyle"];
  fontSize: number;
  fontFamily: number;
  paragraphSpacing?: number;
  textAlign: ExcalidrawTextElement["textAlign"];
};
export type TableData = {
  version: 1;
  rows: number[];
  rowMinHeights?: number[];
  columns: number[];
  cells: TableCell[];
};
export type TableStructureOperation = {
  type: "insert" | "delete";
  axis: "row" | "column";
  index: number;
};
type TableRowResizeOperation = {
  type: "resizeRows";
  row: number;
  endRow: number;
  height: number;
};
export type TableRange = {
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
};
export type TableCellColors = Partial<
  Pick<TableCell, "backgroundColor" | "strokeColor" | "textColor">
>;
type TableMember = { row: number; column: number; role: "background" | "text" };
export type TableCellDefaults = Partial<
  Pick<
    TableCell,
    | "backgroundColor"
    | "textColor"
    | "strokeColor"
    | "strokeWidth"
    | "strokeStyle"
    | "fontSize"
    | "fontFamily"
    | "textAlign"
  >
>;
export type TableRoot = NonDeletedExcalidrawElement & {
  customData: { table: TableData };
};

const emptyCell = (
  row: number,
  column: number,
  defaults: TableCellDefaults = {},
): TableCell => ({
  row,
  column,
  rowSpan: 1,
  columnSpan: 1,
  text: "",
  backgroundColor: "#ffffff",
  textColor: "#1b1b1f",
  strokeColor: "#868e96",
  strokeWidth: 1,
  fontSize: 18,
  fontFamily: FONT_FAMILY.Helvetica,
  textAlign: "left",
  ...defaults,
});
const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);
export const TABLE_MIN_ROW_HEIGHT = 24;
export const TABLE_MIN_COLUMN_WIDTH = 40;
const getTableRowMinHeights = (data: TableData) =>
  data.rowMinHeights ?? data.rows.map(() => TABLE_MIN_ROW_HEIGHT);
export const isTableRoot = (
  element: ExcalidrawElement | null | undefined,
): element is TableRoot =>
  !!element &&
  !element.isDeleted &&
  element.type === "rectangle" &&
  element.customData?.table?.version === 1;
export const getTableMember = (
  element: ExcalidrawElement,
): TableMember | undefined => element.customData?.tableCell;
export const getTableRoot = (
  element: ExcalidrawElement | null | undefined,
  elements: readonly ExcalidrawElement[],
): TableRoot | null => {
  if (isTableRoot(element)) {
    return element;
  }
  if (!element || !getTableMember(element)) {
    return null;
  }
  // The innermost group is owned by the table; outer groups can contain other tables.
  return (
    (elements.find(
      (candidate) =>
        isTableRoot(candidate) && candidate.groupIds[0] === element.groupIds[0],
    ) as TableRoot | undefined) ?? null
  );
};
export const isTableElement = (element: ExcalidrawElement) =>
  isTableRoot(element) || !!getTableMember(element);
export const getTableCellAt = (data: TableData, row: number, column: number) =>
  data.cells.find(
    (cell) =>
      row >= cell.row &&
      row < cell.row + cell.rowSpan &&
      column >= cell.column &&
      column < cell.column + cell.columnSpan,
  );
export const createTableData = (
  rows = 3,
  columns = 3,
  defaults: TableCellDefaults = {},
): TableData => ({
  version: 1,
  rows: Array.from({ length: rows }, () => 48),
  columns: Array.from({ length: columns }, () => 144),
  cells: Array.from({ length: rows * columns }, (_, index) =>
    emptyCell(Math.floor(index / columns), index % columns, defaults),
  ),
});

const memberKey = (role: TableMember["role"], row: number, column: number) =>
  `${role}:${row}:${column}`;

/**
 * Index table members by role and cell in one pass. Keeps the first match for
 * each key, so lookups behave like the `find` scans they replace without
 * turning every cell lookup into a scan of the whole table.
 */
const indexTableMembers = (
  elements: readonly ExcalidrawElement[],
  include: (element: ExcalidrawElement, member: TableMember) => boolean,
) => {
  const index = new Map<string, ExcalidrawElement>();
  for (const element of elements) {
    const member = getTableMember(element);
    if (
      !member ||
      typeof member.row !== "number" ||
      typeof member.column !== "number" ||
      !include(element, member)
    ) {
      continue;
    }
    const key = memberKey(member.role, member.row, member.column);
    if (!index.has(key)) {
      index.set(key, element);
    }
  }
  return index;
};

const readTableDataFromMembers = (
  root: TableRoot,
  members: readonly ExcalidrawElement[],
): TableData => {
  const data = root.customData.table;
  // Labels must be text elements; a non-text "text" member is skipped like
  // the original per-cell search did.
  const index = indexTableMembers(
    members,
    (element, member) => member.role !== "text" || isTextElement(element),
  );
  const cells = data.cells.map((cell) => {
    const background = index.get(
      memberKey("background", cell.row, cell.column),
    );
    const current = background
      ? {
          ...cell,
          backgroundColor: background.backgroundColor,
          strokeColor: background.strokeColor,
          strokeWidth: background.strokeWidth,
          ...(cell.strokeStyle !== undefined ||
          background.strokeStyle !== "solid"
            ? { strokeStyle: background.strokeStyle }
            : {}),
        }
      : cell;
    const label = index.get(memberKey("text", cell.row, cell.column));
    return label && isTextElement(label)
      ? {
          ...current,
          text: label.originalText,
          richText: label.richText,
          textColor: label.strokeColor,
          fontSize: label.fontSize,
          fontFamily: label.fontFamily,
          paragraphSpacing: label.paragraphSpacing,
          textAlign: label.textAlign,
        }
      : current;
  });
  const storedHeight = sum(data.rows);
  const storedWidth = sum(data.columns);
  const rowScale = root.height / storedHeight;
  return {
    ...data,
    rows:
      rowScale === 1 ? data.rows : data.rows.map((height) => height * rowScale),
    ...(rowScale !== 1 &&
      data.rowMinHeights && {
        rowMinHeights: data.rowMinHeights.map((height) => height * rowScale),
      }),
    columns:
      storedWidth === root.width
        ? data.columns
        : data.columns.map((width) => (width * root.width) / storedWidth),
    cells,
  };
};

const isLiveMemberOf = (root: TableRoot, element: ExcalidrawElement) =>
  !element.isDeleted && element.groupIds[0] === root.groupIds[0];

export const readTableData = (
  root: TableRoot,
  elements: readonly ExcalidrawElement[],
): TableData =>
  readTableDataFromMembers(
    root,
    elements.filter((element) => isLiveMemberOf(root, element)),
  );

/**
 * Flush native label edits into persistent table data before saving or
 * structural edits. Runs on every editor change, so it allocates nothing when
 * the scene has no out-of-sync tables and groups members once for all tables.
 */
export const syncTableData = <T extends ExcalidrawElement>(
  elements: readonly T[],
): readonly T[] => {
  let next: T[] | undefined;
  let groups: Map<string | undefined, ExcalidrawElement[]> | undefined;
  for (let position = 0; position < elements.length; position++) {
    const element = elements[position];
    if (!isTableRoot(element)) {
      continue;
    }
    if (!groups) {
      groups = new Map();
      for (const candidate of elements) {
        if (candidate.isDeleted) {
          continue;
        }
        const group = groups.get(candidate.groupIds[0]);
        if (group) {
          group.push(candidate);
        } else {
          groups.set(candidate.groupIds[0], [candidate]);
        }
      }
    }
    const data = readTableDataFromMembers(
      element,
      groups.get(element.groupIds[0]) ?? [],
    );
    if (JSON.stringify(data) === JSON.stringify(element.customData.table)) {
      continue;
    }
    next ??= elements.slice();
    // This is a persistence snapshot; native cell versions already track edits.
    next[position] = {
      ...element,
      customData: { ...element.customData, table: data },
    } as T;
  }
  return next ?? elements;
};

const layoutTableCellText = (
  cell: TableCell,
  width: number,
  renderEnvironment?: RenderEnvironment,
) => {
  const lineHeight = getLineHeight(cell.fontFamily);
  if (cell.richText) {
    return layoutRichText(
      { ...cell, originalText: cell.text, lineHeight },
      width,
      renderEnvironment,
    );
  }
  const text = wrapText(
    cell.text,
    getFontString(cell),
    width,
    renderEnvironment,
  );
  return { text, height: getTextHeight(text, cell.fontSize, lineHeight) };
};

const tableChildren = (
  root: TableRoot,
  data: TableData,
  previous: readonly ExcalidrawElement[] = [],
  renderEnvironment?: RenderEnvironment,
  previousCells?: ReadonlyMap<string, TableCell>,
): NonDeletedExcalidrawElement[] => {
  const groupIds = root.groupIds;
  const center = pointFrom(root.x + root.width / 2, root.y + root.height / 2);
  const previousMembers = indexTableMembers(
    previous,
    (element) => !element.isDeleted,
  );
  return data.cells.flatMap((cell) => {
    const x = root.x + sum(data.columns.slice(0, cell.column));
    const y = root.y + sum(data.rows.slice(0, cell.row));
    const width = sum(
      data.columns.slice(cell.column, cell.column + cell.columnSpan),
    );
    const height = sum(data.rows.slice(cell.row, cell.row + cell.rowSpan));
    const position = pointRotateRads(
      pointFrom(x + width / 2, y + height / 2),
      center,
      root.angle,
    );
    const member = (role: TableMember["role"]) => ({
      tableCell: { row: cell.row, column: cell.column, role },
    });
    const previousCell = previousCells
      ? previousCells.get(`${cell.row}:${cell.column}`)
      : cell;
    const old = (role: TableMember["role"]) =>
      previousCell &&
      previousMembers.get(
        memberKey(role, previousCell.row, previousCell.column),
      );
    const oldBackground = old("background");
    const oldText = old("text");
    const background = {
      ...newElement({
        ...oldBackground,
        type: "rectangle",
        x: position[0] - width / 2,
        y: position[1] - height / 2,
        width,
        height,
        angle: root.angle,
        groupIds,
        frameId: root.frameId,
        opacity: root.opacity,
        backgroundColor: cell.backgroundColor,
        fillStyle: "solid",
        strokeColor: cell.strokeColor,
        strokeWidth: cell.strokeWidth,
        strokeStyle: cell.strokeStyle ?? "solid",
        roughness: root.roughness,
        roundness: null,
        customData: { ...oldBackground?.customData, ...member("background") },
      }),
      id: oldBackground?.id ?? randomId(),
    };
    const fontFamily = cell.fontFamily;
    const text = newTextElement({
      ...(oldText && isTextElement(oldText) ? oldText : {}),
      x,
      y,
      text: cell.text,
      fontSize: cell.fontSize,
      fontFamily,
      lineHeight: getLineHeight(fontFamily),
      textAlign: cell.textAlign,
      verticalAlign: "middle",
      containerId: background.id,
      strokeColor: cell.textColor,
      groupIds,
      frameId: root.frameId,
      opacity: root.opacity,
      customData: { ...oldText?.customData, ...member("text") },
      autoResize: false,
      renderEnvironment,
    });
    const labelWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
    const { text: wrapped, height: labelHeight } = layoutTableCellText(
      cell,
      labelWidth,
      renderEnvironment,
    );
    const label = {
      ...newElementWith(text, {
        x: position[0] - labelWidth / 2,
        y: position[1] - labelHeight / 2,
        width: labelWidth,
        height: labelHeight,
        angle: root.angle,
        text: wrapped,
        originalText: cell.text,
        richText: cell.richText,
        paragraphSpacing: cell.paragraphSpacing,
      }),
      id: oldText?.id ?? text.id,
    };
    return [
      newElementWith(background, {
        boundElements: [
          ...(oldBackground?.boundElements?.filter(
            (binding) => binding.type !== "text",
          ) ?? []),
          { type: "text", id: label.id },
        ],
      }),
      label,
    ];
  });
};

const getCellMinHeight = (
  cell: TableCell,
  columns: number[],
  renderEnvironment?: RenderEnvironment,
) => {
  const padding = TABLE_CELL_PADDING * 2;
  const width = Math.max(
    1,
    sum(columns.slice(cell.column, cell.column + cell.columnSpan)) - padding,
  );
  return layoutTableCellText(cell, width, renderEnvironment).height + padding;
};

export const getTableResizeMinScale = (
  data: TableData,
  axis: "row" | "column",
  renderEnvironment?: RenderEnvironment,
) => {
  if (axis === "column") {
    return TABLE_MIN_COLUMN_WIDTH / Math.min(...data.columns);
  }
  // Clamp the whole gesture to the first row or merged cell that runs out of room.
  return data.cells.reduce(
    (scale, cell) =>
      Math.max(
        scale,
        getCellMinHeight(cell, data.columns, renderEnvironment) /
          sum(data.rows.slice(cell.row, cell.row + cell.rowSpan)),
      ),
    TABLE_MIN_ROW_HEIGHT / Math.min(...data.rows),
  );
};

const fitTableData = (
  data: TableData,
  renderEnvironment?: RenderEnvironment,
  rowResize?: TableRowResizeOperation,
): TableData => {
  const minima = getTableRowMinHeights(data);
  const rows = rowResize
    ? data.rows.map((height, row) =>
        row >= rowResize.row && row <= rowResize.endRow ? minima[row] : height,
      )
    : [...minima];
  // Fit spans in end-row order so they share any growth in overlapping rows.
  const cells = [...data.cells].sort(
    (a, b) => a.row + a.rowSpan - (b.row + b.rowSpan),
  );
  for (const cell of cells) {
    const end = cell.row + cell.rowSpan;
    const lastRow = rowResize ? Math.min(end - 1, rowResize.endRow) : end - 1;
    if (rowResize && lastRow < Math.max(cell.row, rowResize.row)) {
      continue;
    }
    const extra =
      getCellMinHeight(cell, data.columns, renderEnvironment) -
      sum(rows.slice(cell.row, end));
    if (extra > 0) {
      rows[lastRow] += extra;
    }
  }
  return { ...data, rows };
};

export const createTableElements = (
  data: TableData,
  x: number,
  y: number,
  options: Pick<Partial<ExcalidrawElement>, "roughness" | "opacity"> = {},
  renderEnvironment?: RenderEnvironment,
): { root: TableRoot; elements: NonDeletedExcalidrawElement[] } => {
  data = fitTableData(
    { ...data, rowMinHeights: data.rowMinHeights ?? data.rows },
    renderEnvironment,
  );
  const root = newElement({
    type: "rectangle",
    x,
    y,
    width: sum(data.columns),
    height: sum(data.rows),
    strokeColor: "transparent",
    backgroundColor: "transparent",
    roughness: options.roughness ?? 0,
    opacity: options.opacity ?? 100,
    groupIds: [randomId()],
    customData: { table: data },
  }) as TableRoot;
  return {
    root,
    elements: [root, ...tableChildren(root, data, [], renderEnvironment)],
  };
};

export const updateTableElements = (
  elements: readonly ExcalidrawElement[],
  root: TableRoot,
  transform:
    | ((data: TableData) => TableData)
    | TableStructureOperation
    | TableRowResizeOperation,
  renderEnvironment?: RenderEnvironment,
): ExcalidrawElement[] => {
  const previousData = readTableData(root, elements);
  let previousCells: Map<string, TableCell> | undefined;
  let rowResize: TableRowResizeOperation | undefined;
  let transformed: TableData;
  if (typeof transform === "function") {
    transformed = transform(previousData);
  } else if (transform.type === "resizeRows") {
    rowResize = transform;
    const { row, endRow, height } = transform;
    transformed = {
      ...previousData,
      rowMinHeights: getTableRowMinHeights(previousData).map((value, index) =>
        index >= row && index <= endRow ? height : value,
      ),
    };
  } else {
    const { type, axis, index } = transform;
    if (
      type === "delete" &&
      previousData[axis === "row" ? "rows" : "columns"].length <= 1
    ) {
      return [...elements];
    }
    transformed =
      type === "insert"
        ? insertTableAxis(previousData, axis, index)
        : deleteTableAxis(previousData, axis, index);
    previousCells = new Map();
    for (const cell of previousData.cells) {
      const next = transformTableCellAxis(cell, transform);
      if (next) {
        previousCells.set(`${next.row}:${next.column}`, cell);
      }
    }
  }
  const data = fitTableData(transformed, renderEnvironment, rowResize);
  const nextRoot = newElementWith(root, {
    width: sum(data.columns),
    height: sum(data.rows),
    customData: { ...root.customData, table: data },
  }) as TableRoot;
  const children = elements.filter(
    (element) =>
      getTableMember(element) && element.groupIds[0] === root.groupIds[0],
  );
  const generated = tableChildren(
    nextRoot,
    data,
    children,
    renderEnvironment,
    previousCells,
  );
  const byId = new Map(generated.map((element) => [element.id, element]));
  const childSet = new Set(children);
  const result = elements.map((element) => {
    if (element.id === root.id) {
      return nextRoot;
    }
    if (!childSet.has(element)) {
      return element;
    }
    const replacement = byId.get(element.id);
    byId.delete(element.id);
    if (!replacement) {
      return element.isDeleted
        ? element
        : newElementWith(element, {
            isDeleted: true,
            boundElements: null,
            ...(isTextElement(element) ? { containerId: null } : {}),
          });
    }
    const { version, versionNonce, updated, ...updates } = replacement;
    return newElementWith(element, updates);
  });
  return [...result, ...byId.values()];
};

export const tableCellIntersectsRange = (cell: TableCell, range: TableRange) =>
  cell.row <= range.endRow &&
  cell.row + cell.rowSpan > range.row &&
  cell.column <= range.endColumn &&
  cell.column + cell.columnSpan > range.column;
export const canMergeTableCells = (data: TableData, range: TableRange) =>
  data.cells
    .filter((cell) => tableCellIntersectsRange(cell, range))
    .every(
      (cell) =>
        cell.row >= range.row &&
        cell.column >= range.column &&
        cell.row + cell.rowSpan <= range.endRow + 1 &&
        cell.column + cell.columnSpan <= range.endColumn + 1,
    );
export const mergeTableCells = (
  data: TableData,
  range: TableRange,
): TableData => {
  if (!canMergeTableCells(data, range)) {
    return data;
  }
  const selected = data.cells
    .filter((cell) => tableCellIntersectsRange(cell, range))
    .sort((a, b) => a.row - b.row || a.column - b.column);
  if (!selected.length) {
    return data;
  }
  const nonempty = selected.filter((cell) => cell.text.length);
  const merged: TableCell = {
    ...selected[0],
    row: range.row,
    column: range.column,
    rowSpan: range.endRow - range.row + 1,
    columnSpan: range.endColumn - range.column + 1,
    text: nonempty.map((cell) => cell.text).join("\n"),
    richText: {
      version: 1,
      paragraphs: nonempty.flatMap(
        (cell) =>
          (cell.richText ?? richTextFromPlainText(cell.text)).paragraphs,
      ),
    },
  };
  return {
    ...data,
    cells: [...data.cells.filter((cell) => !selected.includes(cell)), merged],
  };
};
export const splitTableCells = (
  data: TableData,
  range: TableRange,
): TableData => ({
  ...data,
  cells: data.cells.flatMap((cell) => {
    if (
      !tableCellIntersectsRange(cell, range) ||
      (cell.rowSpan === 1 && cell.columnSpan === 1)
    ) {
      return [cell];
    }
    return Array.from(
      { length: cell.rowSpan * cell.columnSpan },
      (_, index) => ({
        ...cell,
        row: cell.row + Math.floor(index / cell.columnSpan),
        column: cell.column + (index % cell.columnSpan),
        rowSpan: 1,
        columnSpan: 1,
        ...(index > 0 ? { text: "", richText: undefined } : {}),
      }),
    );
  }),
});
export const styleTableCells = (
  data: TableData,
  range: TableRange | null,
  style: Partial<
    Pick<
      TableCell,
      | "backgroundColor"
      | "strokeColor"
      | "strokeWidth"
      | "textColor"
      | "fontSize"
      | "fontFamily"
      | "strokeStyle"
      | "textAlign"
    >
  >,
): TableData => ({
  ...data,
  cells: data.cells.map((cell) =>
    !range || tableCellIntersectsRange(cell, range)
      ? {
          ...cell,
          ...style,
          ...(style.textColor !== undefined &&
            cell.richText?.paragraphs.some((paragraph) =>
              paragraph.runs.some((run) => run.color !== undefined),
            ) && {
              richText: {
                ...cell.richText,
                paragraphs: cell.richText.paragraphs.map((paragraph) => ({
                  ...paragraph,
                  runs: paragraph.runs.map(({ color, ...run }) => run),
                })),
              },
            }),
        }
      : cell,
  ),
});

export const updateTableColors = (
  elements: readonly ExcalidrawElement[],
  root: TableRoot,
  range: TableRange | null,
  style: TableCellColors,
): readonly ExcalidrawElement[] => {
  const previous = readTableData(root, elements);
  const { cells } = styleTableCells(previous, range, style);
  const changed = new Map<string, TableCell>();
  for (const [index, cell] of cells.entries()) {
    const old = previous.cells[index];
    if (
      cell.backgroundColor !== old.backgroundColor ||
      cell.strokeColor !== old.strokeColor ||
      cell.textColor !== old.textColor ||
      cell.richText !== old.richText
    ) {
      changed.set(`${cell.row}:${cell.column}`, cell);
    }
  }
  if (!changed.size) {
    return elements;
  }
  return elements.map((element) => {
    if (element.id === root.id) {
      return newElementWith(root, {
        customData: {
          ...root.customData,
          table: { ...root.customData.table, cells },
        },
      });
    }
    if (!isLiveMemberOf(root, element)) {
      return element;
    }
    const member = getTableMember(element);
    const cell = member && changed.get(`${member.row}:${member.column}`);
    if (!cell) {
      return element;
    }
    if (member.role === "background") {
      return newElementWith(element, {
        backgroundColor: cell.backgroundColor,
        strokeColor: cell.strokeColor,
      });
    }
    return isTextElement(element)
      ? newElementWith(element, {
          strokeColor: cell.textColor,
          richText: cell.richText,
        })
      : element;
  });
};

const transformTableCellAxis = (
  cell: TableCell,
  { type, axis, index }: TableStructureOperation,
): TableCell | null => {
  const span = axis === "row" ? "rowSpan" : "columnSpan";
  if (type === "insert") {
    return cell[axis] >= index
      ? { ...cell, [axis]: cell[axis] + 1 }
      : cell[axis] + cell[span] > index
      ? { ...cell, [span]: cell[span] + 1 }
      : cell;
  }
  if (cell[axis] > index) {
    return { ...cell, [axis]: cell[axis] - 1 };
  }
  if (cell[axis] + cell[span] <= index) {
    return cell;
  }
  return cell[span] > 1 ? { ...cell, [span]: cell[span] - 1 } : null;
};

export const insertTableAxis = (
  data: TableData,
  axis: "row" | "column",
  index: number,
): TableData => {
  const sizes = axis === "row" ? "rows" : "columns";
  const adjacentIndex = Math.max(0, index - 1);
  const insertSize = (values: number[], size: number) => [
    ...values.slice(0, index),
    size,
    ...values.slice(index),
  ];
  const next = {
    ...data,
    [sizes]: insertSize(
      data[sizes],
      data[sizes][adjacentIndex] ?? (axis === "row" ? 48 : 144),
    ),
    ...(axis === "row" && {
      rowMinHeights: insertSize(
        getTableRowMinHeights(data),
        data.rowMinHeights?.[adjacentIndex] ?? 48,
      ),
    }),
    cells: data.cells.map(
      (cell) => transformTableCellAxis(cell, { type: "insert", axis, index })!,
    ),
  };
  for (
    let other = 0;
    other < (axis === "row" ? next.columns.length : next.rows.length);
    other++
  ) {
    const row = axis === "row" ? index : other;
    const column = axis === "column" ? index : other;
    if (!getTableCellAt(next, row, column)) {
      const adjacent = getTableCellAt(
        data,
        axis === "row" ? adjacentIndex : row,
        axis === "column" ? adjacentIndex : column,
      );
      const {
        text,
        richText,
        row: previousRow,
        column: previousColumn,
        rowSpan,
        columnSpan,
        ...style
      } = adjacent ?? emptyCell(row, column);
      next.cells.push(emptyCell(row, column, style));
    }
  }
  return next;
};
export const deleteTableAxis = (
  data: TableData,
  axis: "row" | "column",
  index: number,
): TableData => {
  const sizes = axis === "row" ? "rows" : "columns";
  if (data[sizes].length <= 1) {
    return data;
  }
  return {
    ...data,
    [sizes]: data[sizes].filter((_, position) => position !== index),
    ...(axis === "row" &&
      data.rowMinHeights && {
        rowMinHeights: data.rowMinHeights.filter(
          (_, position) => position !== index,
        ),
      }),
    cells: data.cells.flatMap((cell) => {
      const next = transformTableCellAxis(cell, {
        type: "delete",
        axis,
        index,
      });
      return next ? [next] : [];
    }),
  };
};

export const tableDataFromTSV = (
  text: string,
  defaults: TableCellDefaults = {},
): TableData | null => {
  if (!text.includes("\t")) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [[]];
  let value = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === '"' && (quoted || !value)) {
      if (quoted && normalized[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === "\t" || character === "\n")) {
      rows[rows.length - 1].push(value);
      value = "";
      if (character === "\n") {
        rows.push([]);
      }
    } else {
      value += character;
    }
  }
  rows[rows.length - 1].push(value);
  const data = createTableData(
    rows.length,
    Math.max(...rows.map((row) => row.length)),
    defaults,
  );
  return {
    ...data,
    cells: data.cells.map((cell) => ({
      ...cell,
      text: rows[cell.row][cell.column] ?? "",
    })),
  };
};

const parseHTMLPixelSize = (value: string) =>
  parseFloat(value) * (/pt\s*$/i.test(value) ? 4 / 3 : 1);

const readHTMLRichText = (
  cell: HTMLElement,
  readStyle: (element: HTMLElement) => CSSStyleDeclaration,
  textColor: string,
): RichTextDocument => {
  const runs: RichTextRun[] = [];
  const defaultColor = colorToHex(textColor);
  const visit = (node: Node, marks: Omit<RichTextRun, "text">) => {
    if (node.nodeType === 3) {
      runs.push({ ...marks, text: node.textContent ?? "" });
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const element = node as HTMLElement;
    if (element.tagName === "BR") {
      runs.push({ text: "\n" });
      return;
    }
    const style = readStyle(element);
    const color = colorToHex(style.color);
    const next = {
      ...marks,
      ...((element.tagName === "B" ||
        element.tagName === "STRONG" ||
        /bold|[6-9]00/.test(style.fontWeight)) && { bold: true }),
      ...((element.tagName === "I" ||
        element.tagName === "EM" ||
        style.fontStyle === "italic") && { italic: true }),
      ...((element.tagName === "U" ||
        /\bunderline\b/.test(
          `${style.textDecoration} ${style.textDecorationLine}`,
        )) && { underline: true }),
      ...(style.backgroundColor && {
        background: style.backgroundColor,
      }),
    };
    if (color) {
      if (color === defaultColor) {
        delete next.color;
      } else {
        next.color = color;
      }
    }
    element.childNodes.forEach((child) => visit(child, next));
    if (/^(P|DIV)$/.test(element.tagName) && element.nextSibling) {
      runs.push({ text: "\n" });
    }
  };
  visit(cell, {});
  const paragraphs: RichTextDocument["paragraphs"] = [{ runs: [] }];
  for (const run of runs) {
    run.text.split("\n").forEach((text, index) => {
      if (index) {
        paragraphs.push({ runs: [] });
      }
      const paragraphRuns = paragraphs[paragraphs.length - 1].runs;
      const previous = paragraphRuns[paragraphRuns.length - 1];
      if (
        previous &&
        previous.bold === run.bold &&
        previous.italic === run.italic &&
        previous.underline === run.underline &&
        previous.background === run.background &&
        previous.color === run.color
      ) {
        previous.text += text;
      } else {
        paragraphRuns.push({ ...run, text });
      }
    });
  }
  return { version: 1, paragraphs };
};
export const tableDataFromHTML = (
  html: string,
  ownerDocument: Document,
  defaults: TableCellDefaults = {},
): TableData | null => {
  const document = ownerDocument.implementation.createHTMLDocument("");
  document.body.innerHTML = html;
  const table = document.querySelector("table");
  if (!table) {
    return null;
  }
  const rules: { selector: string; declarations: string }[] = [];
  document.querySelectorAll("style").forEach((style) => {
    for (const rule of (style.textContent ?? "").matchAll(
      /([^{}]+)\{([^{}]*)\}/g,
    )) {
      const selector = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (selector && !selector.startsWith("@")) {
        rules.push({ selector, declarations: rule[2] });
      }
    }
  });
  const readStyle = (element: HTMLElement) => {
    const style = document.createElement("span").style;
    const ancestors: HTMLElement[] = [];
    for (
      let ancestor: HTMLElement | null = element;
      ancestor && ancestor !== table.parentElement;
      ancestor = ancestor.parentElement
    ) {
      ancestors.unshift(ancestor);
    }
    for (const ancestor of ancestors) {
      const ownStyle = document.createElement("span").style;
      for (const rule of rules) {
        try {
          if (ancestor.matches(rule.selector)) {
            ownStyle.cssText += rule.declarations;
          }
        } catch {
          /* External clipboard CSS can contain selectors unsupported by the browser. */
        }
      }
      ownStyle.cssText += ancestor.getAttribute("style") ?? "";
      if (ancestor === element) {
        style.cssText += ownStyle.cssText;
      } else {
        for (const property of [
          "font-size",
          "font-family",
          "font-weight",
          "font-style",
          "color",
          "text-align",
          "text-decoration",
          "text-decoration-line",
        ]) {
          const value = ownStyle.getPropertyValue(property);
          if (value) {
            style.setProperty(property, value);
          }
        }
      }
    }
    return style;
  };
  const cells: TableCell[] = [];
  const rowElements = Array.from(table.rows);
  let columnCount = 0;
  const columnWidths: number[] = [];
  rowElements.forEach((row, rowIndex) => {
    let column = 0;
    Array.from(row.cells).forEach((td) => {
      while (
        getTableCellAt(
          { version: 1, rows: [], columns: [], cells },
          rowIndex,
          column,
        )
      ) {
        column++;
      }
      const style = readStyle(td);
      const cellDefaults = emptyCell(rowIndex, column, defaults);
      const richText = readHTMLRichText(
        td,
        readStyle,
        style.color || cellDefaults.textColor,
      );
      const cell = {
        ...cellDefaults,
        rowSpan: Math.max(
          1,
          Math.min(td.rowSpan || 1, rowElements.length - rowIndex),
        ),
        columnSpan: Math.max(1, td.colSpan || 1),
        richText,
        text: richTextToPlainText(richText),
        ...(style.backgroundColor && {
          backgroundColor: style.backgroundColor,
        }),
        ...(style.color && { textColor: style.color }),
        ...(style.borderColor && { strokeColor: style.borderColor }),
        ...(parseHTMLPixelSize(style.borderWidth) >= 0 && {
          strokeWidth: parseHTMLPixelSize(style.borderWidth),
        }),
        ...(/^(solid|dashed|dotted)$/.test(style.borderStyle) && {
          strokeStyle: style.borderStyle as TableCell["strokeStyle"],
        }),
        ...(style.fontFamily && {
          fontFamily: /mono|courier/i.test(style.fontFamily)
            ? FONT_FAMILY.Cascadia
            : /virgil/i.test(style.fontFamily)
            ? FONT_FAMILY.Virgil
            : FONT_FAMILY.Helvetica,
        }),
        ...(parseHTMLPixelSize(style.fontSize) && {
          fontSize: parseHTMLPixelSize(style.fontSize),
        }),
        ...(/^(left|center|right|justify)$/.test(style.textAlign) && {
          textAlign: style.textAlign as TableCell["textAlign"],
        }),
      };
      const width = parseHTMLPixelSize(
        style.width || td.getAttribute("width") || "",
      );
      if (width > 0 && cell.columnSpan === 1) {
        columnWidths[column] = width;
      }
      cells.push(cell);
      column += cell.columnSpan;
      columnCount = Math.max(columnCount, column);
    });
  });
  if (!rowElements.length || !columnCount) {
    return null;
  }
  const data: TableData = {
    version: 1,
    rows: rowElements.map((row) =>
      Math.max(
        36,
        parseHTMLPixelSize(
          readStyle(row).height || row.getAttribute("height") || "",
        ) || 48,
      ),
    ),
    columns: Array.from(
      { length: columnCount },
      (_, index) => columnWidths[index] ?? 144,
    ),
    cells,
  };
  for (let row = 0; row < data.rows.length; row++) {
    for (let column = 0; column < columnCount; column++) {
      if (!getTableCellAt(data, row, column)) {
        data.cells.push(emptyCell(row, column, defaults));
      }
    }
  }
  return data;
};
