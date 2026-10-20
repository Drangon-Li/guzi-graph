import clsx from "clsx";

import { IconButton } from "./IconButton";
import { useAppProps } from "./App";
import { PenModeIcon } from "./icons";

type PenModeButtonProps = {
  title?: string;
  checked: boolean;
  onChange?(): void;
  isMobile?: boolean;
  penDetected: boolean;
};

export const PenModeButton = (props: PenModeButtonProps) => {
  const appProps = useAppProps();
  if (!props.penDetected) {
    return null;
  }

  return (
    <IconButton
      className={clsx("ToolIcon__penMode", { "is-mobile": props.isMobile })}
      type="toggle"
      icon={PenModeIcon}
      checked={props.checked}
      tooltip={`${props.title}`}
      tooltipEnabled={appProps?.desktopIntegration?.toolbarTooltips !== false}
      aria-label={`${props.title}`}
      onSelect={() => props.onChange?.()}
    />
  );
};
