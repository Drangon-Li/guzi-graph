import { useId, useRef, useState } from "react";

import {
  DeviceDesktopIcon,
  FreedrawIcon,
  LoadIcon,
  MoonIcon,
  SunIcon,
  palette,
} from "@excalidraw/excalidraw/components/icons";
import { Button } from "@excalidraw/excalidraw";

import type { PreferenceSection } from "@excalidraw/excalidraw/types";

import { DesktopSegmentedControl, DesktopSwitch } from "./DesktopControls";
import { PreferencePanel } from "./PreferencePanel";
import { StylePresetPanel } from "./StylePresetPanel";
import { translate } from "./i18n";

import "./SettingsPanel.scss";

import type { DesktopSettings } from "./shared";
import type { ReactNode } from "react";

type SettingsCategory =
  | "general"
  | "tools"
  | "defaults"
  | "shortcuts"
  | "files";

const SettingsRow = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) => (
  <div className="desktop-settings-item">
    <div className="desktop-settings-item__label">
      <span>{label}</span>
      {description && <p>{description}</p>}
    </div>
    {children}
  </div>
);

export const SettingsPanel = ({
  root,
  settings,
  onChange,
  onChangeDirectory,
}: {
  root: HTMLElement;
  settings: DesktopSettings;
  onChange: (
    update: Partial<DesktopSettings>,
  ) => Promise<DesktopSettings | null>;
  onChangeDirectory: () => Promise<void>;
}) => {
  const [category, setCategory] = useState<SettingsCategory>("general");
  const [preference, setPreference] = useState<PreferenceSection>("fonts");
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  const en = settings.language === "en";
  const t = (message: string) => translate(settings.language, message);
  const categories = [
    { id: "general", label: en ? "General" : "通用", icon: DeviceDesktopIcon },
    {
      id: "tools",
      label: en ? "Canvas & tools" : "画布与工具",
      icon: FreedrawIcon,
    },
    {
      id: "defaults",
      label: en ? "Fonts & colors" : "字体与颜色",
      icon: palette,
    },
    {
      id: "shortcuts",
      label: en ? "Shortcuts" : "快捷键",
      icon: <span className="desktop-settings-command">⌘</span>,
    },
    {
      id: "files",
      label: en ? "Files & export" : "文件与导出",
      icon: LoadIcon,
    },
  ] as const;
  const current = categories.find((item) => item.id === category)!;
  const savePreferences = async (update: Partial<DesktopSettings>) => {
    if (!(await onChange(update))) {
      throw new Error(
        en ? "Unable to save settings." : "设置保存失败，请重试。",
      );
    }
  };
  const descriptions = {
    general: en
      ? "Make the workspace feel like yours."
      : "调整工作区的外观与语言。",
    tools: en
      ? "Choose how tools behave on your canvas."
      : "调整画布工具的显示与创建方式。",
    defaults: en
      ? "Customize toolbar choices and defaults for new drawings."
      : "定制工具栏快捷项与新画布默认值。",
    shortcuts: en
      ? "Keep your favorite drawing styles one shortcut away."
      : "用快捷键快速调用常用绘图样式。",
    files: en
      ? "Manage your drawing folder and export preferences."
      : "设置画布存放位置与导出方式。",
  };

  return (
    <div className="desktop-settings-layout">
      <div
        className="desktop-settings-nav"
        role="tablist"
        aria-label={en ? "Settings categories" : "设置分类"}
        aria-orientation="vertical"
        ref={tabs}
      >
        {categories.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}`}
            aria-controls={`${id}-content`}
            aria-selected={category === item.id}
            tabIndex={category === item.id ? 0 : -1}
            onClick={() => setCategory(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                  ? (index + 1) % categories.length
                  : event.key === "ArrowUp" || event.key === "ArrowLeft"
                  ? (index + categories.length - 1) % categories.length
                  : event.key === "Home"
                  ? 0
                  : event.key === "End"
                  ? categories.length - 1
                  : null;
              if (next !== null) {
                event.preventDefault();
                setCategory(categories[next].id);
                tabs.current?.querySelectorAll("button")[next]?.focus();
              }
            }}
          >
            <span className="desktop-settings-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div
        className="desktop-modal-body desktop-settings-content"
        role="tabpanel"
        id={`${id}-content`}
        aria-labelledby={`${id}-${category}`}
        tabIndex={0}
        key={category}
      >
        <div className="desktop-settings-heading">
          <h3>{current.label}</h3>
          <p>{descriptions[category]}</p>
        </div>
        {category === "general" && (
          <section className="desktop-settings-card">
            <h4>{t("外观")}</h4>
            <DesktopSegmentedControl
              label={t("外观")}
              value={settings.theme}
              options={[
                { value: "light", label: t("浅色"), icon: SunIcon },
                { value: "dark", label: t("深色"), icon: MoonIcon },
                {
                  value: "system",
                  label: t("跟随系统"),
                  icon: DeviceDesktopIcon,
                },
              ]}
              onValueChange={(theme) =>
                void onChange({ theme: theme as DesktopSettings["theme"] })
              }
            />
            <SettingsRow label={t("语言")}>
              <DesktopSegmentedControl
                label={t("语言")}
                value={settings.language}
                options={[
                  { value: "zh-CN", label: "中文" },
                  { value: "en", label: "English" },
                ]}
                onValueChange={(language) =>
                  void onChange({
                    language: language as DesktopSettings["language"],
                  })
                }
              />
            </SettingsRow>
          </section>
        )}
        {category === "tools" && (
          <>
            <section className="desktop-settings-card">
              <h4>{t("工具栏")}</h4>
              <SettingsRow label={t("显示工具名称和快捷键提示")}>
                <DesktopSwitch
                  label={t("显示工具名称和快捷键提示")}
                  checked={settings.toolbarTooltips ?? true}
                  onCheckedChange={(toolbarTooltips) =>
                    void onChange({ toolbarTooltips })
                  }
                />
              </SettingsRow>
              <SettingsRow label={t("显示选区悬浮工具栏")}>
                <DesktopSwitch
                  label={t("显示选区悬浮工具栏")}
                  checked={settings.selectionToolbar ?? true}
                  onCheckedChange={(selectionToolbar) =>
                    void onChange({ selectionToolbar })
                  }
                />
              </SettingsRow>
            </section>
            <section className="desktop-settings-card">
              <h4>{t("新建便签")}</h4>
              <DesktopSegmentedControl
                label={t("新建便签")}
                value={settings.stickyNoteMode ?? "note"}
                options={[
                  { value: "note", label: t("文字便签") },
                  { value: "subcanvas", label: t("子画布图钉") },
                ]}
                onValueChange={(stickyNoteMode) =>
                  void onChange({
                    stickyNoteMode:
                      stickyNoteMode as DesktopSettings["stickyNoteMode"],
                  })
                }
              />
              <p className="desktop-settings-note">
                {t(
                  "沿用最近使用的类型；Control 点击顶部便签工具可直接创建子画布图钉。",
                )}
              </p>
            </section>
          </>
        )}
        {category === "defaults" && (
          <>
            <DesktopSegmentedControl
              label={en ? "Drawing defaults" : "绘图默认值"}
              value={preference}
              options={[
                { value: "fonts", label: en ? "Fonts" : "字体" },
                { value: "fontSizes", label: en ? "Sizes" : "字号" },
                { value: "elementStroke", label: en ? "Stroke" : "描边" },
                { value: "elementBackground", label: en ? "Fill" : "填充" },
                { value: "background", label: en ? "Canvas" : "背景" },
              ]}
              onValueChange={(value) =>
                setPreference(value as PreferenceSection)
              }
            />
            <PreferencePanel
              key={preference}
              root={root}
              preferences={settings.editorPreferences}
              section={preference}
              language={settings.language}
              onChange={(editorPreferences) =>
                savePreferences({ editorPreferences })
              }
            />
          </>
        )}
        {category === "shortcuts" && (
          <StylePresetPanel
            root={root}
            presets={settings.stylePresets}
            language={settings.language}
            onChange={(stylePresets) => savePreferences({ stylePresets })}
          />
        )}
        {category === "files" && (
          <>
            <section className="desktop-settings-card">
              <h4>{t("默认文件夹")}</h4>
              <div className="desktop-settings-folder">
                <span title={settings.rootDirectory || undefined}>
                  {settings.rootDirectory || t("尚未设置")}
                </span>
                <Button onSelect={onChangeDirectory}>{t("选择文件夹…")}</Button>
              </div>
              <p className="desktop-settings-note">
                {t("这里的 .excalidraw 文件显示在项目页，子文件夹对应分类。")}
              </p>
            </section>
            <section className="desktop-settings-card">
              <h4>{t("结构化导出")}</h4>
              <SettingsRow label={t("默认格式")}>
                <DesktopSegmentedControl
                  label={t("默认格式")}
                  value={settings.structuredExportFormat}
                  options={[
                    { value: "json", label: "JSON" },
                    { value: "md", label: "Markdown" },
                  ]}
                  onValueChange={(structuredExportFormat) =>
                    void onChange({
                      structuredExportFormat: structuredExportFormat as
                        | "json"
                        | "md",
                    })
                  }
                />
              </SettingsRow>
              <SettingsRow
                label={t("按布局组织信息")}
                description={t("根据分组、容器和位置推断章节与层级。")}
              >
                <DesktopSwitch
                  label={t("按布局组织信息")}
                  checked={settings.includeInferredStructure}
                  onCheckedChange={(includeInferredStructure) =>
                    void onChange({ includeInferredStructure })
                  }
                />
              </SettingsRow>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
