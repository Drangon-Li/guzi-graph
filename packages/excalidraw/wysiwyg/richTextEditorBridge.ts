export type RichTextCommand =
  | { type: "bold" | "italic" | "underline" }
  | { type: "layout" }
  | { type: "background"; value: string | null }
  | { type: "list"; value: "ordered" | "bullet" | null }
  | { type: "indent"; value: "in" | "out" };

export type RichTextSelectionState = {
  elementId: string;
  background: string | null;
  list: "none" | "ordered" | "bullet" | null;
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
        previous.list === state.list
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
  execute: (command: RichTextCommand) => void;
};
const editors = new WeakMap<Document, ActiveEditor>();

export const registerRichTextEditor = (
  ownerDocument: Document,
  editor: ActiveEditor,
) => {
  editors.set(ownerDocument, editor);
  return () => {
    if (editors.get(ownerDocument) === editor) {
      editors.delete(ownerDocument);
      publishRichTextSelectionState(ownerDocument, null);
    }
  };
};

export const executeRichTextCommand = (
  ownerDocument: Document,
  command: RichTextCommand,
) => {
  const editor = editors.get(ownerDocument);
  if (!editor) {
    return false;
  }
  editor.execute(command);
  return true;
};
