export type RichTextCommand =
  | { type: "bold" | "italic" | "underline" }
  | { type: "layout" }
  | { type: "fontSize"; value: number; baseFontSize: number }
  | { type: "fontSize"; scale: number; baseFontSize: number }
  | { type: "background"; value: string | null }
  | { type: "color"; value: string }
  | { type: "list"; value: "ordered" | "bullet" | null }
  | { type: "indent"; value: "in" | "out" };

export type RichTextSelectionState = {
  elementId: string;
  background: string | null;
  color: string | null;
  hasSelection: boolean;
  fontSize?: number | null;
  list: "none" | "ordered" | "bullet" | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  composing?: boolean;
  selectionKey?: string;
  rect?: { left: number; top: number; right: number; bottom: number } | null;
};

const selectionStates = new WeakMap<Document, RichTextSelectionState>();
const selectionListeners = new WeakMap<Document, Set<() => void>>();

export const getRichTextSelectionState = (ownerDocument: Document) =>
  selectionStates.get(ownerDocument) ?? null;

export const subscribeRichTextSelection = (
  ownerDocument: Document,
  listener: () => void,
) => {
  const listeners =
    selectionListeners.get(ownerDocument) ?? new Set<() => void>();
  listeners.add(listener);
  selectionListeners.set(ownerDocument, listeners);
  return () => {
    listeners.delete(listener);
  };
};

export const publishRichTextSelectionState = (
  ownerDocument: Document,
  state: RichTextSelectionState | null,
) => {
  const previous = selectionStates.get(ownerDocument);
  if (
    state
      ? previous?.elementId === state.elementId &&
        previous.background === state.background &&
        previous.color === state.color &&
        previous.hasSelection === state.hasSelection &&
        previous.fontSize === state.fontSize &&
        previous.list === state.list &&
        previous.bold === state.bold &&
        previous.italic === state.italic &&
        previous.underline === state.underline &&
        previous.composing === state.composing &&
        previous.selectionKey === state.selectionKey &&
        previous.rect?.left === state.rect?.left &&
        previous.rect?.right === state.rect?.right &&
        previous.rect?.top === state.rect?.top &&
        previous.rect?.bottom === state.rect?.bottom
      : !previous
  ) {
    return;
  }
  if (state) {
    selectionStates.set(ownerDocument, state);
  } else {
    selectionStates.delete(ownerDocument);
  }
  selectionListeners.get(ownerDocument)?.forEach((listener) => listener());
};

type ActiveEditor = {
  elementId: string;
  hasTextSelection: () => boolean;
  execute: (command: RichTextCommand) => void;
  focus?: () => void;
};
const editors = new WeakMap<Document, ActiveEditor>();

export const registerRichTextEditor = (
  ownerDocument: Document,
  editor: ActiveEditor,
) => {
  editors.set(ownerDocument, editor);
  return (preserveSelection = false) => {
    if (editors.get(ownerDocument) === editor) {
      editors.delete(ownerDocument);
      if (!preserveSelection) {
        publishRichTextSelectionState(ownerDocument, null);
      }
    }
  };
};

export const executeRichTextCommand = (
  ownerDocument: Document,
  command: RichTextCommand,
  selectedTextElementId?: string,
) => {
  const editor = editors.get(ownerDocument);
  if (
    !editor ||
    (selectedTextElementId &&
      (editor.elementId !== selectedTextElementId ||
        !editor.hasTextSelection()))
  ) {
    return false;
  }
  editor.execute(command);
  return true;
};

export const focusRichTextEditor = (ownerDocument: Document) => {
  editors.get(ownerDocument)?.focus?.();
};
