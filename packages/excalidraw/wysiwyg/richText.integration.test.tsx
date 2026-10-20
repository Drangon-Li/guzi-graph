import {
  DEFAULT_ELEMENT_BACKGROUND_PICKS,
  FONT_FAMILY,
  KEYS,
} from "@excalidraw/common";
import {
  CaptureUpdateAction,
  isNonDeletedElement,
  layoutRichText,
  newElementWith,
  richTextFromPlainText,
} from "@excalidraw/element";
import { exportToCanvas } from "@excalidraw/utils";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { handleDesktopEditingCommand } from "../../../excalidraw-desktop/src/desktopEditing";

import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Keyboard } from "../tests/helpers/ui";
import { getTextEditor } from "../tests/queries/dom";
import { act, fireEvent, render, waitFor } from "../tests/test-utils";
import { exportToSvg } from "../scene/export";
import { restoreElements } from "../data/restore";
import { serializeAsJSON } from "../data/json";
import * as dataModule from "../data";

import {
  executeRichTextCommand,
  getRichTextSelectionState,
} from "./richTextEditorBridge";

import type {} from "../../../excalidraw-desktop/src/shared";

const { h } = window;
const getRichEditor = () =>
  document.querySelector<HTMLDivElement>(".excalidraw-rich-text")!;
const current = (id: string) =>
  h.app.scene.getElement<ExcalidrawTextElement>(id)!;

describe("rich text application integration", () => {
  let rendered: Awaited<ReturnType<typeof render>>;
  beforeAll(() => {
    vi.stubGlobal("DragEvent", class DragEvent extends Event {});
    vi.stubGlobal("ClipboardEvent", class ClipboardEvent extends Event {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    rendered = await render(<Excalidraw handleKeyboardGlobally />);
  });

  it("uses compact spacing presets and keeps custom numeric input inside its popover", async () => {
    const text = API.createElement({ type: "text", text: "first\nsecond" });
    API.setElements([text]);
    API.setSelectedElements([text]);
    const controls = rendered.container.querySelector(".rich-text-controls")!;
    expect(controls).not.toBeNull();
    expect(controls.querySelector('input[type="number"]')).toBeNull();
    expect(controls.querySelector('input[type="color"]')).toBeNull();
    expect(
      controls.querySelectorAll(".rich-text-list-row button"),
    ).toHaveLength(5);
    expect(
      Array.from(controls.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).not.toContain("B");
    const lists = controls.querySelectorAll(".rich-text-list-row button");
    fireEvent.click(lists[2]);
    expect(
      current(text.id).richText?.paragraphs.map((p) => p.list?.kind),
    ).toEqual(["ordered", "ordered"]);
    fireEvent.click(lists[4]);
    expect(
      current(text.id).richText?.paragraphs.map((p) => p.list?.indent),
    ).toEqual([1, 1]);
    fireEvent.click(lists[3]);
    expect(
      current(text.id).richText?.paragraphs.map((p) => p.list?.indent),
    ).toEqual([0, 0]);
    fireEvent.click(lists[0]);
    expect(current(text.id).richText?.paragraphs.every((p) => !p.list)).toBe(
      true,
    );
    const spacings = controls.querySelectorAll(".rich-text-spacing");
    spacings.forEach((spacing) => {
      Array.from(spacing.querySelectorAll("button"))
        .slice(0, 3)
        .forEach((button) => {
          expect(button.querySelector("svg")).not.toBeNull();
          expect(button.textContent).toBe("");
          expect(button.getAttribute("aria-label")).toBe(button.title);
        });
    });
    expect(spacings).toHaveLength(2);
    fireEvent.click(spacings[0].querySelectorAll("button")[2]);
    expect(current(text.id).lineHeight).toBe(1.75);
    fireEvent.click(spacings[1].querySelectorAll("button")[1]);
    expect(current(text.id).paragraphSpacing).toBe(0.5);
    fireEvent.click(spacings[1].querySelector(".properties-trigger")!);
    const input = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".rich-text-spacing-popover input",
      )!;
      expect(input).not.toBeNull();
      return input;
    });
    fireEvent.change(input, { target: { value: "0.8" } });
    expect(current(text.id).paragraphSpacing).toBe(0.8);
  });

  it("shows native justification with the other alignments and promotes only the selected text", () => {
    const text = API.createElement({ type: "text", text: "a b c d" });
    API.setElements([text]);
    API.setSelectedElements([text]);
    const align = rendered.container.querySelector<HTMLInputElement>(
      '[data-testid="align-justify"]',
    )!;
    expect(align).not.toBeNull();
    expect(align.name).toBe("text-align");
    fireEvent.click(align);
    expect(current(text.id).textAlign).toBe("justify");
    expect(current(text.id).autoResize).toBe(false);
    expect(current(text.id).richText).toEqual(
      richTextFromPlainText(text.originalText),
    );
  });

  it("applies a memoized highlight swatch only to the current text after switching equal selections", () => {
    const first = API.createElement({ type: "text", text: "first" });
    const second = API.createElement({ type: "text", text: "second", x: 200 });
    API.setElements([first, second]);
    API.setSelectedElements([first]);
    const color = DEFAULT_ELEMENT_BACKGROUND_PICKS[1];
    const selector = `.rich-text-highlight-controls button[title="${color}"]`;
    const swatch = document.querySelector(selector)!;
    API.setSelectedElements([second]);
    expect(document.querySelector(selector)).toBe(swatch);
    fireEvent.click(swatch);
    expect(current(first.id).richText).toBeUndefined();
    expect(current(second.id).richText?.paragraphs[0].runs).toEqual([
      { text: "second", background: color },
    ]);
  });

  it("tracks the selected highlight and preserves that range through picker input focus and transparent clearing", async () => {
    const initial = DEFAULT_ELEMENT_BACKGROUND_PICKS[1];
    const base = API.createElement({ type: "text", text: "a中文z" });
    const text = newElementWith(base, {
      richText: {
        version: 1,
        paragraphs: [
          {
            runs: [
              { text: "a", italic: true },
              { text: "中文", bold: true, background: initial },
              { text: "z" },
            ],
          },
        ],
      },
    });
    API.setElements([text]);
    API.setSelectedElements([text]);
    API.setAppState({ editingTextElement: text });
    act(() =>
      h.app.text.handleTextWysiwyg(text, {
        isExistingElement: true,
        initialSelection: { start: 1, end: 3 },
      }),
    );
    await waitFor(() =>
      expect(getRichTextSelectionState(document)?.background).toBe(initial),
    );
    const controls = rendered.container.querySelector(".rich-text-controls")!;
    const highlight = rendered.container.querySelector(
      ".rich-text-highlight-controls",
    )!;
    expect(
      highlight
        .querySelector(`button[title="${initial}"]`)
        ?.classList.contains("active"),
    ).toBe(true);
    fireEvent.click(
      highlight.querySelector('[data-openpopup="textHighlight"]')!,
    );
    const input = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".color-picker-input",
      )!;
      expect(input).not.toBeNull();
      return input;
    });
    act(() => {
      input.focus();
      document.getSelection()?.removeAllRanges();
      fireEvent(document, new Event("selectionchange"));
    });
    fireEvent.change(input, { target: { value: "abcdef" } });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
        { text: "a", italic: true },
        { text: "中文", bold: true, background: "#abcdef" },
        { text: "z" },
      ]),
    );
    fireEvent.click(highlight.querySelector('button[title="transparent"]')!);
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
        { text: "a", italic: true },
        { text: "中文", bold: true },
        { text: "z" },
      ]),
    );
    expect(h.state.currentItemBackgroundColor).toBe("transparent");
    fireEvent.click(controls.querySelectorAll(".rich-text-list-row button")[1]);
    await waitFor(() =>
      expect(getRichTextSelectionState(document)?.list).toBe("bullet"),
    );
    expect(
      controls.querySelectorAll(".rich-text-list-row button")[1],
    ).toHaveClass("active");
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
    expect(getRichTextSelectionState(document)).toBeNull();
  });

  it("migrates the selected characters from the textarea on Cmd+B, then submits and restores without losing marks", async () => {
    const text = API.createElement({ type: "text", text: "abc中文def" });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    const textarea = await getTextEditor();
    textarea.setSelectionRange(3, 5);
    fireEvent.keyDown(textarea, { key: "b", [KEYS.CTRL_OR_CMD]: true });
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
        { text: "abc" },
        { text: "中文", bold: true },
        { text: "def" },
      ]),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
    expect(h.state.editingTextElement).toBeNull();
    expect(current(text.id).originalText).toBe("abc中文def");
    const serialized = JSON.parse(
      serializeAsJSON([current(text.id)], h.state, {}, "local"),
    );
    const restored = restoreElements(
      serialized.elements,
      null,
    )[0] as ExcalidrawTextElement;
    expect(restored.richText).toEqual(current(text.id).richText);
    expect(restored.originalText).toBe("abc中文def");
  });

  it.each(["caretPositionFromPoint", "caretRangeFromPoint"] as const)(
    "places the rich caret at the double-click using %s before subsequent formatting",
    async (api) => {
      const base = API.createElement({
        type: "text",
        text: "abc中文def",
        x: 100,
        y: 100,
      });
      const text = newElementWith(base, {
        richText: richTextFromPlainText(base.originalText),
      });
      API.setElements([text]);
      const box = rendered.container.querySelector<HTMLElement>(
        ".excalidraw-textEditorContainer",
      )!;
      box.style.pointerEvents = "none";
      const previous = Object.getOwnPropertyDescriptor(document, api);
      const caret = vi.fn((x: number, y: number) => {
        if (window.getComputedStyle(getRichEditor()).pointerEvents !== "auto") {
          return null;
        }
        const textNode = getRichEditor().querySelector("[data-lexical-text]")!
          .firstChild!;
        if (api === "caretPositionFromPoint") {
          return { offsetNode: textNode, offset: 3 };
        }
        const range = document.createRange();
        range.setStart(textNode, 3);
        range.collapse(true);
        return range;
      });
      Object.defineProperty(document, api, {
        configurable: true,
        value: caret,
      });
      try {
        fireEvent.doubleClick(document.querySelector("canvas.interactive")!, {
          clientX: text.x + 30,
          clientY: text.y + 10,
        });
        await waitFor(() => expect(getRichEditor()).not.toBeNull());
        expect(box.style.pointerEvents).toBe("none");
        expect(window.getComputedStyle(getRichEditor()).pointerEvents).toBe(
          "auto",
        );
        expect(caret).toHaveBeenCalledWith(text.x + 30, text.y + 10);
        expect(document.getSelection()?.isCollapsed).toBe(true);
        expect(document.getSelection()?.anchorOffset).toBe(3);
        fireEvent.keyDown(getRichEditor(), {
          key: "u",
          [KEYS.CTRL_OR_CMD]: true,
        });
        await waitFor(() =>
          expect(getRichEditor().querySelector(".rich-underline")).toBeNull(),
        );
        expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
          { text: "abc中文def" },
        ]);
        fireEvent.paste(getRichEditor(), {
          clipboardData: {
            types: ["text/plain"],
            files: [],
            getData: (type: string) => (type === "text/plain" ? "X" : ""),
          },
        });
        await waitFor(() =>
          expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
            { text: "abc" },
            { text: "X", underline: true },
            { text: "中文def" },
          ]),
        );
        fireEvent.keyDown(getRichEditor(), { key: "Escape" });
      } finally {
        if (previous) {
          Object.defineProperty(document, api, previous);
        } else {
          delete (document as unknown as Record<string, unknown>)[api];
        }
      }
    },
  );

  it("preserves whole-text selection for rich editing started with Enter", async () => {
    const base = API.createElement({ type: "text", text: "abc中文def" });
    const text = newElementWith(base, {
      richText: richTextFromPlainText(base.originalText),
    });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    await waitFor(() =>
      expect(document.getSelection()?.toString()).toBe(text.originalText),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "upgrades textarea then toggles selected underline with %s+U, undo/redo and restores combined formatting for reediting",
    async (modifier) => {
      const text = API.createElement({ type: "text", text: "abc中文def" });
      API.setElements([text]);
      API.setSelectedElements([text]);
      Keyboard.keyPress(KEYS.ENTER);
      const textarea = await getTextEditor();
      textarea.setSelectionRange(3, 5);
      expect(
        fireEvent.keyDown(textarea, { key: "u", [KEYS.CTRL_OR_CMD]: true }),
      ).toBe(false);
      await waitFor(() =>
        expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
          { text: "abc" },
          { text: "中文", underline: true },
          { text: "def" },
        ]),
      );
      expect(
        getRichEditor().querySelector(".rich-underline")?.textContent,
      ).toBe("中文");
      fireEvent.keyDown(getRichEditor(), { key: "u", [modifier]: true });
      await waitFor(() =>
        expect(
          current(text.id).richText?.paragraphs[0].runs.every(
            (run) => !run.underline,
          ),
        ).toBe(true),
      );
      fireEvent.keyDown(getRichEditor(), {
        key: "z",
        [KEYS.CTRL_OR_CMD]: true,
      });
      await waitFor(() =>
        expect(
          current(text.id).richText?.paragraphs[0].runs[1]?.underline,
        ).toBe(true),
      );
      fireEvent.keyDown(getRichEditor(), {
        key: "z",
        [KEYS.CTRL_OR_CMD]: true,
        shiftKey: true,
      });
      await waitFor(() =>
        expect(
          current(text.id).richText?.paragraphs[0].runs.every(
            (run) => !run.underline,
          ),
        ).toBe(true),
      );
      fireEvent.keyDown(getRichEditor(), { key: "u", [modifier]: true });
      fireEvent.keyDown(getRichEditor(), { key: "b", [modifier]: true });
      fireEvent.keyDown(getRichEditor(), { key: "i", [modifier]: true });
      act(() => {
        executeRichTextCommand(document, {
          type: "background",
          value: "#fff3bf",
        });
      });
      const runs = [
        { text: "abc" },
        {
          text: "中文",
          bold: true,
          italic: true,
          underline: true,
          background: "#fff3bf",
        },
        { text: "def" },
      ];
      await waitFor(() =>
        expect(current(text.id).richText?.paragraphs[0].runs).toEqual(runs),
      );
      fireEvent.keyDown(getRichEditor(), { key: "Escape" });
      const serialized = JSON.parse(
        serializeAsJSON([current(text.id)], h.state, {}, "local"),
      );
      const restored = restoreElements(
        serialized.elements,
        null,
      )[0] as ExcalidrawTextElement;
      expect(restored.richText?.paragraphs[0].runs).toEqual(runs);
      API.setElements([restored]);
      API.setSelectedElements([restored].filter(isNonDeletedElement));
      Keyboard.keyPress(KEYS.ENTER);
      await waitFor(() =>
        expect(
          getRichEditor().querySelector(".rich-underline")?.textContent,
        ).toBe("中文"),
      );
      expect(getRichEditor().querySelector(".rich-underline")).toHaveClass(
        "rich-bold",
        "rich-italic",
      );
      fireEvent.keyDown(getRichEditor(), { key: "Escape" });
    },
  );

  it.each([
    "<u><strong><em>中文</em></strong></u>",
    '<span style="text-decoration: underline"><strong><em>中文</em></strong></span>',
  ])(
    "preserves underline together with bold and italic when pasting formatted HTML: %s",
    async (html) => {
      const base = API.createElement({ type: "text", text: "az" });
      const text = newElementWith(base, {
        richText: richTextFromPlainText(base.originalText),
      });
      API.setElements([text]);
      API.setAppState({ editingTextElement: text });
      act(() =>
        h.app.text.handleTextWysiwyg(text, {
          isExistingElement: true,
          initialSelection: { start: 1, end: 1 },
        }),
      );
      await waitFor(() => expect(getRichEditor()).not.toBeNull());
      fireEvent.paste(getRichEditor(), {
        clipboardData: {
          types: ["text/html", "text/plain"],
          files: [],
          getData: (type: string) =>
            type === "text/html"
              ? `<p>${html}</p>`
              : type === "text/plain"
              ? "中文"
              : "",
        },
      });
      await waitFor(() =>
        expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
          { text: "a" },
          { text: "中文", bold: true, italic: true, underline: true },
          { text: "z" },
        ]),
      );
      fireEvent.keyDown(getRichEditor(), { key: "Escape" });
      expect(current(text.id).richText?.paragraphs[0].runs[1].underline).toBe(
        true,
      );
    },
  );

  it("supports whole-block shortcuts and global undo/redo after a rich edit", async () => {
    const text = API.createElement({ type: "text", text: "history" });
    API.updateScene({
      elements: [text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([text]);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("b"));
    expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(true);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.Z));
    expect(
      current(text.id).richText?.paragraphs[0].runs[0].bold,
    ).toBeUndefined();
    Keyboard.withModifierKeys({ ctrl: true, shift: true }, () =>
      Keyboard.keyPress(KEYS.Z),
    );
    expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(true);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    fireEvent.keyDown(getRichEditor(), { key: "i", [KEYS.CTRL_OR_CMD]: true });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs[0].italic).toBe(
        true,
      ),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.Z));
    expect(
      current(text.id).richText?.paragraphs[0].runs[0].italic,
    ).toBeUndefined();
    expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(true);
  });

  it("toggles underline for a whole selected text block and supports canvas undo and redo", () => {
    const text = API.createElement({ type: "text", text: "整块中文\nsecond" });
    API.updateScene({
      elements: [text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([text]);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("u"));
    expect(
      current(text.id)
        .richText?.paragraphs.flatMap((paragraph) => paragraph.runs)
        .every((run) => run.underline),
    ).toBe(true);
    Keyboard.undo();
    expect(
      current(text.id)
        .richText?.paragraphs.flatMap((paragraph) => paragraph.runs)
        .some((run) => run.underline),
    ).toBeFalsy();
    Keyboard.redo();
    expect(
      current(text.id)
        .richText?.paragraphs.flatMap((paragraph) => paragraph.runs)
        .every((run) => run.underline),
    ).toBe(true);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("u"));
    expect(
      current(text.id)
        .richText?.paragraphs.flatMap((paragraph) => paragraph.runs)
        .some((run) => run.underline),
    ).toBe(false);
  });

  it("routes desktop Cmd+Z and Cmd+Shift+Z through Lexical before isolating the canvas", async () => {
    const base = API.createElement({ type: "text", text: "中文history" });
    const text = newElementWith(base, {
      richText: richTextFromPlainText(base.originalText),
    });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    const editor = getRichEditor();
    // jsdom does not implement the browser's isContentEditable getter.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    editor.tabIndex = 0;
    editor.focus();
    const leaked = vi.fn();
    document.addEventListener("keydown", leaked);
    try {
      fireEvent.keyDown(editor, { key: "b", [KEYS.CTRL_OR_CMD]: true });
      await waitFor(() =>
        expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(
          true,
        ),
      );
      await act(async () => {
        await handleDesktopEditingCommand(document.body, "undo", {
          canvasActive: true,
          blocked: false,
        });
      });
      await waitFor(() =>
        expect(
          current(text.id).richText?.paragraphs[0].runs[0].bold,
        ).toBeUndefined(),
      );
      await act(async () => {
        await handleDesktopEditingCommand(document.body, "redo", {
          canvasActive: true,
          blocked: false,
        });
      });
      await waitFor(() =>
        expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(
          true,
        ),
      );
      expect(leaked).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", leaked);
      fireEvent.keyDown(editor, { key: "Escape" });
    }
  });

  it("handles actual Enter events to continue a list and exit an empty item", async () => {
    const base = API.createElement({ type: "text", text: "first" });
    const richText = richTextFromPlainText("first");
    richText.paragraphs[0].list = { kind: "ordered", indent: 0 };
    const text = newElementWith(base, { richText });
    API.setElements([text]);
    API.setAppState({ editingTextElement: text });
    act(() =>
      h.app.text.handleTextWysiwyg(text, {
        isExistingElement: true,
        initialSelection: { start: 5, end: 5 },
      }),
    );
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    fireEvent.keyDown(getRichEditor(), { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(
        current(text.id).richText?.paragraphs.map((p) => p.list?.kind),
      ).toEqual(["ordered", "ordered"]),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(
        current(text.id).richText?.paragraphs.map((p) => p.list?.kind),
      ).toEqual(["ordered", undefined]),
    );
    expect(current(text.id).originalText).toBe("first\n");
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
  });

  it("handles actual Tab and Shift+Tab events to indent and outdent a list item", async () => {
    const base = API.createElement({ type: "text", text: "first\nsecond" });
    const richText = richTextFromPlainText(base.originalText);
    richText.paragraphs.forEach((p) => {
      p.list = { kind: "bullet", indent: 0 };
    });
    const text = newElementWith(base, { richText });
    API.setElements([text]);
    API.setAppState({ editingTextElement: text });
    act(() =>
      h.app.text.handleTextWysiwyg(text, {
        isExistingElement: true,
        initialSelection: { start: 6, end: 12 },
      }),
    );
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    fireEvent.keyDown(getRichEditor(), { key: "Tab", code: "Tab" });
    await waitFor(() =>
      expect(
        current(text.id).richText?.paragraphs.map((p) => p.list?.indent),
      ).toEqual([0, 1]),
    );
    fireEvent.keyDown(getRichEditor(), {
      key: "Tab",
      code: "Tab",
      shiftKey: true,
    });
    await waitFor(() =>
      expect(
        current(text.id).richText?.paragraphs.map((p) => p.list?.indent),
      ).toEqual([0, 0]),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
  });

  it("keeps Chinese composition text intact and ignores composing Enter", async () => {
    const base = API.createElement({ type: "text", text: "中文" });
    const text = newElementWith(base, {
      richText: richTextFromPlainText(base.originalText),
    });
    API.setElements([text]);
    API.setAppState({ editingTextElement: text });
    act(() =>
      h.app.text.handleTextWysiwyg(text, {
        isExistingElement: true,
        initialSelection: { start: 2, end: 2 },
      }),
    );
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    const editor = getRichEditor();
    fireEvent.compositionStart(editor, { data: "" });
    await act(async () => {
      await Promise.resolve();
    });
    const textNode = editor.querySelector("[data-lexical-text]")!.firstChild!;
    textNode.textContent = "中文输入";
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.collapse(true);
    const selection = document.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.input(editor, {
      inputType: "insertCompositionText",
      data: "输入",
      isComposing: true,
    });
    fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      keyCode: 229,
      [KEYS.CTRL_OR_CMD]: true,
    });
    expect(h.state.editingTextElement?.id).toBe(text.id);
    fireEvent.compositionEnd(editor, { data: "输入" });
    fireEvent.input(editor, { inputType: "insertText", data: "输入" });
    await waitFor(() => expect(current(text.id).originalText).toBe("中文输入"));
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(current(text.id).originalText).toBe("中文输入");
  });

  it.each([false, true])(
    "commits rich edits and invokes desktop save once from one Cmd+S event (saveAs=%s)",
    async (saveAs) => {
      const save = vi.fn().mockResolvedValue(true);
      rendered.rerender(
        <Excalidraw
          handleKeyboardGlobally
          desktopIntegration={{ save, open: async () => {} }}
        />,
      );
      const base = API.createElement({ type: "text", text: "保存中文" });
      const text = newElementWith(base, {
        richText: richTextFromPlainText(base.originalText),
      });
      API.setElements([text]);
      API.setSelectedElements([text]);
      Keyboard.keyPress(KEYS.ENTER);
      await waitFor(() => expect(getRichEditor()).not.toBeNull());
      fireEvent.keyDown(getRichEditor(), {
        key: "b",
        [KEYS.CTRL_OR_CMD]: true,
      });
      fireEvent.keyDown(getRichEditor(), {
        key: "u",
        [KEYS.CTRL_OR_CMD]: true,
      });
      const proceeds = fireEvent.keyDown(getRichEditor(), {
        key: saveAs ? "S" : KEYS.S,
        code: "KeyS",
        [KEYS.CTRL_OR_CMD]: true,
        shiftKey: saveAs,
      });
      expect(proceeds).toBe(false);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const [snapshot, requestedSaveAs] = save.mock.calls[0];
      expect(requestedSaveAs).toBe(saveAs);
      expect(snapshot.appState.editingTextElement).toBeNull();
      expect(
        snapshot.elements.find(
          (element: ExcalidrawTextElement) => element.id === text.id,
        ),
      ).toMatchObject({
        originalText: "保存中文",
        richText: {
          version: 1,
          paragraphs: [
            { runs: [{ text: "保存中文", bold: true, underline: true }] },
          ],
        },
      });
      expect(getRichEditor()).toBeNull();
    },
  );

  it.each([false, true])(
    "commits rich edits and preserves web file saving from one Cmd+S event (saveAs=%s)",
    async (saveAs) => {
      const save = vi
        .spyOn(dataModule, "saveAsJSON")
        .mockResolvedValue({ fileHandle: null });
      try {
        const base = API.createElement({ type: "text", text: "web中文" });
        const text = newElementWith(base, {
          richText: richTextFromPlainText(base.originalText),
        });
        API.setElements([text]);
        API.setSelectedElements([text]);
        Keyboard.keyPress(KEYS.ENTER);
        await waitFor(() => expect(getRichEditor()).not.toBeNull());
        fireEvent.keyDown(getRichEditor(), {
          key: "i",
          [KEYS.CTRL_OR_CMD]: true,
        });
        fireEvent.keyDown(getRichEditor(), {
          key: "u",
          [KEYS.CTRL_OR_CMD]: true,
        });
        fireEvent.keyDown(getRichEditor(), {
          key: saveAs ? "S" : KEYS.S,
          code: "KeyS",
          [KEYS.CTRL_OR_CMD]: true,
          shiftKey: saveAs,
        });
        await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        const snapshot = await save.mock.calls[0][0].data;
        expect(snapshot.appState.editingTextElement).toBeNull();
        expect(
          snapshot.elements.find((element) => element.id === text.id),
        ).toMatchObject({
          originalText: "web中文",
          richText: {
            version: 1,
            paragraphs: [
              { runs: [{ text: "web中文", italic: true, underline: true }] },
            ],
          },
        });
        expect(getRichEditor()).toBeNull();
      } finally {
        save.mockRestore();
      }
    },
  );

  it("allows an empty new text to choose a format before typing", async () => {
    const text = API.createElement({ type: "text", text: "" });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    const textarea = await getTextEditor();
    fireEvent.keyDown(textarea, { key: "i", [KEYS.CTRL_OR_CMD]: true });
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    expect(h.state.editingTextElement?.id).toBe(text.id);
    expect(current(text.id).isDeleted).toBe(false);
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
  });

  it("keeps an IME composing Enter from submitting the rich editor", async () => {
    const base = API.createElement({ type: "text", text: "中文" });
    const text = newElementWith(base, {
      richText: richTextFromPlainText("中文"),
    });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    fireEvent.keyDown(getRichEditor(), {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
      [KEYS.CTRL_OR_CMD]: true,
    });
    expect(h.state.editingTextElement?.id).toBe(text.id);
    expect(getRichEditor()).not.toBeNull();
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
  });

  it("keeps Canvas/SVG run positions and backgrounds consistent with the shared layout", async () => {
    const base = API.createElement({
      type: "text",
      text: "abc中文",
      fontSize: 20,
      fontFamily: FONT_FAMILY.Helvetica,
    });
    const text = newElementWith(base, {
      autoResize: false,
      width: 45,
      paragraphSpacing: 0.5,
      richText: {
        version: 1,
        paragraphs: [
          {
            runs: [
              { text: "abc", bold: true },
              { text: "中文", italic: true, background: "rgb(255, 243, 191)" },
            ],
          },
        ],
      },
    });
    const layout = layoutRichText(text, text.width);
    const svg = await exportToSvg(
      [text],
      { exportBackground: false, viewBackgroundColor: "#ffffff" },
      {},
    );
    const rendered = [...svg.querySelectorAll("text")];
    const runs = layout.lines.flatMap((line) => line.runs);
    expect(rendered.map((node) => node.textContent)).toEqual(
      runs.map((run) => run.text),
    );
    expect(rendered.map((node) => Number(node.getAttribute("x")))).toEqual(
      runs.map((run) => run.x),
    );
    expect(rendered.map((node) => node.getAttribute("font-weight"))).toEqual(
      runs.map((run) => (run.bold ? "bold" : "normal")),
    );
    expect(svg.querySelectorAll("rect[fill='rgb(255, 243, 191)']").length).toBe(
      runs.filter((run) => run.background).length,
    );
    const canvas = await exportToCanvas({ elements: [text], files: {} });
    const draw = canvas.getContext("2d")!.fillText;
    for (const run of runs) {
      expect(draw).toHaveBeenCalledWith(run.text, run.x, expect.any(Number));
    }
  });

  it("keeps a rich label bound to its container after editing and submitting", async () => {
    const rectangle = API.createElement({
      type: "rectangle",
      id: "container",
      width: 200,
      height: 100,
      boundElements: [{ id: "label", type: "text" }],
    });
    const base = API.createElement({
      type: "text",
      id: "label",
      text: "label",
      containerId: rectangle.id,
    });
    const text = newElementWith(base, {
      richText: richTextFromPlainText("label"),
    });
    API.setElements([rectangle, text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    await waitFor(() => expect(getRichEditor()).not.toBeNull());
    act(() => {
      executeRichTextCommand(document, { type: "bold" });
    });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs[0].bold).toBe(true),
    );
    fireEvent.keyDown(getRichEditor(), { key: "Escape" });
    expect(current(text.id).containerId).toBe(rectangle.id);
    expect(h.app.scene.getElement(rectangle.id)?.boundElements).toEqual([
      { id: text.id, type: "text" },
    ]);
    expect(current(text.id).height).toBe(
      layoutRichText(current(text.id), current(text.id).width).height,
    );
  });
});
