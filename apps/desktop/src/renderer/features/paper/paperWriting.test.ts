import {
  newElementWith,
  newArrowElement,
  newLinearElement,
  newTextElement,
  LinearElementEditor,
  syncInvalidIndices,
} from "@excalidraw/element";
import {
  getRuledTextBaseline,
  getRuledTextTypography,
} from "@excalidraw/element/ruledText";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import {
  A4,
  appendPaperPage,
  createPaperPage,
  getPaperPages,
  getPaperSettings,
  isPaperRule,
} from "./paper";
import { applyPaperSettings, getPaperTextPlacement } from "./paperWriting";

const paper = (options: Partial<Parameters<typeof createPaperPage>[0]> = {}) =>
  createPaperPage({
    width: A4.width,
    height: A4.height,
    name: "A4",
    template: "ruled",
    ...options,
  });

describe("ruled paper writing", () => {
  it.each(["portrait", "landscape"] as const)(
    "uses the next real baseline inside a translated %s ruled cell",
    (orientation) => {
      const elements = paper({
        x: 150,
        y: 400,
        ...(orientation === "landscape"
          ? { width: A4.height, height: A4.width }
          : {}),
      });
      const page = getPaperPages(elements)[0];
      expect(
        getPaperTextPlacement({ sceneX: 230, sceneY: 494, elements }),
      ).toEqual({
        x: 230,
        baselineY: 504,
        width: page.x + page.width - 48 - 230,
        lineSpacing: 32,
        fontSize: 20,
      });
      expect(
        getPaperTextPlacement({ sceneX: 230, sceneY: 472, elements })
          ?.baselineY,
      ).toBe(472);
    },
  );

  it.each([
    [20, 94],
    [780, 94],
    [100, 20],
    [100, 1100],
    [100, 1150],
  ])("leaves margins and gaps at %s,%s as free text", (sceneX, sceneY) => {
    expect(
      getPaperTextPlacement({ sceneX, sceneY, elements: paper() }),
    ).toBeNull();
  });

  it("does not invent rulings on blank, PDF, or missing-rule pages", () => {
    const elements = paper();
    const page = getPaperPages(elements)[0];
    for (const kind of ["blank", "pdf"]) {
      expect(
        getPaperTextPlacement({
          sceneX: 100,
          sceneY: 94,
          elements: elements.map((element) =>
            element.id === page.id
              ? newElementWith(element, {
                  customData: { guziPaper: { version: 1, kind } },
                })
              : element,
          ),
        }),
      ).toBeNull();
    }
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 94, elements: [page] }),
    ).toBeNull();
  });

  it("preserves the top margin for large spacing and does not treat a missing rule as a wider grid", () => {
    const wide = paper({ settings: { lineSpacing: 96, fontSize: 72 } });
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 20, elements: wide }),
    ).toBeNull();
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 80, elements: wide }),
    ).toMatchObject({ baselineY: 136, lineSpacing: 96 });
    const elements = paper();
    const missing = elements.filter(
      (element) => !(element.type === "line" && element.y === 104),
    );
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 90, elements: missing }),
    ).toBeNull();
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 120, elements: missing }),
    ).toMatchObject({ baselineY: 136, lineSpacing: 32 });
  });

  it("retains legacy rule recognition when only the default size changes", () => {
    const legacy = paper().map((element) =>
      newElementWith(element, {
        customData:
          element.type === "frame"
            ? { guziPaper: { version: 1, kind: "ruled" } }
            : {},
      }),
    );
    const next = applyPaperSettings(legacy, { lineSpacing: 32, fontSize: 24 });
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 90, elements: next }),
    ).toMatchObject({ baselineY: 104, fontSize: 24 });
    expect(
      getPaperPages(next)[0].customData?.guziPaper.rulingVersion,
    ).toBeUndefined();
  });

  it("uses saved document spacing and default size without leaking into another file", () => {
    const original = paper();
    const changed = applyPaperSettings(original, {
      lineSpacing: 40,
      fontSize: 24,
    });
    const saved = JSON.parse(
      serializeAsJSON(changed, getDefaultAppState(), {}, "local"),
    );
    const restored = restoreElements(saved.elements, null);
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 94, elements: restored }),
    ).toMatchObject({ baselineY: 120, lineSpacing: 40, fontSize: 24 });
    expect(
      getPaperTextPlacement({ sceneX: 100, sceneY: 94, elements: original }),
    ).toMatchObject({ baselineY: 104, lineSpacing: 32, fontSize: 20 });
    expect(
      getPaperSettings(
        getPaperPages(appendPaperPage(restored)!.elements).at(-1)!,
      ),
    ).toEqual({ lineSpacing: 40, fontSize: 24 });
  });

  it("reflows only marked text while retaining free text, user ink and deleted elements", () => {
    const elements = paper();
    const page = getPaperPages(elements)[0];
    const initial = newTextElement({
      x: 100,
      y: 80,
      text: "第一行\n第二行",
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      customData: {
        guziRuledText: { version: 1, lineSpacing: 32 },
        other: true,
      },
    });
    const aligned = newElementWith(initial, {
      ...getRuledTextTypography(initial.fontFamily, 20, 104, 32),
      width: 400,
      height: 64,
      autoResize: false,
    });
    const free: ExcalidrawTextElement = {
      ...initial,
      id: "free",
      customData: { other: true },
    };
    const deleted: ExcalidrawTextElement = {
      ...free,
      id: "deleted",
      isDeleted: true,
    };
    const ink = newLinearElement({
      type: "line",
      x: 48,
      y: 104,
      width: A4.width - 96,
      height: 0,
      points: [
        [0, 0],
        [A4.width - 96, 0],
      ] as LocalPoint[],
      strokeColor: "#c8d5e3",
      locked: true,
      frameId: page.id,
    });
    const input = syncInvalidIndices([
      ...elements,
      aligned,
      free,
      deleted,
      ink,
    ]);
    const next = applyPaperSettings(input, { lineSpacing: 40, fontSize: 28 });
    const text = next.find(
      (element) => element.id === aligned.id,
    ) as ExcalidrawTextElement;
    expect(getRuledTextBaseline(text)).toBeCloseTo(120);
    expect(text.lineHeight * text.fontSize).toBe(40);
    expect(text.height).toBe(80);
    expect(text.fontSize).toBe(20);
    expect(text.customData?.other).toBe(true);
    for (const id of [free.id, ink.id, deleted.id]) {
      expect(next.find((element) => element.id === id)).toEqual(
        input.find((element) => element.id === id),
      );
    }
    const newPage = getPaperPages(next)[0];
    const activeRuleIndexes = next.flatMap((element, index) =>
      isPaperRule(element, newPage) ? [index] : [],
    );
    const backgroundIndex = next.findIndex(
      (element) => element.type === "rectangle" && element.frameId === page.id,
    );
    expect(Math.min(...activeRuleIndexes)).toBeGreaterThan(backgroundIndex);
    expect(Math.max(...activeRuleIndexes)).toBeLessThan(
      next.findIndex((element) => element.id === aligned.id),
    );
    expect(
      elements
        .filter((element) => isPaperRule(element, page))
        .every(
          (rule) => next.find((element) => element.id === rule.id)?.isDeleted,
        ),
    ).toBe(true);
  });

  it("shrinks existing ruled text when tighter rows require it, but default-size changes do not alter existing text", () => {
    const elements = paper();
    const text = newTextElement({
      x: 100,
      y: 75,
      text: "原有文字",
      fontSize: 24,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      customData: { guziRuledText: { version: 1, lineSpacing: 32 } },
    });
    const input = syncInvalidIndices([...elements, text]);
    const defaultOnly = applyPaperSettings(input, {
      lineSpacing: 32,
      fontSize: 12,
    });
    expect(defaultOnly.find((element) => element.id === text.id)).toEqual(
      input.find((element) => element.id === text.id),
    );
    expect(
      defaultOnly.filter((element) => element.type === "line"),
    ).toHaveLength(
      elements.filter((element) => element.type === "line").length,
    );
    const tight = applyPaperSettings(defaultOnly, {
      lineSpacing: 16,
      fontSize: 12,
    });
    const fitted = tight.find(
      (element) => element.id === text.id,
    ) as ExcalidrawTextElement;
    expect(fitted.fontSize).toBeLessThan(24);
    expect(fitted.lineHeight * fitted.fontSize).toBe(16);
  });

  it("updates every ruled page in a file, preserves page identities, and supports old unmarked templates", () => {
    const first = paper().map((element) =>
      newElementWith(element, {
        customData:
          element.type === "frame"
            ? { guziPaper: { version: 1, kind: "ruled" } }
            : {},
      }),
    );
    const second = paper({ y: A4.height + 48 });
    const next = applyPaperSettings([...first, ...second], {
      lineSpacing: 48,
      fontSize: 30,
    });
    expect(getPaperPages(next).map((page) => page.id)).toEqual(
      getPaperPages([...first, ...second]).map((page) => page.id),
    );
    for (const page of getPaperPages(next)) {
      expect(getPaperSettings(page)).toEqual({ lineSpacing: 48, fontSize: 30 });
      const rules = next.filter((element) => isPaperRule(element, page));
      expect(rules[1].y - rules[0].y).toBe(48);
    }
  });

  it("moves bound arrow endpoints with reflowed text without mutating the source scene", () => {
    const text = newTextElement({
      x: 300,
      y: 80,
      text: "横线文字",
      fontFamily: 1,
      fontSize: 20,
      textAlign: "left",
      verticalAlign: "top",
      customData: { guziRuledText: { version: 1, lineSpacing: 32 } },
    });
    const aligned = newElementWith(text, {
      ...getRuledTextTypography(text.fontFamily, 20, 104, 32),
      width: 200,
      height: 32,
      autoResize: false,
    });
    const arrow = newElementWith(
      newArrowElement({
        type: "arrow",
        x: 100,
        y: aligned.y + 16,
        width: 200,
        height: 0,
        points: [
          [0, 0],
          [200, 0],
        ] as LocalPoint[],
      }),
      {
        endBinding: {
          elementId: aligned.id,
          mode: "inside",
          fixedPoint: [0, 0.5],
        },
      },
    );
    const bound = newElementWith(aligned, {
      boundElements: [{ id: arrow.id, type: "arrow" }],
    });
    const original = [...paper(), bound, arrow];
    const before = JSON.stringify(original);
    const next = applyPaperSettings(original, {
      lineSpacing: 48,
      fontSize: 20,
    });
    const movedArrow = next.find(
      (element) => element.id === arrow.id,
    ) as typeof arrow;
    const movedText = next.find(
      (element) => element.id === text.id,
    ) as ExcalidrawTextElement;
    const endpoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
      movedArrow,
      -1,
      new Map(next.map((element) => [element.id, element])),
    );
    expect(endpoint[1]).toBeCloseTo(movedText.y + movedText.height / 2, 1);
    expect(JSON.stringify(original)).toBe(before);
  });
});
