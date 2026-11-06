import { arrayToMap } from "@excalidraw/common";
import {
  isArrowElement,
  LinearElementEditor,
  newArrowElement,
  newElement,
  newElementWith,
  newStickyNoteElement,
  newTextElement,
  syncInvalidIndices,
} from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
} from "@excalidraw/element/table";
import { pointFrom } from "@excalidraw/math";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { A4, createPaperPage, getPaperPages, PAPER_GAP } from "./paper";
import { changePaperPages } from "./paperPageManagement";

import type { PaperPageAction } from "./paperPageManagement";

const rect = (x: number, y: number, overrides = {}) =>
  newElement({ type: "rectangle", x, y, width: 36, height: 32, ...overrides });

const layout = () => {
  const first = createPaperPage({ width: 400, height: 300, y: 20, name: "1" });
  const second = createPaperPage({
    width: 400,
    height: 300,
    y: 368,
    name: "2",
    template: "ruled",
  });
  const third = createPaperPage({ width: 400, height: 300, y: 716, name: "3" });
  const elements = syncInvalidIndices([...third, ...second, ...first]);
  return { elements, pages: getPaperPages(elements) };
};

const change = (
  elements: readonly ExcalidrawElement[],
  action: PaperPageAction,
) => {
  const result = changePaperPages(elements, action);
  if (!result || result.requiresConfirmation) {
    throw new Error("Expected a page change");
  }
  return result;
};

describe("paper page management", () => {
  it("moves frame-owned elements, unframed ink, bound text and pins by the page displacement", () => {
    const {
      elements,
      pages: [first, second, third],
    } = layout();
    const ink = rect(70, 90);
    const outsideButOwned = rect(410, 10, { frameId: first.id });
    const text = newTextElement({
      text: "text",
      x: ink.x,
      y: ink.y,
      containerId: ink.id,
    });
    const container = newElementWith(ink, {
      boundElements: [{ id: text.id, type: "text" }],
    });
    const pin = newStickyNoteElement({
      type: "stickynote",
      x: 100,
      y: 150,
      width: 48,
      height: 56,
      customData: { subcanvas: { sceneId: "child", title: "Child canvas" } },
    });
    const overhang = rect(390, 50);
    const between = rect(100, 315, { height: 75 });
    const offCanvas = rect(-100, 100);
    const initial = syncInvalidIndices([
      container,
      text,
      ...elements,
      pin,
      outsideButOwned,
      overhang,
      between,
      offCanvas,
    ]);

    const result = change(initial, {
      type: "reorder",
      pageId: first.id,
      targetId: third.id,
    });
    const byId = arrayToMap(result.elements);
    expect(getPaperPages(result.elements).map((page) => page.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
    expect(result.elements.map((element) => element.id)).toEqual(
      initial.map((element) => element.id),
    );
    for (const element of [container, text, outsideButOwned, pin]) {
      expect(byId.get(element.id)).toMatchObject({
        x: element.x,
        y: element.y + 696,
      });
    }
    expect(byId.get(text.id)).toMatchObject({
      containerId: ink.id,
      frameId: null,
    });
    expect(byId.get(pin.id)?.customData?.subcanvas.sceneId).toBe("child");
    for (const element of [overhang, between, offCanvas]) {
      expect(byId.get(element.id)).toBe(element);
    }
    expect(result.unassigned).toBe(3);

    const removed = change(result.elements, {
      type: "delete",
      pageId: first.id,
      confirmed: true,
    });
    expect(removed.destination).toBe(third.id);
    for (const element of [container, text, outsideButOwned, pin]) {
      expect(
        removed.elements.find(({ id }) => id === element.id)?.isDeleted,
      ).toBe(true);
    }
  });

  it("retains cross-page table and group members together, and moves a fully contained table", () => {
    const {
      elements,
      pages: [first, second],
    } = layout();
    const contained = createTableElements(createTableData(2, 2), 30, 80);
    const crossing = createTableElements(createTableData(2, 2), 30, 282);
    const group = [
      rect(330, 100, { groupIds: ["inner", "outer"] }),
      rect(330, 400, { groupIds: ["outer"] }),
    ];
    const initial = syncInvalidIndices([
      ...elements,
      ...contained.elements,
      ...crossing.elements,
      ...group,
    ]);
    const moved = change(initial, {
      type: "move",
      pageId: first.id,
      direction: 1,
    });
    const next = arrayToMap(moved.elements);
    for (const member of contained.elements) {
      expect(next.get(member.id)).toMatchObject({
        y: member.y + second.height + PAPER_GAP,
        groupIds: member.groupIds,
      });
    }
    for (const member of [...crossing.elements, ...group]) {
      expect(next.get(member.id)).toBe(member);
    }
    expect(moved.unassigned).toBe(
      crossing.elements.filter((member) => member.type !== "text").length +
        group.length,
    );
  });

  it.each([false, true])(
    "preserves a cross-page arrow when elbowed=%s, then unbinds only the deleted endpoint",
    (elbowed) => {
      const {
        elements,
        pages: [first, second],
      } = layout();
      const a = rect(30, 110);
      const b = rect(270, 525);
      const arrow = newElementWith(
        newArrowElement({
          type: "arrow",
          elbowed,
          x: a.x + a.width,
          y: a.y + a.height / 2,
          width: b.x - a.x - a.width,
          height: b.y - a.y,
          points: elbowed
            ? [
                pointFrom(0, 0),
                pointFrom(100, 0),
                pointFrom(100, b.y - a.y),
                pointFrom(b.x - a.x - a.width, b.y - a.y),
              ]
            : [pointFrom(0, 0), pointFrom(b.x - a.x - a.width, b.y - a.y)],
        }),
        {
          startBinding: {
            elementId: a.id,
            mode: "inside",
            fixedPoint: [1, 0.5],
          },
          endBinding: { elementId: b.id, mode: "inside", fixedPoint: [0, 0.5] },
        },
      );
      const bound = [a, b].map((element) =>
        newElementWith(element, {
          boundElements: [{ id: arrow.id, type: "arrow" }],
        }),
      );
      const label = newTextElement({
        text: "Connector label",
        x: arrow.x,
        y: arrow.y,
        containerId: arrow.id,
      });
      const arrowWithLabel = newElementWith(arrow, {
        boundElements: [{ id: label.id, type: "text" }],
      });
      const original = syncInvalidIndices([
        ...elements,
        ...bound,
        arrowWithLabel,
        label,
      ]);
      const originalSnapshot = JSON.stringify(original);
      const next = change(original, {
        type: "move",
        pageId: first.id,
        direction: 1,
      });
      const byId = arrayToMap(next.elements);
      const moved = byId.get(arrow.id);
      expect(next.unassigned).toBe(1);
      expect(isArrowElement(moved)).toBe(true);
      if (!isArrowElement(moved)) {
        return;
      }
      expect(moved.startBinding).toEqual(arrow.startBinding);
      expect(moved.endBinding).toEqual(arrow.endBinding);
      const start = LinearElementEditor.getPointAtIndexGlobalCoordinates(
        moved,
        0,
        byId,
      );
      const end = LinearElementEditor.getPointAtIndexGlobalCoordinates(
        moved,
        -1,
        byId,
      );
      const firstY = a.y + second.height + PAPER_GAP;
      const secondY = b.y - first.height - PAPER_GAP;
      expect(start[1]).toBeCloseTo(firstY + a.height / 2, 0);
      expect(end[1]).toBeCloseTo(secondY + b.height / 2, 0);
      if (elbowed) {
        expect(
          moved.points.every(
            (point, index) =>
              !index ||
              moved.points[index - 1][0] === point[0] ||
              moved.points[index - 1][1] === point[1],
          ),
        ).toBe(true);
      }
      expect(arrow.y).toBe(a.y + a.height / 2);
      expect(arrow.startBinding?.elementId).toBe(a.id);
      expect(byId.get(label.id)).toMatchObject({
        containerId: arrow.id,
        isDeleted: false,
      });
      expect(JSON.stringify(original)).toBe(originalSnapshot);

      const movedSnapshot = JSON.stringify(next.elements);
      const removed = change(next.elements, {
        type: "delete",
        pageId: first.id,
        confirmed: true,
      });
      const survivor = removed.elements.find(({ id }) => id === arrow.id);
      expect(survivor).toMatchObject({
        isDeleted: false,
        startBinding: null,
        endBinding: arrow.endBinding,
      });
      expect(moved.startBinding).toEqual(arrow.startBinding);
      expect(JSON.stringify(next.elements)).toBe(movedSnapshot);
      expect(JSON.stringify(original)).toBe(originalSnapshot);
    },
  );

  it("translates the entire cross-page connector when both endpoints move equally", () => {
    const {
      elements,
      pages: [first, second, third],
    } = layout();
    const from = rect(30, second.y + 80);
    const to = rect(120, third.y + 70);
    const points: LocalPoint[] = [
      pointFrom(0, 0),
      pointFrom(150, 180),
      pointFrom(to.x - from.x, to.y - from.y),
    ];
    const arrow = newElementWith(
      newArrowElement({ type: "arrow", x: from.x, y: from.y, points }),
      {
        startBinding: {
          elementId: from.id,
          mode: "inside",
          fixedPoint: [0, 0],
        },
        endBinding: { elementId: to.id, mode: "inside", fixedPoint: [0, 0] },
      },
    );
    const result = change(syncInvalidIndices([...elements, from, to, arrow]), {
      type: "insert",
      pageId: first.id,
    });
    const inserted = getPaperPages(result.elements).find(
      ({ id }) => id === result.destination,
    )!;
    const moved = result.elements.find(({ id }) => id === arrow.id)!;
    expect(moved.y).toBeCloseTo(arrow.y + inserted.height + PAPER_GAP);
    expect(moved).toMatchObject({
      x: arrow.x,
      points,
      startBinding: arrow.startBinding,
      endBinding: arrow.endBinding,
    });
  });

  it("treats empty ruled paper as empty, confirms content removal, and selects the successor or previous final page", () => {
    const {
      elements,
      pages: [first, second, third],
    } = layout();
    const ink = rect(50, 70);
    expect(
      changePaperPages([...elements, ink], {
        type: "delete",
        pageId: first.id,
      }),
    ).toEqual({
      requiresConfirmation: true,
    });
    expect(
      change([...elements, ink], {
        type: "delete",
        pageId: first.id,
        confirmed: true,
      }).destination,
    ).toBe(second.id);
    expect(
      change(elements, { type: "delete", pageId: second.id }).destination,
    ).toBe(third.id);
    const removed = change(elements, { type: "delete", pageId: third.id });
    expect(removed.destination).toBe(second.id);
    const final = change(removed.elements, {
      type: "delete",
      pageId: second.id,
    });
    expect(
      changePaperPages(final.elements, { type: "delete", pageId: first.id }),
    ).toBeNull();
    expect(
      changePaperPages(final.elements, {
        type: "move",
        pageId: first.id,
        direction: 1,
      }),
    ).toBeNull();
  });

  it("inserts and reorders mixed PDF sizes while preserving images through serialization", () => {
    const image: BinaryFileData = {
      id: "pdf-image" as FileId,
      dataURL: "data:image/png;base64,AAAA" as DataURL,
      mimeType: "image/png",
      created: 1,
    };
    const elements = syncInvalidIndices([
      ...createPaperPage({
        x: 27,
        y: 44,
        width: 700,
        height: 360,
        name: "1",
        image,
      }),
      ...createPaperPage({
        x: -10,
        y: 452,
        width: 400,
        height: 690,
        name: "2",
        image,
      }),
    ]);
    const [first, second] = getPaperPages(elements);
    expect(
      changePaperPages(elements, { type: "delete", pageId: first.id }),
    ).toEqual({
      requiresConfirmation: true,
    });
    const inserted = change(elements, { type: "insert", pageId: first.id });
    expect(getPaperPages(inserted.elements).map(({ id }) => id)).toEqual([
      first.id,
      inserted.destination,
      second.id,
    ]);
    const reordered = change(inserted.elements, {
      type: "move",
      pageId: second.id,
      direction: -1,
    });
    const saved = JSON.parse(
      serializeAsJSON(
        reordered.elements,
        getDefaultAppState(),
        { [image.id]: image },
        "local",
      ),
    );
    const restored = restoreElements(saved.elements, null);
    expect(getPaperPages(restored)).toMatchObject([
      { id: first.id, x: 27, y: 44, width: 700, height: 360 },
      { id: second.id, x: -10, y: 452, width: 400, height: 690 },
      {
        id: inserted.destination,
        x: 27,
        y: 1190,
        width: A4.height,
        height: A4.width,
      },
    ]);
    expect(restored.filter(({ type }) => type === "image")).toMatchObject([
      { fileId: image.id, frameId: first.id, x: 27, y: 44, locked: true },
      { fileId: image.id, frameId: second.id, x: -10, y: 452, locked: true },
    ]);
    expect(saved.files[image.id].dataURL).toBe(image.dataURL);
  });
});
