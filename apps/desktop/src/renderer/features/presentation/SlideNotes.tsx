import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import "./SlideNotes.scss";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent,
} from "react";

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

const isSaveShortcut = (event: ReactKeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  event.key.toLowerCase() === "s";

export const SlideNotesPopover = ({
  id,
  anchor,
  container,
  title,
  notes,
  mode,
  language,
  onChange,
  onEditingEnd,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  id: string;
  anchor: HTMLButtonElement;
  container: HTMLElement;
  title: string;
  notes: string;
  mode: "preview" | "edit";
  language: "zh-CN" | "en";
  onChange: (notes: string) => void;
  onEditingEnd: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const ownerDocument = anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const editing = mode === "edit";
  const previewText = editing ? null : notes;
  const titleId = `${id}-title`;
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);

  useLayoutEffect(() => {
    const popover = popoverRef.current!;
    const card = anchor.closest(".desktop-slide-item");
    const position = () => {
      const margin = 8;
      const gap = 6;
      const { innerHeight, innerWidth } = ownerWindow;
      const anchorBounds = anchor.getBoundingClientRect();
      const { top, bottom } = card?.getBoundingClientRect() ?? anchorBounds;
      const above = Math.min(top - gap, innerHeight - margin);
      const below = Math.max(bottom + gap, margin);
      const spaceAbove = above - margin;
      const spaceBelow = innerHeight - margin - below;
      popover.style.maxHeight = "";
      const { width, height } = popover.getBoundingClientRect();
      const placeAbove = height <= spaceAbove || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(0, placeAbove ? spaceAbove : spaceBelow);
      popover.style.maxHeight = `${maxHeight}px`;
      popover.style.top = `${
        placeAbove ? above - Math.min(height, maxHeight) : below
      }px`;
      popover.style.left = `${Math.max(
        margin,
        Math.min(anchorBounds.right - width, innerWidth - width - margin),
      )}px`;
    };
    const onScroll = (event: Event) => {
      if (!popover.contains(event.target as Node)) {
        position();
      }
    };

    position();
    ownerDocument.addEventListener("scroll", onScroll, true);
    ownerWindow.addEventListener("resize", position);
    return () => {
      ownerDocument.removeEventListener("scroll", onScroll, true);
      ownerWindow.removeEventListener("resize", position);
    };
  }, [anchor, container, editing, ownerDocument, ownerWindow, previewText]);

  useLayoutEffect(() => {
    composing.current = false;
    if (editing) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [anchor, editing]);

  useEffect(() => {
    const popover = popoverRef.current!;
    const onOutside = (event: Event) => {
      const target = event.target as Node;
      if (!popover.contains(target) && !anchor.contains(target)) {
        onClose();
      }
    };
    const onPreviewKeyDown = (event: KeyboardEvent) => {
      if (!event.isComposing && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    ownerDocument.addEventListener("pointerdown", onOutside, true);
    if (editing) {
      ownerDocument.addEventListener("focusin", onOutside);
    } else {
      ownerDocument.addEventListener("keydown", onPreviewKeyDown, true);
    }
    return () => {
      ownerDocument.removeEventListener("pointerdown", onOutside, true);
      ownerDocument.removeEventListener("focusin", onOutside);
      ownerDocument.removeEventListener("keydown", onPreviewKeyDown, true);
    };
  }, [anchor, container, editing, onClose, ownerDocument]);

  return createPortal(
    <div
      id={id}
      ref={popoverRef}
      className="desktop-slide-notes"
      role={editing ? "dialog" : "tooltip"}
      aria-labelledby={editing ? titleId : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onClick={stopPropagation}
      onDoubleClick={stopPropagation}
      onDragStart={stopPropagation}
      onContextMenu={stopPropagation}
      onCopy={stopPropagation}
      onCut={stopPropagation}
      onPaste={stopPropagation}
      onKeyUp={stopPropagation}
      onKeyDown={(event) => {
        const isComposing =
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229;
        if (isComposing || !isSaveShortcut(event)) {
          event.stopPropagation();
        }
        if (editing && !isComposing && event.key === "Escape") {
          event.preventDefault();
          onClose(true);
        }
      }}
    >
      <h2 className="desktop-slide-notes-heading" id={titleId} title={title}>
        {text(`“${title}”的备注`, `Notes for ${title}`)}
      </h2>
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            aria-labelledby={titleId}
            placeholder={text("添加备注…", "Add notes…")}
            value={notes}
            onChange={(event) => onChange(event.currentTarget.value)}
            onBlur={onEditingEnd}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
          <button type="button" onClick={() => onClose(true)}>
            {text("完成", "Done")}
          </button>
        </>
      ) : (
        <div className="desktop-slide-notes-preview">{previewText}</div>
      )}
    </div>,
    container,
  );
};
