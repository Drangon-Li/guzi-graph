import {
  debounce,
  easeOut,
  isBounds,
  type Bounds,
  type StylesPanelMode,
} from "@excalidraw/common";
import { clamp } from "@excalidraw/math";

import {
  getCommonBounds,
  getElementsInGroup,
  isElementLink,
  isExcalidrawElement,
  parseElementLinkFromURL,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeleted,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { getLanguage, t } from "../i18n";
import {
  AnimationController,
  type AnimationKey,
  type AnimationScheduler,
} from "../renderer/animation";
import {
  constrainScrollState,
  DEFAULT_OVERSCROLL,
  getDistancePastEnd,
  getElasticOverscrollY,
  panViewportWithinConstraints,
  type SetViewportOptions,
  type SetViewportRect,
  zoomToFitBounds,
} from "../viewport";

import {
  PaperMotionSamples,
  stepPaperSpring,
  type PaperSpringAxis,
} from "./App.viewportPaper";

import type {
  AppProps,
  AppState,
  NormalizedZoomValue,
  Offsets,
  ScrollConstraints,
  ViewportOffsets,
  ViewportOffsetsOptions,
  ViewportGesture,
  ViewportUIDock,
  ViewportUIName,
} from "../types";
import type App from "./App";

/** The AnimationController keys a viewport uses, unique per AppViewport so
 * concurrent editors in the same window never share (or cancel) each
 * other's animations. */
export type ViewportAnimationKeys = {
  scrollToContent: AnimationKey;
  snapBack: AnimationKey;
};

const DEFAULT_SCROLL_ANIMATION_DURATION = 500;

/** rubberband snap-back animation duration, in ms — kept snappier than the
 * default scroll animation so releasing an overscroll feels responsive */
const SNAP_BACK_ANIMATION_DURATION = 250;
const SCROLL_CONSTRAINTS_TRANSITION_DURATION = 260;

/** how long after the last pan/zoom we animate the rubberband back into the
 * scroll constraints box */
const SCROLL_CONSTRAINTS_SNAP_BACK_DELAY = 200;

/** single source of truth for the `--right-sidebar-width` CSS variable */
export const RIGHT_SIDEBAR_WIDTH = 302;

/**
 * Approximate styles panel footprints (panel width + editor edge inset),
 * used by `getOffsets` to reserve space for the panel before it was ever
 * rendered (= measured). Keep roughly in sync with the CSS
 * (`.App-menu__left` width / `.compact-shape-actions-island` min-width +
 * `--editor-container-padding`).
 */
const STYLES_PANEL_APPROX_WIDTH = { full: 216, compact: 64 };

type Viewport = Pick<AppState, "scrollX" | "scrollY" | "zoom">;
type SpringAxes = { x: PaperSpringAxis | null; y: PaperSpringAxis | null };
type PaperSpring = { axes: SpringAxes; geometry: AppState };

const sameScrollGeometry = (a: AppState, b: AppState) =>
  a.scrollConstraints === b.scrollConstraints &&
  a.zoom.value === b.zoom.value &&
  a.width === b.width &&
  a.height === b.height;

const isSetViewportRect = (target: unknown): target is SetViewportRect => {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }

  const rect = target as Partial<SetViewportRect>;
  return (
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    (rect.width == null || typeof rect.width === "number") &&
    (rect.height == null || typeof rect.height === "number")
  );
};

const getElementsFromId = (
  id: string,
  elementsMap: NonDeletedSceneElementsMap,
) => {
  const element = elementsMap.get(id);
  if (element) {
    return [element];
  }

  return getElementsInGroup(elementsMap, id);
};

type ResolvedViewportTarget = {
  /** null when the target couldn't be resolved (unknown id/link, or all
   * supplied elements deleted) */
  bounds: Bounds | null;
  /** how the target was specified, so callers can react to unresolved
   * targets themselves (e.g. toast on a broken element link) */
  type: "element" | "area" | "link";
};

/** Resolves a `setViewport` target to a scene-coordinate box. */
const resolveViewportTarget = (
  target: SetViewportOptions["target"],
  elementsMap: NonDeletedSceneElementsMap,
  appState: Pick<AppState, "width" | "height">,
): ResolvedViewportTarget => {
  if (typeof target === "string") {
    const isLink = isElementLink(target);
    const type = isLink ? ("link" as const) : ("element" as const);
    const id = isLink ? parseElementLinkFromURL(target) : target;
    const resolved = id ? getElementsFromId(id, elementsMap) : [];

    if (!resolved.length) {
      return { bounds: null, type };
    }

    return { bounds: getCommonBounds(resolved, elementsMap), type };
  }

  if (isBounds(target)) {
    return { bounds: target, type: "area" };
  }

  if (isSetViewportRect(target) && !isExcalidrawElement(target)) {
    const width = target.width ?? appState.width;
    const height = target.height ?? appState.height;
    return {
      bounds: [target.x, target.y, target.x + width, target.y + height],
      type: "area",
    };
  }

  // widening to null values in case the host app doesn't have
  // noUncheckedIndexedAccess enabled
  const targetElements: (ExcalidrawElement | undefined | null)[] =
    Array.isArray(target) ? target : [target];
  const elements = targetElements.reduce<NonDeleted<ExcalidrawElement>[]>(
    (acc, element) => {
      if (element && !element.isDeleted) {
        const sceneElement = elementsMap.get(element.id);
        if (sceneElement) {
          acc.push(sceneElement);
        }
      }
      return acc;
    },
    [],
  );

  const hasNoElements = !elements.length;
  if (elements.length !== targetElements.length || hasNoElements) {
    console.warn(
      "supplied element target(s) for setViewport contain deleted or non-existent elements which have been filtered out",
    );
  }

  if (hasNoElements) {
    return { bounds: null, type: "element" };
  }

  return { bounds: getCommonBounds(elements, elementsMap), type: "element" };
};

const resolveOverscroll = (
  overscroll: boolean | number | undefined,
): number => {
  if (overscroll === false) {
    return 0;
  }
  if (overscroll === true || overscroll == null) {
    return DEFAULT_OVERSCROLL;
  }
  return Math.max(overscroll, 0);
};

/** Computes the viewport (scroll + zoom) that brings the target box into view,
 * based on the requested fit behavior. */
const getTargetViewport = (
  state: AppState,
  bounds: Bounds,
  fit: SetViewportOptions["fit"] = "scale-down",
  offsets?: Offsets,
): Viewport => {
  const { appState } = zoomToFitBounds({
    bounds,
    appState: state,
    fit,
    canvasOffsets: offsets,
    steppedZoom: false,
  });

  return {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom,
  };
};

/** Computes the viewport patch for landing on `bounds`: the target
 * scroll/zoom, plus the scroll lock to install — or `scrollConstraints: null`
 * to clear a previous lock when none is requested. */
const getConstrainedTargetViewport = (
  appState: AppState,
  bounds: Bounds,
  // NOTE offsets must be resolved (see `AppViewport.resolveOffsets`)
  {
    fit,
    offsets,
    lock,
  }: Pick<SetViewportOptions, "fit" | "lock"> & { offsets?: Offsets },
): Viewport & { scrollConstraints: ScrollConstraints | null } => {
  const viewport = getTargetViewport(appState, bounds, fit, offsets);

  if (!lock?.scroll && !lock?.zoom) {
    return { ...viewport, scrollConstraints: null };
  }

  const [x1, y1, x2, y2] = bounds;
  const scrollConstraints: ScrollConstraints = {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    lockScroll: lock.scroll ?? false,
    lockZoom: !!lock.zoom,
    zoom: viewport.zoom.value,
    overscroll: resolveOverscroll(lock.overscroll),
    offsets,
  };

  return {
    ...constrainScrollState({ ...appState, ...viewport, scrollConstraints }),
    scrollConstraints,
  };
};

/**
 * Interpolates the viewport from `from` to `target` at the (already-eased)
 * blend amount `factor` (0 = `from`, 1 = `target`).
 *
 * Zoom is interpolated geometrically (so it feels uniform), but the pan can't
 * simply lerp alongside it: pairing a geometric zoom with a linear scroll (or
 * a linearly-tweened focal point) makes scene points swoop along curved,
 * non-monotone screen paths once the zoom ratio exceeds ~e (the destination
 * visibly drifts away before converging). Instead we interpolate the view
 * transform affinely — a scene point maps to screen as
 * `(scenePt + scroll) * zoom`, and requiring every point to travel a straight
 * screen line forces `zoom` to be a convex blend `(1-m)*z0 + m*z1` with
 * `scroll * zoom` lerped by that same weight. Deriving `m` from the geometric
 * zoom keeps its pacing while making all screen trajectories straight and
 * monotone.
 */
const interpolateViewport = ({
  from,
  target,
  factor,
}: {
  from: Viewport;
  target: Viewport;
  factor: number;
}): Viewport => {
  if (factor >= 1) {
    // land bit-exactly on the target (`z0 * (z1/z0)^1` can be off by an ulp)
    return { ...target };
  }

  const zoom = (from.zoom.value *
    Math.pow(
      target.zoom.value / from.zoom.value,
      factor,
    )) as NormalizedZoomValue;

  // pan blend weight derived from the zoom blend (0/0 for pure pans, hence
  // the `factor` fallback; near-equal zooms are fine — the ratio limits to
  // `factor` smoothly)
  const m =
    target.zoom.value === from.zoom.value
      ? factor
      : (zoom - from.zoom.value) / (target.zoom.value - from.zoom.value);

  return {
    scrollX:
      ((1 - m) * from.scrollX * from.zoom.value +
        m * target.scrollX * target.zoom.value) /
      zoom,
    scrollY:
      ((1 - m) * from.scrollY * from.zoom.value +
        m * target.scrollY * target.zoom.value) /
      zoom,
    zoom: { value: zoom },
  };
};

type AppViewportDependencies = {
  getContainer: () => HTMLDivElement | null;
  getStylesPanelMode: () => StylesPanelMode;
  isGestureActive: () => boolean;
  isPointerDown: () => boolean;
};

const resolveAnimationDuration = (
  animation: SetViewportOptions["animation"],
): number | null => {
  if (animation === false) {
    return null;
  }
  if (animation === true || animation == null) {
    return DEFAULT_SCROLL_ANIMATION_DURATION;
  }
  return animation.duration ?? DEFAULT_SCROLL_ANIMATION_DURATION;
};

/** Eases the viewport from its current position to `target` over `duration`,
 * driving the transition through the shared AnimationController so it doesn't
 * slow down other processes. */
const animateToViewport = (
  from: Viewport,
  target: Viewport,
  duration: number,
  key: AnimationKey,
  scheduler: AnimationScheduler,
  onFrame: (
    state: Pick<
      AppState,
      "scrollX" | "scrollY" | "zoom" | "shouldCacheIgnoreZoom"
    >,
  ) => void,
  onComplete: () => void,
) => {
  AnimationController.start<{ elapsed: number }>(
    key,
    ({ deltaTime, state }) => {
      const elapsed = (state?.elapsed ?? 0) + deltaTime;
      const progress = Math.min(elapsed / duration, 1);
      const factor = easeOut(clamp(progress, 0, 1));

      if (progress < 1) {
        onFrame({
          ...interpolateViewport({ from, target, factor }),
          shouldCacheIgnoreZoom: true,
        });
        return { elapsed };
      }

      onComplete();

      return null;
    },
    scheduler,
  );
};

/**
 * Rubberband snap-back: animates the viewport from its current (possibly
 * overscrolled) position back inside the lock box via the shared
 * AnimationController. No-op when already within the hard bounds (or when
 * there is no lock).
 */
export const snapBackToConstraints = (
  state: Pick<
    AppState,
    "scrollX" | "scrollY" | "zoom" | "width" | "height" | "scrollConstraints"
  >,
  onFrame: (
    updater: (
      state: Pick<
        AppState,
        | "scrollX"
        | "scrollY"
        | "zoom"
        | "width"
        | "height"
        | "scrollConstraints"
      >,
    ) => Viewport | null,
  ) => void,
  keys: ViewportAnimationKeys,
  scheduler: AnimationScheduler = window,
  duration = SNAP_BACK_ANIMATION_DURATION,
) => {
  const target = constrainScrollState(state);

  if (
    target.scrollX === state.scrollX &&
    target.scrollY === state.scrollY &&
    target.zoom.value === state.zoom.value
  ) {
    return;
  }

  // A programmatic navigation owns the viewport until it settles. A stale
  // rubberband debounce must not supersede it.
  if (AnimationController.running(keys.scrollToContent)) {
    return;
  }

  // Keep the displacement zoom-independent. Each animation frame resolves
  // the resting viewport from the latest state, allowing zoom to update the
  // underlying viewport while the same on-screen rubberband distance decays.
  const overscrollX = (state.scrollX - target.scrollX) * state.zoom.value;
  const overscrollY = (state.scrollY - target.scrollY) * state.zoom.value;

  AnimationController.start<{ elapsed: number }>(
    keys.snapBack,
    ({ deltaTime, state: animationState }) => {
      const elapsed = (animationState?.elapsed ?? 0) + deltaTime;
      const progress = Math.min(elapsed / duration, 1);
      const remaining = 1 - easeOut(clamp(progress, 0, 1));

      onFrame((currentState) => {
        if (!currentState.scrollConstraints) {
          return null;
        }

        const restingViewport = constrainScrollState(currentState);
        const zoom = restingViewport.zoom.value;
        return {
          scrollX: restingViewport.scrollX + (overscrollX * remaining) / zoom,
          scrollY:
            currentState.scrollConstraints.lockScroll === "x"
              ? currentState.scrollY
              : restingViewport.scrollY + (overscrollY * remaining) / zoom,
          zoom: restingViewport.zoom,
        };
      });

      return progress < 1 ? { elapsed } : null;
    },
    scheduler,
  );
};

/**
 * Owns viewport state transitions and App-bound viewport concerns. Pure
 * viewport geometry remains in `viewport.ts` so actions and public helpers can
 * calculate state without an App instance.
 */
export class AppViewport {
  public lastPosition = { x: 0, y: 0 };

  private revealSelectionFrame: number | null = null;
  private selectionRevealPending = false;
  private selectionRevealMountFrames = 0;
  private isRevealingSelection = false;

  private activeTransition: {
    target: Viewport & Pick<AppState, "scrollConstraints">;
  } | null = null;

  private uiLastMeasured = new Map<
    ViewportUIName,
    { side: "left" | "right"; offset: number }
  >();

  /** Unique per instance (see `ViewportAnimationKeys`); exposed for tests
   * observing the animations. */
  readonly scrollToContentAnimationKey = Symbol("scrollToContentAnimation");
  readonly snapBackAnimationKey = Symbol("snapBackAnimation");
  readonly caretFollowAnimationKey = Symbol("caretFollowAnimation");
  readonly scrollConstraintsAnimationKey = Symbol("scrollConstraintsAnimation");
  private constraintTransition: {
    constraint: ScrollConstraints;
    anchorScrollX: number;
  } | null = null;
  private caretFollowTarget: { scrollX: number; scrollY: number } | null = null;
  private caretFollowInterrupt: (() => void) | null = null;
  private paperSpring: PaperSpring | null = null;
  private paperSpringToken = 0;
  private paperMotion = new PaperMotionSamples();
  private paperMotionZoom: number | undefined;

  registerCaretFollow = (onInterrupt: () => void) => {
    this.caretFollowInterrupt = onInterrupt;
    return () => {
      this.cancelCaretFollow();
      if (this.caretFollowInterrupt === onInterrupt) {
        this.caretFollowInterrupt = null;
      }
    };
  };

  cancelCaretFollow = () => {
    this.caretFollowTarget = null;
    AnimationController.cancel(this.caretFollowAnimationKey);
  };

  /** A text edit owns only a short pan, never the zoom or the editing DOM. */
  followCaret = (x: number, y: number) => {
    if (this.activeTransition || this.app.unmounted) {
      return;
    }
    const state = this.app.state;
    this.caretFollowTarget = {
      scrollX: state.scrollX + x / state.zoom.value,
      scrollY: state.scrollY + y / state.zoom.value,
    };
    this.cancelSnapBack();
    this.cancelConstraintTransition();
    AnimationController.cancel(this.caretFollowAnimationKey);
    const reducedMotion = this.app.ownerWindow.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    AnimationController.start<{ elapsed: number }>(
      this.caretFollowAnimationKey,
      ({ deltaTime, state: animationState }) => {
        if (!this.caretFollowTarget || this.app.unmounted) {
          return null;
        }
        const target = this.caretFollowTarget;
        const elapsed = (animationState?.elapsed ?? 0) + deltaTime;
        const blend =
          reducedMotion || elapsed >= 180 ? 1 : 1 - Math.exp(-deltaTime / 40);
        this.app.setState((current) => {
          const next = {
            ...current,
            scrollX:
              current.scrollX + (target.scrollX - current.scrollX) * blend,
            scrollY:
              current.scrollY + (target.scrollY - current.scrollY) * blend,
          };
          const constrained = current.scrollConstraints
            ? constrainScrollState(next, 0)
            : next;
          return { scrollX: constrained.scrollX, scrollY: constrained.scrollY };
        });
        if (blend === 1) {
          this.caretFollowTarget = null;
          return null;
        }
        return { elapsed };
      },
      this.app.ownerWindow,
    );
  };

  constructor(
    private app: App,
    private dependencies: AppViewportDependencies,
  ) {}

  get isAnimating() {
    return (
      AnimationController.running(this.scrollToContentAnimationKey) ||
      AnimationController.running(this.snapBackAnimationKey) ||
      AnimationController.running(this.scrollConstraintsAnimationKey) ||
      AnimationController.running(this.caretFollowAnimationKey)
    );
  }

  /** Whether a programmatic transition into a locked viewport currently owns
   * user pan/zoom input. */
  get isLockedTransitionPending() {
    return (
      !this.isRevealingSelection &&
      !!this.activeTransition?.target.scrollConstraints
    );
  }

  invalidateUIOffset = (name: ViewportUIName) => {
    this.uiLastMeasured.delete(name);
  };

  /**
   * The side a rendered side UI (`data-viewport-ui="side"`) docks to, and
   * how far it reaches into the canvas from it, in screen px.
   */
  private measureSide = (node: HTMLElement, containerRect: DOMRect) => {
    const domRect = node.getBoundingClientRect();
    const left = domRect.left - containerRect.left;
    const right = domRect.right - containerRect.left;
    return left + domRect.width / 2 < this.app.state.width / 2
      ? { side: "left" as const, offset: right }
      : { side: "right" as const, offset: this.app.state.width - left };
  };

  private measureSettledSide = (
    node: HTMLElement,
    containerRect: DOMRect,
  ): { side: "left" | "right"; offset: number } => {
    const { viewportDockSide: side, viewportDockWidth: width } = node.dataset;
    if ((side === "left" || side === "right") && width) {
      const inset = parseFloat(
        this.app.ownerWindow.getComputedStyle(node)[side],
      );
      return { side, offset: Number(width) + (inset || 0) };
    }
    return this.measureSide(node, containerRect);
  };

  /**
   * The side a named surface docks to while it's hidden, and how far it
   * reaches into the canvas from it: as last measured, else approximately.
   */
  private getReservedSide = (
    name: keyof NonNullable<ViewportOffsetsOptions["reserve"]>,
  ) => {
    const isRTL = getLanguage().rtl;
    if (
      name === "sidebar" &&
      this.dependencies
        .getContainer()
        ?.nextElementSibling?.matches(
          '.excalidraw-sidebar-dock[data-open="true"]',
        )
    ) {
      return {
        side: isRTL ? ("left" as const) : ("right" as const),
        offset: 0,
      };
    }

    return (
      this.uiLastMeasured.get(name) ??
      (name === "stylesPanel"
        ? {
            side: isRTL ? ("right" as const) : ("left" as const),
            offset:
              this.dependencies.getStylesPanelMode() === "compact"
                ? STYLES_PANEL_APPROX_WIDTH.compact
                : STYLES_PANEL_APPROX_WIDTH.full,
          }
        : {
            side: isRTL ? ("left" as const) : ("right" as const),
            offset: RIGHT_SIDEBAR_WIDTH,
          })
    );
  };

  private querySideUI = (container: HTMLElement, name: ViewportUIName) =>
    container.querySelector<HTMLElement>(
      `[data-viewport-ui="side"][data-viewport-ui-name="${name}"]`,
    );

  /**
   * Where a rendered side UI is, relative to the editor's container, in
   * screen px; null when it isn't rendered.
   */
  getSideUIRect = (name: ViewportUIName) => {
    const container = this.dependencies.getContainer();
    const node = container && this.querySideUI(container, name);
    if (!container || !node) {
      return null;
    }
    const containerRect = container.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left - containerRect.left,
      right: rect.right - containerRect.left,
      top: rect.top - containerRect.top,
      bottom: rect.bottom - containerRect.top,
    };
  };

  /**
   * How far the named side UIs reach into the canvas, in screen px, from
   * the left and the right: the part of the canvas they cover. Zero at a
   * side none of them is rendered at — e.g. with the sidebar closed, or on
   * phones, where it's an overlay that doesn't count as viewport UI — unless
   * a hidden one is reserved (see `ViewportOffsetsOptions.reserve`).
   */
  getSideInsets = (
    names: readonly ViewportUIName[],
    opts?: Pick<ViewportOffsetsOptions, "reserve">,
  ) => {
    const insets = { left: 0, right: 0 };
    const container = this.dependencies.getContainer();
    if (!container) {
      return insets;
    }
    const containerRect = container.getBoundingClientRect();
    for (const name of names) {
      const node = this.querySideUI(container, name);
      let footprint: { side: "left" | "right"; offset: number } | null = null;
      if (node) {
        footprint = this.measureSide(node, containerRect);
        if (footprint.offset > 0) {
          this.uiLastMeasured.set(name, footprint);
        }
      } else if (
        (name === "sidebar" || name === "stylesPanel") &&
        opts?.reserve?.[name] &&
        this.app.editorInterface.formFactor !== "phone"
      ) {
        footprint = this.getReservedSide(name);
      }
      if (footprint) {
        insets[footprint.side] = Math.max(
          insets[footprint.side],
          footprint.offset,
        );
      }
    }
    return insets;
  };

  /** How far the sidebar reaches into the canvas (see `getSideInsets`). */
  getSidebarInsets = () => this.getSideInsets(["sidebar", "toolDock"]);

  /** Wait for the newly selected element's properties panel to mount. */
  revealSelection = () => {
    this.interruptSelectionReveal();
    this.selectionRevealPending = true;
    this.selectionRevealMountFrames = 0;
    this.scheduleSelectionReveal();
  };

  resumeSelectionReveal = () => {
    if (this.selectionRevealPending) {
      this.scheduleSelectionReveal();
    }
  };

  interruptSelectionReveal = () => {
    this.selectionRevealPending = false;
    if (this.revealSelectionFrame !== null) {
      this.app.ownerWindow.cancelAnimationFrame(this.revealSelectionFrame);
      this.revealSelectionFrame = null;
    }
    if (this.isRevealingSelection) {
      this.cancelTransition();
      if (!this.app.unmounted) {
        this.app.setState({ shouldCacheIgnoreZoom: false });
      }
    }
  };

  private scheduleSelectionReveal = () => {
    if (this.revealSelectionFrame !== null) {
      this.app.ownerWindow.cancelAnimationFrame(this.revealSelectionFrame);
    }
    this.revealSelectionFrame = this.app.ownerWindow.requestAnimationFrame(
      () => {
        this.revealSelectionFrame = null;
        const { state } = this.app;
        if (
          state.isLoading ||
          state.viewModeEnabled ||
          this.app.props.userToFollow ||
          state.editingTextElement ||
          (state.scrollConstraints &&
            state.scrollConstraints.lockScroll !== "x") ||
          this.app.unmounted ||
          !this.app.isInteractionEnabled() ||
          this.dependencies.isGestureActive() ||
          this.isAnimating
        ) {
          this.selectionRevealPending = false;
          return;
        }
        if (this.dependencies.isPointerDown()) {
          return;
        }
        const elements = this.app.scene.getSelectedElements(state);
        if (!elements.length) {
          this.selectionRevealPending = false;
          return;
        }
        const container = this.dependencies.getContainer();
        const panelNode =
          container &&
          (this.querySideUI(container, "stylesPanel") ||
            this.querySideUI(container, "toolDock"));
        if (!panelNode) {
          if (this.selectionRevealMountFrames++ < 2) {
            this.scheduleSelectionReveal();
          } else {
            this.selectionRevealPending = false;
          }
          return;
        }
        if (
          panelNode
            .getAnimations?.()
            .some(
              (animation) =>
                animation.playState === "running" || animation.pending,
            )
        ) {
          this.scheduleSelectionReveal();
          return;
        }
        this.selectionRevealPending = false;
        const panel =
          this.getSideUIRect("stylesPanel") || this.getSideUIRect("toolDock");
        if (!panel || panel.right <= panel.left || panel.bottom <= panel.top) {
          return;
        }
        const [x1, y1, x2, y2] = getCommonBounds(elements);
        const left = (x1 + state.scrollX) * state.zoom.value;
        const right = (x2 + state.scrollX) * state.zoom.value;
        const top = (y1 + state.scrollY) * state.zoom.value;
        const bottom = (y2 + state.scrollY) * state.zoom.value;
        if (
          right <= panel.left ||
          left >= panel.right ||
          bottom <= panel.top ||
          top >= panel.bottom
        ) {
          return;
        }
        const insets = this.getSideInsets([
          "stylesPanel",
          "sidebar",
          "toolDock",
        ]);
        const start = insets.left + 16;
        const end = state.width - insets.right - 16;
        if (end <= start) {
          return;
        }
        const center = (left + right) / 2;
        const dx =
          right - left > end - start
            ? clamp(center, start, end) - center
            : left < start
            ? start - left
            : right > end
            ? end - right
            : 0;
        if (!dx) {
          return;
        }
        const from = {
          scrollX: state.scrollX,
          scrollY: state.scrollY,
          zoom: state.zoom,
        };
        const target = {
          ...constrainScrollState({
            ...state,
            scrollX: from.scrollX + dx / state.zoom.value,
          }),
          scrollConstraints: state.scrollConstraints ?? null,
        };
        if (target.scrollX === from.scrollX) {
          return;
        }
        const transition = { target };
        this.activeTransition = transition;
        this.isRevealingSelection = true;
        animateToViewport(
          from,
          target,
          220,
          this.scrollToContentAnimationKey,
          this.app.ownerWindow,
          (update) => {
            if (this.activeTransition === transition) {
              this.app.setState((current) => ({
                ...update,
                ...constrainScrollState({ ...current, ...update }),
              }));
            }
          },
          () => {
            if (this.activeTransition === transition) {
              this.activeTransition = null;
              this.isRevealingSelection = false;
              this.app.setState((current) => ({
                ...constrainScrollState({
                  ...current,
                  ...target,
                  scrollConstraints: current.scrollConstraints,
                }),
                shouldCacheIgnoreZoom: false,
              }));
            }
          },
        );
      },
    );
  };

  /**
   * Resolves user-supplied viewport offsets into concrete per-side pixel
   * values. Static sides take precedence over UI-derived sides.
   */
  resolveOffsets = (
    offsets: ViewportOffsets | undefined,
  ): Offsets | undefined => {
    if (!offsets) {
      return offsets;
    }

    const { ui, ...staticOffsets } = offsets;

    if (!ui) {
      return staticOffsets;
    }

    const uiOffsets = this.getOffsets(ui === true ? undefined : ui);

    return {
      top: staticOffsets.top ?? uiOffsets.top,
      right: staticOffsets.right ?? uiOffsets.right,
      bottom: staticOffsets.bottom ?? uiOffsets.bottom,
      left: staticOffsets.left ?? uiOffsets.left,
    };
  };

  /**
   * Measures the currently rendered editor UI and returns the usable viewport
   * offsets, including optional padding and reserved hidden surfaces.
   */
  getOffsets = (opts?: ViewportOffsetsOptions): Offsets => {
    const excalidrawContainer = this.dependencies.getContainer();
    const excalidrawContainerRect =
      excalidrawContainer?.getBoundingClientRect();
    const isRTL = getLanguage().rtl;

    const measuredOffsets = { top: 0, right: 0, bottom: 0, left: 0 };
    const renderedSurfaces = new Set<ViewportUIName>();

    if (excalidrawContainer && excalidrawContainerRect) {
      for (const node of excalidrawContainer.querySelectorAll<HTMLElement>(
        "[data-viewport-ui]",
      )) {
        const domRect = node.getBoundingClientRect();
        const rect = {
          top: domRect.top - excalidrawContainerRect.top,
          right: domRect.right - excalidrawContainerRect.left,
          bottom: domRect.bottom - excalidrawContainerRect.top,
          left: domRect.left - excalidrawContainerRect.left,
          width: domRect.width,
        };

        switch (node.dataset.viewportUi as ViewportUIDock) {
          case "top":
            measuredOffsets.top = Math.max(measuredOffsets.top, rect.bottom);
            break;
          case "bottom":
            measuredOffsets.bottom = Math.max(
              measuredOffsets.bottom,
              this.app.state.height - rect.top,
            );
            break;
          case "side": {
            const measureSide = opts?.useSettledToolDock
              ? this.measureSettledSide
              : this.measureSide;
            const { side, offset } = measureSide(node, excalidrawContainerRect);

            measuredOffsets[side] = Math.max(measuredOffsets[side], offset);

            const name = node.dataset.viewportUiName as
              | ViewportUIName
              | undefined;
            if (name) {
              renderedSurfaces.add(name);
              if (offset > 0) {
                this.uiLastMeasured.set(name, { side, offset });
              }
            }
            break;
          }
        }
      }
    }

    if (opts?.reserve && this.app.editorInterface.formFactor !== "phone") {
      for (const name of ["stylesPanel", "sidebar"] as const) {
        if (opts.reserve[name] && !renderedSurfaces.has(name)) {
          const { side, offset } = this.getReservedSide(name);
          measuredOffsets[side] = Math.max(measuredOffsets[side], offset);
        }
      }
    }

    const padding = opts?.padding ?? 24;
    const topPadding = opts?.paddingTop ?? padding;
    const rightPadding =
      (isRTL ? opts?.paddingLeft : opts?.paddingRight) ?? padding;
    const bottomPadding = opts?.paddingBottom ?? padding;
    const leftPadding =
      (isRTL ? opts?.paddingRight : opts?.paddingLeft) ?? padding;

    const editorOffsets = {
      top: measuredOffsets.top + topPadding,
      right: measuredOffsets.right + rightPadding,
      bottom: measuredOffsets.bottom + bottomPadding,
      left: measuredOffsets.left + leftPadding,
    };

    return {
      top: opts?.top ?? editorOffsets.top,
      right: (isRTL ? opts?.left : opts?.right) ?? editorOffsets.right,
      bottom: opts?.bottom ?? editorOffsets.bottom,
      left: (isRTL ? opts?.right : opts?.left) ?? editorOffsets.left,
    };
  };

  /** Resolves the host-supplied initial viewport against restored scene data. */
  resolveInitialViewport = (
    opts: Omit<SetViewportOptions, "animation">,
    elementsMap: NonDeletedSceneElementsMap,
    appState: AppState,
  ) => {
    const { bounds } = resolveViewportTarget(
      opts.target,
      elementsMap,
      appState,
    );

    if (!bounds) {
      return null;
    }

    return getConstrainedTargetViewport(appState, bounds, {
      ...opts,
      // Initial state is resolved post-mount so UI-derived offsets measure
      // the actually-rendered editor UI.
      offsets: this.resolveOffsets(opts.offsets),
    });
  };

  /**
   * Navigates to a target and optionally installs scroll/zoom constraints.
   * Navigating stops following a collaborator, as a user's pan does.
   */
  setViewport = (opts: SetViewportOptions | null) => {
    this.app.wheel.cancelPan();
    this.cancelConstraintTransition();
    this.cancelCaretFollow();
    this.caretFollowInterrupt?.();
    this.interruptSelectionReveal();
    if (opts === null) {
      this.cancelTransition();
      this.cancelSnapBack();
      this.snapBackDebounced.cancel();
      this.app.setState({
        scrollConstraints: null,
        shouldCacheIgnoreZoom: false,
      });
      return;
    }

    const { target, fit, lock, animation } = opts;
    const offsets = this.resolveOffsets(opts.offsets);
    const { bounds, type } = resolveViewportTarget(
      target,
      this.app.scene.getNonDeletedElementsMap(),
      this.app.state,
    );

    if (!bounds) {
      if (type === "link") {
        this.app.setState({
          toast: {
            message: t("elementLink.notFound"),
            duration: 3000,
            closable: true,
          },
        });
      }
      return;
    }

    // the view is about to show something other than what the followed
    // user sees
    this.app.requestUnfollow();

    const viewportUpdate = getConstrainedTargetViewport(
      this.app.state,
      bounds,
      { fit, offsets, lock },
    );
    const duration = resolveAnimationDuration(animation);
    const from = {
      scrollX: this.app.state.scrollX,
      scrollY: this.app.state.scrollY,
      zoom: this.app.state.zoom,
    };

    // A new programmatic navigation supersedes the previous one and starts
    // from whatever viewport its last rendered frame reached.
    this.cancelTransition();
    this.cancelSnapBack();
    this.snapBackDebounced.cancel();

    if (duration === null) {
      this.app.setState({
        ...viewportUpdate,
        shouldCacheIgnoreZoom: false,
      });
      return;
    }

    const transition = {
      target: viewportUpdate,
    };
    this.activeTransition = transition;

    // Paper bounds belong to the host. Keep them installed until the new
    // viewport commits so the host doesn't reinstall them mid-navigation.
    if (
      this.app.state.scrollConstraints &&
      !this.app.state.scrollConstraints.elasticPan
    ) {
      this.app.setState({ scrollConstraints: null });
    }

    animateToViewport(
      from,
      viewportUpdate,
      duration,
      this.scrollToContentAnimationKey,
      this.app.ownerWindow,
      (state) => {
        if (this.activeTransition === transition) {
          this.app.setState(state);
        }
      },
      () => {
        if (this.activeTransition !== transition) {
          return;
        }

        this.activeTransition = null;
        this.app.setState({
          ...transition.target,
          shouldCacheIgnoreZoom: false,
        });
      },
    );
  };

  /** Moves with the usable viewport when a dock changes its footprint. */
  transitionScrollConstraints = (constraint: ScrollConstraints) => {
    this.app.wheel.cancelPan();
    if (this.activeTransition) {
      this.app.setState({ scrollConstraints: constraint });
      return;
    }
    const state = this.app.state;
    const previous = state.scrollConstraints;
    const centerOffset = (offsets?: Offsets) =>
      ((offsets?.left ?? 0) - (offsets?.right ?? 0)) / 2;
    const anchorScrollX =
      (this.constraintTransition?.constraint === previous &&
      AnimationController.running(this.scrollConstraintsAnimationKey)
        ? this.constraintTransition.anchorScrollX
        : state.scrollX) +
      (centerOffset(constraint.offsets) - centerOffset(previous?.offsets)) /
        state.zoom.value;
    const target = constrainScrollState({
      ...state,
      scrollConstraints: constraint,
      scrollX: anchorScrollX,
    });
    this.cancelConstraintTransition();
    this.cancelSnapBack();
    this.snapBackDebounced.cancel();
    const reducedMotion = this.app.ownerWindow.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (
      reducedMotion ||
      (target.scrollX === state.scrollX && target.scrollY === state.scrollY)
    ) {
      this.app.setState({ ...target, scrollConstraints: constraint });
      return;
    }

    const transition = { constraint, anchorScrollX };
    this.constraintTransition = transition;
    this.app.setState({ scrollConstraints: constraint }, () => {
      if (this.constraintTransition !== transition) {
        return;
      }
      AnimationController.start<{ elapsed: number }>(
        this.scrollConstraintsAnimationKey,
        ({ deltaTime, state: animationState }) => {
          if (this.app.state.scrollConstraints !== constraint) {
            this.cancelConstraintTransition();
            return null;
          }
          const elapsed = (animationState?.elapsed ?? 0) + deltaTime;
          const progress = Math.min(
            elapsed / SCROLL_CONSTRAINTS_TRANSITION_DURATION,
            1,
          );
          if (progress > 0) {
            const { scrollX, scrollY } = interpolateViewport({
              from: state,
              target,
              factor: easeOut(progress),
            });
            this.app.setState((current) =>
              current.scrollConstraints === constraint &&
              this.constraintTransition === transition
                ? { scrollX, scrollY }
                : null,
            );
          }
          return progress < 1 ? { elapsed } : null;
        },
        this.app.ownerWindow,
      );
    });
  };

  private cancelConstraintTransition = () => {
    this.constraintTransition = null;
    AnimationController.cancel(this.scrollConstraintsAnimationKey);
  };

  beginPan = (time?: number) => {
    if (this.app.state.scrollConstraints?.elasticPan) {
      this.cancelConstraintTransition();
      this.cancelSnapBack();
      this.snapBackDebounced.cancel();
      this.paperMotion.clear();
      this.recordPaperMotion(this.app.state, time);
    }
  };

  panBy = (
    deltaX: number,
    deltaY: number,
    source: ViewportGesture["source"],
    options?: {
      time?: number;
      onCommit?: (state: AppState) => void;
      isCurrent?: () => boolean;
    },
  ) => {
    let movedState: AppState | undefined;
    let previousPastEnd: number | undefined;
    return this.translate(
      (state) => {
        if (options?.isCurrent && !options.isCurrent()) {
          return null;
        }
        const update = panViewportWithinConstraints(state, deltaX, deltaY);
        if (state.scrollConstraints?.elasticPan) {
          // Several events can commit together; each continuation sample
          // still needs its own position relative to the end.
          movedState = { ...state, ...update };
          previousPastEnd = getDistancePastEnd(state);
        }
        return update;
      },
      {
        elasticPanPreConstrained: true,
        onCommit: () => {
          if (options?.isCurrent && !options.isCurrent()) {
            return;
          }
          if (movedState) {
            this.recordPaperMotion(movedState, options?.time);
          }
          this.notifyPan(
            previousPastEnd === undefined
              ? { source, phase: "move", deltaY }
              : { source, phase: "move", deltaY, previousPastEnd },
            movedState,
          );
          options?.onCommit?.(movedState ?? this.app.state);
        },
      },
    );
  };

  notifyPan = (gesture: ViewportGesture, state = this.app.state) => {
    const onGesture = this.app.props.desktopIntegration?.onViewportGesture;
    if (onGesture) {
      const pastEnd = getDistancePastEnd(state);
      onGesture(
        pastEnd === undefined ? gesture : { ...gesture, pastEnd },
        state,
      );
    }
  };

  private recordPaperMotion = (state: AppState, time?: number) => {
    if (!state.scrollConstraints?.elasticPan) {
      return;
    }
    const zoom = state.zoom.value;
    if (zoom !== this.paperMotionZoom) {
      this.paperMotion.clear();
      this.paperMotionZoom = zoom;
    }
    const clock = this.app.ownerWindow.performance;
    const now = clock.now();
    const timestamp =
      time === undefined
        ? now
        : time > now + 1000
        ? time - clock.timeOrigin
        : time;
    this.paperMotion.add({
      x: state.scrollX * zoom,
      y: state.scrollY * zoom,
      time: timestamp >= 0 && timestamp <= now + 2 ? timestamp : now,
    });
  };

  panMomentum = (
    deltas: readonly { x: number; y: number; time: number }[],
    stopped: { x: boolean; y: boolean },
    isCurrent: () => boolean,
    onCommit: (blocked: { x: boolean; y: boolean }) => void,
  ) => {
    let hit = { x: 0, y: 0 };
    let blocked = { x: false, y: false };
    let samples: { state: AppState; time: number }[] = [];
    const canPan = () =>
      isCurrent() &&
      this.app.isNavigationEnabled() &&
      !this.activeTransition &&
      !AnimationController.running(this.scrollConstraintsAnimationKey);
    this.app.setState(
      (state) => {
        if (!canPan() || !state.scrollConstraints?.elasticPan) {
          return null;
        }
        const hard = constrainScrollState(state);
        const zoom = state.zoom.value;
        const ownsAxis = (axis: keyof SpringAxes) =>
          !!this.paperSpring?.axes[axis] &&
          sameScrollGeometry(state, this.paperSpring.geometry);
        hit = { x: 0, y: 0 };
        samples = [];
        blocked = {
          x: stopped.x || ownsAxis("x") || state.scrollX !== hard.scrollX,
          y: stopped.y || ownsAxis("y") || state.scrollY !== hard.scrollY,
        };
        let { scrollX, scrollY } = state;
        for (const delta of deltas) {
          if (blocked.x && blocked.y) {
            break;
          }
          const proposed = {
            ...state,
            scrollX: scrollX - delta.x / zoom,
            scrollY: scrollY - delta.y / zoom,
          };
          const next = constrainScrollState(proposed);
          if (!blocked.x) {
            scrollX = next.scrollX;
            hit.x = Math.sign(proposed.scrollX - next.scrollX);
            blocked.x = hit.x !== 0;
          }
          if (!blocked.y) {
            scrollY = next.scrollY;
            hit.y = Math.sign(proposed.scrollY - next.scrollY);
            blocked.y = hit.y !== 0;
          }
          samples.push({
            state: { ...state, scrollX, scrollY },
            time: delta.time,
          });
        }
        return { scrollX, scrollY };
      },
      () => {
        if (canPan()) {
          for (const sample of samples) {
            this.recordPaperMotion(sample.state, sample.time);
          }
          this.startPaperSpring(hit);
        }
        onCommit(blocked);
      },
    );
  };

  private cancelSnapBack = () => {
    this.paperSpring = null;
    this.paperSpringToken++;
    AnimationController.cancel(this.snapBackAnimationKey);
  };

  private startPaperSpring = (hit = { x: 0, y: 0 }) => {
    const state = this.app.state;
    const constraint = state.scrollConstraints;
    if (!constraint?.elasticPan) {
      return;
    }
    const hard = constrainScrollState(state);
    if (
      this.app.ownerWindow.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
    ) {
      if (hard.scrollX !== state.scrollX || hard.scrollY !== state.scrollY) {
        this.constrain();
      }
      return;
    }
    const zoom = state.zoom.value;
    const velocity =
      zoom === this.paperMotionZoom
        ? this.paperMotion.velocity(this.app.ownerWindow.performance.now())
        : { x: 0, y: 0 };
    const axis = (
      current: number,
      edge: number,
      speed: number,
      direction: number,
      cap: number,
    ): PaperSpringAxis | null => {
      const displacement = (current - edge) * zoom;
      if (!displacement && (!direction || direction !== Math.sign(speed))) {
        return null;
      }
      return {
        displacement,
        velocity: speed,
        edge,
        limit: Math.max(Math.abs(displacement), cap),
      };
    };
    const x = axis(
      state.scrollX,
      hard.scrollX,
      velocity.x,
      hit.x,
      constraint.overscroll,
    );
    const y = axis(
      state.scrollY,
      hard.scrollY,
      velocity.y,
      hit.y,
      getElasticOverscrollY(constraint, zoom),
    );
    if (!x && !y) {
      return;
    }
    if (this.paperSpring) {
      // Momentum can reach the other edge while one axis is still settling.
      if (sameScrollGeometry(state, this.paperSpring.geometry)) {
        this.paperSpring.axes.x ??= x;
        this.paperSpring.axes.y ??= y;
      }
      return;
    }

    const session: PaperSpring = { axes: { x, y }, geometry: state };
    const token = ++this.paperSpringToken;
    this.paperSpring = session;
    AnimationController.start<PaperSpring>(
      this.snapBackAnimationKey,
      ({ deltaTime, state: running = session }) => {
        const current = this.app.state;
        if (
          this.paperSpring !== session ||
          !current.scrollConstraints?.elasticPan
        ) {
          this.paperSpring = null;
          return null;
        }
        if (!sameScrollGeometry(current, running.geometry)) {
          const rest = constrainScrollState(current);
          const rebase = (
            prev: PaperSpringAxis | null,
            scroll: number,
            edge: number,
            cap: number,
          ) => {
            const displacement = (scroll - edge) * current.zoom.value;
            return prev && displacement
              ? {
                  ...prev,
                  displacement,
                  edge,
                  limit: Math.max(Math.abs(displacement), cap),
                }
              : null;
          };
          running.axes.x = rebase(
            running.axes.x,
            current.scrollX,
            rest.scrollX,
            current.scrollConstraints.overscroll,
          );
          running.axes.y = rebase(
            running.axes.y,
            current.scrollY,
            rest.scrollY,
            getElasticOverscrollY(
              current.scrollConstraints,
              current.zoom.value,
            ),
          );
          running.geometry = current;
        }
        if (deltaTime > 0 && (running.axes.x || running.axes.y)) {
          const { x: beforeX, y: beforeY } = running.axes;
          const nextX = beforeX && stepPaperSpring(beforeX, deltaTime);
          const nextY = beforeY && stepPaperSpring(beforeY, deltaTime);
          running.axes = { x: nextX, y: nextY };
          this.app.setState((state) => {
            if (
              token !== this.paperSpringToken ||
              !sameScrollGeometry(state, current)
            ) {
              return null;
            }
            return {
              scrollX: beforeX
                ? beforeX.edge + (nextX?.displacement ?? 0) / state.zoom.value
                : state.scrollX,
              scrollY: beforeY
                ? beforeY.edge + (nextY?.displacement ?? 0) / state.zoom.value
                : state.scrollY,
            };
          });
        }
        if (running.axes.x || running.axes.y) {
          return running;
        }
        this.paperSpring = null;
        return null;
      },
      this.app.ownerWindow,
    );
  };

  /** Use when changing scrollX/scrollY/zoom based on user interaction. */
  translate = <K extends keyof AppState>(
    state:
      | AppState
      | Pick<AppState, K>
      | null
      | ((
          prevState: Readonly<AppState>,
          props: Readonly<AppProps>,
        ) => AppState | Pick<AppState, K> | null),
    opts?: {
      zoomPreConstrained?: boolean;
      preserveScrollConstraintsSnapBack?: boolean;
      elasticPanPreConstrained?: boolean;
      onCommit?: () => void;
    },
  ) => {
    this.interruptSelectionReveal();
    this.cancelCaretFollow();
    this.caretFollowInterrupt?.();
    if (this.isLockedTransitionPending) {
      return false;
    }

    // a user gesture interrupting an animated `setViewport` takes over from
    // frames that draw from zoom-scaled bitmaps, and the completion handler
    // that would switch back to crisp ones no longer runs. Otherwise the
    // flag is left alone: wheel and touch zoom set it and clear it on a
    // debounce once the gesture is over, and a pan frame landing between two
    // zoom ticks must not force every element to be re-rasterized at the
    // in-progress zoom
    if (this.activeTransition) {
      this.app.setState({ shouldCacheIgnoreZoom: false });
    }
    this.cancelTransition();
    this.cancelConstraintTransition();
    if (!opts?.preserveScrollConstraintsSnapBack) {
      this.cancelSnapBack();
    }
    this.app.requestUnfollow();

    this.app.setState((prevState, props) => {
      const update =
        typeof state === "function" ? state(prevState, props) : state;
      if (!update) {
        return null;
      }
      const nextState = { ...prevState, ...update };
      if (
        !nextState.scrollConstraints ||
        (nextState.scrollConstraints.elasticPan &&
          opts?.elasticPanPreConstrained)
      ) {
        return update;
      }
      const zoomed =
        !opts?.zoomPreConstrained &&
        nextState.zoom.value !== prevState.zoom.value;
      const overscroll = zoomed ? 0 : nextState.scrollConstraints.overscroll;
      if (overscroll > 0) {
        this.snapBackDebounced();
      }
      return { ...nextState, ...constrainScrollState(nextState, overscroll) };
    }, opts?.onCommit);

    return true;
  };

  /** Clamps the viewport into the active scroll constraints. */
  constrain = (overscroll = 0) => {
    this.app.setState((prevState) =>
      prevState.scrollConstraints
        ? constrainScrollState(prevState, overscroll)
        : null,
    );
  };

  /** Releases a held rubberband overscroll. */
  releaseOverscroll = () => {
    if (!this.app.state.scrollConstraints) {
      return;
    }
    this.snapBackDebounced.cancel();
    this.snapBack();
  };

  releaseOverscrollAfterCommit = () => {
    const token = this.paperSpringToken;
    this.app.setState({}, () => {
      if (token === this.paperSpringToken) {
        this.releaseOverscroll();
      }
    });
  };

  scheduleOverscrollRelease = () => {
    this.snapBackDebounced();
  };

  private snapBack = () => {
    if (
      this.app.unmounted ||
      this.dependencies.isGestureActive() ||
      AnimationController.running(this.scrollConstraintsAnimationKey)
    ) {
      return;
    }
    if (this.app.state.scrollConstraints?.elasticPan) {
      this.startPaperSpring();
      return;
    }
    if (
      this.app.ownerWindow.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
    ) {
      this.constrain();
      return;
    }
    snapBackToConstraints(
      this.app.state,
      (updater) => this.app.setState((state) => updater(state)),
      {
        scrollToContent: this.scrollToContentAnimationKey,
        snapBack: this.snapBackAnimationKey,
      },
      this.app.ownerWindow,
    );
  };

  private snapBackDebounced = debounce(
    this.snapBack,
    SCROLL_CONSTRAINTS_SNAP_BACK_DELAY,
  );

  private cancelTransition = () => {
    this.isRevealingSelection = false;
    this.activeTransition = null;
    AnimationController.cancel(this.scrollToContentAnimationKey);
  };

  destroy = () => {
    this.cancelCaretFollow();
    this.caretFollowInterrupt = null;
    this.interruptSelectionReveal();
    this.cancelTransition();
    this.cancelConstraintTransition();
    this.cancelSnapBack();
    this.snapBackDebounced.cancel();
  };
}
