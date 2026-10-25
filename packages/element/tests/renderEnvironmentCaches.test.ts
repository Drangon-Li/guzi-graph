import { describe, it, expect } from "vitest";

import {
  charWidth,
  getMaxCharWidth,
  getTextWidth,
} from "../src/textMeasurements";
import {
  newStickyNoteElement,
  newTextElement,
  refreshTextDimensions,
} from "../src/newElement";
import { layoutRichText, richTextFromPlainText } from "../src/richText";
import { getStickyNoteLayout } from "../src/stickyNote";
import {
  createTableData,
  createTableElements,
  updateTableElements,
} from "../src/table";

import type { RenderEnvironment } from "../src/renderEnvironment";
import type { FontString } from "../src/types";

const FONT = "20px Excalifont" as FontString;

// in the test env the canvas provider multiplies the mocked advance width
// (character count) by 10, so an env measuring different widths is observable
const makeEnv = (perChar: number): RenderEnvironment => ({
  createCanvas: () =>
    ({
      getContext: () => ({
        font: "",
        measureText: (text: string) => ({ width: text.length * perChar }),
      }),
    } as unknown as HTMLCanvasElement),
  createImage: () => ({} as HTMLImageElement),
});

/**
 * Everything the renderer memoizes per host realm (text metrics providers,
 * element bitmaps, link icons) is keyed on the render environment's identity,
 * so a swap must invalidate rather than serve one realm's pixels to another.
 */
describe("render environment cache invalidation", () => {
  it("uses the selected environment throughout rich text creation and refresh", () => {
    const env: RenderEnvironment = {
      ...makeEnv(1),
      textMetrics: { getLineWidth: (text) => text.length * 20 },
    };
    const text = newTextElement({
      x: 0,
      y: 0,
      text: "abcdef",
      richText: richTextFromPlainText("abcdef"),
      renderEnvironment: env,
    });
    expect(text.width).toBe(120);
    const refreshed = refreshTextDimensions(
      { ...text, width: 60 },
      null,
      new Map(),
      text.originalText,
      60,
      env,
    );
    expect(refreshed).toMatchObject({
      width: 60,
      text: "abc\ndef",
      autoResize: false,
    });
    const list = {
      ...text,
      richText: {
        version: 1 as const,
        paragraphs: [
          {
            list: { kind: "bullet" as const, indent: 0 },
            runs: [{ text: "ab", bold: true }],
          },
        ],
      },
    };
    const line = layoutRichText(list, Infinity, env).lines[0];
    expect(line.runs.map(({ width }) => width)).toEqual([40, 40]);
  });

  it("uses the selected environment when fitting rich text in notes and tables", () => {
    const narrow: RenderEnvironment = {
      ...makeEnv(1),
      textMetrics: { getLineWidth: (text) => text.length },
    };
    const wide: RenderEnvironment = {
      ...makeEnv(1),
      textMetrics: { getLineWidth: (text) => text.length * 40 },
    };
    const text = newTextElement({
      x: 0,
      y: 0,
      text: "abcdefghij",
      richText: richTextFromPlainText("abcdefghij"),
    });
    const note = newStickyNoteElement({ type: "stickynote", x: 0, y: 0 });
    expect(
      getStickyNoteLayout(note, text, { renderEnvironment: narrow }).text
        ?.width,
    ).toBeLessThan(
      getStickyNoteLayout(note, text, { renderEnvironment: wide }).text!.width,
    );
    const data = createTableData(1, 1);
    data.columns = [96];
    data.cells[0].text = text.originalText;
    data.cells[0].richText = text.richText;
    const { root, elements } = createTableElements(data, 0, 0, {}, narrow);
    const rebuilt = updateTableElements(elements, root, (data) => data, wide);
    expect(
      rebuilt.find((element) => element.id === root.id)!.height,
    ).toBeGreaterThan(root.height);
    expect(rebuilt.find((element) => element.type === "text")).toMatchObject({
      text: "ab\ncd\nef\ngh\nij",
    });
  });

  it("builds a text metrics provider per environment", () => {
    const makeCountingEnv = () => {
      const canvases: HTMLCanvasElement[] = [];
      const env: RenderEnvironment = {
        createCanvas: () => {
          const canvas = document.createElement("canvas");
          canvases.push(canvas);
          return canvas;
        },
        createImage: () => ({} as HTMLImageElement),
      };
      return { env, canvases };
    };
    const first = makeCountingEnv();
    const second = makeCountingEnv();

    // builds + caches the provider's canvas
    getTextWidth("measure me", FONT, first.env);
    getTextWidth("measure me twice", FONT, first.env);
    expect(first.canvases).toHaveLength(1);

    getTextWidth("measure me again", FONT, second.env);

    // measured on a canvas of its own rather than the first env's
    expect(second.canvases).toHaveLength(1);
    expect(first.canvases).toHaveLength(1);
  });

  it("never serves one environment's char widths to another", () => {
    const env = makeEnv(3);

    expect(charWidth.calculate("A", FONT, env)).toBe(30);
    // switching env drops the cache rather than reusing the other env's width
    expect(charWidth.calculate("A", FONT)).toBe(10);
    expect(charWidth.getCache(FONT, env)).toBeUndefined();
    // cached while the env stays put
    expect(charWidth.calculate("A", FONT, env)).toBe(30);
    expect(charWidth.getCache(FONT, env)?.["A".charCodeAt(0)]).toBe(30);

    // clearing a font drops the entry rather than emptying it, so the
    // approximation helpers fall back to measuring
    charWidth.clearCache(FONT);
    expect(charWidth.getCache(FONT, env)).toBeUndefined();
    expect(getMaxCharWidth(FONT, env)).toBe(0);

    charWidth.calculate("A", FONT, env);
    expect(getMaxCharWidth(FONT, env)).toBe(30);
    // ...and asking about a different env reports "unmeasured", not 30
    expect(getMaxCharWidth(FONT)).toBe(0);
  });
});
