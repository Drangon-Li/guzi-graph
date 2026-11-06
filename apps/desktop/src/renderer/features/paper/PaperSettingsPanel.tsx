import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { translate } from "../../shared/i18n/i18n";

import {
  DEFAULT_PAPER_SETTINGS,
  getPaperPages,
  getPaperSettings,
} from "./paper";
import { applyPaperSettings } from "./paperWriting";

import "./PaperSettingsPanel.scss";

const getRuledPage = (api: ExcalidrawImperativeAPI) =>
  getPaperPages(api.getSceneElements()).find(
    (page) => page.customData?.guziPaper?.kind === "ruled",
  );

const toDraft = ({ lineSpacing, fontSize }: typeof DEFAULT_PAPER_SETTINGS) => ({
  lineSpacing: String(lineSpacing),
  fontSize: String(fontSize),
});

export const PaperSettingsPanel = ({
  api,
  language,
  onClose,
  toggleRef,
  id,
}: {
  api: ExcalidrawImperativeAPI;
  language: "en" | "zh-CN";
  onClose: () => void;
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  id: string;
}) => {
  const panel = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState(() => {
    const page = getRuledPage(api);
    return toDraft(page ? getPaperSettings(page) : DEFAULT_PAPER_SETTINGS);
  });
  const lineSpacing = Number(draft.lineSpacing);
  const fontSize = Number(draft.fontSize);
  const valid =
    lineSpacing >= 16 && lineSpacing <= 96 && fontSize >= 8 && fontSize <= 72;
  const readOnly = api.getAppState().viewModeEnabled;
  const t = (message: string) => translate(language, message);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    const form = panel.current!;
    const ownerDocument = form.ownerDocument;
    const dismiss = (event: PointerEvent) => {
      const path = event.composedPath();
      if (
        !path.includes(form) &&
        (!toggleRef.current || !path.includes(toggleRef.current))
      ) {
        onClose();
      }
    };
    ownerDocument.addEventListener("pointerdown", dismiss, true);
    return () =>
      ownerDocument.removeEventListener("pointerdown", dismiss, true);
  }, [onClose, toggleRef]);

  const closeAndFocus = () => {
    onClose();
    toggleRef.current?.focus();
  };

  return (
    <form
      ref={panel}
      id={id}
      className="desktop-paper-settings"
      role="dialog"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-scope`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeAndFocus();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || api.getAppState().viewModeEnabled || !getRuledPage(api)) {
          return;
        }
        api.commitEditing();
        api.updateScene({
          elements: applyPaperSettings(api.getSceneElementsIncludingDeleted(), {
            lineSpacing,
            fontSize,
          }),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        closeAndFocus();
      }}
    >
      <header>
        <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>
          {t("纸张设置")}
        </h2>
        <p id={`${id}-scope`}>{t("本文件的全部横线页")}</p>
      </header>
      <div className="desktop-paper-settings-field">
        <label htmlFor={`${id}-spacing`}>{t("横线间距")}</label>
        <input
          id={`${id}-spacing`}
          aria-describedby={`${id}-spacing-hint`}
          type="number"
          min={16}
          max={96}
          step="any"
          required
          readOnly={readOnly}
          value={draft.lineSpacing}
          onChange={(event) =>
            setDraft({ ...draft, lineSpacing: event.target.value })
          }
        />
        <p id={`${id}-spacing-hint`}>{t("改变间距会重排已对齐横线的文字。")}</p>
      </div>
      <div className="desktop-paper-settings-field">
        <label htmlFor={`${id}-size`}>{t("默认字号")}</label>
        <input
          id={`${id}-size`}
          aria-describedby={`${id}-size-hint`}
          type="number"
          min={8}
          max={72}
          step="any"
          required
          readOnly={readOnly}
          value={draft.fontSize}
          onChange={(event) =>
            setDraft({ ...draft, fontSize: event.target.value })
          }
        />
        <p id={`${id}-size-hint`}>
          {t("默认字号只影响新文字，字号过大时自动缩小到一格内。")}
        </p>
      </div>
      <footer>
        {!readOnly && (
          <button
            type="button"
            className="desktop-paper-settings-reset"
            onClick={() => setDraft(toDraft(DEFAULT_PAPER_SETTINGS))}
          >
            {t("恢复默认")}
          </button>
        )}
        <button type="button" onClick={closeAndFocus}>
          {t("取消")}
        </button>
        {!readOnly && (
          <button
            type="submit"
            className="desktop-paper-settings-apply"
            disabled={!valid}
          >
            {t("应用")}
          </button>
        )}
      </footer>
    </form>
  );
};
