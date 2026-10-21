import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "radix-ui";

import {
  DEFAULT_ELEMENT_BACKGROUND_PICKS,
  isTransparent,
} from "@excalidraw/common";
import {
  CaptureUpdateAction,
  getBoundTextElement,
  isTextElement,
  newElementWith,
  redrawTextBoundingBox,
  richTextFromPlainText,
} from "@excalidraw/element";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { getTargetElements } from "../../scene";
import { getLanguage } from "../../i18n";
import {
  saveCaretPosition,
  restoreCaretPosition,
} from "../../hooks/useTextEditorFocus";

import { ColorPicker } from "../../components/ColorPicker/ColorPicker";
import { RadioSelection } from "../../components/RadioSelection";
import { IconButton } from "../../components/IconButton";
import { PropertiesPopover } from "../../components/PropertiesPopover";
import { useExcalidrawContainer } from "../../components/App";
import { pencilIcon } from "../../components/icons";

import {
  executeRichTextCommand,
  getRichTextSelectionState,
  subscribeRichTextSelection,
} from "./editorBridge";
import {
  RichTextListNoneIcon,
  RichTextListBulletIcon,
  RichTextListOrderedIcon,
  RichTextIndentIcon,
  RichTextOutdentIcon,
  RichTextLineSpacingIcons,
  RichTextParagraphSpacingIcons,
} from "./RichTextIcons";

import "./RichTextControls.scss";

import type { CaretPosition } from "../../hooks/useTextEditorFocus";
import type { RichTextCommand, RichTextSelectionState } from "./editorBridge";
import type { AppClassProperties, UIAppState } from "../../types";

const labels = {
  "zh-CN": {
    background: "文字底色",
    lists: "列表",
    none: "无列表",
    bullet: "无序列表",
    ordered: "有序列表",
    outdent: "减少缩进",
    indent: "增加缩进",
    line: "行间距",
    paragraph: "段间距",
    custom: "自定义",
    compact: "紧凑",
    standard: "标准",
    loose: "宽松",
  },
  en: {
    background: "Text highlight",
    lists: "List",
    none: "No list",
    bullet: "Bulleted list",
    ordered: "Numbered list",
    outdent: "Decrease indent",
    indent: "Increase indent",
    line: "Line spacing",
    paragraph: "Paragraph spacing",
    custom: "Custom",
    compact: "Compact",
    standard: "Standard",
    loose: "Loose",
  },
};

const commonValue = <T,>(values: readonly T[]): T | null =>
  values.length && values.every((value) => value === values[0])
    ? values[0]
    : null;

const SpacingControl = ({
  app,
  appState,
  label,
  value,
  presets,
  minimum,
  icons,
  onChange,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  label: string;
  value: number | null;
  presets: readonly number[];
  minimum: number;
  icons: readonly React.JSX.Element[];
  onChange: (value: number) => void;
}) => {
  const t = getLanguage().code === "en" ? labels.en : labels["zh-CN"];
  const { container } = useExcalidrawContainer();
  const [open, setOpen] = useState(false);
  const savedCaret = useRef<CaretPosition | null>(null);
  const customLabel = `${t.custom} ${label}`;
  return (
    <fieldset className="rich-text-spacing">
      <legend>{label}</legend>
      <div className="buttonList">
        {presets.map((preset, index) => {
          const title = `${label}: ${[t.compact, t.standard, t.loose][index]}`;
          return (
            <button
              key={preset}
              type="button"
              className={value === preset ? "active" : undefined}
              aria-label={title}
              title={title}
              aria-pressed={value === preset}
              onClick={() => onChange(preset)}
            >
              {icons[index]}
            </button>
          );
        })}
        <Popover.Root
          open={open}
          onOpenChange={(next) => {
            if (next) {
              savedCaret.current = saveCaretPosition(app.ownerDocument);
            }
            setOpen(next);
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className={`properties-trigger${
                value !== null && !presets.includes(value) ? " active" : ""
              }`}
              aria-label={customLabel}
              title={`${customLabel}${value === null ? "" : `: ${value}`}`}
            >
              {pencilIcon}
            </button>
          </Popover.Trigger>
          {open && (
            <PropertiesPopover
              container={container}
              className="properties-content rich-text-spacing-popover"
              onClose={() => {
                setOpen(false);
                restoreCaretPosition(savedCaret.current, app.ownerDocument);
              }}
              preventAutoFocusOnTouch={!!appState.editingTextElement}
            >
              <label className="rich-text-spacing-custom">
                <span>{label}</span>
                <input
                  type="number"
                  aria-label={customLabel}
                  min={minimum}
                  max={10}
                  step={0.05}
                  value={value ?? ""}
                  onChange={(event) => onChange(event.target.valueAsNumber)}
                />
              </label>
            </PropertiesPopover>
          )}
        </Popover.Root>
      </div>
    </fieldset>
  );
};

const useRichTextControls = ({
  app,
  appState,
}: {
  app: AppClassProperties;
  appState: UIAppState;
}) => {
  const t = getLanguage().code === "en" ? labels.en : labels["zh-CN"];
  const selection = useSyncExternalStore(
    useCallback(
      (listener) => subscribeRichTextSelection(app.ownerDocument, listener),
      [app.ownerDocument],
    ),
    useCallback(
      () => getRichTextSelectionState(app.ownerDocument),
      [app.ownerDocument],
    ),
    () => null,
  );
  const map = app.scene.getNonDeletedElementsMap();
  const texts = Array.from(
    new Map(
      getTargetElements(map, appState).flatMap((element) => {
        const text = isTextElement(element)
          ? element
          : getBoundTextElement(element, map);
        return text ? [[text.id, text] as const] : [];
      }),
    ).values(),
  );
  const editingSelection =
    selection && texts.some((text) => text.id === selection.elementId)
      ? selection
      : null;
  const paragraphs = texts.flatMap(
    (text) =>
      (text.richText ?? richTextFromPlainText(text.originalText)).paragraphs,
  );
  const background = editingSelection
    ? editingSelection.background
    : commonValue(
        paragraphs.flatMap((p) =>
          p.runs.map((run) => run.background ?? "transparent"),
        ),
      );
  const list = editingSelection
    ? editingSelection.list
    : commonValue(paragraphs.map((p) => p.list?.kind ?? "none"));
  const update = (
    transform: (element: ExcalidrawTextElement) => ExcalidrawTextElement,
  ) => {
    const currentMap = app.scene.getNonDeletedElementsMap();
    const currentTexts = getTargetElements(currentMap, app.state).flatMap(
      (element) => {
        const text = isTextElement(element)
          ? element
          : getBoundTextElement(element, currentMap);
        return text ? [text] : [];
      },
    );
    const ids = new Set(currentTexts.map((text) => text.id));
    app.syncActionResult({
      elements: app.scene
        .getElementsIncludingDeleted()
        .map((element) =>
          ids.has(element.id) && isTextElement(element)
            ? transform(element)
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    for (const text of currentTexts) {
      const latest = app.scene.getNonDeletedElement(text.id);
      if (latest && isTextElement(latest)) {
        redrawTextBoundingBox(
          latest,
          latest.containerId
            ? currentMap.get(latest.containerId) ?? null
            : null,
          app.scene,
        );
      }
    }
  };
  const command = (
    command: Extract<
      RichTextCommand,
      { type: "background" | "list" | "indent" }
    >,
  ) => {
    if (executeRichTextCommand(app.ownerDocument, command)) {
      return;
    }
    update((element) => {
      const document =
        element.richText ?? richTextFromPlainText(element.originalText);
      return newElementWith(element, {
        richText: {
          version: 1,
          paragraphs: document.paragraphs.map((paragraph) => ({
            ...paragraph,
            ...(command.type === "list" && {
              list: command.value
                ? { kind: command.value, indent: paragraph.list?.indent ?? 0 }
                : undefined,
            }),
            ...(command.type === "indent" &&
              paragraph.list && {
                list: {
                  ...paragraph.list,
                  indent: Math.max(
                    0,
                    Math.min(
                      8,
                      paragraph.list.indent + (command.value === "in" ? 1 : -1),
                    ),
                  ),
                },
              }),
            runs: paragraph.runs.map((run) => ({
              ...run,
              ...(command.type === "background" && {
                background: command.value ?? undefined,
              }),
            })),
          })),
        },
      });
    });
  };
  const spacing = (
    property: "lineHeight" | "paragraphSpacing",
    value: number,
  ) => {
    if (
      !Number.isFinite(value) ||
      value < (property === "lineHeight" ? 0.5 : 0) ||
      value > 10
    ) {
      return;
    }
    executeRichTextCommand(app.ownerDocument, { type: "layout" });
    update((element) =>
      newElementWith(element, {
        [property]: value,
        richText:
          element.richText ?? richTextFromPlainText(element.originalText),
      }),
    );
  };
  return { t, texts, background, list, command, spacing };
};

type RichTextControlsProps = { app: AppClassProperties; appState: UIAppState };

export const RichTextHighlightControls = ({
  app,
  appState,
}: RichTextControlsProps) => {
  const { t, texts, background, command } = useRichTextControls({
    app,
    appState,
  });
  if (!texts.length) {
    return null;
  }
  return (
    <fieldset
      className="rich-text-highlight-controls"
      onPointerDown={(event) => {
        if (!(event.target instanceof app.ownerWindow.HTMLInputElement)) {
          event.preventDefault();
        }
      }}
    >
      <legend>{t.background}</legend>
      <ColorPicker
        type="textHighlight"
        customizableTopPicks="elementBackground"
        label={t.background}
        color={background}
        topPicks={
          appState.colorTopPicks.elementBackground ??
          DEFAULT_ELEMENT_BACKGROUND_PICKS
        }
        elements={app.scene.getElementsIncludingDeleted()}
        appState={appState}
        onChange={(color) =>
          command({
            type: "background",
            value: isTransparent(color) ? null : color,
          })
        }
        updateData={(updates) =>
          app.syncActionResult({
            appState: { ...app.state, ...updates },
            captureUpdate: CaptureUpdateAction.EVENTUALLY,
          })
        }
      />
    </fieldset>
  );
};

export const RichTextControls = ({ app, appState }: RichTextControlsProps) => {
  const { t, texts, list, command, spacing } = useRichTextControls({
    app,
    appState,
  });
  if (!texts.length) {
    return null;
  }
  return (
    <div
      className="rich-text-controls"
      onPointerDown={(event) => {
        if (!(event.target instanceof app.ownerWindow.HTMLInputElement)) {
          event.preventDefault();
        }
      }}
    >
      <fieldset>
        <legend>{t.lists}</legend>
        <div className="rich-text-list-row">
          <div className="buttonList">
            <RadioSelection<Exclude<RichTextSelectionState["list"], null>>
              type="button"
              value={list}
              options={[
                { value: "none", text: t.none, icon: RichTextListNoneIcon },
                {
                  value: "bullet",
                  text: t.bullet,
                  icon: RichTextListBulletIcon,
                },
                {
                  value: "ordered",
                  text: t.ordered,
                  icon: RichTextListOrderedIcon,
                },
              ]}
              onClick={(value) =>
                command({
                  type: "list",
                  value: value === "none" ? null : value,
                })
              }
            />
          </div>
          <div className="buttonList">
            <IconButton
              type="button"
              size="small"
              icon={RichTextOutdentIcon}
              aria-label={t.outdent}
              title={t.outdent}
              onClick={() => command({ type: "indent", value: "out" })}
            />
            <IconButton
              type="button"
              size="small"
              icon={RichTextIndentIcon}
              aria-label={t.indent}
              title={t.indent}
              onClick={() => command({ type: "indent", value: "in" })}
            />
          </div>
        </div>
      </fieldset>
      <SpacingControl
        app={app}
        appState={appState}
        label={t.line}
        value={commonValue(texts.map((text) => text.lineHeight))}
        icons={RichTextLineSpacingIcons}
        presets={[1, 1.25, 1.75]}
        minimum={0.5}
        onChange={(value) => spacing("lineHeight", value)}
      />
      <SpacingControl
        app={app}
        appState={appState}
        label={t.paragraph}
        value={commonValue(texts.map((text) => text.paragraphSpacing ?? 0))}
        icons={RichTextParagraphSpacingIcons}
        presets={[0, 0.5, 1]}
        minimum={0}
        onChange={(value) => spacing("paragraphSpacing", value)}
      />
    </div>
  );
};
