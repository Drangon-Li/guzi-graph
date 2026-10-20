import React from "react";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { chevronRight } from "../icons";

import { getDropdownMenuItemClassName, PersistentMenuContext } from "./common";
import MenuItemContent from "./DropdownMenuItemContent";

import type { JSX } from "react";

const DropdownMenuSubTrigger = ({
  children,
  icon,
  shortcut,
  className,
}: {
  children: React.ReactNode;
  icon?: JSX.Element;
  shortcut?: string;
  className?: string;
}) => {
  const persistent = React.useContext(PersistentMenuContext);
  const Trigger = persistent ? "summary" : DropdownMenuPrimitive.SubTrigger;
  return (
    <Trigger
      className={`${getDropdownMenuItemClassName(
        className,
      )} dropdown-menu__submenu-trigger`}
    >
      <MenuItemContent icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemContent>
      <div className="dropdown-menu__submenu-trigger-icon">{chevronRight}</div>
    </Trigger>
  );
};

export default DropdownMenuSubTrigger;
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";
