import { Script } from "node:vm";

import { createElement } from "react";

import {
  FONT_FAMILY,
  KEYS,
  ROUNDNESS,
  getFontString,
} from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import * as textMeasurements from "@excalidraw/element/textMeasurements";
import { exportToSvg } from "@excalidraw/excalidraw/scene/export";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { syncInvalidIndices } from "@excalidraw/element";
import { getTableMember, isTableRoot } from "@excalidraw/element/table";
import { getSubcanvasId } from "@excalidraw/excalidraw/subcanvas";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { TableRoot } from "@excalidraw/element/table";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { EXAMPLE_PLUGIN } from "../../../main/plugin-development.cjs";

import {
  CANVAS_CAPABILITIES,
  canvasExportDimensions,
  isCanvasBusy,
  loadCanvasOperationFonts,
  prepareCanvasOperations,
} from "./canvasCommands";

const state = () => ({
  ...getDefaultAppState(),
  width: 1000,
  height: 700,
  offsetTop: 0,
  offsetLeft: 0,
});
const create = (tempId: string, element: Record<string, unknown>) => ({
  type: "create",
  tempId,
  element,
});
const diagram = () =>
  prepareCanvasOperations(
    [],
    [
      create("a", {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 180,
        height: 100,
        label: { text: "First" },
      }),
      create("b", {
        type: "ellipse",
        x: 320,
        y: 0,
        width: 180,
        height: 100,
        label: { text: "Second" },
      }),
      create("link", {
        type: "arrow",
        x: 180,
        y: 50,
        width: 140,
        height: 0,
        start: { id: "a" },
        end: { id: "b" },
        label: { text: "connect" },
      }),
    ],
    state(),
  );

describe("controlled canvas operations", () => {
  it("runs the published plugin example through actual canvas operation validation", async () => {
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    let result: ReturnType<typeof prepareCanvasOperations> | undefined;
    const call = async (command: string, args: Record<string, unknown>) => {
      if (command === "list_canvases") {
        return {
          activeDocumentId: "canvas",
          canvases: [
            { documentId: "canvas", kind: "canvas", initialized: true },
          ],
        };
      }
      if (command === "read_canvas") {
        return { revision: 1 };
      }
      if (command === "apply_operations") {
        result = prepareCanvasOperations([], args.operations, state());
        return { revision: 2 };
      }
      throw new Error(`Unexpected example command: ${command}`);
    };
    await new Script(
      `(async () => {${EXAMPLE_PLUGIN.source}\n})()`,
    ).runInNewContext({
      guzi: {
        call,
        registerCommand: (_id: string, callback: typeof handler) => {
          handler = callback;
        },
      },
    });
    await handler({ text: "可运行的插件示例" });
    expect(
      result?.elements.some((element) => element.type === "stickynote"),
    ).toBe(true);
    expect(
      result?.elements.some(
        (element) =>
          element.type === "text" && element.text === "可运行的插件示例",
      ),
    ).toBe(true);
  });

  it("uses the editor's hand-drawn defaults for shapes, text, labels and inline endpoints", () => {
    const result = prepareCanvasOperations(
      [],
      [
        ...["rectangle", "ellipse", "diamond", "line"].map((type, index) =>
          create(type, {
            type,
            x: index * 200,
            y: 0,
            width: 140,
            height: 80,
            ...(type === "line" ? {} : { label: { text: type } }),
          }),
        ),
        create("text", { type: "text", x: 0, y: 200, text: "Handwritten" }),
        create("arrow", {
          type: "arrow",
          x: 200,
          y: 300,
          width: 200,
          label: { text: "Flow" },
          start: { type: "rectangle" },
          end: { type: "diamond" },
        }),
        create("text-endpoint", {
          type: "arrow",
          x: 200,
          y: 500,
          width: 200,
          end: { type: "text", text: "Endpoint" },
        }),
      ],
      {
        ...state(),
        currentItemRoughness: 0,
        currentItemFontFamily: FONT_FAMILY.Helvetica,
        currentItemRoundness: "sharp",
      },
    );
    for (const element of result.elements) {
      expect(element).toMatchObject({
        roughness: 1,
        strokeWidth: 2,
        fillStyle: "solid",
      });
      if (element.type === "text") {
        expect(element.fontFamily).toBe(FONT_FAMILY.Excalifont);
      }
      expect(element.roundness).toEqual(
        element.type === "rectangle"
          ? { type: ROUNDNESS.ADAPTIVE_RADIUS }
          : ["diamond", "arrow", "line"].includes(element.type)
          ? { type: ROUNDNESS.PROPORTIONAL_RADIUS }
          : null,
      );
    }
  });

  it("remeasures a first-use handwritten heading after font preload and preserves the complete bounds on reopen", async () => {
    const title = "MCP presentation verification";
    const ownerDocument =
      document.implementation.createHTMLDocument("canvas-fonts");
    let fontReady = false;
    const measure = vi
      .spyOn(textMeasurements, "measureText")
      .mockImplementation((text, font, lineHeight) => ({
        width: text.length * (fontReady ? 20 : 16),
        height: parseFloat(font) * lineHeight,
      }));
    const load = vi
      .spyOn(Fonts, "loadElementsFonts")
      .mockImplementation(async () => {
        fontReady = true;
        return [];
      });
    const clearCache = vi.spyOn(textMeasurements.charWidth, "clearCache");
    try {
      const operations = [
        create("heading", {
          type: "text",
          x: 80,
          y: 70,
          text: title,
          fontSize: 36,
        }),
      ];
      const preflight = prepareCanvasOperations([], operations, state());
      const fallback = preflight.elements[0];
      expect(fallback).toMatchObject({
        width: title.length * 16,
        fontFamily: FONT_FAMILY.Excalifont,
        autoResize: true,
      });
      const original = JSON.stringify(preflight.elements);
      await loadCanvasOperationFonts(preflight.elements, ownerDocument);
      expect(load).toHaveBeenCalledWith(preflight.elements, ownerDocument);
      expect(clearCache).toHaveBeenCalledWith(getFontString(fallback as any));
      expect(JSON.stringify(preflight.elements)).toBe(original);
      const prepared = prepareCanvasOperations([], operations, state());
      expect(prepared.elements[0]).toMatchObject({
        originalText: title,
        width: title.length * 20,
        autoResize: true,
      });
      const reopened = restoreElements(
        JSON.parse(JSON.stringify(prepared.elements)),
        null,
      );
      expect(reopened[0]).toMatchObject({
        text: title,
        originalText: title,
        width: title.length * 20,
        height: 45,
        fontFamily: FONT_FAMILY.Excalifont,
        autoResize: true,
      });
      expect(reopened[0].width).toBeGreaterThan(fallback.width);
    } finally {
      measure.mockRestore();
      load.mockRestore();
      clearCache.mockRestore();
    }
  });

  it("does not modify detached scene data if font preload fails", async () => {
    const prepared = diagram();
    const before = JSON.stringify(prepared.elements);
    const load = vi
      .spyOn(Fonts, "loadElementsFonts")
      .mockRejectedValueOnce(new Error("Font load failed"));
    try {
      await expect(
        loadCanvasOperationFonts(prepared.elements, document),
      ).rejects.toThrow("Font load failed");
      expect(JSON.stringify(prepared.elements)).toBe(before);
    } finally {
      load.mockRestore();
    }
  });

  it("honors explicit clean styles on creation and preserves them on unrelated patches", () => {
    const cleanStyle = { roughness: 0, roundness: null, strokeWidth: 1 };
    const result = prepareCanvasOperations(
      [],
      [
        create("box", {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 180,
          height: 100,
          ...cleanStyle,
          label: { text: "Clean", fontFamily: FONT_FAMILY.Helvetica },
        }),
        create("text", {
          type: "text",
          x: 0,
          y: 200,
          text: "Plain text",
          fontFamily: FONT_FAMILY.Helvetica,
        }),
        create("arrow", {
          type: "arrow",
          x: 200,
          y: 400,
          width: 200,
          ...cleanStyle,
          start: { type: "rectangle", ...cleanStyle },
          end: { type: "text", text: "Plain endpoint", fontFamily: 2 },
        }),
      ],
      state(),
    );
    const patched = prepareCanvasOperations(
      result.elements,
      [
        {
          type: "patch",
          id: result.idMap.box,
          patch: { backgroundColor: "#b2f2bb" },
        },
      ],
      state(),
    );
    for (const element of patched.elements) {
      if (element.type === "text") {
        expect(element.fontFamily).toBe(FONT_FAMILY.Helvetica);
      } else {
        expect(element).toMatchObject(cleanStyle);
      }
    }
    const rounded = prepareCanvasOperations(
      patched.elements,
      [
        {
          type: "patch",
          id: result.idMap.box,
          patch: { roundness: { type: 3 } },
        },
      ],
      state(),
    );
    expect(
      rounded.elements.find((element) => element.id === result.idMap.box),
    ).toMatchObject({ roundness: { type: 3 }, roughness: 0 });
  });

  it.each([
    { type: "rectangle", roundness: { type: 2 } },
    { type: "rectangle", roundness: { type: 3, value: 100 } },
    { type: "rectangle", roundness: {} },
    { type: "rectangle", roundness: "round" },
    { type: "diamond", roundness: { type: 3 } },
    { type: "line", roundness: { type: 1 } },
    { type: "text", text: "Text", roundness: { type: 2 } },
  ])("rejects invalid roundness: %j", (element) => {
    expect(() =>
      prepareCanvasOperations(
        [],
        [create("invalid", { x: 0, y: 0, ...element })],
        state(),
      ),
    ).toThrow();
  });

  it("creates labels and reciprocal arrow bindings using same-batch temporary IDs", () => {
    const result = diagram();
    expect(result.elements).toHaveLength(6);
    const arrow = result.elements.find(
      (element) => element.id === result.idMap.link,
    )!;
    expect(arrow).toMatchObject({
      startBinding: { elementId: result.idMap.a },
      endBinding: { elementId: result.idMap.b },
    });
    expect(
      result.elements.find((element) => element.id === result.idMap.a)
        ?.boundElements,
    ).toEqual(expect.arrayContaining([{ id: arrow.id, type: "arrow" }]));
    expect(
      result.elements
        .filter((element) => element.type === "text")
        .map((element) => element.text),
    ).toEqual(expect.arrayContaining(["First", "Second", "connect"]));
  });

  it("rejects an entire invalid batch without mutating input elements", () => {
    const original = diagram();
    const before = JSON.stringify(original.elements);
    expect(() =>
      prepareCanvasOperations(
        original.elements,
        [
          { type: "patch", id: original.idMap.a, patch: { x: 80 } },
          { type: "patch", id: original.idMap.b, patch: { version: 999 } },
        ],
        state(),
      ),
    ).toThrow("Unsupported ellipse field: version");
    expect(JSON.stringify(original.elements)).toBe(before);
    expect(() =>
      prepareCanvasOperations(
        [],
        [
          create("arrow", {
            type: "arrow",
            x: 0,
            y: 0,
            end: { id: "missing" },
          }),
        ],
        state(),
      ),
    ).toThrow("Unknown endpoint");
  });

  it("updates versions, text layout, container labels, and connected arrow geometry", () => {
    const original = diagram();
    const arrowBefore = original.elements.find(
      (element) => element.id === original.idMap.link,
    )!;
    const label = original.elements.find(
      (element) =>
        element.type === "text" && element.containerId === original.idMap.a,
    )!;
    const result = prepareCanvasOperations(
      original.elements,
      [
        {
          type: "patch",
          id: original.idMap.a,
          patch: { x: 40, width: 220, backgroundColor: "#a5d8ff" },
        },
        {
          type: "patch",
          id: label.id,
          patch: { text: "A much longer label", fontSize: 28 },
        },
      ],
      state(),
    );
    const patchedLabel = result.elements.find(
      (element) => element.id === label.id,
    )!;
    expect(patchedLabel).toMatchObject({
      originalText: "A much longer label",
      fontSize: 28,
    });
    expect(patchedLabel.width).toBeGreaterThan(label.width);
    expect(patchedLabel.version).toBeGreaterThan(label.version);
    expect(
      result.elements.find((element) => element.id === original.idMap.link),
    ).not.toEqual(arrowBefore);
  });

  it("keeps tombstones and unrelated content while repairing bindings after deletion", () => {
    const original = diagram();
    const image = API.createElement({ type: "image", id: "preserved-image" });
    const tombstone = API.createElement({
      type: "rectangle",
      id: "old-deletion",
      isDeleted: true,
    });
    const normalized = syncInvalidIndices([
      ...original.elements,
      image,
      tombstone,
    ]);
    const result = prepareCanvasOperations(
      normalized,
      [{ type: "delete", id: original.idMap.a }],
      state(),
    );
    expect(result.elements.find((element) => element.id === image.id)).toEqual(
      JSON.parse(
        JSON.stringify(normalized.find((element) => element.id === image.id)),
      ),
    );
    expect(
      result.elements.find((element) => element.id === tombstone.id),
    ).toEqual(
      JSON.parse(
        JSON.stringify(
          normalized.find((element) => element.id === tombstone.id),
        ),
      ),
    );
    expect(
      result.elements.find((element) => element.id === original.idMap.a)
        ?.isDeleted,
    ).toBe(true);
    expect(
      result.elements.find(
        (element) =>
          element.type === "text" && element.containerId === original.idMap.a,
      )?.isDeleted,
    ).toBe(true);
    expect(
      result.elements.find((element) => element.id === original.idMap.link),
    ).toMatchObject({ startBinding: null });
  });

  it("creates and edits native tables without losing members or reciprocal label bindings", () => {
    const result = prepareCanvasOperations(
      [],
      [
        create("table", {
          type: "table",
          x: 20,
          y: 30,
          rows: [50, 50],
          columns: [120, 140],
          cells: [
            { row: 0, column: 0, text: "Title", backgroundColor: "#a5d8ff" },
          ],
        }),
      ],
      state(),
    );
    const root = result.elements.find(isTableRoot)!;
    expect(root.id).toBe(result.idMap.table);
    expect(root.roughness).toBe(1);
    expect(result.elements).toHaveLength(9);
    const initialCellIds = result.elements
      .filter((element) => getTableMember(element))
      .map((element) => element.id);
    const updated = prepareCanvasOperations(
      result.elements,
      [
        {
          type: "table",
          id: root.id,
          cells: [{ row: 1, column: 1, text: "Last", fontSize: 22 }],
          columns: [160, 180],
        },
        { type: "patch", id: root.id, patch: { x: 80, y: 100, opacity: 75 } },
      ],
      state(),
    );
    expect(updated.elements.find(isTableRoot)).toMatchObject({
      x: 80,
      y: 100,
      width: 340,
      opacity: 75,
    });
    expect(
      updated.elements
        .filter((element) => getTableMember(element))
        .map((element) => element.id),
    ).toEqual(initialCellIds);
    for (const element of updated.elements.filter(
      (element) => element.type === "text",
    )) {
      const background = updated.elements.find(
        (item) => item.id === element.containerId,
      )!;
      expect(background.boundElements).toEqual([
        { id: element.id, type: "text" },
      ]);
      expect(element.opacity).toBe(75);
      expect(element.fontFamily).toBe(FONT_FAMILY.Excalifont);
    }
    expect(
      updated.elements.some(
        (element) => element.type === "text" && element.originalText === "Last",
      ),
    ).toBe(true);
  });

  it("preserves existing arrows bound to table cells and unbinds them when a merge removes their target", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("table", {
          type: "table",
          x: 0,
          y: 0,
          rows: [60],
          columns: [120, 120],
          roughness: 0,
          strokeWidth: 1,
          cells: [{ row: 0, column: 1, fontFamily: FONT_FAMILY.Helvetica }],
        }),
      ],
      state(),
    );
    const background = created.elements.find(
      (element) =>
        getTableMember(element)?.role === "background" &&
        getTableMember(element)?.column === 1,
    )!;
    expect(background).toMatchObject({ roughness: 0, strokeWidth: 1 });
    expect(
      created.elements.find(
        (element) =>
          getTableMember(element)?.role === "text" &&
          getTableMember(element)?.column === 1,
      ),
    ).toMatchObject({ fontFamily: FONT_FAMILY.Helvetica });
    const arrow = API.createElement({
      type: "arrow",
      id: "existing-cell-arrow",
      x: 245,
      y: 30,
      points: [pointFrom(0, 0), pointFrom(100, 0)],
      startBinding: {
        elementId: background.id,
        fixedPoint: [1, 0.5],
        mode: "orbit",
      },
    });
    const elements = [
      ...created.elements.map((element) =>
        element.id === background.id
          ? {
              ...element,
              boundElements: [
                ...(element.boundElements ?? []),
                { id: arrow.id, type: "arrow" as const },
              ],
            }
          : element,
      ),
      arrow,
    ];
    const updated = prepareCanvasOperations(
      elements,
      [
        {
          type: "table",
          id: created.idMap.table,
          cells: [{ row: 0, column: 1, text: "Edited" }],
        },
      ],
      state(),
    );
    expect(
      updated.elements.find((element) => element.id === background.id)!
        .boundElements,
    ).toEqual(expect.arrayContaining([{ id: arrow.id, type: "arrow" }]));
    expect(
      updated.elements.find((element) => element.id === arrow.id),
    ).toMatchObject({ startBinding: { elementId: background.id } });
    const merged = prepareCanvasOperations(
      updated.elements,
      [
        {
          type: "table",
          id: created.idMap.table,
          merge: { row: 0, column: 0, endRow: 0, endColumn: 1 },
        },
      ],
      state(),
    );
    expect(
      merged.elements.find((element) => element.id === background.id)!
        .isDeleted,
    ).toBe(true);
    expect(
      merged.elements.find((element) => element.id === arrow.id),
    ).toMatchObject({ startBinding: null });
    expect(
      (elements.find((element) => element.id === arrow.id) as any).startBinding
        .elementId,
    ).toBe(background.id);
  });

  it("merges and splits table ranges through the native layout and keeps deleted cells for undo", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("table", {
          type: "table",
          x: 0,
          y: 0,
          rows: [50, 50],
          columns: [120, 120],
          cells: [
            { row: 0, column: 0, text: "One" },
            { row: 0, column: 1, text: "Two" },
          ],
        }),
      ],
      state(),
    );
    const range = { row: 0, column: 0, endRow: 0, endColumn: 1 };
    const merged = prepareCanvasOperations(
      created.elements,
      [{ type: "table", id: created.idMap.table, merge: range }],
      state(),
    );
    expect(
      (
        merged.elements.find(isTableRoot) as TableRoot
      ).customData.table.cells.find(
        (cell: { row: number; column: number }) =>
          cell.row === 0 && cell.column === 0,
      ),
    ).toMatchObject({ text: "One\nTwo", columnSpan: 2 });
    expect(merged.elements.some((element) => element.isDeleted)).toBe(true);
    const split = prepareCanvasOperations(
      merged.elements,
      [{ type: "table", id: created.idMap.table, split: range }],
      state(),
    );
    expect(
      (split.elements.find(isTableRoot) as TableRoot).customData.table.cells,
    ).toHaveLength(4);
    expect(split.elements.filter((element) => !element.isDeleted)).toHaveLength(
      9,
    );
    const cell = split.elements.find((element) => getTableMember(element))!;
    expect(() =>
      prepareCanvasOperations(
        split.elements,
        [{ type: "delete", id: cell.id }],
        state(),
      ),
    ).toThrow("table operation");
    const removed = prepareCanvasOperations(
      split.elements,
      [{ type: "delete", id: created.idMap.table }],
      state(),
    );
    expect(removed.elements.every((element) => element.isDeleted)).toBe(true);
  });

  it("lays out rich text in labels, free text and cells and clears stale formatting on plain replacement", () => {
    const richText = {
      version: 1,
      paragraphs: [
        {
          runs: [
            { text: "Bold", bold: true, background: "#a5d8ff" },
            { text: " italic", italic: true, underline: true },
          ],
          list: { kind: "bullet", indent: 1 },
        },
        { runs: [{ text: "Second" }] },
      ],
    };
    const created = prepareCanvasOperations(
      [],
      [
        create("text", {
          type: "text",
          x: 0,
          y: 0,
          richText,
          width: 120,
          paragraphSpacing: 8,
        }),
        create("box", {
          type: "rectangle",
          x: 0,
          y: 300,
          width: 200,
          height: 100,
          label: { richText },
        }),
        create("table", {
          type: "table",
          x: 300,
          y: 0,
          rows: [50],
          columns: [140],
          cells: [{ row: 0, column: 0, richText }],
        }),
      ],
      state(),
    );
    const text = created.elements.find(
      (element) => element.id === created.idMap.text,
    )!;
    expect(text).toMatchObject({
      richText,
      originalText: "Bold italic\nSecond",
      width: 120,
      autoResize: false,
      paragraphSpacing: 8,
    });
    expect(
      created.elements.filter(
        (element) => element.type === "text" && element.richText,
      ),
    ).toHaveLength(3);
    const replaced = prepareCanvasOperations(
      created.elements,
      [{ type: "patch", id: text.id, patch: { text: "Plain" } }],
      state(),
    );
    expect(
      replaced.elements.find((element) => element.id === text.id),
    ).toMatchObject({ originalText: "Plain", richText: undefined });
    expect((text as any).richText).toEqual(richText);
    const restyled = prepareCanvasOperations(
      replaced.elements,
      [{ type: "patch", id: text.id, patch: { richText } }],
      state(),
    );
    expect(
      restyled.elements.find((element) => element.id === text.id),
    ).toMatchObject({ richText, originalText: "Bold italic\nSecond" });
  });

  it("adds image resources, reuses their IDs and preserves original assets through geometry edits and deletion", () => {
    const file = {
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
    };
    const created = prepareCanvasOperations(
      [],
      [
        create("image", {
          type: "image",
          x: 10,
          y: 10,
          width: 100,
          height: 80,
          file,
        }),
        create("same", {
          type: "image",
          x: 150,
          y: 10,
          width: 100,
          height: 80,
          file,
          scale: [-1, 1],
        }),
      ],
      state(),
    );
    const image = created.elements.find(
      (element) => element.id === created.idMap.image,
    )! as any;
    expect(Object.keys(created.files)).toHaveLength(1);
    expect(created.files[image.fileId]).toMatchObject(file);
    expect(
      (
        created.elements.find(
          (element) => element.id === created.idMap.same,
        ) as any
      ).fileId,
    ).toBe(image.fileId);
    const before = JSON.stringify(created.files);
    const edited = prepareCanvasOperations(
      created.elements,
      [
        { type: "patch", id: image.id, patch: { x: 90, width: 200 } },
        { type: "delete", id: created.idMap.same },
        create("reuse", { type: "image", x: 300, y: 10, fileId: image.fileId }),
      ],
      state(),
      { files: created.files },
    );
    expect(JSON.stringify(edited.files)).toBe(before);
    expect(JSON.stringify(created.files)).toBe(before);
    expect(
      edited.elements.find((element) => element.id === image.id),
    ).toMatchObject({ x: 90, width: 200, fileId: image.fileId });
  });

  it("normalizes freehand geometry and keeps pressure samples synchronized", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("draw", {
          type: "freedraw",
          x: 10,
          y: 20,
          points: [
            [0, 0],
            [40, 80],
            [80, 10],
          ],
          pressures: [0.2, 0.8, 0.4],
          simulatePressure: false,
        }),
      ],
      state(),
    );
    expect(created.elements[0]).toMatchObject({
      type: "freedraw",
      width: 80,
      height: 80,
      simulatePressure: false,
      pressures: [0.2, 0.8, 0.4],
      roughness: 1,
    });
    const resized = prepareCanvasOperations(
      created.elements,
      [{ type: "patch", id: created.idMap.draw, patch: { width: 160 } }],
      state(),
    );
    expect((resized.elements[0] as any).points).toEqual([
      [0, 0],
      [80, 80],
      [160, 10],
    ]);
    expect(() =>
      prepareCanvasOperations(
        created.elements,
        [
          {
            type: "patch",
            id: created.idMap.draw,
            patch: {
              points: [
                [0, 0],
                [100, 100],
              ],
            },
          },
        ],
        state(),
      ),
    ).toThrow("pressures must match");
  });

  it("groups labels, changes native stacking order and locks or unlocks whole table families", () => {
    const created = diagram();
    const grouped = prepareCanvasOperations(
      created.elements,
      [
        { type: "group", ids: [created.idMap.a, created.idMap.b] },
        { type: "order", ids: [created.idMap.a], position: "front" },
        { type: "lock", ids: [created.idMap.a], locked: true },
      ],
      state(),
    );
    const box = grouped.elements.find(
      (element) => element.id === created.idMap.a,
    )!;
    const label = grouped.elements.find(
      (element) => element.type === "text" && element.containerId === box.id,
    )!;
    expect(box.groupIds).toHaveLength(1);
    expect(label).toMatchObject({ locked: true, groupIds: box.groupIds });
    expect(() =>
      prepareCanvasOperations(
        grouped.elements,
        [{ type: "patch", id: box.id, patch: { x: 10 } }],
        state(),
      ),
    ).toThrow("is locked");
    const unlocked = prepareCanvasOperations(
      grouped.elements,
      [
        { type: "lock", ids: [box.id], locked: false },
        { type: "ungroup", ids: [box.id] },
      ],
      state(),
    );
    expect(
      unlocked.elements
        .filter((element) => element.id === box.id || element.id === label.id)
        .every((element) => !element.locked && !element.groupIds.length),
    ).toBe(true);
  });

  it("assigns frame members, moves their labels and detaches children when deleting a frame", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("frame", {
          type: "frame",
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          name: "Page",
        }),
        create("box", {
          type: "rectangle",
          x: 20,
          y: 30,
          width: 120,
          height: 80,
          label: { text: "Content" },
        }),
        { type: "frame", ids: ["box"], frameId: "frame" },
        { type: "patch", id: "frame", patch: { x: 100, y: 200 } },
      ],
      state(),
    );
    const box = created.elements.find(
      (element) => element.id === created.idMap.box,
    )!;
    const label = created.elements.find(
      (element) => element.type === "text" && element.containerId === box.id,
    )!;
    expect(box).toMatchObject({ x: 120, y: 230, frameId: created.idMap.frame });
    expect(label.frameId).toBe(created.idMap.frame);
    const deleted = prepareCanvasOperations(
      created.elements,
      [{ type: "delete", id: created.idMap.frame }],
      state(),
    );
    expect(
      deleted.elements.find((element) => element.id === box.id),
    ).toMatchObject({ frameId: null, isDeleted: false });
    expect(
      deleted.elements.find((element) => element.id === label.id),
    ).toMatchObject({ frameId: null, isDeleted: false });
  });

  it("creates native subcanvas containers and retains child scenes and assets for deletion undo", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("child", { type: "subcanvas", x: 10, y: 20, title: "Details" }),
        {
          type: "canvas",
          patch: {
            viewBackgroundColor: "#fafafa",
            gridModeEnabled: true,
            gridSize: 20,
          },
        },
      ],
      state(),
    );
    const pin = created.elements.find(
      (element) => element.id === created.idMap.child,
    )!;
    const sceneId = getSubcanvasId(pin)!;
    expect(pin).toMatchObject({
      type: "stickynote",
      width: 48,
      height: 56,
      customData: { subcanvas: { sceneId, title: "Details" } },
    });
    expect(created.subscenes[sceneId]).toMatchObject({
      version: 1,
      title: "Details",
      elements: [],
    });
    expect(created.appState).toEqual({
      viewBackgroundColor: "#fafafa",
      gridModeEnabled: true,
      gridSize: 20,
    });
    const renamed = prepareCanvasOperations(
      created.elements,
      [{ type: "subcanvas", id: pin.id, title: "Renamed" }],
      state(),
      { subscenes: created.subscenes },
    );
    expect(renamed.subscenes[sceneId].title).toBe("Renamed");
    expect(created.subscenes[sceneId].title).toBe("Details");
    const deleted = prepareCanvasOperations(
      renamed.elements,
      [{ type: "delete", id: pin.id }],
      state(),
      { subscenes: renamed.subscenes },
    );
    expect(deleted.subscenes).toEqual(renamed.subscenes);
  });

  it("rejects advanced batches atomically, preserving assets, subscenes, table data and bindings", () => {
    const created = prepareCanvasOperations(
      diagram().elements,
      [
        create("table", {
          type: "table",
          x: 0,
          y: 400,
          rows: [60],
          columns: [100, 100],
        }),
        create("child", { type: "subcanvas", x: 300, y: 400 }),
        create("image", {
          type: "image",
          x: 400,
          y: 400,
          file: {
            mimeType: "image/png",
            dataURL: "data:image/png;base64,aGVsbG8=",
          },
        }),
      ],
      state(),
    );
    const before = JSON.stringify(created);
    expect(() =>
      prepareCanvasOperations(
        created.elements,
        [
          {
            type: "table",
            id: created.idMap.table,
            cells: [{ row: 0, column: 0, text: "Changed" }],
          },
          { type: "subcanvas", id: created.idMap.child, title: "Changed" },
          { type: "canvas", patch: { viewBackgroundColor: "#fff" } },
          create("new-file", {
            type: "image",
            x: 0,
            y: 0,
            file: {
              mimeType: "image/png",
              dataURL: "data:image/png;base64,bmV3",
            },
          }),
          {
            type: "table",
            id: created.idMap.table,
            cells: [{ row: 4, column: 0, text: "Invalid" }],
          },
        ],
        state(),
        { files: created.files, subscenes: created.subscenes },
      ),
    ).toThrow("row must be an integer");
    expect(JSON.stringify(created)).toBe(before);
  });

  it.each([
    create("bad", {
      type: "rectangle",
      x: 0,
      y: 0,
      customData: { subcanvas: { sceneId: "injected" } },
    }),
    create("bad", {
      type: "text",
      x: 0,
      y: 0,
      richText: {
        version: 1,
        paragraphs: [{ runs: [{ text: "bad", bold: "yes" }] }],
      },
    }),
    create("bad", {
      type: "text",
      x: 0,
      y: 0,
      text: "mismatch",
      richText: { version: 1, paragraphs: [{ runs: [{ text: "Other" }] }] },
    }),
    create("bad", { type: "table", x: 0, y: 0, rows: [0], columns: [100] }),
    create("bad", { type: "image", x: 0, y: 0, fileId: "missing" }),
    create("bad", {
      type: "image",
      x: 0,
      y: 0,
      file: { mimeType: "image/png", dataURL: "https://example.com/image.png" },
    }),
    create("bad", {
      type: "freedraw",
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [20, 40],
      ],
      pressures: [0.5],
    }),
    { type: "canvas", patch: { theme: "dark" } },
    { type: "canvas", patch: { gridSize: null } },
  ])("rejects malformed advanced input: %j", (operation) => {
    expect(() => prepareCanvasOperations([], [operation], state())).toThrow();
  });

  it("advertises the implemented element and operation set", () => {
    expect(CANVAS_CAPABILITIES.elementTypes).toEqual(
      expect.arrayContaining([
        "table",
        "image",
        "subcanvas",
        "freedraw",
        "frame",
      ]),
    );
    expect(CANVAS_CAPABILITIES.operations).toHaveProperty("table");
    expect(CANVAS_CAPABILITIES.operations).toHaveProperty("lock");
    expect(CANVAS_CAPABILITIES.operations.canvas.fields).toContain(
      "viewBackgroundColor",
    );
  });

  it("recognizes active editing and dragging as busy", () => {
    expect(isCanvasBusy(state())).toBe(false);
    expect(isCanvasBusy({ ...state(), cursorButton: "down" })).toBe(true);
    expect(
      isCanvasBusy({
        ...state(),
        editingTextElement: API.createElement({ type: "text" }),
      }),
    ).toBe(true);
  });

  it("rejects locked targets and locked labels before any related geometry changes", () => {
    const original = diagram();
    const rectangle = original.elements.find(
      (element) => element.id === original.idMap.a,
    )!;
    expect(() =>
      prepareCanvasOperations(
        [{ ...rectangle, locked: true }],
        [{ type: "delete", id: rectangle.id }],
        state(),
      ),
    ).toThrow("is locked");
    const withLockedLabel = original.elements.map((element) =>
      element.type === "text" && element.containerId === rectangle.id
        ? { ...element, locked: true }
        : element,
    );
    const before = JSON.stringify(withLockedLabel);
    expect(() =>
      prepareCanvasOperations(
        withLockedLabel,
        [{ type: "patch", id: rectangle.id, patch: { x: 40 } }],
        state(),
      ),
    ).toThrow("is locked");
    expect(JSON.stringify(withLockedLabel)).toBe(before);
  });

  it("bounds font layout and PNG allocation before creating an export canvas", () => {
    expect(() =>
      prepareCanvasOperations(
        [],
        [
          create("text", {
            type: "text",
            x: 0,
            y: 0,
            text: "Huge",
            fontSize: 1e7,
          }),
        ],
        state(),
      ),
    ).toThrow("fontSize cannot exceed 512");
    expect(() =>
      prepareCanvasOperations(
        [],
        [
          create("text", {
            type: "text",
            x: 0,
            y: 0,
            text: "Tall",
            lineHeight: 1e7,
          }),
        ],
        state(),
      ),
    ).toThrow("lineHeight cannot exceed 10");
    expect(canvasExportDimensions(100000, 100000)).toEqual({
      width: 4096,
      height: 4096,
      scale: 4096 / 100000,
    });
    for (const width of [100001, Infinity, NaN, 0, -10]) {
      expect(() => canvasExportDimensions(width, 200)).toThrow(
        "PNG canvas bounds",
      );
    }
  });

  it("wraps free text at an explicit create/patch width and remeasures text height", () => {
    const created = prepareCanvasOperations(
      [],
      [
        create("text", {
          type: "text",
          x: 0,
          y: 0,
          text: "Several words that should wrap into more lines",
          width: 150,
          fontSize: 20,
        }),
      ],
      state(),
    );
    const text = created.elements[0];
    expect(text).toMatchObject({ width: 150, autoResize: false });
    const patched = prepareCanvasOperations(
      created.elements,
      [{ type: "patch", id: text.id, patch: { width: 70 } }],
      state(),
    ).elements[0];
    expect(patched.width).toBe(70);
    expect(patched.height).toBeGreaterThan(text.height);
  });

  it("repairs reciprocal bindings when a patched arrow moves away from its targets", () => {
    const original = diagram();
    const moved = prepareCanvasOperations(
      original.elements,
      [{ type: "patch", id: original.idMap.link, patch: { x: 1000, y: 1000 } }],
      state(),
    );
    expect(
      moved.elements.find((element) => element.id === original.idMap.link),
    ).toMatchObject({ startBinding: null, endBinding: null });
    for (const id of [original.idMap.a, original.idMap.b]) {
      expect(
        moved.elements
          .find((element) => element.id === id)
          ?.boundElements?.some((bound) => bound.id === original.idMap.link),
      ).toBe(false);
    }
  });

  it("exports SVG nodes into the provided owner document", async () => {
    const ownerDocument = document.implementation.createHTMLDocument("export");
    const svg = await exportToSvg(
      diagram().elements.filter((element) => !element.isDeleted) as any,
      { ...state(), exportEmbedScene: true },
      {},
      { ownerDocument, skipInliningFonts: true },
    );
    expect(svg.ownerDocument).toBe(ownerDocument);
    expect(svg.outerHTML).toContain("svg-source:excalidraw");
    expect(svg.outerHTML).toContain("payload-start");
  });

  it("records a multi-element batch as one undoable edit in the real editor", async () => {
    let api!: ExcalidrawImperativeAPI;
    const view = await render(
      createElement(Excalidraw, {
        onExcalidrawAPI: (value) => {
          if (value) {
            api = value;
          }
        },
        handleKeyboardGlobally: true,
      }),
    );
    await waitFor(() => expect(api.getAppState().isLoading).toBe(false));
    const initialUndo = api.history.checkpoint!().undo.length;
    const prepared = diagram();
    act(() =>
      api.updateScene({
        elements: prepared.elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() => expect(api.getSceneElements()).toHaveLength(6));
    expect(api.history.checkpoint!().undo).toHaveLength(initialUndo + 1);
    fireEvent.keyDown(view.container.querySelector(".excalidraw")!, {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
    });
    await waitFor(() => expect(api.getSceneElements()).toHaveLength(0));
  });
});
