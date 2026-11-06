import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/element";
import { constrainScrollState } from "@excalidraw/excalidraw/viewport";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  ViewportGesture,
} from "@excalidraw/excalidraw/types";

import { translate } from "../../shared/i18n/i18n";

import { PaperPageManagementPanel } from "./PaperPageManagementPanel";
import { PaperSettingsPanel } from "./PaperSettingsPanel";
import {
  appendPaperPage,
  getPaperPages,
  PAPER_GAP,
  paperViewport,
  paperViewportOffsets,
} from "./paper";
import { PageGesture, PAGE_PULL_THRESHOLD } from "./pageGesture";

import "./paper.scss";

export type PaperGestureHandler = (
  gesture: ViewportGesture,
  state: AppState,
) => void;

const getAppendableLastPage = (pages: ReturnType<typeof getPaperPages>) => {
  const last = pages.at(-1);
  const kind = last?.customData?.guziPaper?.kind;
  return (kind === "blank" || kind === "ruled") &&
    !pages.some((page) => page.customData?.guziPaper?.kind === "pdf")
    ? last
    : undefined;
};

const paperConstraint = (
  api: ExcalidrawImperativeAPI,
  pages: ReturnType<typeof getPaperPages>,
  zoom: number,
): NonNullable<AppState["scrollConstraints"]> => {
  const left = Math.min(...pages.map((page) => page.x));
  const right = Math.max(...pages.map((page) => page.x + page.width));
  const top = Math.min(...pages.map((page) => page.y));
  const bottom = Math.max(...pages.map((page) => page.y + page.height));
  const last = getAppendableLastPage(pages);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    lockScroll: true,
    lockZoom: false,
    zoom,
    overscroll: 80,
    elasticPan: true,
    // If both stacks fit, appending a sheet moves the centered stop by
    // half the added height. Keep the pull within that available travel.
    maxOverscrollYInScene: last ? (last.height + PAPER_GAP) / 2 : undefined,
    offsets: paperViewportOffsets(
      api.getViewportOffsets({ useSettledToolDock: true }),
    ),
  };
};

export const PaperPageControls = ({
  api,
  active,
  ownedConstraint,
  language,
  register,
}: {
  api: ExcalidrawImperativeAPI;
  active: boolean;
  ownedConstraint: React.RefObject<AppState["scrollConstraints"]>;
  language: "en" | "zh-CN";
  register: (handler: PaperGestureHandler | null) => void;
}) => {
  const node = useRef<HTMLDivElement>(null);
  const [revision, refresh] = useState(0);
  const [pull, setPull] = useState({
    progress: 0,
    armed: false,
  });
  const cancelGesture = useRef<(() => void) | null>(null);
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<"management" | "settings" | null>(
    null,
  );
  const closePanel = useCallback(() => setOpenPanel(null), []);
  const managingPages = openPanel === "management";
  const settingsOpen = openPanel === "settings";
  const settingsId = useId();
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const managementId = useId();
  const managementToggle = useRef<HTMLButtonElement>(null);
  const lastJump = useRef<{
    pageId: string;
    y: number;
    scrollY: number;
    zoom: number;
  } | null>(null);
  const t = (message: string) => translate(language, message);
  const state = api.getAppState();
  const pages = getPaperPages(api.getSceneElements());
  const visible = active && pages.length > 0;
  const hasRuledPages = pages.some(
    (page) => page.customData?.guziPaper?.kind === "ruled",
  );
  const canAppend = !!getAppendableLastPage(pages) && !state.viewModeEnabled;
  const offsets = api.getViewportOffsets({ useSettledToolDock: true });
  const centerY =
    ((offsets.top ?? 0) + state.height - (offsets.bottom ?? 0)) /
      2 /
      state.zoom.value -
    state.scrollY;
  const closest = pages.reduce(
    (best, page, index) =>
      Math.abs(page.y + page.height / 2 - centerY) <
      Math.abs(pages[best].y + pages[best].height / 2 - centerY)
        ? index
        : best,
    0,
  );
  const anchor = lastJump.current;
  const jumpedTo =
    anchor &&
    anchor.zoom === state.zoom.value &&
    Math.abs(anchor.scrollY - state.scrollY) < 0.01
      ? pages.findIndex(
          (page) => page.id === anchor.pageId && page.y === anchor.y,
        )
      : -1;
  const current = jumpedTo < 0 ? closest : jumpedTo;
  const jumpToPage = (
    pageId: string,
    fitWidth = false,
    layoutChanged = false,
  ) => {
    cancelGesture.current?.();
    const currentPages = getPaperPages(api.getSceneElements());
    const page = currentPages.find((frame) => frame.id === pageId);
    if (page) {
      const currentState = api.getAppState();
      const viewport = paperViewport(
        page,
        currentState,
        api.getViewportOffsets({ useSettledToolDock: true }),
        fitWidth,
      );
      // Stop core navigation animations before this event commits its destination.
      api.setViewport(null);
      let constraint = currentState.scrollConstraints;
      if (
        layoutChanged &&
        (!constraint || constraint === ownedConstraint.current)
      ) {
        constraint = paperConstraint(api, currentPages, viewport.zoom.value);
        ownedConstraint.current = constraint;
      }
      const target = constrainScrollState({
        ...currentState,
        ...viewport,
        scrollConstraints: constraint,
      });
      // At low zoom, a jump can display several small PDF pages at once.
      lastJump.current = {
        pageId: page.id,
        y: page.y,
        scrollY: target.scrollY,
        zoom: target.zoom.value,
      };
      api.updateScene({
        appState: {
          ...target,
          scrollConstraints: constraint,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };
  const jump = (index: number, fitWidth = false) => {
    if (pages[index]) {
      jumpToPage(pages[index].id, fitWidth);
    }
  };

  useEffect(() => api.onChange(() => refresh((value) => value + 1)), [api]);
  useEffect(() => {
    if (!visible || (!hasRuledPages && settingsOpen)) {
      closePanel();
    }
  }, [closePanel, hasRuledPages, settingsOpen, visible]);
  useEffect(() => {
    if (!visible) {
      return;
    }
    let syncing = false;
    let previousDimensions: [number, number] | null = null;
    const sync = () => {
      if (syncing) {
        return;
      }
      const currentState = api.getAppState();
      if (
        currentState.scrollConstraints &&
        currentState.scrollConstraints !== ownedConstraint.current
      ) {
        return;
      }
      const currentPages = getPaperPages(api.getSceneElements());
      if (!currentPages.length) {
        return;
      }
      const previous = currentState.scrollConstraints;
      const next = paperConstraint(api, currentPages, currentState.zoom.value);
      const sameGeometry =
        previous?.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height &&
        previous.maxOverscrollYInScene === next.maxOverscrollYInScene;
      const sameDimensions =
        previousDimensions?.[0] === currentState.width &&
        previousDimensions[1] === currentState.height;
      const sideChanged =
        previous?.offsets?.left !== next.offsets?.left ||
        previous?.offsets?.right !== next.offsets?.right;
      const sameOffsets =
        !sideChanged &&
        previous?.offsets?.top === next.offsets?.top &&
        previous?.offsets?.bottom === next.offsets?.bottom;
      if (sameGeometry && sameOffsets && sameDimensions) {
        return;
      }
      previousDimensions = [currentState.width, currentState.height];
      ownedConstraint.current = next;
      syncing = true;
      if (previous && sameGeometry && sameDimensions && sideChanged) {
        api.transitionScrollConstraints(next);
      } else {
        api.updateScene({
          appState: {
            scrollConstraints: next,
            ...constrainScrollState({
              ...currentState,
              scrollConstraints: next,
            }),
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      syncing = false;
    };
    const unsubscribe = api.onChange(sync);
    const root = node.current?.parentElement;
    const ownerWindow = root?.ownerDocument.defaultView;
    // Dock collapse is local to LayerUI and need not cause an App update.
    const observer = ownerWindow && new ownerWindow.MutationObserver(sync);
    if (observer && root) {
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-viewport-ui", "data-viewport-dock-width"],
      });
    }
    sync();
    return () => {
      observer?.disconnect();
      unsubscribe();
      if (
        !api.isDestroyed &&
        api.getAppState().scrollConstraints === ownedConstraint.current
      ) {
        api.updateScene({
          appState: { scrollConstraints: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      ownedConstraint.current = null;
    };
  }, [api, visible, ownedConstraint]);
  useEffect(() => {
    const ownerWindow = node.current?.ownerDocument.defaultView;
    if (!ownerWindow || !visible || !canAppend) {
      register(null);
      return;
    }
    const machine = new PageGesture();
    let streamHasPage = false;
    const handle: PaperGestureHandler = (gesture, nextState) => {
      const last = getAppendableLastPage(getPaperPages(api.getSceneElements()));
      if (
        !last ||
        nextState.viewModeEnabled ||
        !nextState.scrollConstraints ||
        nextState.scrollConstraints !== ownedConstraint.current ||
        gesture.pastEnd == null
      ) {
        machine.update({ ...gesture, phase: "cancel" }, 0);
        setPull({ progress: 0, armed: false });
        return;
      }
      const viewportOffsets = nextState.scrollConstraints.offsets;
      const pageLeft = (last.x + nextState.scrollX) * nextState.zoom.value;
      const pageRight = pageLeft + last.width * nextState.zoom.value;
      const overlapsPage =
        pageRight > (viewportOffsets?.left ?? 0) &&
        pageLeft < nextState.width - (viewportOffsets?.right ?? 0) &&
        (last.y + last.height + nextState.scrollY) * nextState.zoom.value >=
          (viewportOffsets?.top ?? 0);
      if (gesture.phase === "begin" || !machine.active) {
        streamHasPage = overlapsPage;
      }
      streamHasPage ||= overlapsPage;
      if (!streamHasPage) {
        machine.cancel();
      }
      const create = machine.update(
        streamHasPage || gesture.phase === "end" || gesture.phase === "cancel"
          ? gesture
          : { ...gesture, phase: "cancel" },
        gesture.pastEnd,
      );
      setPull({
        progress: machine.progress,
        armed: machine.armed,
      });
      if (create) {
        const next = appendPaperPage(api.getSceneElementsIncludingDeleted());
        if (next) {
          const constraint = paperConstraint(
            api,
            getPaperPages(next.elements),
            nextState.zoom.value,
          );
          ownedConstraint.current = constraint;
          api.updateScene({
            elements: next.elements,
            appState: { scrollConstraints: constraint },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
        }
      }
    };
    const cancel = () => {
      machine.cancel();
      setPull({ progress: 0, armed: false });
    };
    cancelGesture.current = cancel;
    register(handle);
    ownerWindow.addEventListener("blur", cancel);
    ownerWindow.addEventListener("pointerdown", cancel, true);
    ownerWindow.addEventListener("keydown", cancel, true);
    return () => {
      ownerWindow.removeEventListener("blur", cancel);
      ownerWindow.removeEventListener("pointerdown", cancel, true);
      ownerWindow.removeEventListener("keydown", cancel, true);
      cancelGesture.current = null;
      register(null);
      machine.cancel();
      setPull({ progress: 0, armed: false });
    };
  }, [api, visible, canAppend, ownedConstraint, register]);

  // Keep the mounted owner document available even for an infinite canvas.
  if (!visible) {
    return <div ref={node} hidden />;
  }
  const last = pages.at(-1)!;
  const opacity = Math.min(1, pull.progress / PAGE_PULL_THRESHOLD);
  const lastBottom = (last.y + last.height + state.scrollY) * state.zoom.value;
  const bottomDistance = state.height - (offsets.bottom ?? 24) - lastBottom;
  const nearEnd =
    canAppend &&
    bottomDistance >= -96 &&
    lastBottom >= (offsets.top ?? 0) &&
    (last.x + last.width + state.scrollX) * state.zoom.value >
      (offsets.left ?? 0) &&
    (last.x + state.scrollX) * state.zoom.value <
      state.width - (offsets.right ?? 0);
  return (
    <div
      ref={node}
      className="desktop-paper-page-layer"
      data-revision={revision}
    >
      {pull.progress > 0 && (
        <>
          <div
            className="desktop-paper-next-outline"
            aria-hidden="true"
            style={{
              left: (last.x + state.scrollX) * state.zoom.value,
              top:
                (last.y + last.height + PAPER_GAP + state.scrollY) *
                state.zoom.value,
              width: last.width * state.zoom.value,
              height: last.height * state.zoom.value,
              opacity: opacity * 0.65,
            }}
          />
        </>
      )}
      {(nearEnd || pull.progress > 0) && (
        <div
          className={`desktop-paper-pull-hint${pull.armed ? " is-ready" : ""}`}
        >
          <div className="desktop-paper-pull-heading">
            <span role="status" aria-live="polite">
              {t(pull.armed ? "松手新建一页" : "继续下拉新建一页…")}
            </span>
            <button
              type="button"
              className="desktop-paper-add-page"
              onClick={() => {
                cancelGesture.current?.();
                if (
                  !getAppendableLastPage(
                    getPaperPages(api.getSceneElements()),
                  ) ||
                  api.getAppState().viewModeEnabled
                ) {
                  return;
                }
                const next = appendPaperPage(
                  api.getSceneElementsIncludingDeleted(),
                );
                if (next) {
                  api.updateScene({
                    elements: next.elements,
                    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
                  });
                }
              }}
            >
              {t("+ 新建一页")}
            </button>
          </div>
          <div
            className="desktop-paper-pull-progress"
            role="progressbar"
            aria-label={t("+ 新建一页")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pull.armed ? 100 : Math.round(opacity * 100)}
          >
            <span
              className="desktop-paper-pull-progress-fill"
              style={{ transform: `scaleX(${pull.armed ? 1 : opacity})` }}
            />
          </div>
        </div>
      )}
      <nav
        className="desktop-paper-page-controls"
        aria-label={t("纸张页码导航")}
      >
        <button
          type="button"
          disabled={current === 0}
          aria-label={t("上一页")}
          onClick={() => jump(current - 1)}
        >
          ↑
        </button>
        <label>
          <span className="desktop-paper-sr-only">{t("页码")}</span>
          <input
            aria-label={t("页码")}
            inputMode="numeric"
            value={pageInput ?? String(current + 1)}
            onChange={(event) => setPageInput(event.target.value)}
            onFocus={() => setPageInput(String(current + 1))}
            onBlur={() => setPageInput(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const value = Number(pageInput);
                if (
                  Number.isInteger(value) &&
                  value >= 1 &&
                  value <= pages.length
                ) {
                  jump(value - 1);
                }
                setPageInput(null);
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setPageInput(null);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <span aria-hidden="true">/ {pages.length}</span>
        <button
          type="button"
          disabled={current === pages.length - 1}
          aria-label={t("下一页")}
          onClick={() => jump(current + 1)}
        >
          ↓
        </button>
        <button type="button" onClick={() => jump(current, true)}>
          {t("适合页宽")}
        </button>
        <button
          type="button"
          ref={managementToggle}
          className="desktop-paper-page-toggle"
          aria-expanded={managingPages}
          aria-controls={managingPages ? managementId : undefined}
          onClick={() =>
            setOpenPanel((open) =>
              open === "management" ? null : "management",
            )
          }
        >
          {t("页面管理")}
        </button>
        {hasRuledPages && (
          <button
            type="button"
            ref={settingsToggle}
            className="desktop-paper-settings-toggle"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-controls={settingsOpen ? settingsId : undefined}
            onClick={() =>
              setOpenPanel((open) => (open === "settings" ? null : "settings"))
            }
          >
            {t("纸张设置")}
          </button>
        )}
        {hasRuledPages && settingsOpen && (
          <PaperSettingsPanel
            id={settingsId}
            api={api}
            language={language}
            toggleRef={settingsToggle}
            onClose={closePanel}
          />
        )}
        {managingPages && (
          <PaperPageManagementPanel
            id={managementId}
            api={api}
            pages={pages}
            current={pages[current]}
            language={language}
            onClose={(restoreFocus = true) => {
              closePanel();
              if (restoreFocus) {
                managementToggle.current?.focus();
              }
            }}
            onNavigate={(pageId, layoutChanged) =>
              jumpToPage(pageId, false, layoutChanged)
            }
          />
        )}
      </nav>
    </div>
  );
};
