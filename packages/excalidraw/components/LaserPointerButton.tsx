import clsx from "clsx";

import { IconButton } from "./IconButton";
import { useAppProps } from "./App";
import { laserPointerToolIcon } from "./icons";

type LaserPointerButtonProps = {
  title?: string;
  checked: boolean;
  onChange?(): void;
  isMobile?: boolean;
};

export const LaserPointerButton = (props: LaserPointerButtonProps) => {
  const appProps = useAppProps();
  return (
    <IconButton
      className={clsx("ToolIcon__LaserPointer", {
        "is-mobile": props.isMobile,
      })}
      type="toggle"
      size="small"
      icon={laserPointerToolIcon}
      checked={props.checked}
      tooltip={`${props.title}`}
      tooltipEnabled={appProps?.desktopIntegration?.toolbarTooltips !== false}
      aria-label={`${props.title}`}
      data-testid="toolbar-LaserPointer"
      onSelect={() => props.onChange?.()}
    />
  );
};
