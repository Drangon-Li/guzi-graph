import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import {
  A4,
  appendPaperPage,
  createPaperPage,
  createPaperTemplate,
  getPaperPages,
  isPaperFrame,
  PAPER_GAP,
  paperViewport,
} from "./paper";

describe("paper templates", () => {
  it.each(["portrait", "landscape"] as const)(
    "keeps A4 %s size and locked paper after a save round trip",
    (orientation) => {
      const scene = createPaperTemplate("ruled", orientation);
      const elements = restoreElements(scene.elements!, null);
      const frame = elements.find(isPaperFrame)!;
      expect(frame.width).toBeCloseTo(
        orientation === "portrait" ? A4.width : A4.height,
      );
      expect(frame.height).toBeCloseTo(
        orientation === "portrait" ? A4.height : A4.width,
      );
      expect(elements.every((element) => element.locked)).toBe(true);
      expect(
        elements.filter((element) => element.type === "line").length,
      ).toBeGreaterThan(10);
      expect(
        elements
          .filter((element) => element.id !== frame.id)
          .every((element) => element.frameId === frame.id),
      ).toBe(true);
      const saved = JSON.parse(
        serializeAsJSON(
          elements,
          { ...getDefaultAppState(), ...scene.appState },
          {},
          "local",
        ),
      );
      const restored = restoreElements(saved.elements, null);
      expect(restored.find(isPaperFrame)?.width).toBe(frame.width);
      expect(restored).toHaveLength(elements.length);
    },
  );

  it("creates blank paper without rules and does not crop editing to the page", () => {
    const scene = createPaperTemplate("blank", "portrait");
    expect(scene.elements).toHaveLength(2);
    expect(scene.elements?.[0]).toMatchObject({
      type: "rectangle",
      backgroundColor: "#ffffff",
    });
    expect(scene.appState).not.toHaveProperty("scrollX");
  });

  it.each(["blank", "ruled"] as const)(
    "continues translated %s sheets behind existing ink without dropping deleted items",
    (template) => {
      const first = createPaperPage({
        x: 100,
        y: 70,
        width: A4.height,
        height: A4.width,
        name: "A4",
        template,
      });
      const ink = {
        ...first[0],
        id: "off-page-ink",
        frameId: null,
        y: 1000,
        locked: false,
      };
      const deleted = { ...ink, id: "deleted-ink", isDeleted: true };
      const next = appendPaperPage([...first, ink, deleted])!;
      expect(next.frame).toMatchObject({
        x: 100,
        y: 70 + A4.width + PAPER_GAP,
        width: A4.height,
        height: A4.width,
      });
      expect(next.frame.customData?.guziPaper.kind).toBe(template);
      expect(next.elements.at(-1)).toBe(deleted);
      expect(
        next.elements.findIndex((element) => element.id === next.frame.id),
      ).toBeLessThan(
        next.elements.findIndex((element) => element.id === ink.id),
      );
      expect(getPaperPages(next.elements)).toEqual([first.at(-1), next.frame]);
      const third = appendPaperPage(next.elements)!;
      expect(getPaperPages(third.elements).map((frame) => frame.y)).toEqual([
        70,
        70 + A4.width + PAPER_GAP,
        70 + 2 * (A4.width + PAPER_GAP),
      ]);
      expect(getPaperPages(restoreElements(third.elements, null))).toHaveLength(
        3,
      );
    },
  );

  it("uses geometry order regardless of scene order and refuses PDF continuation", () => {
    const a = createPaperPage({
      width: 100,
      height: 100,
      y: 200,
      name: "late",
    });
    const b = createPaperPage({ width: 100, height: 100, y: 0, name: "early" });
    expect(getPaperPages([...a, ...b]).map((frame) => frame.name)).toEqual([
      "early",
      "late",
    ]);
    const pdf = {
      ...a.at(-1)!,
      customData: { guziPaper: { version: 1, kind: "pdf" } },
    };
    expect(appendPaperPage([pdf])).toBeNull();
    expect(appendPaperPage([])).toBeNull();
  });

  it("fits page width to the area left by the sidebar while preserving top alignment", () => {
    const frame = createPaperPage({
      x: 80,
      y: 200,
      width: 600,
      height: 1000,
      name: "A4",
    }).find(isPaperFrame)!;
    const state = {
      ...getDefaultAppState(),
      width: 1200,
      height: 700,
      offsetLeft: 0,
      offsetTop: 0,
    };
    const viewport = paperViewport(
      frame,
      state,
      { left: 320, right: 40, top: 24 },
      true,
    );
    expect(viewport.zoom.value).toBe(1.24);
    expect((frame.x + viewport.scrollX) * viewport.zoom.value).toBeCloseTo(368);
    expect((frame.y + viewport.scrollY) * viewport.zoom.value).toBeCloseTo(24);
  });
});
