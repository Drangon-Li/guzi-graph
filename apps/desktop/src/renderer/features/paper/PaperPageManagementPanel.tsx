import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, hashElementsVersion } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { translate } from "../../shared/i18n/i18n";
import { createThumbnailCache } from "../projects/thumbnailCache";

import { startPaperPageCardDrag } from "./paperPageCardDrag";
import { changePaperPages } from "./paperPageManagement";
import { renderPaperPageThumbnail } from "./paperPageThumbnail";

import "./paperPageManagement.scss";

import type { DesktopLanguage } from "../../shared/i18n/i18n";
import type { getPaperPages } from "./paper";
import type { PaperPageAction } from "./paperPageManagement";

type Page = ReturnType<typeof getPaperPages>[number];

const PaperPagePreview = ({
  api,
  page,
  version,
  cache,
  theme,
}: {
  api: ExcalidrawImperativeAPI;
  page: Page;
  version: number;
  cache: ReturnType<typeof createThumbnailCache>;
  theme: "light" | "dark";
}) => {
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const element = node.current!;
    const ownerWindow = element.ownerDocument.defaultView!;
    const observer = new ownerWindow.IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: element.closest(".desktop-paper-page-list") },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      setPreview(null);
      return;
    }
    const ownerDocument = node.current!.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    let disposed = false;
    let release: (() => void) | undefined;
    const timer = ownerWindow.setTimeout(() => {
      const thumbnail = cache.acquire(
        JSON.stringify([page.id, version, theme]),
        (cancelled) =>
          renderPaperPageThumbnail(
            api,
            page.id,
            ownerDocument,
            theme,
            cancelled,
          ),
      );
      release = thumbnail.release;
      void thumbnail.promise.then(
        (value) => !disposed && setPreview(value),
        () => !disposed && setPreview(null),
      );
    }, 120);
    return () => {
      disposed = true;
      ownerWindow.clearTimeout(timer);
      release?.();
    };
  }, [api, cache, page.id, theme, version, visible]);

  const ratio = page.width / page.height;
  return (
    <span className="desktop-paper-page-preview" aria-hidden="true" ref={node}>
      <span
        style={{
          width: Math.min(52, 60 * ratio),
          height: Math.min(60, 52 / ratio),
        }}
      >
        {preview && <img src={preview} alt="" draggable={false} />}
      </span>
    </span>
  );
};

export const PaperPageManagementPanel = ({
  id,
  api,
  pages,
  current,
  language,
  onClose,
  onNavigate,
}: {
  id: string;
  api: ExcalidrawImperativeAPI;
  pages: Page[];
  current: Page;
  language: DesktopLanguage;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (pageId: string, layoutChanged?: boolean) => void;
}) => {
  const [cache] = useState(() => createThumbnailCache(2 * 1024 * 1024));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    source: string;
    target: string | null;
  } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const cancelDrag = useRef<ReturnType<typeof startPaperPageCardDrag> | null>(
    null,
  );
  const suppressPointerClick = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const pageList = useRef<HTMLOListElement>(null);
  const activeRow = useRef<HTMLLIElement>(null);
  const t = (message: string, params?: Record<string, number>) =>
    translate(language, message, params);
  const state = api.getAppState();
  const readOnly = state.viewModeEnabled;
  const version = hashElementsVersion(api.getSceneElements());

  useEffect(() => {
    heading.current?.focus();
    return () => cancelDrag.current?.(false);
  }, []);
  useEffect(() => {
    const section = panel.current!;
    const ownerDocument = section.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const dismiss = (event: PointerEvent) => {
      const path = event.composedPath();
      if (
        cancelDrag.current ||
        path.includes(section) ||
        path.some(
          (node) =>
            node instanceof ownerWindow.Element &&
            node.getAttribute("aria-controls") === id,
        )
      ) {
        return;
      }
      onClose(false);
    };
    ownerDocument.addEventListener("pointerdown", dismiss, true);
    return () =>
      ownerDocument.removeEventListener("pointerdown", dismiss, true);
  }, [id, onClose]);
  useEffect(() => {
    if (readOnly) {
      cancelDrag.current?.();
    }
  }, [readOnly]);
  useEffect(() => {
    const list = pageList.current!;
    const row = activeRow.current!;
    if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop;
    } else if (
      row.offsetTop + row.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [current.id, current.y]);
  useEffect(() => {
    if (confirmDelete) {
      cancelDelete.current?.focus();
    }
  }, [confirmDelete]);

  const apply = (action: PaperPageAction) => {
    if (api.getAppState().viewModeEnabled) {
      return;
    }
    api.commitEditing();
    const result = changePaperPages(
      api.getSceneElementsIncludingDeleted(),
      action,
    );
    if (!result) {
      setConfirmDelete(null);
      return;
    }
    if (result.requiresConfirmation) {
      setConfirmDelete(action.pageId);
      return;
    }
    setConfirmDelete(null);
    const appState = api.getAppState();
    api.updateScene({
      elements: result.elements,
      ...(result.deleted.size
        ? {
            appState: {
              selectedElementIds: Object.fromEntries(
                Object.entries(appState.selectedElementIds).filter(
                  ([elementId]) => !result.deleted.has(elementId),
                ),
              ),
              selectedGroupIds: {},
              editingGroupId: null,
            },
          }
        : {}),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    onNavigate(
      action.type === "delete" && action.pageId !== current.id
        ? current.id
        : result.destination,
      true,
    );
    if (action.type === "delete") {
      heading.current?.focus();
    }
    if (result.unassigned) {
      api.setToast({
        message: t("已保留 {count} 个跨页或页外元素。", {
          count: result.unassigned,
        }),
        closable: true,
      });
    }
  };

  const confirmIndex = pages.findIndex((page) => page.id === confirmDelete);
  const dragIndex = pages.findIndex((page) => page.id === drag?.source);

  return (
    <section
      ref={panel}
      id={id}
      aria-labelledby={`${id}-heading`}
      className="desktop-paper-page-management"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (confirmDelete) {
            setConfirmDelete(null);
            heading.current?.focus();
          } else {
            onClose();
          }
        }
      }}
    >
      <header>
        <h2 ref={heading} id={`${id}-heading`} tabIndex={-1}>
          {t("页面管理")}
        </h2>
        <button
          type="button"
          aria-label={t("收起页面面板")}
          onClick={() => onClose()}
        >
          ×
        </button>
      </header>
      {!readOnly && (
        <button
          type="button"
          className="desktop-paper-page-insert"
          onClick={() => apply({ type: "insert", pageId: current.id })}
        >
          {t("在当前页后插入空白页")}
        </button>
      )}
      {!readOnly && confirmIndex >= 0 && (
        <div className="desktop-paper-page-confirm">
          <p role="alert">
            {t("删除第 {page} 页及其内容？可撤销此操作。", {
              page: confirmIndex + 1,
            })}
          </p>
          <div>
            <button
              type="button"
              ref={cancelDelete}
              onClick={() => {
                setConfirmDelete(null);
                heading.current?.focus();
              }}
            >
              {t("取消")}
            </button>
            <button
              type="button"
              className="desktop-paper-page-delete"
              onClick={() =>
                apply({
                  type: "delete",
                  pageId: pages[confirmIndex].id,
                  confirmed: true,
                })
              }
            >
              {t("确认删除")}
            </button>
          </div>
        </div>
      )}
      <ol
        className="desktop-paper-page-list"
        ref={pageList}
        onPointerDownCapture={() => {
          if (!cancelDrag.current) {
            suppressPointerClick.current = false;
          }
        }}
        onClickCapture={(event) => {
          if (event.detail && suppressPointerClick.current) {
            suppressPointerClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {pages.map((page, index) => {
          const label = { page: index + 1 };
          const active = page.id === current.id;
          const dropTarget =
            drag?.target === page.id && drag.source !== page.id
              ? index < dragIndex
                ? "before"
                : "after"
              : undefined;
          return (
            <li
              key={page.id}
              ref={active ? activeRow : undefined}
              className="desktop-paper-page-row"
              data-page-id={page.id}
              data-reorderable={
                !readOnly && pages.length > 1 ? true : undefined
              }
              data-drag-source={drag?.source === page.id || undefined}
              data-drop-target={dropTarget}
              data-active={active || undefined}
              onPointerDown={(event) => {
                const row = event.currentTarget;
                const ownerWindow = row.ownerDocument.defaultView!;
                if (
                  readOnly ||
                  pages.length < 2 ||
                  event.button !== 0 ||
                  event.pointerType === "touch" ||
                  cancelDrag.current ||
                  (event.target instanceof ownerWindow.Element &&
                    event.target.closest(".desktop-paper-page-row-actions"))
                ) {
                  return;
                }
                cancelDrag.current = startPaperPageCardDrag({
                  source: row,
                  list: pageList.current!,
                  pointer: event,
                  onMove: (target) => setDrag({ source: page.id, target }),
                  onFinish: (moved, target) => {
                    cancelDrag.current = null;
                    suppressPointerClick.current = moved;
                    setDrag(null);
                    if (target) {
                      apply({
                        type: "reorder",
                        pageId: page.id,
                        targetId: target,
                      });
                    }
                  },
                });
              }}
            >
              <button
                className="desktop-paper-page-link"
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate(page.id)}
              >
                <PaperPagePreview
                  api={api}
                  page={page}
                  version={version}
                  cache={cache}
                  theme={state.theme}
                />
                {t("第 {page} 页", label)}
              </button>
              {!readOnly && (
                <div className="desktop-paper-page-row-actions">
                  <button
                    type="button"
                    disabled={index === 0}
                    aria-label={t("上移第 {page} 页", label)}
                    onClick={() =>
                      apply({ type: "move", pageId: page.id, direction: -1 })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === pages.length - 1}
                    aria-label={t("下移第 {page} 页", label)}
                    onClick={() =>
                      apply({ type: "move", pageId: page.id, direction: 1 })
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="desktop-paper-page-delete"
                    disabled={pages.length === 1}
                    aria-label={t("删除第 {page} 页", label)}
                    onClick={() => apply({ type: "delete", pageId: page.id })}
                  >
                    ×
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
