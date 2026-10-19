import { useContext } from "react";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { PersistentMenuContext } from "./common";
import DropdownMenuSubContent from "./DropdownMenuSubContent";
import DropdownMenuSubTrigger from "./DropdownMenuSubTrigger";
import {
  getSubMenuContentComponent,
  getSubMenuTriggerComponent,
} from "./dropdownMenuUtils";

const DropdownMenuSub = ({ children }: { children?: React.ReactNode }) => {
  const MenuTriggerComp = getSubMenuTriggerComponent(children);
  const MenuContentComp = getSubMenuContentComponent(children);
  const persistent = useContext(PersistentMenuContext);
  if (persistent) {
    return (
      <details className="dropdown-menu__submenu--persistent">
        {MenuTriggerComp}
        {MenuContentComp}
      </details>
    );
  }
  return (
    <DropdownMenuPrimitive.Sub>
      {MenuTriggerComp}
      {MenuContentComp}
    </DropdownMenuPrimitive.Sub>
  );
};

DropdownMenuSub.Trigger = DropdownMenuSubTrigger;
DropdownMenuSub.Content = DropdownMenuSubContent;

DropdownMenuSub.displayName = "DropdownMenuSub";

export default DropdownMenuSub;
