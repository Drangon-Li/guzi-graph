import { useState } from "react";
import { Popover } from "radix-ui";

import type { FontFamilyValues } from "@excalidraw/element/types";

import { useAppStateValue } from "../hooks/useAppStateValue";

import { FontPickerList } from "./FontPicker/FontPickerList";
import { useAppProps } from "./App";
import { Button } from "./Button";

import "./SceneFontPicker.scss";

export const SceneFontPicker = () => {
  const { desktopIntegration, langCode } = useAppProps();
  const [open, setOpen] = useState(false);
  const font = useAppStateValue("currentItemFontFamily");
  const [hoveredFont, setHoveredFont] = useState<FontFamilyValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!desktopIntegration?.onReplaceSceneFont) {
    return null;
  }
  const en = langCode === "en";
  return (
    <fieldset className="scene-font-picker" disabled={busy}>
      <legend>
        {desktopIntegration.sceneFontLabel ??
          (en ? "Replace canvas fonts" : "替换当前画布字体")}
      </legend>
      <p>
        {en
          ? "Only this layer. Locked text is skipped."
          : "仅替换当前层，跳过锁定文字。"}
      </p>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button onSelect={() => {}}>
            {en ? "Choose a replacement font" : "选择字体并替换"}
          </Button>
        </Popover.Trigger>
        {open && (
          <FontPickerList
            selectedFontFamily={font}
            hoveredFontFamily={hoveredFont}
            onSelect={(fontFamily) => {
              setOpen(false);
              setBusy(true);
              setError("");
              void desktopIntegration.onReplaceSceneFont!(fontFamily)
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setBusy(false));
            }}
            onHover={setHoveredFont}
            onLeave={() => setHoveredFont(null)}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
          />
        )}
      </Popover.Root>
      {busy && <span role="status">{en ? "Replacing…" : "正在替换…"}</span>}
      {error && <span role="alert">{error}</span>}
    </fieldset>
  );
};
