import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  executeRichTextCommand,
  focusRichTextEditor,
  getRichTextSelectionState,
  subscribeRichTextSelection,
} from "../features/rich-text/editorBridge";
import { t } from "../i18n";

import { ColorPicker } from "./ColorPicker/ColorPicker";

import "./SelectionToolbar.scss";
import "./TextSelectionToolbar.scss";

import type { RichTextSelectionState } from "../features/rich-text/editorBridge";
import type { AppClassProperties, UIAppState } from "../types";

export const getTextSelectionToolbarPosition = (
  rect: NonNullable<RichTextSelectionState["rect"]>,
  bounds: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  insets: { left: number; right: number; top?: number; bottom?: number },
) => {
  const left = bounds.left + insets.left;
  const right = bounds.left + bounds.width - insets.right;
  const top = bounds.top + Math.max(8, insets.top ?? 0);
  const bottom = bounds.top + bounds.height - Math.max(8, insets.bottom ?? 0);
  if (
    right - left < size.width ||
    rect.right < left ||
    rect.left > right ||
    rect.bottom < top ||
    rect.top > bottom
  ) {
    return null;
  }
  const above = rect.top - size.height - 10;
  const below = rect.bottom + 10;
  if (above < top && below + size.height > bottom) {
    return null;
  }
  return {
    left:
      Math.max(
        left,
        Math.min(right - size.width, (rect.left + rect.right - size.width) / 2),
      ) - bounds.left,
    top: (above >= top ? above : below) - bounds.top,
  };
};

export const TextSelectionToolbar = ({
  app,
  appState,
  leftInset,
  rightInset,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  leftInset: number;
  rightInset: number;
}) => {
  const selection = useSyncExternalStore(
    (listener) => subscribeRichTextSelection(app.ownerDocument, listener),
    () => getRichTextSelectionState(app.ownerDocument),
  );
  const [settled, setSettled] = useState(selection);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 218, height: 44 });
  const identity = selection
    ? `${selection.elementId}:${selection.selectionKey}`
    : "";
  useEffect(() => setDismissed(null), [identity]);
  useEffect(() => {
    const timer = app.ownerWindow.setTimeout(() => setSettled(selection), 140);
    return () => app.ownerWindow.clearTimeout(timer);
  }, [app, selection]);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (
        event.target instanceof app.ownerWindow.Element &&
        event.target.closest(".selection-toolbar, .properties-content")
      ) {
        return;
      }
      setDragging(true);
    };
    const up = () => setDragging(false);
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        event.target instanceof app.ownerWindow.Element &&
        event.target.closest(".properties-content") &&
        toolbarRef.current?.querySelector('[data-openpopup][data-state="open"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        app.setAppState({ openPopup: null });
        app.ownerWindow.requestAnimationFrame(() =>
          focusRichTextEditor(app.ownerDocument),
        );
        return;
      }
      if (
        event.key === "Escape" &&
        event.target instanceof app.ownerWindow.Element &&
        event.target.closest(".text-selection-toolbar")
      ) {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(identity);
        focusRichTextEditor(app.ownerDocument);
      }
    };
    app.ownerWindow.addEventListener("pointerdown", down, true);
    app.ownerWindow.addEventListener("pointerup", up, true);
    app.ownerWindow.addEventListener("pointercancel", up, true);
    app.ownerDocument.addEventListener("keydown", key, true);
    return () => {
      app.ownerWindow.removeEventListener("pointerdown", down, true);
      app.ownerWindow.removeEventListener("pointerup", up, true);
      app.ownerWindow.removeEventListener("pointercancel", up, true);
      app.ownerDocument.removeEventListener("keydown", key, true);
    };
  }, [app, identity]);
  const offsets = app.viewport.getOffsets();
  const position =
    selection?.hasSelection &&
    selection.rect &&
    !selection.composing &&
    !dragging &&
    settled?.elementId === selection.elementId &&
    settled?.selectionKey === selection.selectionKey &&
    dismissed !== identity &&
    appState.editingTextElement?.id === selection.elementId &&
    !appState.viewModeEnabled &&
    !appState.zenModeEnabled
      ? getTextSelectionToolbarPosition(
          selection.rect,
          {
            left: appState.offsetLeft,
            top: appState.offsetTop,
            width: appState.width,
            height: appState.height,
          },
          size,
          {
            left: Math.max(leftInset, offsets.left ?? 0),
            right: Math.max(rightInset, offsets.right ?? 0),
            top: offsets.top,
            bottom: offsets.bottom,
          },
        )
      : null;
  useLayoutEffect(() => {
    if (!position || !toolbarRef.current) {
      return;
    }
    const rect = toolbarRef.current.getBoundingClientRect();
    if (
      rect.width &&
      rect.height &&
      (rect.width !== size.width || rect.height !== size.height)
    ) {
      setSize({ width: rect.width, height: rect.height });
    }
  }, [position, size]);
  if (!position || !selection) {
    return null;
  }
  const updateData = (data: Partial<UIAppState>) => {
    app.setAppState((state) => ({ ...state, ...data }));
    if (data.openPopup === null) {
      app.ownerWindow.requestAnimationFrame(() =>
        focusRichTextEditor(app.ownerDocument),
      );
    }
  };
  return (
    <div
      className="selection-toolbar text-selection-toolbar"
      role="toolbar"
      aria-label={t("labels.textFormatting")}
      ref={toolbarRef}
      style={position}
      onPointerDown={(event) => {
        // Buttons must leave the native text range intact; color inputs live in a portal.
        if (!(event.target instanceof app.ownerWindow.HTMLInputElement)) {
          event.preventDefault();
        }
      }}
    >
      {(["bold", "italic", "underline"] as const).map((format) => (
        <button
          key={format}
          type="button"
          className={`text-selection-toolbar__format text-selection-toolbar__format--${format}`}
          aria-label={t(`labels.${format}`)}
          title={t(`labels.${format}`)}
          aria-pressed={!!selection[format]}
          onClick={() =>
            executeRichTextCommand(
              app.ownerDocument,
              { type: format },
              selection.elementId,
            )
          }
        >
          {{ bold: "B", italic: "I", underline: "U" }[format]}
        </button>
      ))}
      <ColorPicker
        type="elementStroke"
        color={selection.color}
        label={t("labels.textColor")}
        elements={[]}
        appState={appState}
        updateData={updateData}
        onChange={(value) =>
          executeRichTextCommand(
            app.ownerDocument,
            { type: "color", value },
            selection.elementId,
          )
        }
      />
      <ColorPicker
        type="elementBackground"
        color={selection.background ?? "transparent"}
        label={t("labels.textHighlight")}
        elements={[]}
        appState={appState}
        updateData={updateData}
        onChange={(value) =>
          executeRichTextCommand(
            app.ownerDocument,
            { type: "background", value },
            selection.elementId,
          )
        }
      />
    </div>
  );
};
