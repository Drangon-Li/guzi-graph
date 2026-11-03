import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/element";
import { constrainScrollState } from "@excalidraw/excalidraw/viewport";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  ViewportGesture,
} from "@excalidraw/excalidraw/types";

import { translate } from "../../shared/i18n/i18n";

import {
  appendPaperPage,
  getPaperPages,
  PAPER_GAP,
  paperViewport,
  paperViewportOffsets,
} from "./paper";
import {
  PageGesture,
  PAGE_PULL_THRESHOLD,
  WHEEL_PAGE_IDLE,
} from "./pageGesture";

import "./paper.scss";

export type PaperGestureHandler = (
  gesture: ViewportGesture,
  state: AppState,
) => void;

export const PaperPageControls = ({
  api,
  active,
  language,
  register,
}: {
  api: ExcalidrawImperativeAPI;
  active: boolean;
  language: "en" | "zh-CN";
  register: (handler: PaperGestureHandler | null) => void;
}) => {
  const node = useRef<HTMLDivElement>(null);
  const [revision, refresh] = useState(0);
  const [pull, setPull] = useState({
    progress: 0,
    armed: false,
  });
  const ownedConstraint = useRef<AppState["scrollConstraints"]>(null);
  const cancelGesture = useRef<(() => void) | null>(null);
  const [pageInput, setPageInput] = useState<string | null>(null);
  const t = (message: string) => translate(language, message);
  const state = api.getAppState();
  const pages = getPaperPages(api.getSceneElements());
  const visible = active && pages.length > 0;
  const canAppend = ["blank", "ruled"].includes(
    pages.at(-1)?.customData?.guziPaper?.kind,
  );
  const offsets = api.getViewportOffsets();
  const centerY =
    ((offsets.top ?? 0) + state.height - (offsets.bottom ?? 0)) /
      2 /
      state.zoom.value -
    state.scrollY;
  const current = pages.reduce(
    (best, page, index) =>
      Math.abs(page.y + page.height / 2 - centerY) <
      Math.abs(pages[best].y + pages[best].height / 2 - centerY)
        ? index
        : best,
    0,
  );
  const jump = (index: number, fitWidth = false) => {
    cancelGesture.current?.();
    const page = getPaperPages(api.getSceneElements())[index];
    if (page) {
      const currentState = api.getAppState();
      const viewport = paperViewport(
        page,
        currentState,
        api.getViewportOffsets(),
        fitWidth,
      );
      // Stop core navigation animations before this event commits its destination.
      api.setViewport(null);
      api.updateScene({
        appState: {
          ...viewport,
          scrollConstraints: currentState.scrollConstraints,
          scrollX: constrainScrollState({ ...currentState, ...viewport })
            .scrollX,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  useEffect(() => api.onChange(() => refresh((value) => value + 1)), [api]);
  useEffect(() => {
    if (!visible) {
      return;
    }
    let syncing = false;
    let previousLayout = "";
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
      const left = Math.min(...currentPages.map((page) => page.x));
      const right = Math.max(
        ...currentPages.map((page) => page.x + page.width),
      );
      const viewportOffsets = paperViewportOffsets(api.getViewportOffsets());
      const layout = JSON.stringify([
        left,
        right,
        viewportOffsets,
        currentState.width,
      ]);
      if (layout === previousLayout && currentState.scrollConstraints) {
        return;
      }
      previousLayout = layout;
      const constraint: NonNullable<AppState["scrollConstraints"]> = {
        x: left,
        y: 0,
        width: right - left,
        height: 1,
        lockScroll: "x",
        lockZoom: false,
        zoom: currentState.zoom.value,
        overscroll: 80,
        offsets: viewportOffsets,
      };
      ownedConstraint.current = constraint;
      syncing = true;
      api.updateScene({
        appState: {
          scrollConstraints: constraint,
          scrollX: constrainScrollState({
            ...currentState,
            scrollConstraints: constraint,
          }).scrollX,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      syncing = false;
    };
    const unsubscribe = api.onChange(sync);
    sync();
    return () => {
      unsubscribe();
      if (api.getAppState().scrollConstraints === ownedConstraint.current) {
        api.updateScene({
          appState: { scrollConstraints: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      ownedConstraint.current = null;
    };
  }, [api, visible]);
  useEffect(() => {
    const ownerWindow = node.current?.ownerDocument.defaultView;
    if (!ownerWindow || !visible || !canAppend) {
      register(null);
      return;
    }
    const machine = new PageGesture();
    let timer: number | undefined;
    let lastState = api.getAppState();
    let streamHasPage = false;
    const handle: PaperGestureHandler = (gesture, nextState) => {
      ownerWindow.clearTimeout(timer);
      lastState = nextState;
      const last = getPaperPages(api.getSceneElements()).at(-1);
      const kind = last?.customData?.guziPaper?.kind;
      if (!last || (kind !== "blank" && kind !== "ruled")) {
        machine.cancel();
        setPull({ progress: 0, armed: false });
        return;
      }
      const viewportOffsets = api.getViewportOffsets();
      const bottom = nextState.height - (viewportOffsets.bottom ?? 24);
      const pageLeft = (last.x + nextState.scrollX) * nextState.zoom.value;
      const pageRight = pageLeft + last.width * nextState.zoom.value;
      const overlapsPage =
        pageRight > (viewportOffsets.left ?? 0) &&
        pageLeft < nextState.width - (viewportOffsets.right ?? 0) &&
        (last.y + last.height + nextState.scrollY) * nextState.zoom.value >=
          (viewportOffsets.top ?? 0);
      const pastEnd =
        bottom -
        (last.y + last.height + nextState.scrollY) * nextState.zoom.value;
      if (gesture.phase === "begin" || !machine.active) {
        streamHasPage = overlapsPage;
      }
      streamHasPage ||= overlapsPage;
      if (!streamHasPage) {
        machine.cancel();
      }
      const create = machine.update(
        streamHasPage || gesture.phase === "end"
          ? gesture
          : { ...gesture, phase: "cancel" },
        pastEnd,
        ownerWindow.performance.now(),
      );
      setPull({
        progress: machine.progress,
        armed: machine.armed,
      });
      if (create) {
        const next = appendPaperPage(api.getSceneElementsIncludingDeleted());
        if (next) {
          api.updateScene({
            elements: next.elements,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
        }
      }
      if (
        gesture.source === "wheel" &&
        (gesture.phase === "move" || gesture.phase === "cancel")
      ) {
        timer = ownerWindow.setTimeout(() => {
          const currentState = api.getAppState();
          const unchanged =
            currentState.scrollY === lastState.scrollY &&
            currentState.zoom.value === lastState.zoom.value &&
            !currentState.editingTextElement;
          if (!unchanged) {
            machine.cancel();
          }
          handle({ source: "wheel", phase: "end", deltaY: 0 }, currentState);
        }, WHEEL_PAGE_IDLE);
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
      ownerWindow.clearTimeout(timer);
      ownerWindow.removeEventListener("blur", cancel);
      ownerWindow.removeEventListener("pointerdown", cancel, true);
      ownerWindow.removeEventListener("keydown", cancel, true);
      cancelGesture.current = null;
      register(null);
      machine.cancel();
      setPull({ progress: 0, armed: false });
    };
  }, [api, visible, canAppend, register]);

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
      </nav>
    </div>
  );
};
