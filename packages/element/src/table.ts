import {
  colorToHex,
  FONT_FAMILY,
  getFontString,
  getLineHeight,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import { newElement, newTextElement } from "./newElement";
import { newElementWith } from "./mutateElement";
import { isTextElement } from "./typeChecks";
import { wrapText } from "./textWrapping";
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
  columns: number[];
  cells: TableCell[];
};
export type TableRange = {
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
};
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

export const readTableData = (
  root: TableRoot,
  elements: readonly ExcalidrawElement[],
): TableData => {
  const data = root.customData.table;
  const members = elements.filter(
    (element) => !element.isDeleted && element.groupIds[0] === root.groupIds[0],
  );
  const cells = data.cells.map((cell) => {
    const background = members.find((element) => {
      const member = getTableMember(element);
      return (
        member?.role === "background" &&
        member.row === cell.row &&
        member.column === cell.column
      );
    });
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
    const label = members.find((element) => {
      const member = getTableMember(element);
      return (
        isTextElement(element) &&
        member?.role === "text" &&
        member.row === cell.row &&
        member.column === cell.column
      );
    });
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
  return {
    ...data,
    rows: data.rows.map((height) => (height * root.height) / sum(data.rows)),
    columns: data.columns.map(
      (width) => (width * root.width) / sum(data.columns),
    ),
    cells,
  };
};

/** Flush native label edits into persistent table data before saving or structural edits. */
export const syncTableData = <T extends ExcalidrawElement>(
  elements: readonly T[],
): readonly T[] => {
  let changed = false;
  const next = elements.map((element) => {
    if (!isTableRoot(element)) {
      return element;
    }
    const data = readTableData(element, elements);
    if (JSON.stringify(data) === JSON.stringify(element.customData.table)) {
      return element;
    }
    changed = true;
    // This is a persistence snapshot; native cell versions already track edits.
    return {
      ...element,
      customData: { ...element.customData, table: data },
    } as T;
  });
  return changed ? next : elements;
};

const tableChildren = (
  root: TableRoot,
  data: TableData,
  previous: readonly ExcalidrawElement[] = [],
  renderEnvironment?: RenderEnvironment,
): NonDeletedExcalidrawElement[] => {
  const groupIds = root.groupIds;
  const center = pointFrom(root.x + root.width / 2, root.y + root.height / 2);
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
    const old = (role: TableMember["role"]) =>
      previous.find((element) => {
        const info = getTableMember(element);
        return (
          !element.isDeleted &&
          info?.role === role &&
          info.row === cell.row &&
          info.column === cell.column
        );
      });
    const background = {
      ...newElement({
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
        customData: member("background"),
      }),
      id: old("background")?.id ?? randomId(),
    };
    const fontFamily = cell.fontFamily;
    const text = newTextElement({
      x,
      y,
      text: cell.text,
      fontSize: cell.fontSize,
      fontFamily,
      textAlign: cell.textAlign,
      verticalAlign: "middle",
      containerId: background.id,
      strokeColor: cell.textColor,
      groupIds,
      frameId: root.frameId,
      opacity: root.opacity,
      customData: member("text"),
      autoResize: false,
      renderEnvironment,
    });
    const labelWidth = Math.max(1, width - 16);
    const wrapped = wrapText(
      cell.text,
      getFontString(text),
      labelWidth,
      renderEnvironment,
    );
    const richLayout = cell.richText
      ? layoutRichText(
          {
            ...text,
            richText: cell.richText,
            paragraphSpacing: cell.paragraphSpacing,
          },
          labelWidth,
          renderEnvironment,
        )
      : null;
    const labelHeight =
      richLayout?.height ??
      wrapped.split("\n").length * text.fontSize * text.lineHeight;
    const label = {
      ...newElementWith(text, {
        x: position[0] - labelWidth / 2,
        y: position[1] - labelHeight / 2,
        width: labelWidth,
        height: labelHeight,
        angle: root.angle,
        text: richLayout?.text ?? wrapped,
        originalText: cell.text,
        richText: cell.richText,
        paragraphSpacing: cell.paragraphSpacing,
      }),
      id: old("text")?.id ?? text.id,
    };
    return [
      newElementWith(background, {
        boundElements: [
          ...(old("background")?.boundElements?.filter(
            (binding) => binding.type !== "text",
          ) ?? []),
          { type: "text", id: label.id },
        ],
      }),
      label,
    ];
  });
};

const fitTableData = (
  data: TableData,
  renderEnvironment?: RenderEnvironment,
): TableData => {
  const rows = [...data.rows];
  for (const cell of data.cells) {
    const width = Math.max(
      1,
      sum(data.columns.slice(cell.column, cell.column + cell.columnSpan)) - 16,
    );
    const lineHeight = getLineHeight(cell.fontFamily);
    const contentHeight = cell.richText
      ? layoutRichText(
          {
            fontSize: cell.fontSize,
            fontFamily: cell.fontFamily,
            lineHeight,
            textAlign: cell.textAlign,
            originalText: cell.text,
            richText: cell.richText,
            paragraphSpacing: cell.paragraphSpacing,
          },
          width,
          renderEnvironment,
        ).height
      : wrapText(
          cell.text,
          getFontString({
            fontSize: cell.fontSize,
            fontFamily: cell.fontFamily,
          }),
          width,
          renderEnvironment,
        ).split("\n").length *
        cell.fontSize *
        lineHeight;
    const extra =
      contentHeight + 16 - sum(rows.slice(cell.row, cell.row + cell.rowSpan));
    if (extra > 0) {
      rows[cell.row + cell.rowSpan - 1] += extra;
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
  data = fitTableData(data, renderEnvironment);
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
  transform: (data: TableData) => TableData,
  renderEnvironment?: RenderEnvironment,
): ExcalidrawElement[] => {
  const data = fitTableData(
    transform(readTableData(root, elements)),
    renderEnvironment,
  );
  const nextRoot = newElementWith(root, {
    width: sum(data.columns),
    height: sum(data.rows),
    customData: { ...root.customData, table: data },
  }) as TableRoot;
  const children = elements.filter(
    (element) =>
      getTableMember(element) && element.groupIds[0] === root.groupIds[0],
  );
  const generated = tableChildren(nextRoot, data, children, renderEnvironment);
  const byId = new Map(generated.map((element) => [element.id, element]));
  const result = elements.map((element) => {
    if (element.id === root.id) {
      return nextRoot;
    }
    if (!children.includes(element)) {
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

const inRange = (cell: TableCell, range: TableRange) =>
  cell.row <= range.endRow &&
  cell.row + cell.rowSpan > range.row &&
  cell.column <= range.endColumn &&
  cell.column + cell.columnSpan > range.column;
export const canMergeTableCells = (data: TableData, range: TableRange) =>
  data.cells
    .filter((cell) => inRange(cell, range))
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
    .filter((cell) => inRange(cell, range))
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
      !inRange(cell, range) ||
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
  range: TableRange,
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
    inRange(cell, range)
      ? {
          ...cell,
          ...style,
          ...(style.textColor !== undefined &&
            cell.richText && {
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

export const insertTableAxis = (
  data: TableData,
  axis: "row" | "column",
  index: number,
): TableData => {
  const span = axis === "row" ? "rowSpan" : "columnSpan";
  const sizes = axis === "row" ? "rows" : "columns";
  const next = {
    ...data,
    [sizes]: [
      ...data[sizes].slice(0, index),
      data[sizes][Math.max(0, index - 1)] ?? (axis === "row" ? 48 : 144),
      ...data[sizes].slice(index),
    ],
    cells: data.cells.map((cell) =>
      cell[axis] >= index
        ? { ...cell, [axis]: cell[axis] + 1 }
        : cell[axis] + cell[span] > index
        ? { ...cell, [span]: cell[span] + 1 }
        : cell,
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
        axis === "row" ? Math.max(0, index - 1) : row,
        axis === "column" ? Math.max(0, index - 1) : column,
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
  const span = axis === "row" ? "rowSpan" : "columnSpan";
  const sizes = axis === "row" ? "rows" : "columns";
  if (data[sizes].length <= 1) {
    return data;
  }
  return {
    ...data,
    [sizes]: data[sizes].filter((_, position) => position !== index),
    cells: data.cells.flatMap((cell) => {
      if (cell[axis] > index) {
        return [{ ...cell, [axis]: cell[axis] - 1 }];
      }
      if (cell[axis] + cell[span] <= index) {
        return [cell];
      }
      return cell[span] > 1 ? [{ ...cell, [span]: cell[span] - 1 }] : [];
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
      Math.max(36, parseHTMLPixelSize(readStyle(row).height) || 48),
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
