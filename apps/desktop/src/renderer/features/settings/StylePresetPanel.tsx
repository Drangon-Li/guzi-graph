import { useEffect, useState } from "react";

import { Button } from "@excalidraw/excalidraw/components/Button";
import { PlusIcon, TrashIcon } from "@excalidraw/excalidraw/components/icons";

import { DesktopSelect } from "../../shared/ui/DesktopControls";

import {
  DEFAULT_STYLE_PRESETS,
  getStyleShortcut,
  isReservedStyleShortcut,
} from "../../shared/config/stylePresets";

import "./StylePresetPanel.scss";

import type { DesktopLanguage } from "../../shared/i18n/i18n";
import type { StylePreset } from "../../../shared/desktop-api";

export const StylePresetPanel = ({
  root,
  presets,
  language,
  onChange,
}: {
  root: HTMLElement;
  presets?: StylePreset[];
  language: DesktopLanguage;
  onChange: (presets: StylePreset[]) => Promise<void>;
}) => {
  const [draft, setDraft] = useState(presets ?? DEFAULT_STYLE_PRESETS);
  const [error, setError] = useState("");
  const en = language === "en";
  useEffect(() => setDraft(presets ?? DEFAULT_STYLE_PRESETS), [presets]);
  const update = async (next: StylePreset[]) => {
    setError("");
    try {
      await onChange(next);
      setDraft(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const change = (id: string, updates: Partial<StylePreset>) =>
    void update(
      draft.map((preset) =>
        preset.id === id ? { ...preset, ...updates } : preset,
      ),
    );
  return (
    <div
      className="desktop-style-presets"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <p className="desktop-style-presets__description">
        {en
          ? "With a selection, the shortcut changes its stroke. With no selection, it activates the drawing tool. Text inputs keep their own shortcuts."
          : "选中元素时快捷键修改线条样式；未选中时切换绘图工具。文本输入时保留编辑快捷键。"}
      </p>
      {draft.map((preset) => (
        <section key={preset.id} className="desktop-style-presets__card">
          <div className="desktop-style-presets__header">
            <h3>{preset.name || (en ? "New preset" : "新预设")}</h3>
            <Button
              className="desktop-style-presets__remove"
              aria-label={`${en ? "Remove preset" : "移除预设"} ${preset.name}`}
              title={en ? "Remove preset" : "移除预设"}
              onSelect={() =>
                void update(draft.filter((current) => current.id !== preset.id))
              }
            >
              {TrashIcon}
            </Button>
          </div>
          <div className="desktop-style-presets__fields">
            <label>
              {en ? "Name" : "名称"}
              <input
                aria-label={`${en ? "Preset name" : "预设名称"} ${preset.name}`}
                value={preset.name}
                onChange={(event) =>
                  setDraft(
                    draft.map((current) =>
                      current.id === preset.id
                        ? { ...current, name: event.target.value }
                        : current,
                    ),
                  )
                }
                onBlur={() => void update(draft)}
              />
            </label>
            <label>
              {en ? "Shortcut" : "快捷键"}
              <input
                readOnly
                aria-label={`${en ? "Shortcut" : "快捷键"} ${preset.name}`}
                value={preset.shortcut}
                placeholder={en ? "Press a key combination" : "按下组合键"}
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === "Backspace" || event.key === "Delete") {
                    change(preset.id, { shortcut: "" });
                    return;
                  }
                  const shortcut = getStyleShortcut(event.nativeEvent);
                  if (!shortcut) {
                    setError(
                      en
                        ? "Include Control, Command, or Option."
                        : "请包含Control、Command或Option修饰键。",
                    );
                    return;
                  }
                  if (
                    isReservedStyleShortcut(shortcut) ||
                    draft.some(
                      (other) =>
                        other.id !== preset.id && other.shortcut === shortcut,
                    )
                  ) {
                    setError(
                      en
                        ? "This shortcut is already in use."
                        : "此快捷键已被占用。",
                    );
                    return;
                  }
                  change(preset.id, { shortcut });
                }}
              />
            </label>
            <div className="desktop-style-presets__field">
              <span>{en ? "Tool" : "工具"}</span>
              <DesktopSelect
                root={root}
                label={en ? "Tool" : "工具"}
                value={preset.tool}
                options={[
                  { value: "arrow", label: en ? "Arrow" : "箭头" },
                  { value: "line", label: en ? "Line" : "线条" },
                  { value: "rectangle", label: en ? "Rectangle" : "矩形" },
                  { value: "ellipse", label: en ? "Ellipse" : "椭圆" },
                ]}
                onValueChange={(tool) =>
                  change(preset.id, { tool: tool as StylePreset["tool"] })
                }
              />
            </div>
            <div className="desktop-style-presets__field">
              <span>{en ? "Stroke style" : "线型"}</span>
              <DesktopSelect
                root={root}
                label={en ? "Stroke style" : "线型"}
                value={preset.strokeStyle}
                options={[
                  { value: "solid", label: en ? "Solid" : "实线" },
                  { value: "dashed", label: en ? "Dashed" : "虚线" },
                  { value: "dotted", label: en ? "Dotted" : "点线" },
                ]}
                onValueChange={(strokeStyle) =>
                  change(preset.id, {
                    strokeStyle: strokeStyle as StylePreset["strokeStyle"],
                  })
                }
              />
            </div>
            <div className="desktop-style-presets__field">
              <span>{en ? "Stroke width" : "粗细"}</span>
              <DesktopSelect
                root={root}
                label={en ? "Stroke width" : "粗细"}
                value={String(preset.strokeWidth)}
                options={[1, 2, 4].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
                onValueChange={(strokeWidth) =>
                  change(preset.id, {
                    strokeWidth: Number(
                      strokeWidth,
                    ) as StylePreset["strokeWidth"],
                  })
                }
              />
            </div>
            <label>
              {en ? "Color" : "颜色"}
              <span className="desktop-style-presets__color">
                <span
                  className="desktop-style-presets__swatch"
                  style={{ backgroundColor: preset.strokeColor }}
                />
                <span>{preset.strokeColor.toUpperCase()}</span>
                <input
                  aria-label={`${en ? "Color" : "颜色"} ${preset.name}`}
                  type="color"
                  value={preset.strokeColor}
                  onChange={(event) =>
                    change(preset.id, { strokeColor: event.target.value })
                  }
                />
              </span>
            </label>
          </div>
        </section>
      ))}
      <Button
        className="desktop-style-presets__add"
        disabled={draft.length >= 30}
        onSelect={() =>
          void update([
            ...draft,
            {
              ...DEFAULT_STYLE_PRESETS[0],
              id: root.ownerDocument.defaultView!.crypto.randomUUID(),
              name: en ? "New preset" : "新预设",
              shortcut: "",
            },
          ])
        }
      >
        {PlusIcon}
        {en ? "Add preset" : "添加预设"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
};
