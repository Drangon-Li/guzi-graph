import { isWritableElement, KEYS } from "@excalidraw/common";

export const handleDesktopEditingCommand = async (
  root: HTMLElement,
  command: "undo" | "redo",
  options: { canvasActive: boolean; blocked: boolean },
) => {
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const focused = ownerDocument.activeElement;
  if (
    isWritableElement(focused) ||
    (focused instanceof ownerWindow.HTMLElement && focused.isContentEditable)
  ) {
    if (!focused.matches(":disabled, [readonly]")) {
      if (focused.closest(".excalidraw-rich-text")) {
        focused.dispatchEvent(
          new ownerWindow.KeyboardEvent("keydown", {
            key: "z",
            code: "KeyZ",
            [KEYS.CTRL_OR_CMD]: true,
            shiftKey: command === "redo",
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        await ownerWindow.desktop.editText(command);
      }
    }
    return;
  }
  if (!options.canvasActive || options.blocked) {
    return;
  }

  const filmstrip = root.querySelector<HTMLElement>(
    ".desktop-editor-pane.is-active .desktop-presentation-filmstrip",
  );
  const editor =
    (focused && filmstrip?.contains(focused) ? focused : null) ??
    root.querySelector<HTMLElement>(
      ".desktop-editor-pane.is-active .desktop-subcanvas .excalidraw",
    ) ??
    root.querySelector<HTMLElement>(
      ".desktop-editor-pane.is-active .excalidraw",
    );
  // Dispatch in the renderer so the native accelerator cannot consume it again.
  editor?.dispatchEvent(
    new ownerWindow.KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
      shiftKey: command === "redo",
      bubbles: true,
      cancelable: true,
    }),
  );
};
