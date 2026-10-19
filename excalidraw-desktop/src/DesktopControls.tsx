import { useId, useState } from "react";
import { Select } from "radix-ui";
import {
  checkIcon,
  chevronDownIcon,
} from "@excalidraw/excalidraw/components/icons";

import "./DesktopControls.scss";

import type { ReactNode } from "react";

export type DesktopControlOption = {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
};

export const DesktopSelect = ({
  root,
  label,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  root: HTMLElement;
  label: string;
  value: string;
  options: DesktopControlOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) => {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  return (
    <Select.Root
      value={`option:${value}`}
      onValueChange={(selected) => onValueChange(selected.slice(7))}
      disabled={disabled}
    >
      <Select.Trigger
        ref={setTrigger}
        className="desktop-select-trigger"
        aria-label={label}
      >
        <Select.Value />
        <Select.Icon>{chevronDownIcon}</Select.Icon>
      </Select.Trigger>
      <Select.Portal container={trigger?.closest(".desktop-shell") || root}>
        <Select.Content
          className="desktop-select-content"
          position="popper"
          sideOffset={5}
          collisionPadding={10}
          aria-label={label}
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={`option:${option.value}`}
                className="desktop-select-option"
              >
                <span className="desktop-select-check">
                  <Select.ItemIndicator>{checkIcon}</Select.ItemIndicator>
                </span>
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
};

export const DesktopSegmentedControl = ({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: DesktopControlOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) => {
  const name = useId();
  return (
    <div
      className="desktop-segmented-control"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={`desktop-segmented-option${
            value === option.value ? " is-selected" : ""
          }${disabled ? " is-disabled" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            tabIndex={value === option.value ? 0 : -1}
            onChange={() => onValueChange(option.value)}
          />
          {option.icon && (
            <span className="desktop-control-icon" aria-hidden="true">
              {option.icon}
            </span>
          )}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
};
