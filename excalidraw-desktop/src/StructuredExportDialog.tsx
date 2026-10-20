import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";

import type {
  ExcalidrawImperativeAPI,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import type { SubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  buildStructuredExport,
  prepareStructuredExport,
  structuredExportToMarkdown,
} from "./structuredExport";
import { DesktopSegmentedControl } from "./DesktopControls";

import "./StructuredExportDialog.scss";

import type { SceneSnapshot } from "./document";

const messages = {
  "zh-CN": {
    title: "结构化导出",
    format: "导出格式",
    infer: "根据位置推断分区",
    inferHint:
      "优先保留画框、分组和文本绑定；位置包含与阅读顺序标记为推断，不推断业务含义。",
    overview: "覆盖概览",
    nodes: "节点",
    connectors: "连接",
    texts: "正文",
    assets: "图片资源",
    subcanvases: "子画布",
    inferred: "推断包含关系",
    original: "原文优先，保留所有有效元素 ID、绑定端点、箭头方向和几何信息。",
    warning: "导出说明",
    selfLoops: "条同框自环已保留",
    unbound: "条连接含未知端点，保留坐标",
    noOcr: "图片未进行 OCR；可用图片会另存为同目录下的附件。",
    missingImages: "张图片缺失资源，无法导出附件",
    preview: "内容预览",
    markdown: "阅读视图",
    json: "JSON",
    cancel: "取消",
    save: "导出",
    saving: "正在导出…",
    loading: "正在读取画布…",
    failed: "导出失败，请重试。",
    snapshot: "预览与导出使用打开对话框时的同一画布快照。",
    close: "关闭对话框",
    empty: "画布为空。",
    attachmentHint:
      "附件保存在文件旁的独立目录；再次导出相同快照会复用同名附件，覆盖现有导出文件时将由保存窗口确认。",
  },
  en: {
    title: "Structured export",
    format: "Export format",
    infer: "Infer regions from positions",
    inferHint:
      "Frames, groups and text bindings take priority. Containment and reading order are marked as inferred; domain meaning is not inferred.",
    overview: "Coverage",
    nodes: "nodes",
    connectors: "connectors",
    texts: "text elements",
    assets: "image resources",
    subcanvases: "subcanvases",
    inferred: "inferred containment relations",
    original:
      "Preserves original text, every live element ID, endpoint bindings, arrow direction and geometry.",
    warning: "Export notes",
    selfLoops: "same-container self-loops retained",
    unbound: "connectors have unknown endpoints; coordinates retained",
    noOcr:
      "Images were not OCR processed. Available images are exported as attachments beside the file.",
    missingImages: "images have missing resources and cannot be attached",
    preview: "Preview",
    markdown: "Reading view",
    json: "JSON",
    cancel: "Cancel",
    save: "Export",
    saving: "Exporting…",
    loading: "Reading canvas…",
    failed: "Export failed. Please try again.",
    snapshot:
      "Preview and export use the same canvas snapshot captured when this dialog opened.",
    close: "Close dialog",
    empty: "The canvas is empty.",
    attachmentHint:
      "Attachments are saved in a separate directory beside the file. Exporting the same snapshot reuses attachment names; the save dialog asks before replacing an existing export file.",
  },
};

export const StructuredExportDialog = ({
  root,
  api,
  title,
  language,
  defaultFormat,
  includeInferredStructure,
  getSnapshot,
  onClose,
}: {
  root: HTMLElement;
  api: ExcalidrawImperativeAPI;
  title: string;
  language: "zh-CN" | "en";
  defaultFormat: "json" | "md";
  includeInferredStructure: boolean;
  getSnapshot?: () => SceneSnapshot;
  onClose: () => void;
}) => {
  const t = messages[language];
  const headingId = useId();
  const container = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(false);
  const [snapshot, setSnapshot] = useState<{
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
    subscenes: SubcanvasScenes;
  } | null>(null);
  const [format, setFormat] = useState(defaultFormat);
  const [infer, setInfer] = useState(includeInferredStructure);
  const [view, setView] = useState<"md" | "json">("md");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.commitEditing();
    const current = getSnapshot?.();
    setSnapshot({
      elements: JSON.parse(
        JSON.stringify(current?.elements ?? api.getSceneElements()),
      ),
      files: JSON.parse(JSON.stringify(current?.files ?? api.getFiles())),
      subscenes: JSON.parse(
        JSON.stringify(
          (current?.appState ?? api.getAppState()).subscenes ?? {},
        ),
      ),
    });
  }, [api, getSnapshot]);
  useEffect(() => {
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const previous = ownerDocument.activeElement as HTMLElement | null;
    const node = container.current!;
    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          "button:not(:disabled):not([tabindex='-1']), input:not(:disabled):not([tabindex='-1']), select:not(:disabled), summary, [tabindex='0']",
        ),
      );
    const frame = ownerWindow.requestAnimationFrame(() =>
      focusable()[0]?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) {
          closeRef.current();
        }
      } else if (event.key === "Tab") {
        const items = focusable();
        if (event.shiftKey && ownerDocument.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          ownerDocument.activeElement === items.at(-1)
        ) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [root]);
  const document = useMemo(
    () =>
      snapshot
        ? buildStructuredExport(snapshot.elements, snapshot.files, {
            title,
            includeInferredStructure: infer,
            subscenes: snapshot.subscenes,
          })
        : null,
    [snapshot, title, infer],
  );
  const preview = useMemo(
    () =>
      document
        ? view === "json"
          ? JSON.stringify(document, null, 2)
          : structuredExportToMarkdown(document)
        : "",
    [document, view],
  );
  const close = () => !busyRef.current && onClose();
  const submit = async () => {
    if (!document || !snapshot || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const desktop = root.ownerDocument.defaultView!.desktop;
      const success = await desktop.saveExport(
        prepareStructuredExport(document, snapshot.files, format),
      );
      if (success) {
        onClose();
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? `${t.failed} ${failure.message}` : t.failed,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const selfLoops =
    document?.diagnostics.filter(
      (item) => item.code === "same-container-self-loop",
    ).length || 0;
  const unbound =
    document?.diagnostics.filter(
      (item) =>
        item.code === "unbound-connector" ||
        item.code === "partially-bound-connector",
    ).length || 0;
  const missingImages =
    document?.nodes.filter(
      (node) =>
        node.type === "image" &&
        !document.assets.some(
          (asset) =>
            asset.fileId === node.fileId && asset.status === "available",
        ),
    ).length || 0;
  return (
    <div
      className="desktop-modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        className="desktop-modal structured-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={container}
      >
        <header>
          <div className="structured-export-title">
            <h2 id={headingId}>{t.title}</h2>
            <p title={title}>{title}</p>
          </div>
          <Button aria-label={t.close} disabled={busy} onSelect={close}>
            {CloseIcon}
          </Button>
        </header>
        <div className="structured-export-body">
          <div className="structured-export-controls">
            <div className="structured-export-option">
              <span>{t.format}</span>
              <DesktopSegmentedControl
                label={t.format}
                value={format}
                disabled={busy}
                onValueChange={(value) => setFormat(value as "json" | "md")}
                options={[
                  { value: "json", label: "JSON" },
                  { value: "md", label: "Markdown" },
                ]}
              />
            </div>
            <div className="structured-export-layout-option">
              <label className="desktop-checkbox-label">
                <input
                  type="checkbox"
                  checked={infer}
                  disabled={busy}
                  onChange={(event) => setInfer(event.target.checked)}
                />
                {t.infer}
              </label>
              <p className="structured-export-hint">{t.inferHint}</p>
            </div>
          </div>
          {document ? (
            <>
              <section
                className="structured-export-summary"
                aria-label={t.overview}
              >
                <div className="structured-export-stats">
                  {[
                    [document.nodes.length, t.nodes],
                    [document.connectors.length, t.connectors],
                    [
                      document.nodes.filter((node) => node.type === "text")
                        .length,
                      t.texts,
                    ],
                    [document.assets.length, t.assets],
                    ...(document.subcanvases?.length
                      ? [[document.subcanvases.length, t.subcanvases]]
                      : []),
                  ].map(([count, label]) => (
                    <div key={label}>
                      <strong>{count}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                <p>{t.original}</p>
              </section>
              {(selfLoops > 0 ||
                unbound > 0 ||
                document.assets.length > 0 ||
                missingImages > 0) && (
                <details
                  className="structured-export-notes"
                  open={missingImages > 0 || undefined}
                >
                  <summary>{t.warning}</summary>
                  <p>
                    {
                      document.layout.relations.filter(
                        (relation) => relation.source === "inferred",
                      ).length
                    }{" "}
                    {t.inferred}
                  </p>
                  {selfLoops > 0 && (
                    <p>
                      {selfLoops} {t.selfLoops}
                    </p>
                  )}
                  {unbound > 0 && (
                    <p>
                      {unbound} {t.unbound}
                    </p>
                  )}
                  {document.assets.length > 0 && <p>{t.noOcr}</p>}
                  {missingImages > 0 && (
                    <p>
                      {missingImages} {t.missingImages}
                    </p>
                  )}
                </details>
              )}
              <div className="structured-export-preview-heading">
                <strong>{t.preview}</strong>
                <DesktopSegmentedControl
                  label={t.preview}
                  value={view}
                  onValueChange={(value) => setView(value as "md" | "json")}
                  options={[
                    { value: "md", label: t.markdown },
                    { value: "json", label: t.json },
                  ]}
                />
              </div>
              <pre
                className="structured-export-preview"
                tabIndex={0}
                aria-label={`${t.preview}: ${
                  view === "json" ? t.json : t.markdown
                }`}
              >
                {preview}
              </pre>
            </>
          ) : (
            <p>{t.loading}</p>
          )}
          <div className="structured-export-footnotes">
            <p className="structured-export-hint">{t.snapshot}</p>
            {document && document.assets.length > 0 && (
              <p className="structured-export-hint">{t.noOcr}</p>
            )}
            <p className="structured-export-hint">{t.attachmentHint}</p>
          </div>
          {document?.source.liveElementCount === 0 && (
            <p role="status">{t.empty}</p>
          )}
          {error && (
            <p className="structured-export-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="structured-export-footer">
          <Button disabled={busy} onSelect={close}>
            {t.cancel}
          </Button>
          <Button
            className="desktop-primary"
            disabled={busy || !document?.source.liveElementCount}
            onSelect={() => void submit()}
          >
            {busy ? t.saving : t.save}
          </Button>
        </footer>
      </div>
    </div>
  );
};
