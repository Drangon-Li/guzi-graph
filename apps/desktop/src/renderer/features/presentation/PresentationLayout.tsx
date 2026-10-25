import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { isInputLike, KEYS, matchKey } from "@excalidraw/common";

import {
  PinIcon,
  PlusIcon,
  chevronDownIcon,
  downloadIcon,
  fullscreenIcon,
  playerPlayIcon,
} from "@excalidraw/excalidraw/components/icons";

import { ProjectContextMenu } from "../projects/ProjectContextMenu";

import { renderSlideSvg } from "./renderSlide";

import "./Presentation.scss";

import type { ReactNode } from "react";
import type { Presentation, PresentationSlide } from "./model";
import type { PresentationController } from "./control";

type Props = {
  presentation: Presentation;
  activeSlideId: string;
  revision: number;
  active: boolean;
  blocked: boolean;
  language: "zh-CN" | "en";
  theme?: "light" | "dark";
  onSelect: (id: string) => void;
  onAdd: () => void;
  onCopy: (id: string) => string | null;
  onPaste: (content: string) => void;
  onCanvasPaste: (event: ClipboardEvent) => void;
  onHistory: (direction: "undo" | "redo") => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onExportPdf: () => void;
  onFit?: () => void;
  onPresent?: (presenting: boolean) => void;
  onController?: (controller: PresentationController | null) => void;
  beforePresent: () => void;
  children: ReactNode;
};

const SlidePreview = ({
  slide,
  width,
  height,
  revision,
  failedLabel,
  immediate = false,
  darkMode = false,
}: {
  slide: PresentationSlide;
  width: number;
  height: number;
  revision: number;
  failedLabel: string;
  immediate?: boolean;
  darkMode?: boolean;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const { id, title, scene, bounds } = slide;
  useEffect(() => {
    const node = container.current!;
    const ownerWindow = node.ownerDocument.defaultView!;
    let cancelled = false;
    setFailed(false);
    if (immediate) {
      node.replaceChildren();
    }
    const timer = ownerWindow.setTimeout(
      () => {
        void renderSlideSvg(
          { id, title, scene, bounds },
          width,
          height,
          node.ownerDocument,
          darkMode,
        ).then(
          (svg) => {
            if (!cancelled) {
              node.replaceChildren(svg);
            }
          },
          () => !cancelled && setFailed(true),
        );
      },
      immediate ? 0 : 180,
    );
    return () => {
      cancelled = true;
      ownerWindow.clearTimeout(timer);
    };
  }, [id, title, scene, bounds, width, height, revision, immediate, darkMode]);
  return (
    <div
      className="desktop-slide-preview"
      style={{ aspectRatio: `${width}/${height}` }}
    >
      <div ref={container} aria-hidden="true" />
      {failed && <span role="status">{failedLabel}</span>}
    </div>
  );
};

type Session = {
  slides: PresentationSlide[];
  width: number;
  height: number;
  restoreFocus: HTMLElement | null;
  fullscreenTarget: HTMLElement | null;
  enteredFullscreen: boolean;
};

const PINNED_STORAGE_KEY = "guzi.presentation.filmstrip.pinned";

const waitForFullscreenTransition = (
  ownerDocument: Document,
  transition: Promise<void>,
  reachedState: () => boolean,
): Promise<void> => {
  if (reachedState()) {
    return Promise.resolve();
  }
  const ownerWindow = ownerDocument.defaultView!;
  return new Promise((resolve) => {
    const finish = () => {
      ownerWindow.clearTimeout(timer);
      ownerDocument.removeEventListener("fullscreenchange", onChange);
      resolve();
    };
    const onChange = () => {
      if (reachedState()) {
        finish();
      }
    };
    // Electron can leave the Fullscreen API promise pending after the UI changes.
    const timer = ownerWindow.setTimeout(finish, 1000);
    ownerDocument.addEventListener("fullscreenchange", onChange);
    void transition.then(finish, finish);
  });
};

export const PresentationLayout = (props: Props) => {
  const {
    presentation,
    activeSlideId,
    revision,
    active,
    blocked,
    language,
    theme = "light",
    children,
  } = props;
  const t = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const root = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const slideList = useRef<HTMLOListElement>(null);
  const dragPreview = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const initialSlideIds = useRef(
    new Set(presentation.slides.map((slide) => slide.id)),
  );
  const presentMenuButton = useRef<HTMLButtonElement>(null);
  const filmstripId = useId();
  const presentMenuId = useId();
  const [presentMenu, setPresentMenu] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const restoreSlideFocus = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    slideId: string | null;
    anchor: HTMLButtonElement;
    left: number;
    top: number;
  } | null>(null);
  const dragging = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
    source: HTMLLIElement;
    moved: boolean;
    toIndex: number | null;
  } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const suppressSlideClick = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [page, setPage] = useState(0);
  const committed = useRef({ session, page });
  const fullscreenRequest = useRef<Promise<void>>(Promise.resolve());
  const fullscreenExit = useRef<Promise<void>>(Promise.resolve());
  const fullscreenTarget = useRef<HTMLElement | null>(null);
  const execute = useRef<PresentationController["execute"]>(async () => {
    throw new Error("演示控制器尚未就绪。");
  });
  const [fullscreenError, setFullscreenError] = useState(false);
  const disabled = blocked || !active;
  const currentIndex = presentation.slides.findIndex(
    (slide) => slide.id === activeSlideId,
  );
  const draggedIndex = presentation.slides.findIndex(
    (slide) => slide.id === draggedId,
  );
  const expanded =
    pinned ||
    hovered ||
    keyboardFocus ||
    !!renaming ||
    !!contextMenu ||
    dragActive;

  useLayoutEffect(() => {
    committed.current = { session, page };
  }, [session, page]);

  useLayoutEffect(() => {
    const onController = props.onController;
    onController?.({ execute: (command) => execute.current(command) });
    return () => onController?.(null);
  }, [props.onController]);

  useLayoutEffect(() => {
    const ownerDocument = root.current!.ownerDocument;
    const onFullscreenChange = () => {
      if (
        fullscreenTarget.current &&
        ownerDocument.fullscreenElement === fullscreenTarget.current &&
        !sessionRef.current
      ) {
        fullscreenExit.current = ownerDocument.exitFullscreen().catch(() => {});
      }
    };
    ownerDocument.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      ownerDocument.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const resetDrag = useCallback(() => {
    dragging.current = null;
    dragPreview.current?.replaceChildren();
    setDragActive(false);
    setDraggedId(null);
    setDropIndex(null);
  }, []);

  useLayoutEffect(() => {
    if (disabled || session) {
      resetDrag();
      setPresentMenu(null);
      setContextMenu(null);
    }
  }, [disabled, session, resetDrag]);

  useEffect(() => {
    if (!dragActive) {
      return;
    }
    const ownerWindow = root.current!.ownerDocument.defaultView!;
    const cancel = () => {
      suppressSlideClick.current = !!dragging.current?.moved;
      resetDrag();
    };
    ownerWindow.addEventListener("blur", cancel);
    return () => ownerWindow.removeEventListener("blur", cancel);
  }, [dragActive, resetDrag]);

  useLayoutEffect(() => {
    if (active) {
      const ownerWindow = root.current!.ownerDocument.defaultView!;
      setPinned(
        ownerWindow.localStorage.getItem(PINNED_STORAGE_KEY) !== "false",
      );
    }
  }, [active]);

  useLayoutEffect(() => {
    const list = slideList.current;
    const item = list?.querySelector<HTMLElement>(
      ".desktop-slide-item.is-active",
    );
    if (!expanded || !list || !item || contextMenu) {
      return;
    }
    const bounds = list.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    if (itemBounds.left < bounds.left) {
      list.scrollLeft -= bounds.left - itemBounds.left;
    } else if (itemBounds.right > bounds.right) {
      list.scrollLeft += itemBounds.right - bounds.right;
    }
  }, [activeSlideId, expanded, contextMenu, presentation.slides.length]);

  useLayoutEffect(() => {
    if (renaming) {
      renameInput.current?.focus();
      renameInput.current?.select();
    } else if (
      restoreSlideFocus.current ||
      slideList.current?.contains(root.current!.ownerDocument.activeElement)
    ) {
      slideList.current
        ?.querySelector<HTMLButtonElement>(
          ".desktop-slide-item.is-active .desktop-slide-select",
        )
        ?.focus({ preventScroll: true });
      restoreSlideFocus.current = false;
    }
  }, [renaming, activeSlideId]);

  const finish = () => {
    if (sessionRef.current) {
      sessionRef.current = null;
      latest.current.onPresent?.(false);
    }
    setSession(null);
  };

  useLayoutEffect(() => {
    if (!session) {
      return;
    }
    const ownerDocument = root.current!.ownerDocument;
    const leaveFullscreen = () => {
      if (
        session.fullscreenTarget &&
        ownerDocument.fullscreenElement === session.fullscreenTarget
      ) {
        fullscreenExit.current = ownerDocument.exitFullscreen().catch(() => {});
      }
    };
    const dispose = () => {
      if (sessionRef.current === session) {
        sessionRef.current = null;
        latest.current.onPresent?.(false);
      }
      leaveFullscreen();
      if (session.restoreFocus?.isConnected) {
        session.restoreFocus.focus({ preventScroll: true });
      }
    };
    if (!active || blocked) {
      setSession(null);
      dispose();
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "")
      ) {
        return;
      }
      event.stopImmediatePropagation();
      if (event.type !== "keydown") {
        return;
      }
      if (
        event.key !== "Tab" &&
        !(event.key === "Enter" && target?.tagName === "BUTTON")
      ) {
        event.preventDefault();
      }
      if (event.key === "Tab") {
        const controls = overlay.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (
          event.shiftKey &&
          (target === first || target === overlay.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && target === last) {
          event.preventDefault();
          first?.focus();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish();
      } else if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
          event.preventDefault();
          setPage((value) => Math.min(session.slides.length - 1, value + 1));
        } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
          event.preventDefault();
          setPage((value) => Math.max(0, value - 1));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          setPage(event.key === "Home" ? 0 : session.slides.length - 1);
        }
      }
    };
    const onFullscreenChange = () => {
      if (
        session.fullscreenTarget &&
        ownerDocument.fullscreenElement === session.fullscreenTarget
      ) {
        session.enteredFullscreen = true;
      } else if (
        session.enteredFullscreen &&
        !ownerDocument.fullscreenElement
      ) {
        finish();
      }
    };
    ownerDocument.addEventListener("keydown", onKey, true);
    ownerDocument.addEventListener("keyup", onKey, true);
    ownerDocument.addEventListener("keypress", onKey, true);
    ownerDocument.addEventListener("fullscreenchange", onFullscreenChange);
    overlay.current?.focus({ preventScroll: true });
    return () => {
      ownerDocument.removeEventListener("keydown", onKey, true);
      ownerDocument.removeEventListener("keyup", onKey, true);
      ownerDocument.removeEventListener("keypress", onKey, true);
      ownerDocument.removeEventListener("fullscreenchange", onFullscreenChange);
      dispose();
    };
  }, [session, active, blocked]);

  const present = (index: number) => {
    if (disabled || !presentation.slides.length) {
      return;
    }
    latest.current.beforePresent();
    fullscreenRequest.current = Promise.resolve();
    const ownerDocument = root.current!.ownerDocument;
    const nextSession: Session = {
      // Freeze the scene before asynchronous SVG rendering starts.
      slides: JSON.parse(JSON.stringify(latest.current.presentation.slides)),
      width: presentation.width,
      height: presentation.height,
      restoreFocus: ownerDocument.activeElement as HTMLElement | null,
      fullscreenTarget: null,
      enteredFullscreen: false,
    };
    sessionRef.current = nextSession;
    setPage(Math.max(0, index));
    setFullscreenError(false);
    setSession(nextSession);
    latest.current.onPresent?.(true);
    const target = ownerDocument.documentElement;
    if (!ownerDocument.fullscreenElement && target.requestFullscreen) {
      nextSession.fullscreenTarget = target;
      fullscreenTarget.current = target;
      try {
        fullscreenRequest.current = target
          .requestFullscreen()
          .then(async () => {
            if (
              !sessionRef.current &&
              ownerDocument.fullscreenElement === target
            ) {
              fullscreenExit.current = ownerDocument
                .exitFullscreen()
                .catch(() => {});
              await fullscreenExit.current;
            }
          })
          .catch(() => {
            if (sessionRef.current === nextSession) {
              setFullscreenError(true);
            }
          });
      } catch {
        setFullscreenError(true);
      }
    } else if (!ownerDocument.fullscreenElement) {
      setFullscreenError(true);
    }
  };

  execute.current = async ({ action, slideId }) => {
    const node = root.current;
    if (!node) {
      throw new Error("演示控制器已卸载。");
    }
    const ownerDocument = node.ownerDocument;
    const current = latest.current;
    if (
      action !== "status" &&
      action !== "stop" &&
      (!current.active || current.blocked)
    ) {
      throw new Error("演示文稿当前不可操作。");
    }
    if (action === "start") {
      const slides = sessionRef.current?.slides ?? current.presentation.slides;
      const index = slides.findIndex(
        (slide) => slide.id === (slideId ?? current.activeSlideId),
      );
      if (index < 0) {
        throw new Error("找不到要放映的幻灯片。");
      }
      flushSync(() => {
        if (sessionRef.current) {
          setPage(index);
        } else {
          present(index);
        }
      });
      await waitForFullscreenTransition(
        ownerDocument,
        fullscreenRequest.current,
        () => !!ownerDocument.fullscreenElement,
      );
    } else if (action === "stop") {
      const playing = sessionRef.current;
      const target = playing?.fullscreenTarget ?? fullscreenTarget.current;
      flushSync(finish);
      if (!playing && target && ownerDocument.fullscreenElement === target) {
        fullscreenExit.current = ownerDocument.exitFullscreen().catch(() => {});
      }
      await waitForFullscreenTransition(
        ownerDocument,
        fullscreenExit.current,
        () => !target || ownerDocument.fullscreenElement !== target,
      );
      if (target && ownerDocument.fullscreenElement === target) {
        throw new Error("无法退出演示全屏。");
      }
    } else if (action !== "status") {
      const playing = committed.current;
      if (!playing.session) {
        throw new Error("演示尚未开始。");
      }
      let index = playing.page;
      if (action === "goto") {
        index = playing.session.slides.findIndex(
          (slide) => slide.id === slideId,
        );
        if (index < 0) {
          throw new Error("请指定有效的幻灯片 ID。");
        }
      } else if (action === "next") {
        index = Math.min(playing.session.slides.length - 1, index + 1);
      } else if (action === "previous") {
        index = Math.max(0, index - 1);
      }
      flushSync(() => setPage(index));
    }
    const playing = committed.current;
    const slides =
      playing.session?.slides ?? latest.current.presentation.slides;
    const index = playing.session
      ? playing.page
      : slides.findIndex((slide) => slide.id === latest.current.activeSlideId);
    return {
      presenting: !!playing.session,
      slideId: slides[index]?.id ?? null,
      index,
      slideCount: slides.length,
      fullscreen: !!ownerDocument.fullscreenElement,
    };
  };

  const rename = (slide: PresentationSlide) => {
    setTitle(slide.title);
    setRenaming(slide.id);
  };
  const saveTitle = () => {
    if (renaming) {
      const id = renaming;
      setRenaming(null);
      if (title.trim()) {
        props.onRename(id, title.trim());
      }
    }
  };
  const closeContextMenu = (restoreFocus = false) => {
    if (restoreFocus) {
      contextMenu?.anchor.focus({ preventScroll: true });
    }
    setContextMenu(null);
  };
  const openPresentMenu = () => {
    const bounds = presentMenuButton.current!.getBoundingClientRect();
    setPresentMenu({ left: bounds.left, top: bounds.bottom + 6 });
  };
  const closePresentMenu = (restoreFocus = false) => {
    if (restoreFocus) {
      presentMenuButton.current?.focus({ preventScroll: true });
    }
    setPresentMenu(null);
  };
  const deleteSlide = (id: string) => {
    if (presentation.slides.length > 1) {
      restoreSlideFocus.current = true;
      props.onDelete(id);
    }
  };
  const menuSlide = presentation.slides.find(
    (slide) => slide.id === contextMenu?.slideId,
  );
  const selectSlide = (id: string, button: HTMLButtonElement) => {
    if (disabled) {
      return;
    }
    if (suppressSlideClick.current) {
      suppressSlideClick.current = false;
      return;
    }
    props.onSelect(id);
    button.focus({ preventScroll: true });
  };
  const addSlide = () => {
    setKeyboardFocus(true);
    restoreSlideFocus.current = true;
    props.onAdd();
  };

  return (
    <div
      className="desktop-presentation"
      ref={root}
      inert={session ? true : undefined}
      onKeyDown={(event) => {
        if (contextMenu || presentMenu) {
          event.stopPropagation();
        }
      }}
    >
      <div
        className="desktop-presentation-toolbar"
        role="toolbar"
        aria-label={t("演示文稿", "Presentation")}
      >
        <div className="desktop-presentation-controls">
          <button
            className="desktop-presentation-start"
            disabled={disabled}
            title={t("从当前页放映", "Present current slide")}
            onClick={() => present(currentIndex)}
          >
            <span className="desktop-presentation-icon" aria-hidden="true">
              {playerPlayIcon}
            </span>
            {t("放映", "Present")}
          </button>
          <button
            ref={presentMenuButton}
            className="desktop-presentation-options"
            disabled={disabled}
            aria-label={t("放映选项", "Presentation options")}
            title={t("放映选项", "Presentation options")}
            aria-haspopup="menu"
            aria-expanded={!!presentMenu}
            aria-controls={presentMenu ? presentMenuId : undefined}
            onClick={() =>
              presentMenu ? closePresentMenu() : openPresentMenu()
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                openPresentMenu();
              }
            }}
          >
            <span
              className="desktop-presentation-icon desktop-presentation-chevron"
              aria-hidden="true"
            >
              {chevronDownIcon}
            </span>
          </button>
        </div>
        {props.onFit && (
          <button
            className="desktop-presentation-fit"
            disabled={disabled}
            onClick={props.onFit}
            aria-label={t("适应页面", "Fit page")}
            title={t("适应页面", "Fit page")}
          >
            <span className="desktop-presentation-icon" aria-hidden="true">
              {fullscreenIcon}
            </span>
          </button>
        )}
        <div className="desktop-presentation-toolbar-spacer" />
        <button
          disabled={disabled}
          onClick={props.onExportPdf}
          aria-label={t("导出 PDF", "Export PDF")}
          title={t("导出 PDF", "Export PDF")}
        >
          <span className="desktop-presentation-icon" aria-hidden="true">
            {downloadIcon}
          </span>
          PDF
        </button>
      </div>
      <div className="desktop-presentation-body">
        <div
          className="desktop-presentation-editor"
          aria-hidden={session ? true : undefined}
          inert={session ? true : undefined}
        >
          {children}
        </div>
        <div
          className={`desktop-presentation-dock${
            pinned ? " is-pinned" : " is-autohide"
          }${expanded ? " is-expanded" : " is-collapsed"}`}
        >
          <aside
            className="desktop-presentation-filmstrip"
            aria-label={t("幻灯片", "Slides")}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocusCapture={(event) => {
              if (event.target.matches(":focus-visible")) {
                setKeyboardFocus(true);
              }
            }}
            onPointerDownCapture={() => setKeyboardFocus(false)}
            onBlurCapture={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setKeyboardFocus(false);
              }
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (
                !disabled &&
                !renaming &&
                !event.defaultPrevented &&
                !event.nativeEvent.isComposing &&
                !isInputLike(event.target) &&
                event[KEYS.CTRL_OR_CMD] &&
                !event.altKey &&
                (matchKey(event, KEYS.Z) ||
                  (!event.shiftKey && matchKey(event, KEYS.Y)))
              ) {
                event.preventDefault();
                const filmstrip = event.currentTarget;
                props.onHistory(
                  event.shiftKey || matchKey(event, KEYS.Y) ? "redo" : "undo",
                );
                filmstrip.ownerDocument.defaultView!.queueMicrotask(() =>
                  filmstrip
                    .querySelector<HTMLButtonElement>(
                      ".desktop-slide-item.is-active .desktop-slide-select",
                    )
                    ?.focus({ preventScroll: true }),
                );
                return;
              }
              if (event.key === "Escape" && dragging.current) {
                event.preventDefault();
                suppressSlideClick.current = dragging.current.moved;
                resetDrag();
              }
            }}
            onKeyUp={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              if (disabled || renaming) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                slideId: null,
                anchor: addButton.current!,
                left: event.clientX,
                top: event.clientY,
              });
            }}
          >
            <div className="desktop-presentation-filmstrip-header">
              <button
                className="desktop-filmstrip-reveal"
                aria-label={t("幻灯片栏", "Slide strip")}
                aria-expanded={expanded}
                aria-controls={filmstripId}
                disabled={disabled}
                onClick={() => setHovered(true)}
              >
                {t("幻灯片", "Slides")} · {presentation.slides.length}
                {!pinned && (
                  <span aria-hidden="true">{expanded ? "▾" : "▴"}</span>
                )}
              </button>
              <div className="desktop-filmstrip-actions desktop-filmstrip-actions-start">
                <button
                  ref={addButton}
                  className="desktop-filmstrip-add"
                  disabled={disabled}
                  onClick={addSlide}
                  aria-label={t("新建页面", "Add slide")}
                  title={t("新建页面", "Add slide")}
                >
                  <span aria-hidden="true">{PlusIcon}</span>
                </button>
              </div>
              <div className="desktop-filmstrip-actions">
                <button
                  disabled={disabled}
                  aria-label={t("固定缩略图栏", "Pin slide strip")}
                  aria-pressed={pinned}
                  title={
                    pinned
                      ? t("切换为自动收起", "Switch to auto-hide")
                      : t("固定显示缩略图栏", "Keep the slide strip visible")
                  }
                  onClick={() => {
                    const next = !pinned;
                    setPinned(next);
                    root.current!.ownerDocument.defaultView!.localStorage.setItem(
                      PINNED_STORAGE_KEY,
                      String(next),
                    );
                  }}
                >
                  <span aria-hidden="true">{PinIcon}</span>
                </button>
              </div>
            </div>
            <ol
              id={filmstripId}
              className={`desktop-slide-list${draggedId ? " is-dragging" : ""}`}
              ref={slideList}
              aria-hidden={!expanded}
              inert={!expanded ? true : undefined}
              onPointerMove={(event) => {
                const drag = dragging.current;
                if (!drag || drag.pointerId !== event.pointerId || disabled) {
                  return;
                }
                if (
                  !drag.moved &&
                  Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5
                ) {
                  return;
                }
                const preview = dragPreview.current!;
                if (!drag.moved) {
                  drag.moved = true;
                  preview.replaceChildren(drag.source.cloneNode(true));
                  preview.style.width = `${drag.width}px`;
                  setDraggedId(drag.id);
                }
                preview.style.transform = `translate3d(${
                  event.clientX - drag.offsetX
                }px, ${event.clientY - drag.offsetY - 6}px, 0)`;
                const list = event.currentTarget;
                const bounds = list.getBoundingClientRect();
                if (event.clientX < bounds.left + 24) {
                  list.scrollLeft -= 16;
                } else if (event.clientX > bounds.right - 24) {
                  list.scrollLeft += 16;
                }
                const index = Array.from(list.children).findIndex((item) => {
                  const rect = item.getBoundingClientRect();
                  return (
                    event.clientX >= rect.left &&
                    event.clientX <= rect.right &&
                    event.clientY >= rect.top &&
                    event.clientY <= rect.bottom
                  );
                });
                drag.toIndex = index < 0 ? null : index;
                setDropIndex(drag.toIndex);
              }}
              onPointerUp={(event) => {
                const drag = dragging.current;
                if (!drag || drag.pointerId !== event.pointerId) {
                  return;
                }
                resetDrag();
                suppressSlideClick.current = drag.moved;
                if (!disabled && drag.moved && drag.toIndex !== null) {
                  props.onMove(drag.id, drag.toIndex);
                }
              }}
              onLostPointerCapture={resetDrag}
              onPointerCancel={() => {
                resetDrag();
                suppressSlideClick.current = false;
              }}
              onDragStart={(event) => event.preventDefault()}
            >
              {presentation.slides.map((slide, index) => (
                <li
                  key={slide.id}
                  className={`desktop-slide-item${
                    slide.id === activeSlideId ? " is-active" : ""
                  }${!initialSlideIds.current.has(slide.id) ? " is-new" : ""}${
                    slide.id === draggedId ? " is-dragging" : ""
                  }${
                    dropIndex === index && index !== draggedIndex
                      ? ` is-drop-target${
                          index > draggedIndex ? " is-drop-after" : ""
                        }`
                      : ""
                  }`}
                  onPointerDown={(event) => {
                    if (disabled || renaming || event.button !== 0) {
                      return;
                    }
                    const button = (
                      event.target as HTMLElement
                    ).closest<HTMLButtonElement>(
                      ".desktop-slide-select, .desktop-slide-title",
                    );
                    if (!button) {
                      return;
                    }
                    suppressSlideClick.current = false;
                    setDragActive(true);
                    const bounds = event.currentTarget.getBoundingClientRect();
                    dragging.current = {
                      id: slide.id,
                      pointerId: event.pointerId,
                      x: event.clientX,
                      y: event.clientY,
                      offsetX: event.clientX - bounds.left,
                      offsetY: event.clientY - bounds.top,
                      width: bounds.width,
                      source: event.currentTarget,
                      moved: false,
                      toIndex: null,
                    };
                    button.setPointerCapture(event.pointerId);
                  }}
                  onContextMenu={(event) => {
                    if (disabled || renaming) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const anchor =
                      event.currentTarget.querySelector<HTMLButtonElement>(
                        ".desktop-slide-select",
                      )!;
                    anchor.focus({ preventScroll: true });
                    props.onSelect(slide.id);
                    setContextMenu({
                      slideId: slide.id,
                      anchor,
                      left: event.clientX,
                      top: event.clientY,
                    });
                  }}
                  onCopy={(event) => {
                    if (
                      disabled ||
                      renaming ||
                      !event.currentTarget.contains(
                        event.currentTarget.ownerDocument.activeElement,
                      )
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const focused = event.currentTarget.ownerDocument
                      .activeElement as HTMLElement;
                    const content = props.onCopy(slide.id);
                    focused.focus({ preventScroll: true });
                    if (content) {
                      event.clipboardData.setData("text/plain", content);
                    }
                  }}
                  onPaste={(event) => {
                    if (
                      disabled ||
                      renaming ||
                      !event.currentTarget.contains(
                        event.currentTarget.ownerDocument.activeElement,
                      )
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const content = event.clipboardData.getData("text/plain");
                    let isPresentation = false;
                    try {
                      isPresentation =
                        JSON.parse(content)?.type === "guzi-presentation";
                    } catch {}
                    if (isPresentation) {
                      props.onPaste(content);
                    } else {
                      props.onCanvasPaste(event.nativeEvent);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      !disabled &&
                      !renaming &&
                      !contextMenu &&
                      !dragging.current &&
                      !event.defaultPrevented &&
                      !event.nativeEvent.isComposing &&
                      !isInputLike(event.target) &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.shiftKey &&
                      (event.key === "ArrowLeft" || event.key === "ArrowRight")
                    ) {
                      event.preventDefault();
                      setKeyboardFocus(true);
                      const nextIndex =
                        index + (event.key === "ArrowRight" ? 1 : -1);
                      const nextSlide = presentation.slides[nextIndex];
                      if (nextSlide) {
                        props.onSelect(nextSlide.id);
                        slideList
                          .current!.children[
                            nextIndex
                          ].querySelector<HTMLButtonElement>(
                            ".desktop-slide-select",
                          )!
                          .focus({ preventScroll: true });
                      }
                      return;
                    }
                    if (
                      !disabled &&
                      !renaming &&
                      !event.nativeEvent.isComposing &&
                      (event.key === "Delete" || event.key === "Backspace")
                    ) {
                      event.preventDefault();
                      deleteSlide(slide.id);
                    }
                  }}
                >
                  <button
                    className="desktop-slide-select"
                    aria-label={`${t("选择幻灯片", "Select slide")} ${
                      index + 1
                    }: ${slide.title}`}
                    aria-current={
                      slide.id === activeSlideId ? "page" : undefined
                    }
                    disabled={disabled}
                    aria-keyshortcuts="ArrowLeft ArrowRight"
                    title={t(
                      "← → 切换页面 · 拖拽排序 · 右键操作",
                      "← → Switch slides · Drag to reorder · Right-click for actions",
                    )}
                    onClick={(event) =>
                      selectSlide(slide.id, event.currentTarget)
                    }
                  >
                    <span className="desktop-slide-number">{index + 1}</span>
                    <SlidePreview
                      slide={slide}
                      width={presentation.width}
                      height={presentation.height}
                      revision={slide.id === activeSlideId ? revision : 0}
                      failedLabel={t("预览不可用", "Preview unavailable")}
                      darkMode={theme === "dark"}
                    />
                  </button>
                  {renaming === slide.id ? (
                    <input
                      ref={renameInput}
                      aria-label={t("幻灯片名称", "Slide title")}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      onBlur={saveTitle}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.nativeEvent.isComposing) {
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          restoreSlideFocus.current = true;
                          saveTitle();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          restoreSlideFocus.current = true;
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="desktop-slide-title"
                      disabled={disabled}
                      title={t("双击重命名", "Double-click to rename")}
                      onClick={(event) =>
                        selectSlide(slide.id, event.currentTarget)
                      }
                      onDoubleClick={() => rename(slide)}
                    >
                      {slide.title}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </div>
      <div
        className="desktop-slide-drag-preview"
        ref={dragPreview}
        aria-hidden="true"
        inert
        hidden={!draggedId}
      />
      {presentMenu && !disabled && !session && root.current && (
        <ProjectContextMenu
          id={presentMenuId}
          root={root.current}
          anchor={presentMenuButton.current!}
          label={t("放映", "Present")}
          left={presentMenu.left}
          top={presentMenu.top}
          align="start"
          items={[
            {
              label: t("从头放映", "Present from start"),
              onSelect: () => present(0),
            },
          ]}
          onClose={closePresentMenu}
        />
      )}
      {contextMenu && !disabled && !session && root.current && (
        <ProjectContextMenu
          id="desktop-slide-context-menu"
          root={root.current}
          anchor={contextMenu.anchor}
          label={t("幻灯片操作", "Slide actions")}
          left={contextMenu.left}
          top={contextMenu.top}
          align="start"
          items={[
            ...(menuSlide
              ? [
                  {
                    label: t("改名", "Rename"),
                    onSelect: () => rename(menuSlide),
                  },
                  {
                    label: t("删除", "Delete"),
                    danger: true,
                    disabled: presentation.slides.length === 1,
                    onSelect: () => deleteSlide(menuSlide.id),
                  },
                ]
              : []),
            {
              label: t("新建页面", "New slide"),
              separatorBefore: !!menuSlide,
              onSelect: addSlide,
            },
            ...(!menuSlide
              ? [
                  {
                    label: t("从头放映", "Present from start"),
                    onSelect: () => present(0),
                  },
                ]
              : []),
          ]}
          onClose={closeContextMenu}
        />
      )}
      {session &&
        active &&
        !blocked &&
        root.current &&
        createPortal(
          <div
            className="desktop-presentation-player"
            ref={overlay}
            role="dialog"
            aria-modal="true"
            aria-label={t("幻灯片放映", "Slide show")}
            tabIndex={-1}
          >
            <div
              className="desktop-presentation-stage"
              style={{
                aspectRatio: `${session.width}/${session.height}`,
                width: `min(100vw, calc(100vh * ${
                  session.width / session.height
                }))`,
              }}
            >
              <SlidePreview
                slide={session.slides[page]}
                width={session.width}
                height={session.height}
                revision={0}
                immediate
                failedLabel={t("此页无法显示", "Unable to display this slide")}
              />
            </div>
            {fullscreenError && (
              <div
                className="desktop-presentation-fullscreen-hint"
                role="status"
              >
                {t(
                  "无法进入全屏，正在窗口内放映",
                  "Fullscreen unavailable. Presenting in this window.",
                )}
              </div>
            )}
            <div className="desktop-presentation-player-controls">
              <button
                aria-label={t("上一页", "Previous slide")}
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                ←
              </button>
              <span role="status" aria-live="polite">
                {page + 1} / {session.slides.length}
              </span>
              <button
                aria-label={t("下一页", "Next slide")}
                disabled={page === session.slides.length - 1}
                onClick={() =>
                  setPage((value) =>
                    Math.min(session.slides.length - 1, value + 1),
                  )
                }
              >
                →
              </button>
              <button onClick={finish}>
                {t("退出放映", "Exit slide show")}
              </button>
            </div>
          </div>,
          root.current.ownerDocument.body,
        )}
    </div>
  );
};
