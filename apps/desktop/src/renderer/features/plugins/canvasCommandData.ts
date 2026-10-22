import { FONT_FAMILY, randomId } from "@excalidraw/common";
import {
  normalizeRichTextBackground,
  richTextToPlainText,
} from "@excalidraw/element/richText";
import { createTableData, getTableCellAt } from "@excalidraw/element/table";

import type { RichTextDocument } from "@excalidraw/element/richText";
import type {
  TableCell,
  TableData,
  TableRange,
} from "@excalidraw/element/table";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

type Invalid = (message: string) => never;
export const onlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  invalid: Invalid,
) => {
  const key = Object.keys(value).find((key) => !allowed.includes(key));
  if (key) {
    invalid(`Unexpected field: ${key}.`);
  }
};
export const record = (
  value: unknown,
  invalid: Invalid,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected an object.");
  }
  return value as Record<string, unknown>;
};
export const finite = (
  value: unknown,
  name: string,
  min: number,
  max: number,
  invalid: Invalid,
  integer = false,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    return invalid(
      `${name} must be ${
        integer ? "an integer" : "a number"
      } between ${min} and ${max}.`,
    );
  }
  return value;
};
export const richTextArgument = (
  value: unknown,
  invalid: Invalid,
): RichTextDocument => {
  const document = record(value, invalid);
  onlyKeys(document, ["version", "paragraphs"], invalid);
  if (
    document.version !== 1 ||
    !Array.isArray(document.paragraphs) ||
    !document.paragraphs.length ||
    document.paragraphs.length > 1000
  ) {
    return invalid("richText requires version 1 and 1–1000 paragraphs.");
  }
  let length = 0;
  let runCount = 0;
  const paragraphs = document.paragraphs.map((value) => {
    const paragraph = record(value, invalid);
    onlyKeys(paragraph, ["runs", "list"], invalid);
    if (!Array.isArray(paragraph.runs) || paragraph.runs.length > 1000) {
      return invalid("A rich text paragraph requires at most 1000 runs.");
    }
    const runs = paragraph.runs.map((value) => {
      const run = record(value, invalid);
      onlyKeys(
        run,
        ["text", "bold", "italic", "underline", "background"],
        invalid,
      );
      if (typeof run.text !== "string") {
        return invalid("A rich text run requires text.");
      }
      length += run.text.length;
      runCount++;
      for (const mark of ["bold", "italic", "underline"] as const) {
        if (run[mark] !== undefined && typeof run[mark] !== "boolean") {
          invalid(`${mark} must be boolean.`);
        }
      }
      if (
        run.background !== undefined &&
        !normalizeRichTextBackground(run.background)
      ) {
        invalid("Invalid rich text background color.");
      }
      return {
        ...run,
      } as RichTextDocument["paragraphs"][number]["runs"][number];
    });
    let list: RichTextDocument["paragraphs"][number]["list"];
    if (paragraph.list !== undefined) {
      const item = record(paragraph.list, invalid);
      onlyKeys(item, ["kind", "indent"], invalid);
      if (item.kind !== "ordered" && item.kind !== "bullet") {
        invalid("Invalid rich text list kind.");
      }
      list = {
        kind: item.kind as "ordered" | "bullet",
        indent: finite(item.indent, "list.indent", 0, 8, invalid, true),
      };
    }
    return { runs, ...(list ? { list } : {}) };
  });
  if (length > 100000 || runCount > 10000) {
    invalid("richText exceeds the text or run limit.");
  }
  return { version: 1, paragraphs };
};
export const normalizeTextFields = (
  fields: Record<string, unknown>,
  invalid: Invalid,
  patch = false,
) => {
  if (fields.richText !== undefined) {
    if (fields.richText === null && patch) {
      fields.richText = undefined;
    } else {
      const document = richTextArgument(fields.richText, invalid);
      const text = richTextToPlainText(document);
      if (fields.text !== undefined && fields.text !== text) {
        invalid("text must match the plain text of richText.");
      }
      fields.richText = document;
      fields.text = text;
    }
  } else if (patch && fields.text !== undefined) {
    fields.richText = undefined;
  }
};

export const tableAxisArgument = (
  value: unknown,
  invalid: Invalid,
): number[] => {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    return invalid("Table rows and columns require 1–100 sizes.");
  }
  return value.map((size) => finite(size, "Table size", 1, 100000, invalid));
};
const cellFields = [
  "row",
  "column",
  "text",
  "richText",
  "backgroundColor",
  "textColor",
  "strokeColor",
  "strokeWidth",
  "strokeStyle",
  "fontSize",
  "fontFamily",
  "paragraphSpacing",
  "textAlign",
];
export const updateTableData = (
  data: TableData,
  updates: Record<string, unknown>,
  invalid: Invalid,
): TableData => {
  const rows =
    updates.rows === undefined
      ? data.rows
      : tableAxisArgument(updates.rows, invalid);
  const columns =
    updates.columns === undefined
      ? data.columns
      : tableAxisArgument(updates.columns, invalid);
  if (
    rows.length !== data.rows.length ||
    columns.length !== data.columns.length
  ) {
    invalid("Table resize must preserve row and column counts.");
  }
  let next = {
    ...data,
    rows,
    columns,
    cells: data.cells.map((cell) => ({ ...cell })),
  };
  if (updates.cells !== undefined) {
    if (!Array.isArray(updates.cells) || updates.cells.length > 2500) {
      invalid("cells must be an array of at most 2500 updates.");
    }
    const visited = new Set<string>();
    for (const value of updates.cells as unknown[]) {
      const cell = { ...record(value, invalid) };
      onlyKeys(cell, cellFields, invalid);
      const row = finite(cell.row, "row", 0, rows.length - 1, invalid, true);
      const column = finite(
        cell.column,
        "column",
        0,
        columns.length - 1,
        invalid,
        true,
      );
      const target = getTableCellAt(next, row, column)!;
      if (target.row !== row || target.column !== column) {
        invalid("Update merged cells through their top-left coordinate.");
      }
      const key = `${row}:${column}`;
      if (visited.has(key)) {
        invalid("A table cell may be updated only once per operation.");
      }
      visited.add(key);
      normalizeTextFields(cell, invalid, true);
      for (const [key, value] of Object.entries(cell)) {
        if (["row", "column", "richText"].includes(key)) {
          continue;
        }
        if (
          [
            "fontSize",
            "fontFamily",
            "strokeWidth",
            "paragraphSpacing",
          ].includes(key)
        ) {
          finite(
            value,
            key,
            key === "fontSize" || key === "fontFamily" ? 1 : 0,
            key === "fontSize"
              ? 512
              : key === "paragraphSpacing"
              ? 1000
              : 10000000,
            invalid,
          );
        } else if (key === "textAlign") {
          if (!["left", "center", "right"].includes(String(value))) {
            invalid("Invalid table textAlign.");
          }
        } else if (key === "strokeStyle") {
          if (!["solid", "dashed", "dotted"].includes(String(value))) {
            invalid("Invalid table strokeStyle.");
          }
        } else if (
          typeof value !== "string" ||
          value.length > (key === "text" ? 100000 : 4096)
        ) {
          invalid(`Invalid table ${key}.`);
        }
      }
      next = {
        ...next,
        cells: next.cells.map((item) =>
          item === target ? ({ ...item, ...cell } as TableCell) : item,
        ),
      };
    }
  }
  if (
    next.cells.reduce((length, cell) => length + cell.text.length, 0) > 1000000
  ) {
    invalid("Table text cannot exceed 1000000 characters.");
  }
  return next;
};
export const createTableDataArgument = (
  value: Record<string, unknown>,
  invalid: Invalid,
) => {
  const rows = tableAxisArgument(value.rows, invalid);
  const columns = tableAxisArgument(value.columns, invalid);
  if (rows.length * columns.length > 2500) {
    invalid("A table may contain at most 2500 cells.");
  }
  return updateTableData(
    {
      ...createTableData(rows.length, columns.length, {
        fontFamily: FONT_FAMILY.Excalifont,
        strokeWidth: 2,
        ...Object.fromEntries(
          ["backgroundColor", "strokeColor", "strokeWidth", "strokeStyle"]
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, value[key]]),
        ),
      }),
      rows,
      columns,
    },
    value,
    invalid,
  );
};
export const tableRangeArgument = (
  value: unknown,
  data: TableData,
  invalid: Invalid,
): TableRange => {
  const range = record(value, invalid);
  onlyKeys(range, ["row", "column", "endRow", "endColumn"], invalid);
  const row = finite(range.row, "row", 0, data.rows.length - 1, invalid, true);
  const column = finite(
    range.column,
    "column",
    0,
    data.columns.length - 1,
    invalid,
    true,
  );
  return {
    row,
    column,
    endRow: finite(
      range.endRow,
      "endRow",
      row,
      data.rows.length - 1,
      invalid,
      true,
    ),
    endColumn: finite(
      range.endColumn,
      "endColumn",
      column,
      data.columns.length - 1,
      invalid,
      true,
    ),
  };
};
export const imageFileArgument = (
  value: unknown,
  files: BinaryFiles,
  invalid: Invalid,
): BinaryFileData => {
  const file = record(value, invalid);
  onlyKeys(file, ["mimeType", "dataURL"], invalid);
  if (
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      String(file.mimeType),
    )
  ) {
    return invalid("Images require PNG, JPEG, GIF, or WebP data.");
  }
  if (
    typeof file.dataURL !== "string" ||
    file.dataURL.length > 1024 * 1024 ||
    !file.dataURL.startsWith(`data:${file.mimeType};base64,`) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(file.dataURL.split(",")[1] ?? "")
  ) {
    return invalid(
      "Images require a base64 data URL of at most 1 MiB matching mimeType.",
    );
  }
  const existing = Object.values(files).find(
    (item) => item.dataURL === file.dataURL && item.mimeType === file.mimeType,
  );
  return (
    existing ??
    ({
      id: randomId(),
      dataURL: file.dataURL,
      mimeType: file.mimeType,
      created: Date.now(),
    } as BinaryFileData)
  );
};
