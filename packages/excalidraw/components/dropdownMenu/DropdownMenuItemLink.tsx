import React from "react";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import type { Merge } from "@excalidraw/common/utility-types";

import MenuItemContent from "./DropdownMenuItemContent";
import {
  getDropdownMenuItemClassName,
  PersistentMenuContext,
  useHandleDropdownMenuItemSelect,
} from "./common";

import type { JSX } from "react";

const DropdownMenuItemLink = ({
  icon,
  shortcut,
  href,
  children,
  onSelect,
  className = "",
  selected,
  rel = "noopener",
  ...rest
}: Merge<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  {
    href: string;
    icon?: JSX.Element;
    children: React.ReactNode;
    shortcut?: string;
    className?: string;
    selected?: boolean;
    onSelect?: (event: Event) => void;
    rel?: string;
  }
>) => {
  const handleSelect = useHandleDropdownMenuItemSelect(onSelect);
  const persistent = React.useContext(PersistentMenuContext);

  const item = (
    // eslint-disable-next-line react/jsx-no-target-blank
    <a
      {...rest}
      href={href}
      target="_blank"
      rel={`noopener ${rel}`}
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
      <MenuItemContent icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemContent>
    </a>
  );

  if (persistent) {
    return item;
  }

  return (
    // eslint-disable-next-line react/jsx-no-target-blank
    <DropdownMenuPrimitive.Item
      className="radix-menu-item"
      onSelect={handleSelect}
      asChild
    >
      {item}
    </DropdownMenuPrimitive.Item>
  );
};

export default DropdownMenuItemLink;
DropdownMenuItemLink.displayName = "DropdownMenuItemLink";
