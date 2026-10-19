import clsx from "clsx";
import React, { useEffect, useRef } from "react";

import { getShortcutFromShortcutName } from "../actions/shortcuts";
import { t } from "../i18n";

import { useExcalidrawAppState, useExcalidrawElements } from "./App";

import { Popover } from "./Popover";
import { checkIcon, clipboard } from "./icons";

import "./ContextMenu.scss";

import type { ActionManager } from "../actions/manager";
import type { ShortcutName } from "../actions/shortcuts";
import type { Action } from "../actions/types";

import type { TranslationKeys } from "../i18n";

export type ContextMenuItem = typeof CONTEXT_MENU_SEPARATOR | Action;

export type ContextMenuItems = (ContextMenuItem | false | null | undefined)[];

type ContextMenuProps = {
  actionManager: ActionManager;
  items: ContextMenuItems;
  top: number;
  left: number;
  onClose: (callback?: () => void) => void;
};

export const CONTEXT_MENU_SEPARATOR = "separator";

export const ContextMenu = React.memo(
  ({ actionManager, items, top, left, onClose }: ContextMenuProps) => {
    const appState = useExcalidrawAppState();
    const elements = useExcalidrawElements();
    const menuRef = useRef<HTMLUListElement>(null);

    useEffect(() => {
      const menu = menuRef.current!;
      const popover = menu.parentElement!;
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          !["Escape", "Tab", "ArrowDown", "ArrowUp", "Home", "End"].includes(
            event.key,
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          onClose();
          return;
        }
        const buttons = Array.from(
          menu.querySelectorAll<HTMLButtonElement>("button"),
        );
        const index = buttons.findIndex(
          (button) => button === menu.ownerDocument.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
            ? buttons.length - 1
            : index < 0
            ? event.key === "ArrowDown"
              ? 0
              : buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
        buttons[next]?.focus();
      };
      popover.addEventListener("keydown", onKeyDown, true);
      return () => popover.removeEventListener("keydown", onKeyDown, true);
    }, [onClose]);

    const filteredItems = items.reduce((acc: ContextMenuItem[], item) => {
      if (
        item &&
        (item === CONTEXT_MENU_SEPARATOR ||
          !item.predicate ||
          item.predicate(
            elements,
            appState,
            actionManager.app.props,
            actionManager.app,
          ))
      ) {
        acc.push(item);
      }
      return acc;
    }, []);

    return (
      <Popover
        onCloseRequest={() => {
          onClose();
        }}
        top={top}
        left={left}
        fitInViewport={true}
        viewportWidth={appState.width}
        viewportHeight={appState.height}
        className="context-menu-popover"
      >
        <ul
          ref={menuRef}
          role="menu"
          className="context-menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          {filteredItems.map((item, idx) => {
            if (item === CONTEXT_MENU_SEPARATOR) {
              if (
                !filteredItems[idx - 1] ||
                filteredItems[idx - 1] === CONTEXT_MENU_SEPARATOR ||
                !filteredItems[idx + 1]
              ) {
                return null;
              }
              return <hr key={idx} className="context-menu-item-separator" />;
            }

            const actionName = item.name;
            const checked = item.checked?.(appState);
            const icon = checked
              ? checkIcon
              : typeof item.icon === "function"
              ? item.icon(appState, elements)
              : item.icon || (actionName === "paste" ? clipboard : null);
            let label = "";
            if (item.label) {
              if (typeof item.label === "function") {
                label = t(
                  item.label(
                    elements,
                    appState,
                    actionManager.app,
                  ) as unknown as TranslationKeys,
                );
              } else {
                label = t(item.label as unknown as TranslationKeys);
              }
            }

            return (
              <li
                key={idx}
                role="none"
                data-testid={actionName}
                onClick={() => {
                  // we need update state before executing the action in case
                  // the action uses the appState it's being passed (that still
                  // contains a defined contextMenu) to return the next state.
                  onClose(() => {
                    actionManager.executeAction(item, "contextMenu");
                  });
                }}
              >
                <button
                  type="button"
                  role={item.checked ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={item.checked ? checked : undefined}
                  className={clsx("context-menu-item", {
                    dangerous: actionName === "deleteSelectedElements",
                    checkmark: checked,
                  })}
                >
                  <span className="context-menu-item__icon" aria-hidden="true">
                    {icon}
                  </span>
                  <div className="context-menu-item__label">{label}</div>
                  <kbd className="context-menu-item__shortcut">
                    {actionName
                      ? getShortcutFromShortcutName(actionName as ShortcutName)
                      : ""}
                  </kbd>
                </button>
              </li>
            );
          })}
        </ul>
      </Popover>
    );
  },
);
