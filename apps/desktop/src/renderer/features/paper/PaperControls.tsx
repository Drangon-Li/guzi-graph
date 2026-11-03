import { useEffect, useRef, useState } from "react";

import { Button } from "@excalidraw/excalidraw";

import { translate } from "../../shared/i18n/i18n";

import { createPaperTemplate } from "./paper";
import { importPdf } from "./importPdf";

import "./paper.scss";

import type { PaperOrientation, PaperTemplate } from "./paper";
import type { Workspace } from "../workspace/workspace";

export const PaperControls = ({ workspace }: { workspace: Workspace }) => {
  const t = (message: string) =>
    translate(workspace.settings.language, message);
  const [template, setTemplate] = useState<PaperTemplate | "infinite">(
    "infinite",
  );
  const [orientation, setOrientation] = useState<PaperOrientation>("portrait");
  return (
    <>
      <div className="desktop-modal-body">
        <div
          className="desktop-paper-choices"
          role="group"
          aria-label={t("纸张模板")}
        >
          {(["infinite", "blank", "ruled"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={template === value}
              onClick={() => setTemplate(value)}
            >
              <span
                className={`desktop-paper-preview ${value}`}
                aria-hidden="true"
              >
                {value === "infinite" ? "∞" : "A4"}
              </span>
              {t(
                value === "infinite"
                  ? "无限画布"
                  : value === "blank"
                  ? "A4 空白"
                  : "A4 横线",
              )}
            </button>
          ))}
        </div>
        {template !== "infinite" && (
          <fieldset className="desktop-paper-orientation">
            <legend>{t("纸张方向")}</legend>
            {(["portrait", "landscape"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="paper-orientation"
                  checked={orientation === value}
                  onChange={() => setOrientation(value)}
                />
                {t(value === "portrait" ? "纵向" : "横向")}
              </label>
            ))}
          </fieldset>
        )}
        <p>{t("纸张外也可绘图。导出 PDF 时，纸张内的内容按页输出。")}</p>
      </div>
      <footer>
        <Button onSelect={workspace.closeNewDocument}>{t("取消")}</Button>
        <Button
          className="desktop-primary"
          onSelect={() =>
            workspace.createCanvas(
              template === "infinite"
                ? {}
                : createPaperTemplate(template, orientation),
              t(
                template === "infinite"
                  ? "未命名"
                  : template === "blank"
                  ? "A4 空白"
                  : "A4 横线",
              ),
            )
          }
        >
          {t("创建")}
        </Button>
      </footer>
    </>
  );
};

export const PdfImportControls = ({
  root,
  workspace,
}: {
  root: HTMLElement;
  workspace: Workspace;
}) => {
  const t = (message: string, params?: Record<string, number | string>) =>
    translate(workspace.settings.language, message, params);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const start = async () => {
    const ownerWindow = root.ownerDocument.defaultView!;
    const abort = new ownerWindow.AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setProgress({ page: 0, total: 0 });
    try {
      const file = await ownerWindow.desktop.importPdf();
      if (!file || abort.signal.aborted) {
        return;
      }
      const scene = await importPdf(
        file.data,
        root.ownerDocument,
        abort.signal,
        (page, total) => setProgress({ page, total }),
      );
      if (!abort.signal.aborted) {
        workspace.createCanvas(scene, file.name.replace(/\.pdf$/i, ""));
      }
    } catch (failure) {
      if (!abort.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
      }
    }
  };
  return (
    <>
      <div className="desktop-modal-body">
        <p>{t("每页 PDF 会作为锁定底图纵向排列，可在上面绘图和批注。")}</p>
        <p>
          {t(
            "保存为新画布，或导出带批注的新 PDF；原文件保持不变，文字和链接会转换为图片。",
          )}
        </p>
        {busy && (
          <div role="status" aria-live="polite">
            <p>
              {progress.total
                ? t("正在导入第 {page} / {total} 页…", progress)
                : t("正在读取 PDF…")}
            </p>
            <progress
              aria-label={t("PDF 导入进度")}
              max={progress.total || 1}
              value={progress.page}
            />
          </div>
        )}
        {error && <p role="alert">{t(error)}</p>}
      </div>
      <footer>
        <Button
          onSelect={() => {
            controller.current?.abort();
            workspace.closePdfImport();
          }}
        >
          {t("取消")}
        </Button>
        <Button
          className="desktop-primary"
          disabled={busy}
          onSelect={() => void start()}
        >
          {t("选择 PDF 文件")}
        </Button>
      </footer>
    </>
  );
};
