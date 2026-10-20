import { useContext } from "react";

import { checkIcon, emptyIcon } from "../icons";

import { PersistentMenuContext } from "./common";
import DropdownMenuItem from "./DropdownMenuItem";

import type { DropdownMenuItemProps } from "./DropdownMenuItem";

const DropdownMenuItemCheckbox = (
  props: Omit<DropdownMenuItemProps, "icon"> & { checked: boolean },
) => {
  const persistent = useContext(PersistentMenuContext);
  return (
    <DropdownMenuItem
      {...props}
      {...(persistent
        ? { role: "checkbox", "aria-checked": props.checked }
        : {})}
      icon={props.checked ? checkIcon : emptyIcon}
    />
  );
};

export default DropdownMenuItemCheckbox;
