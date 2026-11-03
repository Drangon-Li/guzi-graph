import type App from "../components/App";

export type CaretRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const getAxisFollowDelta = (
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
  margins: {
    before: number;
    after: number;
    landingBefore: number;
    landingAfter: number;
  },
) => {
  const available = viewportEnd - viewportStart;
  if (available <= 0) {
    return 0;
  }
  const size = end - start;
  if (size >= available) {
    // A larger caret cannot fit. Leave it still while it covers the viewport,
    // otherwise move just enough to cover the nearest viewport edge.
    return Math.max(viewportEnd - end, Math.min(viewportStart - start, 0));
  }
  const scale = Math.min(
    1,
    (available - size) / (margins.before + margins.after),
  );
  const safeStart = viewportStart + margins.before * scale;
  const safeEnd = viewportEnd - margins.after * scale;
  const desired =
    start < safeStart - 0.01
      ? safeStart + margins.landingBefore - start
      : end > safeEnd + 0.01
      ? safeEnd - margins.landingAfter - end
      : 0;
  const delta = Math.max(safeStart - start, Math.min(safeEnd - end, desired));
  return Math.abs(delta) < 0.01 ? 0 : delta;
};

export const getCaretFollowDelta = ({
  caret,
  width,
  height,
  insets,
  panels = [],
  composing,
}: {
  caret: CaretRect;
  width: number;
  height: number;
  insets: { left: number; right: number; top: number; bottom: number };
  panels?: CaretRect[];
  composing: boolean;
}) => {
  const horizontal = Math.min(
    16,
    Math.max(0, width - insets.left - insets.right) / 6,
  );
  const vertical = Math.max(0, height - insets.top - insets.bottom);
  const bottom = Math.min(composing ? 96 : 40, vertical / 3);
  const top = Math.min(20, vertical / 6);
  let x = getAxisFollowDelta(
    caret.left,
    caret.right,
    insets.left,
    width - insets.right,
    {
      before: horizontal,
      after: horizontal,
      landingBefore: 12,
      landingAfter: 12,
    },
  );
  const y = getAxisFollowDelta(
    caret.top,
    caret.bottom,
    insets.top,
    height - insets.bottom,
    {
      before: top,
      after: bottom,
      landingBefore: 12,
      landingAfter: 16,
    },
  );
  for (const panel of panels) {
    if (
      caret.right + x >= panel.left - 8 &&
      caret.left + x <= panel.right + 8 &&
      caret.bottom + y > panel.top &&
      caret.top + y < panel.bottom
    ) {
      const candidate =
        panel.left + panel.right < width
          ? panel.right + 20 - caret.left
          : panel.left - 20 - caret.right;
      if (
        caret.left + candidate >= insets.left &&
        caret.right + candidate <= width - insets.right
      ) {
        x = candidate;
      }
    }
  }
  return { x, y };
};

/** Read the native focus point, including the DOM owned by an active IME. */
export const getContentEditableCaretRect = (
  editable: HTMLElement,
): CaretRect | null => {
  const document = editable.ownerDocument;
  const window = document.defaultView;
  const selection = window?.getSelection();
  const focus = selection?.focusNode;
  if (!window || !selection || !focus || !editable.contains(focus)) {
    return null;
  }
  const range = document.createRange();
  range.setStart(focus, selection.focusOffset);
  range.collapse(true);
  const readRect = () => {
    const rects =
      typeof range.getClientRects === "function" ? range.getClientRects() : [];
    return [...rects].find((rect) => rect.height > 0) ?? null;
  };
  const collapsed = readRect();
  if (collapsed) {
    return collapsed;
  }
  // Empty lines and soft breaks can have no collapsed Range box. Inspect
  // only a neighboring character/BR, never the whole paragraph or editor.
  let node = focus;
  let offset = selection.focusOffset;
  if (node.nodeType === window.Node.ELEMENT_NODE) {
    const next = node.childNodes[offset];
    node = next ?? node.childNodes[offset - 1] ?? node;
    offset = next || node === focus ? 0 : node.textContent?.length ?? 0;
    while (node.firstChild) {
      node = offset === 0 ? node.firstChild : node.lastChild!;
      offset = offset === 0 ? 0 : node.textContent?.length ?? 0;
    }
  }
  if (node.nodeType === window.Node.TEXT_NODE && node.textContent?.length) {
    const end = Math.max(1, Math.min(offset, node.textContent.length));
    range.setStart(node, end - 1);
    range.setEnd(node, end);
    const rect = readRect();
    if (rect) {
      const x = offset === 0 ? rect.left : rect.right;
      return { left: x, right: x, top: rect.top, bottom: rect.bottom };
    }
  }
  const element =
    node.nodeType === window.Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  if (!element || (element.textContent && element.tagName !== "BR")) {
    return null;
  }
  if (element.tagName === "BR") {
    range.selectNode(element);
    const rect = readRect();
    if (rect) {
      return rect;
    }
  }
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 20;
  return {
    left: rect.left,
    right: rect.left,
    top: rect.top,
    bottom: rect.top + lineHeight,
  };
};

export const createCaretFollow = (
  app: App,
  editable: HTMLElement,
  getCaret: () => CaretRect | null,
  isComposing: () => boolean,
) => {
  const window = app.ownerWindow;
  let frame: number | null = null;
  let enabled = true;
  let destroyed = false;
  const interrupt = () => {
    enabled = false;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    app.viewport.cancelCaretFollow();
  };
  const unregister = app.viewport.registerCaretFollow(interrupt);
  const schedule = () => {
    if (!enabled || destroyed || frame !== null) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (
        destroyed ||
        !enabled ||
        !editable.isConnected ||
        app.ownerDocument.activeElement !== editable
      ) {
        return;
      }
      const caret = getCaret();
      if (!caret) {
        return;
      }
      const side = app.viewport.getSidebarInsets();
      const offsets = app.viewport.getOffsets({ padding: 0 });
      const delta = getCaretFollowDelta({
        caret,
        width: app.state.width,
        height: app.state.height,
        insets: { ...side, top: offsets.top ?? 0, bottom: offsets.bottom ?? 0 },
        composing: isComposing(),
        panels: app.text.getTextSidePanels().flatMap((name) => {
          const rect = app.viewport.getSideUIRect(name);
          return rect ? [rect] : [];
        }),
      });
      if (delta.x || delta.y) {
        app.viewport.followCaret(delta.x, delta.y);
      }
    });
  };
  const onInput = () => {
    enabled = true;
    schedule();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(event.key) &&
      !event.shiftKey
    ) {
      enabled = true;
      schedule();
    }
  };
  const inputEvents = [
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
  ] as const;
  inputEvents.forEach((name) => editable.addEventListener(name, onInput));
  editable.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointerdown", interrupt, true);
  window.addEventListener("wheel", interrupt, true);
  return {
    schedule,
    destroy: () => {
      destroyed = true;
      interrupt();
      unregister();
      inputEvents.forEach((name) =>
        editable.removeEventListener(name, onInput),
      );
      editable.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", interrupt, true);
      window.removeEventListener("wheel", interrupt, true);
    },
  };
};
