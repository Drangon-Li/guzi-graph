import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import "@excalidraw/excalidraw/components/ContextMenu.scss";

import "./ProjectContextMenu.scss";

type MenuItem = {
  label: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
};

export const ProjectContextMenu = ({
  id,
  root,
  anchor,
  label,
  left,
  top,
  align,
  items,
  onClose,
}: {
  id: string;
  root: HTMLElement;
  anchor: HTMLButtonElement;
  label: string;
  left: number;
  top: number;
  align: "start" | "end";
  items: MenuItem[];
  onClose: (restoreFocus?: boolean) => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const gap = 8;
    const { width, height } = menu.getBoundingClientRect();
    const desiredLeft = align === "end" ? left - width : left;
    menu.style.left = `${Math.max(
      gap,
      Math.min(desiredLeft, ownerWindow.innerWidth - width - gap),
    )}px`;
    menu.style.top = `${Math.max(
      gap,
      Math.min(top, ownerWindow.innerHeight - height - gap),
    )}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor, left, top, align, ownerWindow]);

  useEffect(() => {
    const menu = menuRef.current!;
    const onOutsidePointer = (event: Event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !anchor.contains(target)) {
        onClose();
      }
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !anchor.contains(target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }
    };
    const onScroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) {
        onClose(true);
      }
    };
    const onResize = () => onClose(true);
    const onBlur = () => onClose();
    ownerDocument.addEventListener("pointerdown", onOutsidePointer, true);
    ownerDocument.addEventListener("contextmenu", onOutsidePointer, true);
    ownerDocument.addEventListener("focusin", onFocus);
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    ownerDocument.addEventListener("scroll", onScroll, true);
    ownerWindow.addEventListener("resize", onResize);
    ownerWindow.addEventListener("blur", onBlur);
    return () => {
      ownerDocument.removeEventListener("pointerdown", onOutsidePointer, true);
      ownerDocument.removeEventListener("contextmenu", onOutsidePointer, true);
      ownerDocument.removeEventListener("focusin", onFocus);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("scroll", onScroll, true);
      ownerWindow.removeEventListener("resize", onResize);
      ownerWindow.removeEventListener("blur", onBlur);
    };
  }, [anchor, onClose, ownerDocument, ownerWindow]);

  return createPortal(
    <div
      id={id}
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="context-menu desktop-project-context-menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          onClose(true);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const index = buttons.findIndex(
          (button) => button === ownerDocument.activeElement,
        );
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
        buttons[nextIndex]?.focus();
      }}
    >
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="context-menu-item"
          key={item.label}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose(true);
            item.onSelect();
          }}
        >
          <span className="context-menu-item__label">{item.label}</span>
        </button>
      ))}
    </div>,
    anchor.closest(".desktop-shell") || root,
  );
};
