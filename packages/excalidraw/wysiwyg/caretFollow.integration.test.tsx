import { KEYS } from "@excalidraw/common";
import { newElementWith, richTextFromPlainText } from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
} from "@excalidraw/element/table";

import type { Radians } from "@excalidraw/math";

import type {
  ExcalidrawTextElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Keyboard } from "../tests/helpers/ui";
import { getTextEditor, updateTextEditor } from "../tests/queries/dom";
import { act, fireEvent, render, waitFor } from "../tests/test-utils";
import { AnimationController } from "../renderer/animation";

const { h } = window;
const settle = async () => {
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await waitFor(() =>
    expect(
      AnimationController.running(h.app.viewport.caretFollowAnimationKey),
    ).toBe(false),
  );
};

const start = (
  text: NonDeleted<ExcalidrawTextElement>,
  end = text.originalText.length,
) => {
  API.setAppState({ editingTextElement: text });
  act(() =>
    h.app.text.handleTextWysiwyg(text, {
      isExistingElement: true,
      initialSelection: { start: end, end },
    }),
  );
};

describe("caret input safety area", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    API.setAppState({ width: 1000, height: 800 });
  });

  it("honors reduced motion and clamps follow movement without changing zoom", () => {
    const media = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    try {
      act(() => h.app.viewport.followCaret(0, -40));
      expect(h.state.scrollY).toBe(-40);
      expect(
        AnimationController.running(h.app.viewport.caretFollowAnimationKey),
      ).toBe(false);
      API.setAppState({
        scrollX: 0,
        scrollY: 0,
        scrollConstraints: {
          x: 0,
          y: 0,
          width: 1000,
          height: 800,
          lockScroll: true,
          lockZoom: true,
          zoom: 1,
          overscroll: 0,
        },
      });
      act(() => h.app.viewport.followCaret(-200, -200));
      expect(h.state.scrollX).toBe(0);
      expect(h.state.scrollY).toBe(0);
      expect(h.state.zoom.value).toBe(1);
    } finally {
      media.mockRestore();
    }
  });

  it.each(
    [0.5, 1, 2].flatMap((zoom) => [0, 0.25].map((angle) => ({ zoom, angle }))),
  )(
    "leaves room under a plain caret at zoom $zoom and angle $angle before native reveal scrolling",
    async ({ zoom, angle }) => {
      API.setAppState({ zoom: { value: zoom as typeof h.state.zoom.value } });
      const text = API.createElement({
        type: "text",
        x: 400 / zoom,
        y: 750 / zoom,
        text: "hello",
        angle: angle as Radians,
      });
      API.setElements([text]);
      start(text);
      const editor = await getTextEditor();
      const before = h.state.scrollY;
      act(() => updateTextEditor(editor, "hello!"));
      await settle();
      expect(h.state.scrollY).toBeLessThan(before);
      expect(h.state.zoom.value).toBe(zoom);
      expect(await getTextEditor()).toBe(editor);
      const settled = h.state.scrollY;
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
        h.app.onScrollChangeEmitter.trigger(
          h.state.scrollX,
          h.state.scrollY,
          h.state.zoom,
        );
      });
      await settle();
      expect(h.state.scrollY).toBe(settled);
    },
  );

  it("keeps a long paragraph still when the caret is in the safety area", async () => {
    const text = API.createElement({
      type: "text",
      x: 400,
      y: 200,
      text: "line\n".repeat(80),
    });
    API.setElements([text]);
    start(text, 2);
    const editor = await getTextEditor();
    const before = h.state.scrollY;
    fireEvent.input(editor);
    await settle();
    expect(h.state.scrollY).toBe(before);
  });

  it("reserves composition room while preserving the textarea, its text and its selection", async () => {
    const text = API.createElement({
      type: "text",
      x: 400,
      y: 720,
      text: "中文",
    });
    API.setElements([text]);
    start(text);
    const editor = await getTextEditor();
    const before = h.state.scrollY;
    fireEvent.compositionStart(editor, { data: "" });
    editor.value = "中文输入";
    editor.setSelectionRange(4, 4);
    fireEvent.input(editor, {
      isComposing: true,
      inputType: "insertCompositionText",
      data: "输入",
    });
    await settle();
    expect(h.state.scrollY).toBeLessThan(before - 40);
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("中文输入");
    expect(editor.selectionStart).toBe(4);
    fireEvent.compositionEnd(editor, { data: "输入" });
    fireEvent.input(editor, { inputType: "insertText", data: "输入" });
    Keyboard.exitTextEditor(editor);
    expect(
      h.app.scene.getElement<ExcalidrawTextElement>(text.id)!.originalText,
    ).toBe("中文输入");
  });

  it.each([false, true])(
    "follows the native rich focus point during composition (table=%s)",
    async (tableCell) => {
      let text: NonDeleted<ExcalidrawTextElement>;
      if (tableCell) {
        const data = createTableData(1, 1);
        data.cells[0].text = "中文";
        data.cells[0].richText = richTextFromPlainText("中文");
        const table = createTableElements(data, 400, 720);
        API.setElements(table.elements);
        text = table.elements.find(
          (el): el is NonDeleted<ExcalidrawTextElement> => el.type === "text",
        )!;
      } else {
        const base = API.createElement({
          type: "text",
          x: 400,
          y: 720,
          text: "中文",
        });
        text = newElementWith(base, {
          richText: richTextFromPlainText("中文"),
        });
        API.setElements([text]);
      }
      start(text);
      const editable = await waitFor(() => {
        const node = document.querySelector<HTMLDivElement>(
          ".excalidraw-rich-text",
        );
        expect(node).not.toBeNull();
        return node!;
      });
      editable.tabIndex = 0;
      editable.focus();
      const original = Range.prototype.getClientRects;
      const originalBounds = Range.prototype.getBoundingClientRect;
      const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
      Range.prototype.getClientRects = function (this: Range) {
        const top = parseFloat(editable.style.top);
        return [
          { left: 400, right: 401, top, bottom: top + 25, height: 25 },
        ] as unknown as DOMRectList;
      };
      Range.prototype.getBoundingClientRect = function (this: Range) {
        return this.getClientRects()[0];
      };
      try {
        fireEvent.compositionStart(editable, { data: "" });
        await act(async () => {
          await Promise.resolve();
        });
        const textNode = editable.querySelector("[data-lexical-text]")!
          .firstChild!;
        textNode.textContent = "中文输入";
        document.defaultView!.getSelection()!.collapse(textNode, 4);
        fireEvent.input(editable, {
          inputType: "insertCompositionText",
          data: "输入",
          isComposing: true,
        });
        await settle();
        expect(h.state.scrollY).toBeLessThan(-30);
        expect(document.activeElement).toBe(editable);
        expect(editable.querySelector("[data-lexical-text]")!.firstChild).toBe(
          textNode,
        );
        expect(document.defaultView!.getSelection()!.focusNode).toBe(textNode);
        expect(textNode.textContent?.replace(/\u200b/g, "")).toBe("中文输入");
        expect(
          h.app.scene.getElement<ExcalidrawTextElement>(text.id)!.originalText,
        ).toBe("中文");
        fireEvent.compositionEnd(editable, { data: "输入" });
        fireEvent.input(editable, { inputType: "insertText", data: "输入" });
        await waitFor(() =>
          expect(
            h.app.scene.getElement<ExcalidrawTextElement>(text.id)!
              .originalText,
          ).toBe("中文输入"),
        );
        fireEvent.keyDown(editable, { key: KEYS.ESCAPE });
      } finally {
        Range.prototype.getClientRects = original;
        Range.prototype.getBoundingClientRect = originalBounds;
        scroll.mockRestore();
      }
    },
  );
});
