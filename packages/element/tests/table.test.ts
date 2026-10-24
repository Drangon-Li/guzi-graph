import { FONT_FAMILY } from "@excalidraw/common";

import { newElementWith } from "../src/mutateElement";
import { duplicateElements } from "../src/duplicate";
import { layoutRichText, normalizeRichText } from "../src/richText";
import {
  canMergeTableCells,
  createTableData,
  createTableElements,
  deleteTableAxis,
  getTableCellAt,
  getTableRoot,
  insertTableAxis,
  isTableRoot,
  mergeTableCells,
  readTableData,
  splitTableCells,
  styleTableCells,
  syncTableData,
  tableDataFromHTML,
  tableDataFromTSV,
  updateTableElements,
} from "../src/table";

import type { TableData, TableRoot } from "../src/table";
import type { ExcalidrawTextElement } from "../src/types";

const range = { row: 0, column: 0, endRow: 1, endColumn: 1 };
const expectCompleteGrid = (data: TableData) => {
  for (let row = 0; row < data.rows.length; row++) {
    for (let column = 0; column < data.columns.length; column++) {
      expect(
        data.cells.filter(
          (cell) =>
            row >= cell.row &&
            row < cell.row + cell.rowSpan &&
            column >= cell.column &&
            column < cell.column + cell.columnSpan,
        ),
      ).toHaveLength(1);
    }
  }
};

it("merges and splits cells using structural data and preserves rich text", () => {
  const data = createTableData();
  data.cells[0] = {
    ...data.cells[0],
    text: "Bold",
    richText: {
      version: 1,
      paragraphs: [{ runs: [{ text: "Bold", bold: true }] }],
    },
  };
  data.cells[1].text = "Second";
  const merged = mergeTableCells(data, range);
  expect(getTableCellAt(merged, 1, 1)).toMatchObject({
    rowSpan: 2,
    columnSpan: 2,
    text: "Bold\nSecond",
  });
  expect(
    getTableCellAt(merged, 1, 1)?.richText?.paragraphs[0].runs[0].bold,
  ).toBe(true);
  expectCompleteGrid(merged);
  expect(
    canMergeTableCells(merged, { row: 1, column: 1, endRow: 2, endColumn: 2 }),
  ).toBe(false);
  const split = splitTableCells(merged, range);
  expect(split.cells).toHaveLength(9);
  expectCompleteGrid(split);
});

it.each(["row", "column"] as const)(
  "inserts/deletes %s through merged cells without overlaps or missing cells",
  (axis) => {
    let data = mergeTableCells(createTableData(), range);
    data = insertTableAxis(data, axis, 1);
    expectCompleteGrid(data);
    expect(
      getTableCellAt(data, 0, 0)?.[axis === "row" ? "rowSpan" : "columnSpan"],
    ).toBe(3);
    data = deleteTableAxis(data, axis, 0);
    expectCompleteGrid(data);
    data = deleteTableAxis(data, axis, 1);
    expectCompleteGrid(data);
  },
);

it("synchronizes native label edits and resolves only the innermost table group", () => {
  const { root, elements } = createTableElements(
    createTableData(2, 2),
    100,
    100,
  );
  const text = elements.find(
    (element) => element.type === "text",
  ) as ExcalidrawTextElement;
  const changed = elements.map((element) =>
    element.id === text.id
      ? newElementWith(text, {
          text: "Edited",
          originalText: "Edited",
          richText: {
            version: 1,
            paragraphs: [{ runs: [{ text: "Edited", italic: true }] }],
          },
        })
      : element,
  );
  const synced = syncTableData(changed);
  const syncedRoot = synced.find(isTableRoot)!;
  expect(syncedRoot.customData.table.cells[0].text).toBe("Edited");
  expect(
    syncedRoot.customData.table.cells[0].richText?.paragraphs[0].runs[0].italic,
  ).toBe(true);
  expect(syncTableData(synced)).toBe(synced);
  const unrelated = createTableElements(createTableData(1, 1), 0, 0);
  const nested = [...synced, ...unrelated.elements].map((element) =>
    newElementWith(element, { groupIds: [...element.groupIds, "outer"] }),
  );
  expect(
    getTableRoot(
      nested.find((element) => element.id === text.id),
      nested,
    )?.id,
  ).toBe(root.id);
});

it("keeps child ids and bindings coherent through operations, serialization and copy", () => {
  const initial = createTableElements(createTableData(2, 2), 100, 100);
  const edited = updateTableElements(initial.elements, initial.root, (data) =>
    mergeTableCells(data, range),
  );
  const live = edited.filter((element) => !element.isDeleted);
  expect(live).toHaveLength(3);
  const background = live.find(
    (element) => element.customData?.tableCell?.role === "background",
  )!;
  const text = live.find(
    (element) => element.type === "text",
  ) as ExcalidrawTextElement;
  expect(text.containerId).toBe(background.id);
  expect(background.boundElements?.[0].id).toBe(text.id);
  const saved = JSON.parse(JSON.stringify(live));
  expect(readTableData(saved[0] as TableRoot, saved).cells[0].columnSpan).toBe(
    2,
  );
  // Native duplicate remaps group and binding ids; table metadata contains no element ids.
  const { duplicatedElements: copies } = duplicateElements({
    type: "everything",
    elements: live,
    randomizeSeed: false,
  });
  const copyRoot = copies.find(isTableRoot)!;
  const copyText = copies.find((element) => element.type === "text")!;
  expect(copyRoot.id).not.toBe(initial.root.id);
  expect(getTableRoot(copyText, [...live, ...copies])?.id).toBe(copyRoot.id);
});

it("imports HTML merged cells, inline format and TSV as editable table data", () => {
  const data = tableDataFromHTML(
    '<table><tr><td rowspan="2" style="background-color:#ff0000;width:120px"><strong>A</strong></td><td>B</td></tr><tr><td><em>C</em></td></tr></table>',
    document,
  )!;
  expect(data.columns[0]).toBe(120);
  expect(getTableCellAt(data, 1, 0)?.rowSpan).toBe(2);
  expect(data.cells[0].richText?.paragraphs[0].runs[0].bold).toBe(true);
  expect(data.cells[0].backgroundColor).toBe("rgb(255, 0, 0)");
  expectCompleteGrid(data);
  expect(
    tableDataFromTSV("A\tB\nC\tD\n")?.cells.map((cell) => cell.text),
  ).toEqual(["A", "B", "C", "D"]);
  expect(tableDataFromHTML("<p>not a table</p>", document)).toBe(null);
});

it("preserves stylesheet formatting and quoted TSV multiline cells", () => {
  const data = tableDataFromHTML(
    '<style>.xl1{font-weight:bold;background-color:#ffeeaa;font-size:24px}.xl2{font-style:italic;text-align:center}</style><table><tr><td class="xl1">One</td><td class="xl2">Two</td></tr></table>',
    document,
  )!;
  expect(data.cells[0].fontSize).toBe(24);
  expect(data.cells[0].richText?.paragraphs[0].runs[0].bold).toBe(true);
  expect(data.cells[1].richText?.paragraphs[0].runs[0].italic).toBe(true);
  expect(data.cells[1].textAlign).toBe("center");
  expect(
    tableDataFromTSV('"line 1\nline 2"\t"A\tB"\nC\tD')?.cells.map(
      (cell) => cell.text,
    ),
  ).toEqual(["line 1\nline 2", "A\tB", "C", "D"]);
});

it("fits table row heights to wrapped text before generating native cells", () => {
  const data = createTableData(1, 1);
  data.columns[0] = 80;
  data.cells[0].text = "Multiple words that will wrap across many lines";
  const { root, elements } = createTableElements(data, 0, 0);
  const label = elements.find((element) => element.type === "text")!;
  expect(root.height).toBeGreaterThan(48);
  expect(label.height + 16).toBeLessThanOrEqual(root.height + 0.01);
});

it("uses supplied defaults and inherits neighboring cell styles when inserting axes", () => {
  const defaults = {
    fontFamily: FONT_FAMILY.Excalifont,
    fontSize: 28,
    textColor: "#123456",
    backgroundColor: "#ffffaa",
    strokeColor: "#234567",
    strokeWidth: 4,
    strokeStyle: "dotted" as const,
    textAlign: "center" as const,
  };
  const initial = createTableData(2, 2, defaults);
  initial.cells[0].text = "Keep original";
  const inserted = insertTableAxis(
    insertTableAxis(initial, "row", 1),
    "column",
    1,
  );
  expect(getTableCellAt(inserted, 1, 0)).toMatchObject({
    ...defaults,
    text: "",
  });
  expect(getTableCellAt(inserted, 0, 1)).toMatchObject({
    ...defaults,
    text: "",
  });
  const { root, elements } = createTableElements(inserted, 0, 0, {
    roughness: 2,
  });
  expect(root.roughness).toBe(2);
  expect(
    elements.find(
      (element) => element.customData?.tableCell?.role === "background",
    ),
  ).toMatchObject({ roughness: 2, strokeStyle: "dotted", strokeWidth: 4 });
  expectCompleteGrid(inserted);
});

it("keeps native border and font edits across structure regeneration", () => {
  const initial = createTableElements(createTableData(2, 2), 0, 0);
  const edited = initial.elements.map((element) =>
    element.type === "text"
      ? newElementWith(element, {
          fontFamily: FONT_FAMILY.Excalifont,
          fontSize: 28,
        })
      : newElementWith(element, {
          roughness: 2,
          strokeStyle: "dashed",
          strokeColor: "#445566",
          backgroundColor: "#ffccaa",
          strokeWidth: 4,
        }),
  );
  const regenerated = updateTableElements(
    edited,
    edited.find(isTableRoot)!,
    (data) => insertTableAxis(data, "row", 1),
  );
  const root = regenerated.find(isTableRoot)!;
  const cell = root.customData.table.cells.find((cell) => cell.row === 1)!;
  expect(cell).toMatchObject({
    fontFamily: FONT_FAMILY.Excalifont,
    fontSize: 28,
    strokeStyle: "dashed",
    strokeColor: "#445566",
    backgroundColor: "#ffccaa",
    strokeWidth: 4,
  });
  expect(
    regenerated
      .filter(
        (element) =>
          !element.isDeleted &&
          element.customData?.tableCell?.role === "background",
      )
      .every((element) => element.roughness === 2),
  ).toBe(true);
});

it("preserves explicit HTML styles while using canvas defaults for unstyled cells and TSV", () => {
  const defaults = {
    fontFamily: FONT_FAMILY.Excalifont,
    fontSize: 28,
    strokeColor: "#445566",
    strokeWidth: 4,
    strokeStyle: "dashed" as const,
  };
  const data = tableDataFromHTML(
    '<table><tr><td>Default</td><td style="font-family:Helvetica;font-size:16px;border:2px dotted red">Explicit</td></tr></table>',
    document,
    defaults,
  )!;
  expect(data.cells[0]).toMatchObject(defaults);
  expect(data.cells[1]).toMatchObject({
    fontFamily: FONT_FAMILY.Helvetica,
    fontSize: 16,
    strokeColor: "red",
    strokeWidth: 2,
    strokeStyle: "dotted",
  });
  expect(tableDataFromTSV("A\tB", defaults)?.cells[1]).toMatchObject(defaults);
});

it("preserves cell arrow bindings when regenerating table elements", () => {
  const table = createTableElements(createTableData(1, 1), 0, 0);
  const background = table.elements.find(
    (element) => element.customData?.tableCell?.role === "background",
  )!;
  const arrowBinding = { id: "bound-arrow", type: "arrow" as const };
  const edited = table.elements.map((element) =>
    element.id === background.id
      ? newElementWith(element, {
          boundElements: [...(element.boundElements ?? []), arrowBinding],
        })
      : element,
  );
  const regenerated = updateTableElements(edited, table.root, (data) => data);
  expect(
    regenerated.find((element) => element.id === background.id)?.boundElements,
  ).toEqual([arrowBinding, ...background.boundElements!]);
});

it("converts Office HTML point dimensions into CSS pixels", () => {
  const data = tableDataFromHTML(
    '<table><tr style="height:45pt"><td style="font-size:18pt;width:72pt;border:1.5pt solid red">Office</td><td style="font-size:16px;width:120px">Pixels</td></tr></table>',
    document,
  )!;
  expect(data.cells[0].fontSize).toBe(24);
  expect(data.cells[0].strokeWidth).toBe(2);
  expect(data.rows).toEqual([60]);
  expect(data.columns).toEqual([96, 120]);
  expect(data.cells[1].fontSize).toBe(16);
});

it("overrides inline colors only when changing a selected cell's text color", () => {
  const data = createTableData(1, 2);
  data.cells = data.cells.map((cell) => ({
    ...cell,
    text: "Red",
    richText: {
      version: 1,
      paragraphs: [{ runs: [{ text: "Red", color: "#ff0000", bold: true }] }],
    },
  }));
  const selection = { row: 0, column: 0, endRow: 0, endColumn: 0 };
  const filled = styleTableCells(data, selection, {
    backgroundColor: "#ffff00",
  });
  expect(filled.cells[0].richText).toEqual(data.cells[0].richText);
  const recolored = styleTableCells(filled, selection, {
    textColor: "#0000ff",
  });
  expect(recolored.cells[0].richText?.paragraphs[0].runs).toEqual([
    { text: "Red", bold: true },
  ]);
  expect(recolored.cells[1]).toBe(data.cells[1]);
  const table = createTableElements(recolored, 0, 0);
  const label = table.elements.find(
    (element) => element.type === "text",
  ) as ExcalidrawTextElement;
  expect(
    layoutRichText(label).lines[0].runs.map(
      (run) => run.color ?? label.strokeColor,
    ),
  ).toEqual(["#0000ff"]);
});

it("imports effective HTML inline colors and coalesces identically styled runs", () => {
  const data = tableDataFromHTML(
    '<table style="color:green"><tr><td>Base<span style="color:red">Red</span><span style="color:#ff0000"> again<i> italic</i></span><span style="color:blue">Blue</span><span style="color:green">Base again</span></td></tr></table>',
    document,
  )!;
  const richText = data.cells[0].richText!;
  expect(data.cells[0].textColor).toBe("green");
  expect(richText.paragraphs[0].runs).toEqual([
    { text: "Base" },
    { text: "Red again", color: "#ff0000" },
    { text: " italic", color: "#ff0000", italic: true },
    { text: "Blue", color: "#0000ff" },
    { text: "Base again" },
  ]);
  expect(normalizeRichText(richText)).toEqual(richText);
});

it("keeps unstyled HTML text on cell defaults and inherits nested inline colors", () => {
  const data = tableDataFromHTML(
    '<table><tr><td>Plain<span> inherited</span><span style="color:#123456"> same</span></td><td><span style="color:red">Red<span style="color:inherit"> inherited</span></span> tail</td></tr></table>',
    document,
    { textColor: "#123456" },
  )!;
  expect(data.cells[0].richText?.paragraphs[0].runs).toEqual([
    { text: "Plain inherited same" },
  ]);
  expect(data.cells[1].richText?.paragraphs[0].runs).toEqual([
    { text: "Red inherited", color: "#ff0000" },
    { text: " tail" },
  ]);
});
