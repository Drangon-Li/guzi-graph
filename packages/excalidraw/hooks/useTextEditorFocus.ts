import { useState, useCallback } from "react";

// Utility type for caret position
export type CaretPosition = {
  start: number;
  end: number;
  range?: Range;
};

// Utility function to get text editor element
const getTextEditor = (ownerDocument: Document): HTMLElement | null =>
  ownerDocument.querySelector(".excalidraw-wysiwyg");

const restoreSelection = (editor: HTMLElement, position: CaretPosition) => {
  const ownerWindow = editor.ownerDocument.defaultView;
  if (ownerWindow && editor instanceof ownerWindow.HTMLTextAreaElement) {
    editor.setSelectionRange(position.start, position.end);
  } else if (
    position.range &&
    editor.contains(position.range.commonAncestorContainer)
  ) {
    const selection = ownerWindow?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(position.range);
  }
};

// Utility functions for caret position management
export const saveCaretPosition = (
  ownerDocument: Document = document,
): CaretPosition | null => {
  const textEditor = getTextEditor(ownerDocument);
  if (textEditor) {
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow && textEditor instanceof ownerWindow.HTMLTextAreaElement) {
      return { start: textEditor.selectionStart, end: textEditor.selectionEnd };
    }
    const selection = ownerWindow?.getSelection();
    if (selection?.rangeCount && textEditor.contains(selection.anchorNode)) {
      return { start: 0, end: 0, range: selection.getRangeAt(0).cloneRange() };
    }
  }
  return null;
};

export const restoreCaretPosition = (
  position: CaretPosition | null,
  ownerDocument: Document = document,
): void => {
  const ownerWindow = ownerDocument.defaultView ?? window;
  ownerWindow.setTimeout(() => {
    const textEditor = getTextEditor(ownerDocument);
    if (textEditor) {
      textEditor.focus();
      if (position) {
        restoreSelection(textEditor, position);
      }
    }
  }, 0);
};

export const withCaretPositionPreservation = (
  callback: () => void,
  isCompactMode: boolean,
  isEditingText: boolean,
  onPreventClose?: () => void,
  ownerDocument: Document = document,
): void => {
  // Prevent popover from closing in compact mode
  if (isCompactMode && onPreventClose) {
    onPreventClose();
  }

  // Save caret position if editing text
  const savedPosition =
    isCompactMode && isEditingText ? saveCaretPosition(ownerDocument) : null;

  // Execute the callback
  callback();

  // Restore caret position if needed
  if (isCompactMode && isEditingText) {
    restoreCaretPosition(savedPosition, ownerDocument);
  }
};

// Hook for managing text editor caret position with state
export const useTextEditorFocus = (ownerDocument: Document = document) => {
  const [savedCaretPosition, setSavedCaretPosition] =
    useState<CaretPosition | null>(null);

  const saveCaretPositionToState = useCallback(() => {
    const position = saveCaretPosition(ownerDocument);
    setSavedCaretPosition(position);
  }, [ownerDocument]);

  const restoreCaretPositionFromState = useCallback(() => {
    const ownerWindow = ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => {
      const textEditor = getTextEditor(ownerDocument);
      if (textEditor) {
        textEditor.focus();
        if (savedCaretPosition) {
          restoreSelection(textEditor, savedCaretPosition);
          setSavedCaretPosition(null);
        }
      }
    }, 0);
  }, [ownerDocument, savedCaretPosition]);

  const clearSavedPosition = useCallback(() => {
    setSavedCaretPosition(null);
  }, []);

  return {
    saveCaretPosition: saveCaretPositionToState,
    restoreCaretPosition: restoreCaretPositionFromState,
    clearSavedPosition,
    hasSavedPosition: !!savedCaretPosition,
  };
};

// Utility function to temporarily disable text editor blur
export const temporarilyDisableTextEditorBlur = (
  ownerDocument: Document = document,
  duration: number = 100,
): void => {
  const textEditor = getTextEditor(ownerDocument);
  if (textEditor) {
    const originalOnBlur = textEditor.onblur;
    textEditor.onblur = null;

    const ownerWindow = ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => {
      textEditor.onblur = originalOnBlur;
    }, duration);
  }
};
