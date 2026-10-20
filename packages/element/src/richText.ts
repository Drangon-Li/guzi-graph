import { getFontString } from "@excalidraw/common";

import { getLineWidth } from "./textMeasurements";

import type { ExcalidrawTextElement, FontString } from "./types";

export type RichTextRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  background?: string;
};

export type RichTextParagraph = {
  runs: RichTextRun[];
  list?: { kind: "ordered" | "bullet"; indent: number };
};

export type RichTextDocument = {
  version: 1;
  paragraphs: RichTextParagraph[];
};

export const richTextFromPlainText = (text: string): RichTextDocument => ({
  version: 1,
  paragraphs: text.split("\n").map((text) => ({ runs: [{ text }] })),
});

export const richTextToPlainText = (document: RichTextDocument) =>
  document.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

export const normalizeRichTextBackground = (
  value: unknown,
): string | undefined =>
  typeof value === "string" &&
  /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(value)
    ? value
    : undefined;

export const normalizeRichText = (
  value: unknown,
): RichTextDocument | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const document = value as RichTextDocument;
  if (document.version !== 1 || !Array.isArray(document.paragraphs)) {
    return undefined;
  }
  const paragraphs: RichTextParagraph[] = [];
  for (const paragraph of document.paragraphs) {
    if (!paragraph || !Array.isArray(paragraph.runs)) {
      return undefined;
    }
    const runs: RichTextRun[] = [];
    for (const run of paragraph.runs) {
      if (!run || typeof run.text !== "string") {
        return undefined;
      }
      runs.push({
        text: run.text,
        ...(run.bold && { bold: true }),
        ...(run.italic && { italic: true }),
        ...(run.underline === true && { underline: true }),
        ...(normalizeRichTextBackground(run.background) && {
          background: run.background,
        }),
      });
    }
    const list = paragraph.list;
    paragraphs.push({
      runs,
      ...(list &&
        (list.kind === "ordered" || list.kind === "bullet") && {
          list: {
            kind: list.kind,
            indent: Math.max(0, Math.min(8, Math.floor(list.indent) || 0)),
          },
        }),
    });
  }
  return {
    version: 1,
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }],
  };
};

export const getRichTextFont = (
  element: Pick<ExcalidrawTextElement, "fontSize" | "fontFamily">,
  run: RichTextRun,
): FontString =>
  `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${getFontString(
    element,
  )}` as FontString;

export type RichTextLayoutRun = RichTextRun & {
  x: number;
  y: number;
  width: number;
};
export type RichTextLayoutLine = {
  runs: RichTextLayoutRun[];
  width: number;
  y: number;
  paragraph: number;
  last: boolean;
};

export const getRichTextUnderline = (
  run: Pick<RichTextLayoutRun, "x" | "y" | "width">,
  fontSize: number,
  baseline: number,
) => ({
  x: run.x,
  y: run.y + baseline + Math.max(1, fontSize * 0.06),
  width: run.width,
  height: Math.max(1, fontSize * 0.05),
});

/** One layout feeds measurement, the canvas, and SVG export. */
export const layoutRichText = (
  element: Pick<
    ExcalidrawTextElement,
    | "fontSize"
    | "fontFamily"
    | "lineHeight"
    | "textAlign"
    | "richText"
    | "originalText"
    | "paragraphSpacing"
  >,
  maxWidth = Infinity,
) => {
  const document =
    element.richText ?? richTextFromPlainText(element.originalText);
  const lines: RichTextLayoutLine[] = [];
  const lineHeight = element.fontSize * element.lineHeight;
  let y = 0;
  let width = 0;
  const counters: number[] = [];
  document.paragraphs.forEach((paragraph, paragraphIndex) => {
    const list = paragraph.list;
    const indent = list ? (list.indent + 1) * element.fontSize * 1.5 : 0;
    if (list?.kind === "ordered") {
      counters[list.indent] = (counters[list.indent] ?? 0) + 1;
      counters.length = list.indent + 1;
    } else if (list?.kind === "bullet") {
      counters.length = list.indent;
    } else if (!list) {
      counters.length = 0;
    }
    const marker = list
      ? list.kind === "bullet"
        ? "• "
        : `${counters[list.indent]}. `
      : "";
    type Glyph = { text: string; run: RichTextRun; width: number };
    const glyphs: Glyph[] = paragraph.runs.flatMap((run) =>
      Array.from(run.text).map((text) => ({
        text,
        run,
        width: getLineWidth(text, getRichTextFont(element, run)),
      })),
    );
    let pending: Glyph[] = [];
    let pendingWidth = 0;
    let first = true;
    const flush = (last: boolean) => {
      const naturalWidth = pending.reduce((sum, glyph) => sum + glyph.width, 0);
      const available = Number.isFinite(maxWidth)
        ? Math.max(0, maxWidth - indent)
        : naturalWidth;
      const spaces = pending.filter((glyph) => /\s/.test(glyph.text)).length;
      const justify = element.textAlign === "justify" && !last && spaces > 0;
      const extra = justify
        ? Math.max(0, available - naturalWidth) / spaces
        : 0;
      let x =
        indent +
        (element.textAlign === "center"
          ? (available - naturalWidth) / 2
          : element.textAlign === "right"
          ? available - naturalWidth
          : 0);
      const runs: RichTextLayoutRun[] = [];
      if (first && marker) {
        const markerWidth = getLineWidth(marker, getFontString(element));
        runs.push({
          text: marker,
          x: indent - markerWidth,
          y,
          width: markerWidth,
        });
      }
      for (const glyph of pending) {
        const glyphWidth = glyph.width + (/\s/.test(glyph.text) ? extra : 0);
        const previous = runs[runs.length - 1];
        if (
          previous &&
          !(first && marker && runs.length === 1) &&
          !justify &&
          previous.bold === glyph.run.bold &&
          previous.italic === glyph.run.italic &&
          previous.underline === glyph.run.underline &&
          previous.background === glyph.run.background &&
          previous.x + previous.width === x
        ) {
          previous.text += glyph.text;
          previous.width += glyphWidth;
        } else {
          runs.push({
            ...glyph.run,
            text: glyph.text,
            x,
            y,
            width: glyphWidth,
          });
        }
        x += glyphWidth;
      }
      lines.push({
        runs,
        width: indent + naturalWidth,
        y,
        paragraph: paragraphIndex,
        last,
      });
      width = Math.max(width, indent + naturalWidth);
      y += lineHeight;
      first = false;
      pending = [];
      pendingWidth = 0;
    };
    for (const glyph of glyphs) {
      if (glyph.text === "\n") {
        flush(false);
        continue;
      }
      if (
        pending.length &&
        pendingWidth + glyph.width > Math.max(1, maxWidth - indent)
      ) {
        let breakAt = pending.length;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (/\s/.test(pending[i].text)) {
            breakAt = i + 1;
            break;
          }
        }
        const remainder = pending.slice(breakAt);
        pending = pending.slice(0, breakAt);
        flush(false);
        pending = remainder;
        pendingWidth = remainder.reduce((sum, item) => sum + item.width, 0);
      }
      pending.push(glyph);
      pendingWidth += glyph.width;
    }
    flush(true);
    if (paragraphIndex < document.paragraphs.length - 1) {
      y += (element.paragraphSpacing ?? 0) * element.fontSize;
    }
  });
  if (
    !Number.isFinite(maxWidth) &&
    (element.textAlign === "center" || element.textAlign === "right")
  ) {
    for (const line of lines) {
      const shift =
        (width - line.width) / (element.textAlign === "center" ? 2 : 1);
      line.runs.forEach((run) => {
        run.x += shift;
      });
    }
  }
  return {
    lines,
    width,
    height: y || lineHeight,
    text: lines
      .map((line) => line.runs.map((run) => run.text).join(""))
      .join("\n"),
  };
};
