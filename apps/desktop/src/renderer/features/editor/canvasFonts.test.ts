import { FONT_FAMILY, getLineHeight } from "@excalidraw/common";
import { isTextElement, StoreSnapshot } from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
  getTableMember,
  isTableRoot,
} from "@excalidraw/element/table";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { SceneElementsMap } from "@excalidraw/element/types";

import {
  appendFontReplacementHistory,
  loadReplacementFont,
  replaceLayerFont,
  restoreLayerFontChanges,
  replaceSnapshotFonts,
} from "./canvasFonts";

describe("desktop scene font replacement", () => {
  it("updates the scene default even when no text needs replacement", () => {
    const previous = {
      elements: [],
      appState: { currentItemFontFamily: FONT_FAMILY.Excalifont },
    };
    const next = replaceSnapshotFonts(previous, FONT_FAMILY.Nunito);
    expect(next.elements).toBe(previous.elements);
    expect(next.appState.currentItemFontFamily).toBe(FONT_FAMILY.Nunito);
    expect(
      appendFontReplacementHistory(undefined, previous, next),
    ).toBeUndefined();
    expect(replaceSnapshotFonts(next, FONT_FAMILY.Nunito)).toBe(next);
  });

  it("restores deleted and locked text fonts without resizing a live container", () => {
    const container = API.createElement({ type: "rectangle", id: "container" });
    const original = API.createElement({
      type: "text",
      id: "text",
      containerId: container.id,
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const before = [container, original];
    const after = replaceLayerFont(before, FONT_FAMILY.Nunito);
    const current = after.map((element) =>
      element.id === original.id
        ? { ...element, isDeleted: true, locked: true }
        : element,
    );
    const restored = restoreLayerFontChanges(current, after, before);
    expect(
      restored.find((element) => element.id === original.id),
    ).toMatchObject({
      fontFamily: FONT_FAMILY.Excalifont,
      isDeleted: true,
      locked: true,
    });
    expect(restored.find((element) => element.id === container.id)).toEqual(
      current.find((element) => element.id === container.id),
    );
  });

  it("propagates font face load failures before any scene conversion", async () => {
    const text = API.createElement({
      type: "text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const load = vi
      .spyOn(document.fonts, "load")
      .mockRejectedValueOnce(new Error("font unavailable"));
    try {
      await expect(
        loadReplacementFont([text], FONT_FAMILY.Nunito, document),
      ).rejects.toThrow("font unavailable");
      expect(text.fontFamily).toBe(FONT_FAMILY.Excalifont);
    } finally {
      load.mockRestore();
    }
  });

  it("keeps rich text marks and alignment while skipping locked and deleted text", () => {
    const text = {
      ...API.createElement({
        type: "text",
        id: "text",
        fontFamily: FONT_FAMILY.Excalifont,
        x: 120,
        width: 200,
        textAlign: "right",
        text: "styled text",
      }),
      paragraphSpacing: 14,
      richText: {
        version: 1 as const,
        paragraphs: [
          {
            list: { kind: "bullet" as const, indent: 1 },
            runs: [
              {
                text: "styled text",
                bold: true,
                italic: true,
                underline: true,
                color: "#0099ff",
                background: "#ff0000",
              },
            ],
          },
        ],
      },
    };
    const locked = API.createElement({
      type: "text",
      id: "locked",
      locked: true,
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const deleted = API.createElement({
      type: "text",
      id: "deleted",
      isDeleted: true,
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const next = replaceLayerFont([text, locked, deleted], FONT_FAMILY.Nunito);
    expect(next[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
      lineHeight: getLineHeight(FONT_FAMILY.Nunito),
      richText: text.richText,
      paragraphSpacing: 14,
    });
    expect(next[0].x + next[0].width).toBeCloseTo(text.x + text.width);
    expect(next[1]).toBe(locked);
    expect(next[2]).toBe(deleted);
    expect(text.fontFamily).toBe(FONT_FAMILY.Excalifont);
  });

  it("reflows bound text without mutating the original container", () => {
    const container = API.createElement({
      type: "rectangle",
      id: "box",
      width: 120,
      height: 40,
      boundElements: [{ id: "label", type: "text" }],
    });
    const text = API.createElement({
      type: "text",
      id: "label",
      containerId: container.id,
      fontFamily: FONT_FAMILY.Excalifont,
      text: "A long text that wraps across multiple lines",
    });
    const next = replaceLayerFont([container, text], FONT_FAMILY.Nunito);
    expect(container.height).toBe(40);
    expect(next[0].height).toBeGreaterThan(40);
    expect(next[1]).toMatchObject({
      containerId: "box",
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(next[1].x).toBeGreaterThanOrEqual(next[0].x);
  });

  it("skips labels owned by locked shapes and locked tables and persists editable table fonts", () => {
    const container = API.createElement({
      type: "rectangle",
      id: "locked-box",
      locked: true,
    });
    const label = API.createElement({
      type: "text",
      id: "locked-label",
      containerId: container.id,
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const { elements: table } = createTableElements(
      createTableData(1, 1, { fontFamily: FONT_FAMILY.Excalifont }),
      0,
      0,
    );
    const lockedTable = table.map((element) =>
      isTableRoot(element) ? { ...element, locked: true } : element,
    );
    const freeText = API.createElement({
      type: "text",
      id: "free-text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const next = replaceLayerFont(
      [container, label, ...lockedTable, freeText],
      FONT_FAMILY.Nunito,
    );
    expect(next.find((element) => element.id === label.id)).toBe(label);
    expect(
      next.filter((element) => getTableMember(element)?.role === "text"),
    ).toMatchObject([{ fontFamily: FONT_FAMILY.Excalifont }]);
    const editable = replaceLayerFont(table, FONT_FAMILY.Nunito);
    const root = editable.find(isTableRoot)!;
    expect(root.customData.table.cells[0].fontFamily).toBe(FONT_FAMILY.Nunito);
  });

  it("reflows complete table rows when a taller font needs more space", () => {
    const data = createTableData(2, 2, { fontFamily: FONT_FAMILY.Helvetica });
    data.cells[0].text = Array.from({ length: 20 }, () => "line").join("\n");
    const { elements } = createTableElements(data, 10, 20);
    const next = replaceLayerFont(elements, FONT_FAMILY.Excalifont);
    const backgrounds = next.filter(
      (element) => getTableMember(element)?.role === "background",
    );
    const first = backgrounds.find(
      (element) =>
        getTableMember(element)?.row === 0 &&
        getTableMember(element)?.column === 0,
    )!;
    const sameRow = backgrounds.find(
      (element) =>
        getTableMember(element)?.row === 0 &&
        getTableMember(element)?.column === 1,
    )!;
    const nextRow = backgrounds.find(
      (element) => getTableMember(element)?.row === 1,
    )!;
    expect(first.height).toBe(sameRow.height);
    expect(nextRow.y).toBeGreaterThanOrEqual(first.y + first.height);
    const root = next.find(isTableRoot)!;
    expect(root.height).toBe(
      root.customData.table.rows.reduce((sum, height) => sum + height, 0),
    );
    expect(root.version).toBeGreaterThan(elements.find(isTableRoot)!.version);
  });

  it("replaces nested scene snapshots and appends an undo entry to cached history", () => {
    const text = API.createElement({
      type: "text",
      id: "text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const child = {
      version: 1 as const,
      title: "child",
      elements: [text],
      appState: {},
    };
    const previous = { elements: [text], appState: { subscenes: { child } } };
    const next = replaceSnapshotFonts(previous, FONT_FAMILY.Nunito);
    expect(next.appState.subscenes.child.elements[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(child.elements[0]).toBe(text);
    const older = appendFontReplacementHistory(
      undefined,
      { elements: [] },
      previous,
    )!;
    const checkpoint = appendFontReplacementHistory(older, previous, next)!;
    expect(checkpoint.undo).toHaveLength(older.undo.length + 1);
    expect(checkpoint.undo[0]).toBe(older.undo[0]);
    const elements = new Map(
      next.elements.map((element) => [element.id, element]),
    ) as SceneElementsMap;
    const state = {
      ...getDefaultAppState(),
      width: 1000,
      height: 700,
      offsetLeft: 0,
      offsetTop: 0,
    };
    const [undone] = checkpoint.undo
      .at(-1)!
      .applyTo(elements, state, StoreSnapshot.create(elements, state));
    expect(undone.get(text.id)).toMatchObject({
      fontFamily: FONT_FAMILY.Excalifont,
    });
    expect(isTextElement(next.elements[0]) && next.elements[0].fontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
    expect(replaceSnapshotFonts(next, FONT_FAMILY.Nunito)).toBe(next);
  });
});
