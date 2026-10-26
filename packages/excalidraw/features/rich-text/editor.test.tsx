import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  HISTORY_PUSH_TAG,
  KEY_ENTER_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  type LexicalEditor,
} from "lexical";
import { ListItemNode, ListNode, registerList } from "@lexical/list";
import { registerRichText } from "@lexical/rich-text";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import {
  richTextFromPlainText,
  richTextToPlainText,
} from "@excalidraw/element";

import type { RichTextDocument } from "@excalidraw/element";

import {
  $readRichText,
  $writeRichText,
  $getRichTextSelectionOffsets,
  applyRichTextEditorCommand,
} from "./editor";

const read = (editor: LexicalEditor) =>
  editor.getEditorState().read($readRichText);
const flush = (editor: LexicalEditor) =>
  editor.update(() => {}, { discrete: true });

describe("Lexical rich text editing", () => {
  let editor: LexicalEditor;
  let cleanups: (() => void)[];
  beforeEach(() => {
    editor = createEditor({
      namespace: "test",
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error;
      },
    });
    cleanups = [
      registerRichText(editor),
      registerList(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
    ];
  });
  afterEach(() => cleanups.forEach((cleanup) => cleanup()));

  it.each([false, true])(
    "restores forward and backward ranges across paragraphs and nested lists (backward=%s)",
    (backward) => {
      const document = richTextFromPlainText("first\n\n中文\nlist\nnested");
      document.paragraphs[3].list = { kind: "bullet", indent: 0 };
      document.paragraphs[4].list = { kind: "bullet", indent: 1 };
      const selection = backward
        ? { start: 17, end: 8 }
        : { start: 8, end: 17 };
      editor.update(() => $writeRichText(document, selection), {
        discrete: true,
      });
      editor.update(
        () => {
          const offsets = $getRichTextSelectionOffsets();
          expect(offsets).toEqual(selection);
          $writeRichText(document, offsets);
          expect($getRichTextSelectionOffsets()).toEqual(selection);
        },
        { discrete: true },
      );
    },
  );

  it("round trips paragraphs, nested lists and partial inline styles", () => {
    const document: RichTextDocument = {
      version: 1,
      paragraphs: [
        {
          runs: [
            { text: "普通" },
            { text: "加粗", bold: true },
            {
              text: "底色",
              italic: true,
              underline: true,
              background: "#fff3bf",
              color: "#e03131",
              fontSizeScale: 1.5,
            },
          ],
        },
        { runs: [{ text: "一" }], list: { kind: "ordered", indent: 0 } },
        { runs: [{ text: "子项" }], list: { kind: "bullet", indent: 1 } },
        { runs: [{ text: "二" }], list: { kind: "ordered", indent: 0 } },
      ],
    };
    editor.update(() => $writeRichText(document), { discrete: true });
    expect(read(editor)).toEqual(document);
  });

  it("formats the selected Chinese characters without changing surrounding text", () => {
    editor.update(
      () =>
        $writeRichText(richTextFromPlainText("abc中文def"), {
          start: 3,
          end: 5,
        }),
      { discrete: true },
    );
    applyRichTextEditorCommand(editor, { type: "bold" });
    flush(editor);
    const document = read(editor);
    expect(document.paragraphs[0].runs).toEqual([
      { text: "abc" },
      { text: "中文", bold: true },
      { text: "def" },
    ]);
    expect(richTextToPlainText(document)).toBe("abc中文def");
    applyRichTextEditorCommand(editor, { type: "italic" });
    applyRichTextEditorCommand(editor, { type: "underline" });
    applyRichTextEditorCommand(editor, {
      type: "background",
      value: "#fff3bf",
    });
    flush(editor);
    expect(read(editor).paragraphs[0].runs[1]).toMatchObject({
      text: "中文",
      bold: true,
      italic: true,
      underline: true,
      background: "#fff3bf",
    });
    applyRichTextEditorCommand(editor, { type: "underline" });
    flush(editor);
    expect(read(editor).paragraphs[0].runs).toEqual([
      { text: "abc" },
      { text: "中文", bold: true, italic: true, background: "#fff3bf" },
      { text: "def" },
    ]);
  });

  it("colors a selection across styled runs while retaining backgrounds and history", () => {
    const document: RichTextDocument = {
      version: 1,
      paragraphs: [
        {
          runs: [
            { text: "abc", bold: true, background: "#fff3bf" },
            { text: "中文", italic: true, color: "#1971c2" },
            { text: "def", underline: true },
          ],
        },
      ],
    };
    editor.update(() => $writeRichText(document, { start: 1, end: 6 }), {
      discrete: true,
    });
    editor.update(
      () =>
        applyRichTextEditorCommand(editor, { type: "color", value: "#e03131" }),
      { discrete: true, tag: HISTORY_PUSH_TAG },
    );
    const colored = read(editor);
    expect(colored.paragraphs[0].runs).toEqual([
      { text: "a", bold: true, background: "#fff3bf" },
      { text: "bc", bold: true, background: "#fff3bf", color: "#e03131" },
      { text: "中文", italic: true, color: "#e03131" },
      { text: "d", underline: true, color: "#e03131" },
      { text: "ef", underline: true },
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    flush(editor);
    expect(read(editor)).toEqual(document);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    flush(editor);
    expect(read(editor)).toEqual(colored);
  });

  it("sizes a backward selection across paragraphs and restores styles with undo/redo", () => {
    const document: RichTextDocument = {
      version: 1,
      paragraphs: [
        { runs: [{ text: "abc", bold: true, fontSizeScale: 1.5 }] },
        { runs: [{ text: "中文z", color: "#e03131" }] },
      ],
    };
    editor.update(() => $writeRichText(document, { start: 6, end: 1 }), {
      discrete: true,
    });
    editor.update(
      () =>
        applyRichTextEditorCommand(editor, {
          type: "fontSize",
          value: 40,
          baseFontSize: 20,
        }),
      { discrete: true, tag: HISTORY_PUSH_TAG },
    );
    const sized = read(editor);
    expect(sized.paragraphs).toEqual([
      {
        runs: [
          { text: "a", bold: true, fontSizeScale: 1.5 },
          { text: "bc", bold: true, fontSizeScale: 2 },
        ],
      },
      {
        runs: [
          { text: "中文", color: "#e03131", fontSizeScale: 2 },
          { text: "z", color: "#e03131" },
        ],
      },
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    flush(editor);
    expect(read(editor)).toEqual(document);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    flush(editor);
    expect(read(editor)).toEqual(sized);
  });

  it("increases mixed selected sizes relative to each run and removes the default scale", () => {
    editor.update(
      () =>
        $writeRichText(
          {
            version: 1,
            paragraphs: [
              {
                runs: [
                  { text: "a" },
                  { text: "中文", fontSizeScale: 2 },
                  { text: "z" },
                ],
              },
            ],
          },
          { start: 0, end: 3 },
        ),
      { discrete: true },
    );
    applyRichTextEditorCommand(editor, {
      type: "fontSize",
      scale: 1.1,
      baseFontSize: 20,
    });
    flush(editor);
    expect(read(editor).paragraphs[0].runs).toEqual([
      { text: "a", fontSizeScale: 1.1 },
      { text: "中文", fontSizeScale: 2.2 },
      { text: "z" },
    ]);
    applyRichTextEditorCommand(editor, {
      type: "fontSize",
      value: 20,
      baseFontSize: 20,
    });
    flush(editor);
    expect(read(editor).paragraphs[0].runs).toEqual([
      { text: "a中文" },
      { text: "z" },
    ]);
  });

  it("continues a list on Enter and exits an empty item on the next Enter", () => {
    const document = richTextFromPlainText("first");
    document.paragraphs[0].list = { kind: "ordered", indent: 0 };
    editor.update(() => $writeRichText(document, { start: 5, end: 5 }), {
      discrete: true,
    });
    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent("keydown", { key: "Enter" }),
    );
    flush(editor);
    expect(
      read(editor).paragraphs.map((paragraph) => paragraph.list?.kind),
    ).toEqual(["ordered", "ordered"]);
    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent("keydown", { key: "Enter" }),
    );
    flush(editor);
    expect(
      read(editor).paragraphs.map((paragraph) => paragraph.list?.kind),
    ).toEqual(["ordered", undefined]);
    expect(richTextToPlainText(read(editor))).toBe("first\n");
  });

  it("indents and outdents a list item through Lexical commands", () => {
    const document = richTextFromPlainText("first\nsecond");
    document.paragraphs.forEach((paragraph) => {
      paragraph.list = { kind: "bullet", indent: 0 };
    });
    editor.update(() => $writeRichText(document, { start: 6, end: 12 }), {
      discrete: true,
    });
    applyRichTextEditorCommand(editor, { type: "indent", value: "in" });
    flush(editor);
    expect(
      read(editor).paragraphs.map((paragraph) => paragraph.list?.indent),
    ).toEqual([0, 1]);
    applyRichTextEditorCommand(editor, { type: "indent", value: "out" });
    flush(editor);
    expect(
      read(editor).paragraphs.map((paragraph) => paragraph.list?.indent),
    ).toEqual([0, 0]);
  });

  it.each(["bold", "underline"] as const)(
    "undoes and redoes %s formatting while preserving content",
    (format) => {
      editor.update(
        () =>
          $writeRichText(richTextFromPlainText("text"), { start: 0, end: 4 }),
        { discrete: true },
      );
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.formatText(format);
          }
        },
        { discrete: true, tag: HISTORY_PUSH_TAG },
      );
      expect(read(editor).paragraphs[0].runs[0][format]).toBe(true);
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      flush(editor);
      expect(read(editor).paragraphs[0].runs[0][format]).toBeUndefined();
      editor.dispatchCommand(REDO_COMMAND, undefined);
      flush(editor);
      expect(read(editor).paragraphs[0].runs[0][format]).toBe(true);
      expect(
        editor.getEditorState().read(() => $getRoot().getTextContent()),
      ).toBe("text");
    },
  );
});
