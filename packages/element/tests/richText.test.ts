import "@excalidraw/element";

import { FONT_FAMILY, getVerticalOffset } from "@excalidraw/common";

import type { getLineHeight } from "@excalidraw/common";

import {
  layoutRichText,
  getRichTextUnderline,
  normalizeRichText,
  richTextFromPlainText,
  richTextToPlainText,
} from "../src/richText";
import { newTextElement, refreshTextDimensions } from "../src/newElement";

const element = (
  text: string,
  updates: Partial<ReturnType<typeof newTextElement>> = {},
) => ({
  ...newTextElement({
    x: 0,
    y: 0,
    text,
    fontFamily: FONT_FAMILY.Helvetica,
    fontSize: 20,
  }),
  ...updates,
});

describe("rich text layout", () => {
  it("initializes justification through rich layout while preserving ordinary text", () => {
    expect(element("ordinary").richText).toBeUndefined();
    const justified = newTextElement({
      x: 0,
      y: 0,
      text: "a b c d",
      textAlign: "justify",
      fontSize: 20,
      fontFamily: FONT_FAMILY.Helvetica,
      autoResize: false,
      width: 50,
    });
    expect(justified.richText).toEqual(richTextFromPlainText("a b c d"));
    expect(layoutRichText(justified, 50).lines).toHaveLength(2);
  });
  it("round-trips paragraph breaks and inline marks without adding list markers to the plain text", () => {
    const document = richTextFromPlainText("中文\nEnglish\n");
    document.paragraphs[0].runs[0].bold = true;
    document.paragraphs[1].list = { kind: "ordered", indent: 1 };
    expect(
      richTextToPlainText(
        normalizeRichText(JSON.parse(JSON.stringify(document)))!,
      ),
    ).toBe("中文\nEnglish\n");
    expect(normalizeRichText({ version: 2, paragraphs: [] })).toBeUndefined();
    expect(
      normalizeRichText({
        version: 1,
        paragraphs: [{ runs: [{ text: 123 }] }],
      }),
    ).toBeUndefined();
  });

  it("preserves inline styling when wrapping through Chinese and Latin text", () => {
    const text = element("中文English", {
      autoResize: false,
      width: 50,
      richText: {
        version: 1,
        paragraphs: [
          {
            runs: [
              { text: "中文", bold: true },
              { text: "English", italic: true, background: "#fff3bf" },
            ],
          },
        ],
      },
    });
    const layout = layoutRichText(text, 50);
    expect(layout.lines.length).toBeGreaterThan(1);
    const runs = layout.lines.flatMap((line) => line.runs);
    expect(
      runs
        .filter((run) => run.bold)
        .map((run) => run.text)
        .join(""),
    ).toBe("中文");
    expect(
      runs
        .filter((run) => run.italic)
        .map((run) => run.text)
        .join(""),
    ).toBe("English");
    expect(
      runs
        .filter((run) => run.italic)
        .every((run) => run.background === "#fff3bf"),
    ).toBe(true);
    expect(layout.height).toBe(
      layout.lines.length * text.fontSize * text.lineHeight,
    );
  });

  it("separates paragraph spacing from line spacing and never adds a trailing paragraph gap", () => {
    const text = element("abcde\nf", {
      richText: richTextFromPlainText("abcde\nf"),
      paragraphSpacing: 0.5,
      lineHeight: 1.5 as ReturnType<typeof getLineHeight>,
    });
    const layout = layoutRichText(text, 30);
    expect(layout.height).toBe(layout.lines.length * 30 + 10);
    expect(layout.lines.filter((line) => line.paragraph === 1)[0].y).toBe(70);
  });

  it("justifies wrapped lines and leaves the final line at its natural width", () => {
    const text = element("a b c d", {
      richText: richTextFromPlainText("a b c d"),
      textAlign: "justify",
      width: 50,
      autoResize: false,
    });
    const layout = layoutRichText(text, 50);
    expect(layout.lines.length).toBe(2);
    const first = layout.lines[0].runs;
    const last = layout.lines[1].runs;
    expect(first[first.length - 1].x + first[first.length - 1].width).toBe(50);
    expect(last[last.length - 1].x + last[last.length - 1].width).toBeLessThan(
      50,
    );
    expect(last[0].x).toBe(0);
  });

  it("numbers list items at each depth and wraps continuations with a hanging indent", () => {
    const richText = richTextFromPlainText("abcde\nsecond\nnested\nthird");
    richText.paragraphs.forEach((paragraph, index) => {
      paragraph.list = { kind: "ordered", indent: index === 2 ? 1 : 0 };
    });
    const text = element(richTextToPlainText(richText), { richText });
    const layout = layoutRichText(text, 70);
    expect(
      layout.lines
        .filter((line) => line.runs[0]?.text.match(/^\d+\. /))
        .map((line) => line.runs[0].text),
    ).toEqual(["1. ", "2. ", "1. ", "3. "]);
    const continuation = layout.lines.find(
      (line) => line.paragraph === 0 && line.runs[0]?.text !== "1. ",
    )!;
    expect(continuation.runs[0].x).toBe(30);
  });

  it("uses identical layout for text dimension refresh while leaving legacy text unchanged", () => {
    const rich = element("abcdef", {
      richText: richTextFromPlainText("abcdef"),
      width: 30,
      autoResize: false,
    });
    const layout = layoutRichText(rich, 30);
    expect(refreshTextDimensions(rich, null, new Map())).toMatchObject({
      text: layout.text,
      width: 30,
      height: layout.height,
    });
    const legacy = element("abcdef");
    expect(legacy.richText).toBeUndefined();
    expect(refreshTextDimensions(legacy, null, new Map())?.text).toBe("abcdef");
  });

  it("persists underline marks and keeps marked and unmarked runs separate without changing measurements", async () => {
    const { serializeAsJSON } = await import(
      "@excalidraw/excalidraw/data/json"
    );
    const { restoreElements } = await import(
      "@excalidraw/excalidraw/data/restore"
    );
    const text = element("plainmarkedplain", {
      richText: {
        version: 1,
        paragraphs: [
          {
            runs: [
              { text: "plain" },
              {
                text: "marked",
                underline: true,
                bold: true,
                italic: true,
                background: "#fff3bf",
              },
              { text: "plain" },
            ],
          },
        ],
      },
    });
    const normalized = normalizeRichText(
      JSON.parse(JSON.stringify(text.richText)),
    )!;
    expect(normalized.paragraphs[0].runs[1]).toEqual(
      text.richText!.paragraphs[0].runs[1],
    );
    const restored = restoreElements(
      JSON.parse(serializeAsJSON([text], {}, {}, "local")).elements,
      null,
    );
    expect(
      restored.find((element) => element.type === "text")?.richText,
    ).toEqual(normalized);
    const layout = layoutRichText(text);
    expect(layout.lines[0].runs.map((run) => run.text)).toEqual([
      "plain",
      "marked",
      "plain",
    ]);
    expect(
      layoutRichText(
        element("abc", {
          richText: {
            version: 1,
            paragraphs: [
              {
                runs: [
                  { text: "a" },
                  { text: "b", underline: true },
                  { text: "c" },
                ],
              },
            ],
          },
        }),
      ).lines[0].runs.map((run) => run.text),
    ).toEqual(["a", "b", "c"]);
    const plain = layoutRichText({
      ...text,
      richText: {
        version: 1,
        paragraphs: [
          {
            runs: text.richText!.paragraphs[0].runs.map(
              ({ underline, ...run }) => run,
            ),
          },
        ],
      },
    });
    expect({
      width: layout.width,
      height: layout.height,
      text: layout.text,
    }).toEqual({ width: plain.width, height: plain.height, text: plain.text });
  });

  it.each([20, 40])(
    "exports matching Canvas and SVG underlines with highlights, wrapping and justified spaces at %spx",
    async (fontSize) => {
      const { exportToCanvas, exportToSvg } = await import(
        "@excalidraw/excalidraw/scene/export"
      );
      const { getDefaultAppState } = await import(
        "@excalidraw/excalidraw/appState"
      );
      const text = element("a b c d", {
        fontSize,
        strokeColor: "#123456",
        autoResize: false,
        width: 50,
        textAlign: "justify",
        richText: {
          version: 1,
          paragraphs: [
            {
              runs: [
                {
                  text: "a b c ",
                  bold: true,
                  italic: true,
                  underline: true,
                  background: "#fff3bf",
                },
                { text: "d", bold: true, italic: true },
              ],
            },
          ],
        },
      });
      const layout = layoutRichText(text, text.width);
      const renderedText = { ...text, height: layout.height };
      const baseline = getVerticalOffset(
        text.fontFamily,
        fontSize,
        fontSize * text.lineHeight,
      );
      const underlines = layout.lines.flatMap((line) =>
        line.runs
          .filter((run) => run.underline)
          .map((run) => getRichTextUnderline(run, fontSize, baseline)),
      );
      expect(layout.lines.length).toBeGreaterThan(1);
      expect(
        layout.lines[0].runs.at(-1)!.x + layout.lines[0].runs.at(-1)!.width,
      ).toBe(text.width);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      const spy = vi.spyOn(context, "fillRect");
      try {
        await exportToCanvas(
          [renderedText],
          {
            ...getDefaultAppState(),
            width: 800,
            height: 600,
            offsetTop: 0,
            offsetLeft: 0,
          },
          {},
          { exportBackground: false, viewBackgroundColor: "#fff" },
          (width, height) => {
            canvas.width = width * 2;
            canvas.height = height * 2;
            return { canvas, scale: 2 };
          },
          async () => {},
        );
        expect(
          spy.mock.calls
            .filter(([, , , height]) => height === Math.max(1, fontSize * 0.05))
            .map(([x, y, width, height]) => ({ x, y, width, height })),
        ).toEqual(underlines);
        expect(
          spy.mock.calls.some(
            ([, , , height]) => height === fontSize * text.lineHeight,
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
      const svg = await exportToSvg(
        [renderedText],
        { exportBackground: false, viewBackgroundColor: "#fff" },
        {},
        { skipInliningFonts: true },
      );
      expect(
        Array.from(svg.querySelectorAll('rect[fill="#123456"]')).map(
          (rect) => ({
            x: Number(rect.getAttribute("x")),
            y: Number(rect.getAttribute("y")),
            width: Number(rect.getAttribute("width")),
            height: Number(rect.getAttribute("height")),
          }),
        ),
      ).toEqual(underlines);
      expect(
        svg.querySelector('text[font-weight="bold"][font-style="italic"]'),
      ).not.toBeNull();
      expect(svg.querySelector('rect[fill="#fff3bf"]')).not.toBeNull();
    },
  );
});
