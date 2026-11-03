import {
  createCaretFollow,
  getCaretFollowDelta,
  getContentEditableCaretRect,
} from "./caretFollow";

import type App from "../components/App";

const viewport = {
  width: 1000,
  height: 800,
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  composing: false,
};
const caret = (left: number, top: number) => ({
  left,
  right: left + 1,
  top,
  bottom: top + 20,
});

describe("caret safety geometry", () => {
  it("does not move a visible caret, regardless of the editor's length", () => {
    expect(
      getCaretFollowDelta({ ...viewport, caret: caret(200, 200) }),
    ).toEqual({ x: 0, y: 0 });
  });
  it("moves only the overflowing axis and leaves a separate landing margin", () => {
    expect(
      getCaretFollowDelta({ ...viewport, caret: caret(200, 750) }),
    ).toEqual({ x: 0, y: -26 });
    expect(
      getCaretFollowDelta({ ...viewport, caret: caret(200, 724) }),
    ).toEqual({ x: 0, y: 0 });
  });
  it("reserves more room for composition and scales it down in short views", () => {
    expect(
      getCaretFollowDelta({
        ...viewport,
        composing: true,
        caret: caret(200, 750),
      }).y,
    ).toBe(-82);
    expect(
      getCaretFollowDelta({
        ...viewport,
        height: 120,
        composing: true,
        caret: caret(200, 80),
      }).y,
    ).toBe(-36);
  });
  it("uses the full sidebar but only the overlapping part of a floating panel", () => {
    const panels = [{ left: 600, right: 900, top: 0, bottom: 300 }];
    expect(
      getCaretFollowDelta({ ...viewport, panels, caret: caret(650, 100) }).x,
    ).toBe(-71);
    expect(
      getCaretFollowDelta({ ...viewport, panels, caret: caret(650, 400) }).x,
    ).toBe(0);
    expect(
      getCaretFollowDelta({
        ...viewport,
        insets: { ...viewport.insets, right: 300 },
        caret: caret(750, 400),
      }).x,
    ).toBe(-79);
  });

  it("lands without reversing direction in a 48px-high viewport", () => {
    const options = { ...viewport, height: 48, caret: caret(200, 30) };
    const first = getCaretFollowDelta(options);
    const landed = {
      ...options.caret,
      top: options.caret.top + first.y,
      bottom: options.caret.bottom + first.y,
    };
    expect(first.y).toBeLessThan(0);
    expect(landed.top).toBeGreaterThanOrEqual(0);
    expect(landed.bottom).toBeLessThanOrEqual(48);
    expect(getCaretFollowDelta({ ...options, caret: landed }).y).toBe(0);
  });

  it.each([
    { left: 4, right: 42 },
    { left: 0, right: 48 },
  ])(
    "keeps a caret visible and stable when a panel fills a tiny viewport (%s)",
    (panel) => {
      const options = {
        ...viewport,
        width: 48,
        height: 120,
        insets: { top: 0, bottom: 0, left: 4, right: 6 },
        panels: [{ ...panel, top: 0, bottom: 120 }],
        caret: caret(30, 30),
      };
      const first = getCaretFollowDelta(options);
      const landed = {
        ...options.caret,
        left: options.caret.left + first.x,
        right: options.caret.right + first.x,
        top: options.caret.top + first.y,
        bottom: options.caret.bottom + first.y,
      };
      expect(landed.left).toBeGreaterThanOrEqual(4);
      expect(landed.right).toBeLessThanOrEqual(42);
      expect(getCaretFollowDelta({ ...options, caret: landed })).toEqual({
        x: 0,
        y: 0,
      });
    },
  );

  it.each([false, true])(
    "settles when margins or the caret exceed the available viewport (composing=%s)",
    (composing) => {
      for (const size of [0, 8, 24, 48, 120]) {
        for (const stroke of [1, 20, 80, 160]) {
          for (const position of [-100, -10, 10, 30, 100]) {
            const options = {
              ...viewport,
              width: size + 10,
              height: size + 10,
              insets: { top: 4, bottom: 6, left: 4, right: 6 },
              composing,
              caret: {
                left: position,
                right: position + stroke,
                top: position,
                bottom: position + stroke,
              },
            };
            const first = getCaretFollowDelta(options);
            const landed = {
              left: options.caret.left + first.x,
              right: options.caret.right + first.x,
              top: options.caret.top + first.y,
              bottom: options.caret.bottom + first.y,
            };
            const next = getCaretFollowDelta({ ...options, caret: landed });
            expect(next.x).toBeCloseTo(0, 8);
            expect(next.y).toBeCloseTo(0, 8);
          }
        }
      }
    },
  );
});

describe("caret follow event ownership", () => {
  it("ignores geometry notifications, cancels on navigation, resumes on input, and cleans up", () => {
    const editable = document.createElement("div");
    editable.tabIndex = 0;
    document.body.append(editable);
    editable.focus();
    let callback: FrameRequestCallback | null = null;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((fn) => {
        callback = fn;
        return 1;
      });
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {
        callback = null;
      });
    const follow = vi.fn();
    const stop = vi.fn();
    let interrupt = () => {};
    const unregister = vi.fn();
    const app = {
      ownerWindow: window,
      ownerDocument: document,
      state: viewport,
      viewport: {
        registerCaretFollow: (fn: () => void) => {
          interrupt = fn;
          return unregister;
        },
        cancelCaretFollow: stop,
        followCaret: follow,
        getSidebarInsets: () => ({ left: 0, right: 0 }),
        getOffsets: () => ({ top: 0, bottom: 0 }),
      },
      text: { getTextSidePanels: () => [] },
    } as unknown as App;
    const controller = createCaretFollow(
      app,
      editable,
      () => caret(200, 750),
      () => false,
    );
    const flush = () => {
      const fn = callback;
      callback = null;
      fn?.(0);
    };
    try {
      document.dispatchEvent(new Event("selectionchange"));
      window.dispatchEvent(new Event("scroll"));
      expect(callback).toBe(null);
      editable.dispatchEvent(new Event("input"));
      flush();
      expect(follow).toHaveBeenCalledWith(0, -26);
      interrupt();
      editable.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true }),
      );
      controller.schedule();
      expect(callback).toBe(null);
      editable.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
      flush();
      expect(follow).toHaveBeenCalledTimes(2);
      interrupt();
      editable.dispatchEvent(new CompositionEvent("compositionupdate"));
      flush();
      expect(follow).toHaveBeenCalledTimes(3);
      window.dispatchEvent(new Event("wheel"));
      expect(stop).toHaveBeenCalled();
      editable.dispatchEvent(new Event("input"));
      controller.destroy();
      expect(callback).toBe(null);
      editable.dispatchEvent(new Event("input"));
      expect(callback).toBe(null);
      expect(unregister).toHaveBeenCalledTimes(1);
    } finally {
      controller.destroy();
      editable.remove();
      raf.mockRestore();
      cancel.mockRestore();
    }
  });
});

describe("native contenteditable focus geometry", () => {
  it.each(["<p><br></p>", "<ul><li><br></li></ul>", "<p>first<br></p>"])(
    "reads only the BR line when a collapsed Range has no box (%s)",
    (html) => {
      const editable = document.createElement("div");
      editable.innerHTML = html;
      document.body.append(editable);
      const br = editable.querySelector("br")!;
      const parent = br.parentElement!;
      const offset = [...parent.childNodes].indexOf(br);
      const selection = window.getSelection()!;
      selection.collapse(parent, offset);
      const original = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function (this: Range) {
        return (this.collapsed
          ? []
          : [{ ...caret(200, 750), height: 20 }]) as unknown as DOMRectList;
      };
      try {
        expect(getContentEditableCaretRect(editable)).toMatchObject(
          caret(200, 750),
        );
        expect(editable.innerHTML).toBe(html);
        expect(selection.focusNode).toBe(parent);
        expect(selection.focusOffset).toBe(offset);
      } finally {
        Range.prototype.getClientRects = original;
        editable.remove();
      }
    },
  );

  it("reads a collapsed focus Range without modifying nodes or the selection", () => {
    const editable = document.createElement("div");
    editable.innerHTML = "<p>first</p><p>中文输入</p>";
    document.body.append(editable);
    const text = editable.lastElementChild!.firstChild!;
    const selection = window.getSelection()!;
    selection.collapse(text, 2);
    const original = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function (this: Range) {
      expect(this.collapsed).toBe(true);
      expect(this.startContainer).toBe(text);
      expect(this.startOffset).toBe(2);
      return [{ ...caret(200, 750), height: 20 }] as unknown as DOMRectList;
    };
    try {
      expect(getContentEditableCaretRect(editable)).toMatchObject(
        caret(200, 750),
      );
      expect(selection.focusNode).toBe(text);
      expect(selection.focusOffset).toBe(2);
      expect(editable.textContent).toBe("first中文输入");
    } finally {
      Range.prototype.getClientRects = original;
      editable.remove();
    }
  });
});
