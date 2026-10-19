import React from "react";

import { THEME } from "@excalidraw/common";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import type { ValueOf } from "@excalidraw/common/utility-types";

import { useExcalidrawAppState } from "../App";

import {
  getDropdownMenuItemClassName,
  PersistentMenuContext,
  useHandleDropdownMenuItemSelect,
} from "./common";
import MenuItemContent from "./DropdownMenuItemContent";

import type { JSX } from "react";

export type DropdownMenuItemProps = {
  icon?: JSX.Element;
  badge?: React.ReactNode;
  value?: string | number | undefined;
  onSelect?: (event: Event) => void;
  children: React.ReactNode;
  shortcut?: string;
  selected?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">;

const DropdownMenuItem = ({
  icon,
  badge,
  value,
  children,
  shortcut,
  className,
  selected,
  onSelect,
  ...rest
}: DropdownMenuItemProps) => {
  const handleSelect = useHandleDropdownMenuItemSelect(onSelect);
  const persistent = React.useContext(PersistentMenuContext);

  const item = (
    <button
      {...rest}
      type={persistent ? rest.type ?? "button" : rest.type}
      value={value}
      className={getDropdownMenuItemClassName(className, selected)}
      title={rest.title ?? rest["aria-label"]}
      onClick={
        persistent
          ? (event) => {
              rest.onClick?.(event);
              if (!event.defaultPrevented) {
                handleSelect(event.nativeEvent);
              }
            }
          : rest.onClick
      }
    >
      <MenuItemContent icon={icon} shortcut={shortcut} badge={badge}>
        {children}
      </MenuItemContent>
    </button>
  );

  if (persistent) {
    return item;
  }

  return (
    <DropdownMenuPrimitive.Item
      className="radix-menu-item"
      onSelect={handleSelect}
      asChild
    >
      {item}
    </DropdownMenuPrimitive.Item>
  );
};
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropDownMenuItemBadgeType = {
  GREEN: "green",
  RED: "red",
  BLUE: "blue",
} as const;

export const DropDownMenuItemBadge = ({
  type = DropDownMenuItemBadgeType.BLUE,
  children,
}: {
  type?: ValueOf<typeof DropDownMenuItemBadgeType>;
  children: React.ReactNode;
}) => {
  const { theme } = useExcalidrawAppState();
  const style = {
    display: "inline-flex",
    marginLeft: "auto",
    padding: "2px 4px",
    borderRadius: 6,
    fontSize: 9,
    fontFamily: "Cascadia, monospace",
    border: theme === THEME.LIGHT ? "1.5px solid white" : "none",
  };

  switch (type) {
    case DropDownMenuItemBadgeType.GREEN:
      Object.assign(style, {
        backgroundColor: "var(--background-color-badge)",
        color: "var(--color-badge)",
      });
      break;
    case DropDownMenuItemBadgeType.RED:
      Object.assign(style, {
        backgroundColor: "pink",
        color: "darkred",
      });
      break;
    case DropDownMenuItemBadgeType.BLUE:
    default:
      Object.assign(style, {
        background: "var(--color-promo)",
        color: "var(--color-surface-lowest)",
      });
  }

  return (
    <div className="DropDownMenuItemBadge" style={style}>
      {children}
    </div>
  );
};
DropDownMenuItemBadge.displayName = "DropdownMenuItemBadge";

DropdownMenuItem.Badge = DropDownMenuItemBadge;

export default DropdownMenuItem;
