import { KEYS } from "@excalidraw/common";
import { newElementWith, richTextFromPlainText } from "@excalidraw/element";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import {
  getRichTextSelectionState,
  publishRichTextSelectionState,
  subscribeRichTextSelection,
} from "../features/rich-text/editorBridge";
import { API } from "../tests/helpers/api";
import { Keyboard } from "../tests/helpers/ui";
import { getTextEditor } from "../tests/queries/dom";
import { act, fireEvent, render, waitFor } from "../tests/test-utils";

import { getTextSelectionToolbarPosition } from "./TextSelectionToolbar";

import type { ExcalidrawProps } from "../types";

const { h } = window;
const current = (id: string) =>
  h.app.scene.getElement<ExcalidrawTextElement>(id)!;
const richEditor = () =>
  document.querySelector<HTMLDivElement>(".excalidraw-rich-text")!;
const toolbar = () =>
  document.querySelector<HTMLDivElement>(".text-selection-toolbar");
const selectionRect = {
  left: 400,
  top: 250,
  right: 500,
  bottom: 280,
  width: 100,
  height: 30,
  x: 400,
  y: 250,
  toJSON: () => ({}),
};

beforeAll(() => {
  vi.stubGlobal("DragEvent", class extends Event {});
  vi.stubGlobal("ClipboardEvent", class extends Event {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => selectionRect,
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

const mount = async () => {
  const result = await render(
    <Excalidraw
      handleKeyboardGlobally
      desktopIntegration={{ save: async () => true, open: async () => {} }}
    />,
  );
  API.setAppState({ width: 1200, height: 800 });
  return result;
};
const selectedPlainText = async (expectToolbar = true) => {
  const text = API.createElement({
    type: "text",
    x: 400,
    y: 250,
    text: "abc中文def",
  });
  API.setElements([text]);
  API.setSelectedElements([text]);
  Keyboard.keyPress(KEYS.ENTER);
  const textarea = await getTextEditor();
  textarea.setSelectionRange(3, 5);
  fireEvent.select(textarea);
  if (expectToolbar) {
    await waitFor(() => expect(toolbar()).not.toBeNull());
  }
  return { text, textarea };
};

it.each<{
  name: string;
  desktopIntegration?: ExcalidrawProps["desktopIntegration"];
  textSelectionToolbar?: boolean;
  enabled: boolean;
}>([
  { name: "web default", enabled: false },
  { name: "web opt-in", textSelectionToolbar: true, enabled: true },
  { name: "web disabled", textSelectionToolbar: false, enabled: false },
  {
    name: "desktop default",
    desktopIntegration: { save: async () => true, open: async () => {} },
    enabled: true,
  },
  {
    name: "desktop disabled via UIOptions",
    desktopIntegration: { save: async () => true, open: async () => {} },
    textSelectionToolbar: false,
    enabled: false,
  },
  {
    name: "desktop selection toolbar disabled despite opt-in",
    desktopIntegration: {
      save: async () => true,
      open: async () => {},
      selectionToolbar: false,
    },
    textSelectionToolbar: true,
    enabled: false,
  },
])("respects the text toolbar option for $name", async (options) => {
  await render(
    <Excalidraw
      handleKeyboardGlobally
      desktopIntegration={options.desktopIntegration}
      UIOptions={{ textSelectionToolbar: options.textSelectionToolbar }}
    />,
  );
  API.setAppState({ width: 1200, height: 800 });
  if (!options.desktopIntegration) {
    const rectangle = API.createElement({
      type: "rectangle",
      x: 400,
      y: 250,
      width: 100,
      height: 100,
    });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    expect(document.querySelector(".selection-toolbar")).toBeNull();
  }
  await selectedPlainText(options.enabled);
  if (!options.enabled) {
    await act(async () => {
      await new Promise((resolve) =>
        h.app.ownerWindow.setTimeout(resolve, 180),
      );
    });
    expect(toolbar()).toBeNull();
  }
});

it("publishes a new equal-format range and geometry without suppressing listeners", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeRichTextSelection(document, listener);
  const state = {
    elementId: "test",
    hasSelection: true,
    background: null,
    color: "#000000",
    list: "none" as const,
    selectionKey: "0:2",
    rect: selectionRect,
  };
  publishRichTextSelectionState(document, state);
  publishRichTextSelectionState(document, { ...state });
  expect(listener).toHaveBeenCalledTimes(1);
  publishRichTextSelectionState(document, { ...state, selectionKey: "3:5" });
  publishRichTextSelectionState(document, {
    ...state,
    selectionKey: "3:5",
    rect: { ...selectionRect, top: 300 },
  });
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
  publishRichTextSelectionState(document, null);
});

it("clamps at sidebars, flips below multiline text and hides outside the viewport", () => {
  const bounds = { left: 10, top: 20, width: 1000, height: 700 };
  const size = { width: 218, height: 44 };
  const insets = { left: 280, right: 250, top: 20 };
  expect(
    getTextSelectionToolbarPosition(
      { left: 280, right: 320, top: 100, bottom: 160 },
      bounds,
      size,
      insets,
    ),
  ).toEqual({ left: 280, top: 26 });
  expect(
    getTextSelectionToolbarPosition(
      { left: 600, right: 750, top: 45, bottom: 140 },
      bounds,
      size,
      insets,
    ),
  ).toEqual({ left: 532, top: 130 });
  expect(
    getTextSelectionToolbarPosition(
      { left: 0, right: 200, top: 100, bottom: 140 },
      bounds,
      size,
      insets,
    ),
  ).toBeNull();
});

it("shows on a plain selection without conversion, then retains partial selection through repeated formats and undo/redo", async () => {
  await mount();
  const { text, textarea } = await selectedPlainText();
  expect(current(text.id).richText).toBeUndefined();
  expect(getRichTextSelectionState(document)).toMatchObject({
    selectionKey: "3:5",
    bold: false,
  });
  const bold = toolbar()!.querySelector<HTMLButtonElement>(
    '[aria-label="Bold"]',
  )!;
  fireEvent.pointerDown(bold);
  fireEvent.click(bold);
  await waitFor(() =>
    expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
      { text: "abc" },
      { text: "中文", bold: true },
      { text: "def" },
    ]),
  );
  expect(textarea.isConnected).toBe(false);
  await waitFor(() => expect(toolbar()).not.toBeNull());
  fireEvent.click(toolbar()!.querySelector('[aria-label="Italic"]')!);
  await waitFor(() =>
    expect(current(text.id).richText?.paragraphs[0].runs[1]).toEqual({
      text: "中文",
      bold: true,
      italic: true,
    }),
  );
  fireEvent.keyDown(richEditor(), { key: "z", [KEYS.CTRL_OR_CMD]: true });
  await waitFor(() =>
    expect(current(text.id).richText?.paragraphs[0].runs[1]).toEqual({
      text: "中文",
      bold: true,
    }),
  );
  fireEvent.keyDown(richEditor(), {
    key: "z",
    [KEYS.CTRL_OR_CMD]: true,
    shiftKey: true,
  });
  await waitFor(() =>
    expect(current(text.id).richText?.paragraphs[0].runs[1]).toEqual({
      text: "中文",
      bold: true,
      italic: true,
    }),
  );
  fireEvent.keyDown(richEditor(), { key: "Escape" });
  await waitFor(() => expect(toolbar()).toBeNull());
});

it.each([false, true])(
  "retains a range and color-input focus through repeated custom colors and highlight (rich=%s)",
  async (rich) => {
    await mount();
    const base = API.createElement({
      type: "text",
      x: 400,
      y: 250,
      text: "abc中文def",
    });
    const text = rich
      ? newElementWith(base, {
          richText: richTextFromPlainText(base.originalText),
        })
      : base;
    API.setElements([text]);
    API.setAppState({ editingTextElement: text });
    act(() =>
      h.app.text.handleTextWysiwyg(text, {
        isExistingElement: true,
        initialSelection: { start: 3, end: 5 },
      }),
    );
    await waitFor(() => expect(toolbar()).not.toBeNull());
    fireEvent.click(
      toolbar()!.querySelector('[data-openpopup="elementStroke"]')!,
    );
    const input = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".color-picker-input",
      )!;
      expect(input).not.toBeNull();
      return input;
    });
    fireEvent.pointerDown(input);
    act(() => input.focus());
    expect(h.state.editingTextElement?.id).toBe(text.id);
    fireEvent.change(input, { target: { value: "abcdef" } });
    await act(async () => {
      await Promise.resolve();
      // jsdom does not implement contenteditable's native focusability.
      richEditor().tabIndex = -1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs[1]).toEqual({
        text: "中文",
        color: "#abcdef",
      }),
    );
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "123456" } });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs[1]).toEqual({
        text: "中文",
        color: "#123456",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(input);
    expect(current(text.id).strokeColor).toBe(text.strokeColor);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(richEditor()));
    fireEvent.click(
      toolbar()!.querySelector('[data-openpopup="elementBackground"]')!,
    );
    const highlight = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".color-picker-input",
      )!;
      expect(input).not.toBeNull();
      return input;
    });
    act(() => highlight.focus());
    fireEvent.change(highlight, { target: { value: "fff3bf" } });
    await waitFor(() =>
      expect(current(text.id).richText?.paragraphs[0].runs).toEqual([
        { text: "abc" },
        { text: "中文", color: "#123456", background: "#fff3bf" },
        { text: "def" },
      ]),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(highlight);
    fireEvent.keyDown(highlight, { key: "Escape" });
    fireEvent.keyDown(richEditor(), { key: "Escape" });
  },
);

it("hides for a collapsed selection and throughout IME composition", async () => {
  await mount();
  const { textarea } = await selectedPlainText();
  fireEvent.compositionStart(textarea);
  await waitFor(() => expect(toolbar()).toBeNull());
  fireEvent.compositionEnd(textarea);
  await waitFor(() => expect(toolbar()).not.toBeNull());
  textarea.setSelectionRange(5, 5);
  fireEvent.select(textarea);
  await waitFor(() => expect(toolbar()).toBeNull());
  fireEvent.keyDown(textarea, { key: "Escape" });
});
