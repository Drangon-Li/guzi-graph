import { useState } from "react";
import { Popover } from "radix-ui";

import { DEFAULT_ELEMENT_STROKE_COLOR_PALETTE } from "@excalidraw/common";
import { chevronDownIcon } from "@excalidraw/excalidraw/components/icons";

import "./PreferenceColorPicker.scss";

import type { DesktopLanguage } from "../../shared/i18n/i18n";

const COLOR_NAMES = {
  transparent: ["透明", "Transparent"],
  black: ["黑色", "Black"],
  white: ["白色", "White"],
  gray: ["灰色", "Gray"],
  red: ["红色", "Red"],
  pink: ["粉色", "Pink"],
  grape: ["葡萄紫", "Grape"],
  violet: ["紫色", "Violet"],
  blue: ["蓝色", "Blue"],
  cyan: ["青色", "Cyan"],
  teal: ["蓝绿色", "Teal"],
  green: ["绿色", "Green"],
  yellow: ["黄色", "Yellow"],
  orange: ["橙色", "Orange"],
  bronze: ["棕色", "Bronze"],
} as const;

const PALETTE_ENTRIES: [string, string | readonly string[]][] = Object.entries(
  DEFAULT_ELEMENT_STROKE_COLOR_PALETTE,
);

export const PreferenceColorPicker = ({
  root,
  label,
  value,
  language,
  allowTransparent = false,
  defaultShade = 4,
  showValue = false,
  onChange,
}: {
  root: HTMLElement;
  label: string;
  value: string;
  language: DesktopLanguage;
  allowTransparent?: boolean;
  defaultShade?: number;
  showValue?: boolean;
  onChange: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const en = language === "en";
  const selectedFamily = PALETTE_ENTRIES.find(([, colors]) =>
    typeof colors === "string" ? colors === value : colors.includes(value),
  );
  const shades =
    selectedFamily && typeof selectedFamily[1] !== "string"
      ? selectedFamily[1]
      : null;
  const selectedShade = shades?.indexOf(value) ?? -1;
  const shadeIndex = selectedShade >= 0 ? selectedShade : defaultShade;
  const colorName = (name: string) =>
    COLOR_NAMES[name as keyof typeof COLOR_NAMES][en ? 1 : 0];
  const commonLabel = en ? "Common colors" : "常用颜色";
  return (
    <Popover.Root modal open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={setTrigger}
        type="button"
        className="desktop-preference-color-trigger"
        aria-label={`${label} — ${commonLabel}`}
        title={`${label} — ${commonLabel}`}
      >
        <span
          className={`desktop-preference-color-swatch${
            value === "transparent" ? " is-transparent" : ""
          }`}
          style={{ backgroundColor: value }}
        />
        {showValue && <span>{value.toUpperCase()}</span>}
        <span aria-hidden="true" className="desktop-preference-color-chevron">
          {chevronDownIcon}
        </span>
      </Popover.Trigger>
      <Popover.Portal
        container={
          trigger?.closest(".desktop-modal-backdrop") ||
          trigger?.closest(".desktop-shell") ||
          root
        }
      >
        <Popover.Content
          className="desktop-preference-color-picker"
          aria-label={`${label} — ${commonLabel}`}
          sideOffset={6}
          collisionPadding={10}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <div className="desktop-preference-color-picker__heading">
            <span>{commonLabel}</span>
            <Popover.Close aria-label={en ? "Close color palette" : "关闭色板"}>
              ×
            </Popover.Close>
          </div>
          <div
            className="desktop-preference-color-picker__grid"
            role="group"
            aria-label={commonLabel}
          >
            {PALETTE_ENTRIES.map(([name, colors]) => {
              if (name === "transparent" && !allowTransparent) {
                return <span key={name} aria-hidden="true" />;
              }
              const color =
                typeof colors === "string" ? colors : colors[shadeIndex];
              return (
                <button
                  key={name}
                  type="button"
                  className={`desktop-preference-color-swatch${
                    color === "transparent" ? " is-transparent" : ""
                  }`}
                  style={{ backgroundColor: color }}
                  aria-label={`${colorName(name)} ${color}`}
                  title={`${colorName(name)} ${color}`}
                  aria-pressed={selectedFamily?.[0] === name}
                  onClick={() => onChange(color)}
                />
              );
            })}
          </div>
          {shades && (
            <>
              <span>{en ? "Shades · light to dark" : "深浅 · 从浅到深"}</span>
              <div
                className="desktop-preference-color-picker__grid"
                role="group"
                aria-label={en ? "Shades" : "深浅"}
              >
                {shades.map((color, index) => (
                  <button
                    key={color}
                    type="button"
                    className="desktop-preference-color-swatch"
                    style={{ backgroundColor: color }}
                    aria-label={`${colorName(selectedFamily![0])} ${
                      en ? "shade" : "深浅"
                    } ${index + 1} ${color}`}
                    title={color}
                    aria-pressed={value === color}
                    onClick={() => onChange(color)}
                  />
                ))}
              </div>
            </>
          )}
          <label className="desktop-preference-color-picker__custom">
            <span>{en ? "Custom color" : "自定义颜色"}</span>
            <input
              type="color"
              aria-label={label}
              value={value === "transparent" ? "#ffffff" : value}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
