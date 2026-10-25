import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  FONT_FAMILY,
  MIN_FONT_SIZE,
  getSystemFontId,
  isValidSystemFontFamily,
} from "@excalidraw/common";

import { Button } from "@excalidraw/excalidraw/components/Button";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";

import type { PreferenceSection } from "@excalidraw/excalidraw/types";
import type { FontFamilyValues } from "@excalidraw/element/types";

import { DesktopSelect } from "../../shared/ui/DesktopControls";
import {
  registerPreferenceFonts,
  resolveEditorPreferences,
} from "../../shared/config/editorPreferences";

import { PreferenceColorPicker } from "./PreferenceColorPicker";

import "./PreferencePanel.scss";

import type { EditorPreferences } from "../../../shared/desktop-api";
import type { DesktopLanguage } from "../../shared/i18n/i18n";

export {
  DEFAULT_EDITOR_PREFERENCES,
  registerPreferenceFonts,
} from "../../shared/config/editorPreferences";

type LocalFontsWindow = Window & {
  queryLocalFonts?: () => Promise<{ family: string; fullName: string }[]>;
};

export const PreferencePanel = ({
  root,
  preferences,
  section,
  language,
  onChange,
  onApplyFontToOpenDocuments,
}: {
  root: HTMLElement;
  preferences?: EditorPreferences;
  section: PreferenceSection;
  language: DesktopLanguage;
  onChange: (preferences: EditorPreferences) => void | Promise<void>;
  onApplyFontToOpenDocuments?: (fontFamily: FontFamilyValues) => Promise<void>;
}) => {
  const [draft, setDraft] = useState(() =>
    resolveEditorPreferences(preferences),
  );
  const [families, setFamilies] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selectedSystemFamily, setSelectedSystemFamily] = useState("");
  const [error, setError] = useState("");
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [pendingFont, setPendingFont] = useState<{
    id: number;
    family: string;
    systemFont?: boolean;
  } | null>(null);
  const [savingFont, setSavingFont] = useState(false);
  const [fontStatus, setFontStatus] = useState("");
  const fontConfirmation = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState("#ffffff");
  const en = language === "en";
  const [fontSizes, setFontSizes] = useState(draft.fontSizePresets);
  const fontSizeId = useId();
  useEffect(() => {
    const next = resolveEditorPreferences(preferences);
    setDraft(next);
    setFontSizes(next.fontSizePresets);
  }, [preferences]);
  useEffect(() => {
    if (pendingFont) {
      fontConfirmation.current?.focus();
    }
  }, [pendingFont]);
  const colorSection =
    section === "elementStroke"
      ? ({
          defaultKey: "defaultStrokeColor",
          picksKey: "elementStrokeTopPicks",
          defaultLabel: en ? "Default stroke color" : "默认描边颜色",
          shortcutLabel: en ? "Stroke shortcut" : "描边快捷项",
        } as const)
      : section === "elementBackground"
      ? ({
          defaultKey: "defaultElementBackground",
          picksKey: "elementBackgroundTopPicks",
          defaultLabel: en ? "Default fill color" : "默认填充颜色",
          shortcutLabel: en ? "Fill shortcut" : "填充快捷项",
        } as const)
      : ({
          defaultKey: "defaultBackground",
          picksKey: "backgroundTopPicks",
          defaultLabel: en ? "Default canvas background" : "默认画布背景",
          shortcutLabel: en ? "Background shortcut" : "背景快捷项",
        } as const);
  const allowTransparent =
    section === "elementStroke" || section === "elementBackground";
  const picks = draft[colorSection.picksKey];
  const updatePicks = (next: string[]) =>
    void update({ ...draft, [colorSection.picksKey]: next });
  const transparentLabel = en ? "Transparent" : "透明";
  const fonts = useMemo(
    () => [
      ...Object.entries(FONT_FAMILY)
        .filter(([name]) => name !== "Assistant")
        .map(([family, id]) => ({ id, family })),
      ...draft.systemFonts,
    ],
    [draft.systemFonts],
  );
  const update = async (next: EditorPreferences) => {
    setError("");
    try {
      registerPreferenceFonts(next);
      await onChange(next);
      setDraft(resolveEditorPreferences(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const applyDefaultFont = async (replaceExisting: boolean) => {
    if (!pendingFont || savingFont) {
      return;
    }
    const { id, family, systemFont } = pendingFont;
    const next = {
      ...draft,
      defaultFontFamily: id,
      defaultFontName: family,
      systemFonts:
        systemFont && !draft.systemFonts.some((font) => font.id === id)
          ? [...draft.systemFonts, { id, family }]
          : draft.systemFonts,
    };
    setSavingFont(true);
    setError("");
    setFontStatus("");
    let saved = false;
    try {
      registerPreferenceFonts(next);
      await onChange(next);
      saved = true;
      setDraft(resolveEditorPreferences(next));
      if (replaceExisting) {
        await onApplyFontToOpenDocuments?.(id as FontFamilyValues);
      }
      setPendingFont(null);
      setFontStatus(
        replaceExisting
          ? en
            ? "Default font saved and open documents updated."
            : "默认字体已保存，已替换打开文档中的文字。"
          : en
          ? "Default font saved. Existing text is unchanged."
          : "默认字体已保存，已有文字保持不变。",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        saved
          ? `${
              en
                ? "Default font saved, but replacing existing text failed: "
                : "默认字体已保存，但替换已有文字失败："
            }${message}`
          : message,
      );
    } finally {
      setSavingFont(false);
    }
  };
  const loadFonts = async () => {
    setLoadingFonts(true);
    setError("");
    try {
      const ownerWindow = root.ownerDocument.defaultView as LocalFontsWindow;
      if (!ownerWindow.queryLocalFonts) {
        throw new Error(
          en
            ? "Local font enumeration is unavailable in this window."
            : "当前窗口不支持读取本机字体。",
        );
      }
      const localFonts = await ownerWindow.queryLocalFonts();
      const next = [
        ...new Set(
          localFonts.map((font) => font.family).filter(isValidSystemFontFamily),
        ),
      ].sort((a, b) => a.localeCompare(b, language));
      setFamilies(next);
      setSelectedSystemFamily(
        next.find((family) => /Songti|SimSun|宋体/i.test(family)) ??
          next[0] ??
          "",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingFonts(false);
    }
  };
  const addSystemFont = () => {
    if (!selectedSystemFamily) {
      return;
    }
    const id = getSystemFontId(selectedSystemFamily);
    const existing = draft.systemFonts.find((font) => font.id === id);
    if (existing && existing.family !== selectedSystemFamily) {
      setError(
        en
          ? "This font id conflicts with another font. Choose a different font."
          : "此字体编号与另一字体冲突，请选择其它字体。",
      );
      return;
    }
    setFontStatus("");
    setPendingFont({
      id,
      family: selectedSystemFamily,
      systemFont: true,
    });
  };
  return (
    <div className="desktop-preference-panel">
      {section === "fonts" ? (
        <>
          <div className="desktop-preference-panel__group">
            <span className="desktop-preference-panel__label">
              {en ? "Default font" : "默认字体"}
            </span>
            <DesktopSelect
              root={root}
              label={en ? "Default font" : "默认字体"}
              disabled={savingFont}
              value={String(draft.defaultFontFamily)}
              options={fonts.map(({ id, family }) => ({
                value: String(id),
                label: family,
              }))}
              onValueChange={(value) => {
                const font = fonts.find((item) => item.id === Number(value));
                if (font) {
                  setError("");
                  setFontStatus("");
                  setPendingFont(font);
                }
              }}
            />
            {pendingFont && (
              <div
                className="desktop-preference-panel__font-confirm"
                ref={fontConfirmation}
                role="group"
                tabIndex={-1}
                aria-label={en ? "Apply default font" : "应用默认字体"}
                aria-busy={savingFont}
              >
                <p>
                  {en
                    ? `Use ${pendingFont.family} as the default font?`
                    : `将默认字体设为 ${pendingFont.family}？`}
                </p>
                {onApplyFontToOpenDocuments && (
                  <p className="desktop-preference-panel__hint">
                    {en
                      ? "You can also replace text in all open documents, including every slide and subcanvas. Locked text is skipped."
                      : "可同时替换全部已打开文档中的文字，包含所有 PPT 页和子画布，跳过锁定文字。"}
                  </p>
                )}
                <div className="desktop-preference-panel__font-actions">
                  <Button
                    className="desktop-preference-panel__button"
                    disabled={savingFont}
                    onSelect={() => void applyDefaultFont(false)}
                  >
                    {en ? "New text only" : "仅用于新内容"}
                  </Button>
                  {onApplyFontToOpenDocuments && (
                    <Button
                      className="desktop-preference-panel__button"
                      disabled={savingFont}
                      onSelect={() => void applyDefaultFont(true)}
                    >
                      {en
                        ? "Also replace open documents"
                        : "同时替换已打开文档"}
                    </Button>
                  )}
                  <Button
                    className="desktop-preference-panel__button"
                    disabled={savingFont}
                    onSelect={() => {
                      setPendingFont(null);
                      setError("");
                    }}
                  >
                    {en ? "Cancel" : "取消"}
                  </Button>
                </div>
                {savingFont && (
                  <p role="status">{en ? "Applying…" : "正在应用…"}</p>
                )}
              </div>
            )}
            {fontStatus && <p role="status">{fontStatus}</p>}
          </div>
          <fieldset>
            <legend>
              {en ? "Font shortcuts (up to 3)" : "字体快捷项（最多3项）"}
            </legend>
            <div className="desktop-preference-panel__fonts">
              {fonts.map(({ id, family }) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    disabled={savingFont}
                    checked={draft.fontTopPicks.includes(id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.fontTopPicks, id]
                        : draft.fontTopPicks.filter((value) => value !== id);
                      if (!next.length || next.length > 3) {
                        setError(
                          en
                            ? "Choose 1–3 font shortcuts."
                            : "请选择1至3个字体快捷项。",
                        );
                        return;
                      }
                      void update({ ...draft, fontTopPicks: next });
                    }}
                  />
                  <span style={{ fontFamily: family }}>{family}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="desktop-preference-panel__group">
            <span className="desktop-preference-panel__label">
              {en ? "Installed fonts" : "本机字体"}
            </span>
            <p className="desktop-preference-panel__hint">
              {en
                ? "Allow font access to choose from fonts installed on this computer."
                : "授权读取后，可选择这台电脑上安装的字体。"}
            </p>
            <Button
              className="desktop-preference-panel__button"
              disabled={loadingFonts || savingFont}
              onSelect={() => void loadFonts()}
            >
              {loadingFonts
                ? en
                  ? "Reading…"
                  : "读取中…"
                : en
                ? "Read fonts installed on this computer"
                : "读取本机已安装字体"}
            </Button>
            {!!families.length && (
              <>
                <input
                  aria-label={en ? "Search installed fonts" : "搜索本机字体"}
                  placeholder={en ? "Search fonts" : "搜索字体，如宋体、Songti"}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <DesktopSelect
                  root={root}
                  label={en ? "Installed font" : "本机字体"}
                  value={selectedSystemFamily}
                  options={families
                    .filter((family) =>
                      family
                        .toLocaleLowerCase()
                        .includes(query.toLocaleLowerCase()),
                    )
                    .map((family) => ({ value: family, label: family }))}
                  onValueChange={setSelectedSystemFamily}
                />
                <p
                  className="desktop-preference-panel__font-preview"
                  style={{ fontFamily: selectedSystemFamily }}
                >
                  宋体预览 · Typography Aa 123
                </p>
                <Button
                  className="desktop-preference-panel__button"
                  disabled={savingFont}
                  onSelect={addSystemFont}
                >
                  {en ? "Add and use as default" : "添加并设为默认字体"}
                </Button>
              </>
            )}
          </div>
        </>
      ) : section === "fontSizes" ? (
        <>
          <fieldset>
            <legend>{en ? "Font size shortcuts" : "字号快捷项"}</legend>
            <div className="desktop-preference-panel__font-sizes">
              {(["sm", "md", "lg", "xl"] as const).map((key, index) => (
                <div
                  className="desktop-preference-panel__font-size-field"
                  key={key}
                >
                  <label
                    className="desktop-preference-panel__font-size-label"
                    htmlFor={`${fontSizeId}-${key}`}
                  >
                    {["S", "M", "L", "XL"][index]}
                  </label>
                  <input
                    id={`${fontSizeId}-${key}`}
                    type="number"
                    aria-label={`${["S", "M", "L", "XL"][index]} ${
                      en ? "font size" : "字号"
                    }`}
                    min={MIN_FONT_SIZE}
                    value={Number.isNaN(fontSizes[key]) ? "" : fontSizes[key]}
                    onChange={(event) =>
                      setFontSizes({
                        ...fontSizes,
                        [key]: event.target.valueAsNumber,
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>
          <Button
            className="desktop-preference-panel__button"
            onSelect={() => {
              const values = [
                fontSizes.sm,
                fontSizes.md,
                fontSizes.lg,
                fontSizes.xl,
              ];
              if (
                !values.every(
                  (value, index) =>
                    Number.isFinite(value) &&
                    value >= MIN_FONT_SIZE &&
                    (!index || value > values[index - 1]),
                )
              ) {
                setError(
                  en
                    ? "Enter four increasing font sizes of at least 1."
                    : "请输入四个依次递增且不小于1的字号。",
                );
                return;
              }
              void update({ ...draft, fontSizePresets: fontSizes });
            }}
          >
            {en ? "Apply font sizes" : "应用字号"}
          </Button>
        </>
      ) : (
        <>
          <div className="desktop-preference-panel__group">
            <div className="desktop-preference-panel__color-label">
              <span className="desktop-preference-panel__label">
                {colorSection.defaultLabel}
              </span>
              <PreferenceColorPicker
                root={root}
                language={language}
                allowTransparent={allowTransparent}
                defaultShade={section === "elementStroke" ? 4 : 1}
                label={colorSection.defaultLabel}
                value={draft[colorSection.defaultKey]}
                onChange={(value) =>
                  void update({
                    ...draft,
                    [colorSection.defaultKey]: value,
                  })
                }
              />
            </div>
            {allowTransparent && (
              <label className="desktop-preference-panel__transparent">
                <input
                  type="checkbox"
                  checked={draft[colorSection.defaultKey] === "transparent"}
                  onChange={(event) =>
                    void update({
                      ...draft,
                      [colorSection.defaultKey]: event.target.checked
                        ? "transparent"
                        : "#ffffff",
                    })
                  }
                />
                {en ? "Use a transparent default" : "默认使用透明色"}
              </label>
            )}
          </div>
          <fieldset>
            <legend>{`${colorSection.shortcutLabel}${
              en ? "s (up to 5)" : "（最多5项）"
            }`}</legend>
            <div className="desktop-preference-panel__colors">
              {picks.map((value, index) => (
                <div key={index}>
                  <PreferenceColorPicker
                    root={root}
                    language={language}
                    allowTransparent={allowTransparent}
                    defaultShade={section === "elementStroke" ? 4 : 1}
                    label={`${colorSection.shortcutLabel} ${index + 1}`}
                    value={value}
                    onChange={(nextColor) =>
                      updatePicks(
                        picks.map((previous, current) =>
                          current === index ? nextColor : previous,
                        ),
                      )
                    }
                  />
                  {allowTransparent && (
                    <label className="desktop-preference-panel__transparent">
                      <input
                        type="checkbox"
                        aria-label={`${colorSection.shortcutLabel} ${
                          index + 1
                        } ${transparentLabel}`}
                        checked={value === "transparent"}
                        onChange={(event) =>
                          updatePicks(
                            picks.map((previous, current) =>
                              current === index
                                ? event.target.checked
                                  ? "transparent"
                                  : "#ffffff"
                                : previous,
                            ),
                          )
                        }
                      />
                      {transparentLabel}
                    </label>
                  )}
                  <Button
                    className="desktop-preference-panel__remove-color"
                    disabled={picks.length === 1}
                    aria-label={`${en ? "Remove" : "移除"} ${value}`}
                    onSelect={() =>
                      updatePicks(
                        picks.filter((_, current) => current !== index),
                      )
                    }
                  >
                    <span aria-hidden="true">{CloseIcon}</span>
                  </Button>
                </div>
              ))}
            </div>
            <div className="desktop-preference-panel__add-color">
              <PreferenceColorPicker
                root={root}
                language={language}
                allowTransparent={allowTransparent}
                defaultShade={section === "elementStroke" ? 4 : 1}
                label={en ? "New color shortcut" : "新颜色快捷项"}
                value={color}
                onChange={setColor}
              />
              {allowTransparent && (
                <label className="desktop-preference-panel__transparent">
                  <input
                    type="checkbox"
                    checked={color === "transparent"}
                    onChange={(event) =>
                      setColor(event.target.checked ? "transparent" : "#ffffff")
                    }
                  />
                  {transparentLabel}
                </label>
              )}
              <Button
                className="desktop-preference-panel__button"
                disabled={picks.length >= 5}
                onSelect={() => updatePicks([...picks, color])}
              >
                {en ? "Add shortcut" : "添加快捷项"}
              </Button>
            </div>
          </fieldset>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <p className="desktop-preference-panel__hint">
        {section === "fonts"
          ? en
            ? "The default font applies to new text in all drawings. You choose whether to replace existing text. Installed font names are saved with each drawing."
            : "默认字体用于所有画布中的新文字；是否替换已有文字由你选择。本机字体名称会随画布保存。"
          : section === "fontSizes"
          ? en
            ? "Font size shortcuts do not change existing text."
            : "字号快捷项不会改变已有文字的大小。"
          : en
          ? "Shortcuts appear in the toolbar. Default colors apply to new drawings."
          : "快捷项显示在工具栏中，默认颜色用于新画布。"}
      </p>
    </div>
  );
};
