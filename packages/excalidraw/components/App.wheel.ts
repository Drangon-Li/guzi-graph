import { CLASSES, KEYS, MIN_ZOOM, ZOOM_STEP } from "@excalidraw/common";

import { resolveInputDevice } from "../appState";
import { withBatchedUpdates } from "../reactUtils";
import { getNormalizedZoom } from "../scene";
import { getViewportForZoomWithScrollConstraints } from "../viewport";

import type App from "./App";
import type { AppState } from "../types";

/** `MouseEvent.buttons` bit of the wheel (middle) button */
const WHEEL_BUTTON_MASK = 4;
const WHEEL_PAN_IDLE = 200;
type DirectWheel = { previous?: AppState; finishing: boolean };
type MomentumWheel = {
  queue: { x: number; y: number; time: number }[];
  ready: boolean;
  applying: boolean;
  blocked: { x: boolean; y: boolean };
};

/**
 * Wheel input over the editor: pans the canvas, or zooms it around the
 * pointer (`viewport.lastPosition`) — on ctrl/cmd+wheel (which is also how
 * a trackpad pinch is delivered), while the wheel button itself is held
 * down, or on a plain wheel when the input device is a mouse
 * (`appState.inputDevice`). Shift+wheel pans horizontally;
 * ctrl/cmd+shift+wheel pans vertically.
 */
export class AppWheel {
  constructor(private app: App) {}

  private panTimer: number | undefined;
  private direct: DirectWheel | null = null;
  private momentum: MomentumWheel | null = null;
  private generation = 0;
  private finishingGeneration: number | null = null;

  private clearIdle = () => {
    this.app.ownerWindow.clearTimeout(this.panTimer);
    this.panTimer = undefined;
  };

  destroy = () => {
    this.clearIdle();
    this.generation++;
    this.direct = null;
    this.momentum = null;
    this.finishingGeneration = null;
  };

  cancelPan = () => {
    const direct = this.direct;
    this.destroy();
    if (direct) {
      this.app.viewport.notifyPan({
        source: "wheel",
        phase: "cancel",
        deltaY: 0,
      });
    }
  };

  /** the editor surfaces whose wheel input the editor consumes; everywhere
   * else (menus, sidebars, …) the DOM keeps scrolling. The frame-name labels
   * are DOM, but sit inside the container this listener is attached to */
  private isOverEditorSurface = (event: WheelEvent) => {
    const { ownerWindow } = this.app;
    return (
      event.target instanceof ownerWindow.HTMLCanvasElement ||
      event.target instanceof ownerWindow.HTMLTextAreaElement ||
      event.target instanceof ownerWindow.HTMLIFrameElement ||
      (event.target instanceof ownerWindow.HTMLElement &&
        (event.target.classList.contains(CLASSES.FRAME_NAME) ||
          !!event.target.closest(".excalidraw-rich-text")))
    );
  };

  handle = withBatchedUpdates((event: WheelEvent) => {
    // NOTE no preventDefault so the page can scroll over the editor
    if (!this.app.isNavigationEnabled()) {
      return;
    }
    if (!this.isOverEditorSurface(event)) {
      // prevent zooming the browser (but allow scrolling DOM)
      if (event[KEYS.CTRL_OR_CMD]) {
        event.preventDefault();
      }

      return;
    }

    event.preventDefault();

    // scrolling with the wheel button held down zooms: the wheel sits under
    // the same finger, so a wheel-button pan can be zoomed without reaching
    // for a modifier — hence it wins over any modifier, and over the
    // drag-pan the button itself started
    const isWheelButtonHeld = !!(event.buttons & WHEEL_BUTTON_MASK);

    // a drag-pan (wheel button, space+drag, hand tool) in progress owns the
    // viewport; wheel input is ignored meanwhile — except for the wheel
    // button's own zoom
    if (this.app.pan.isActive()) {
      if (!isWheelButtonHeld) {
        return;
      }
      // the drag-pan applies pointer movement once per frame; a move still
      // waiting for its frame has to land before the zoom, or it lands after
      // it — at the new zoom, on a viewport the zoom anchored without it —
      // and the point grabbed by the pan drifts from under the cursor a
      // little on every tick
      this.app.pan.flushMove();
    }

    const { deltaX, deltaY } = event;
    const elastic = this.app.state.scrollConstraints?.elasticPan;
    const momentum =
      !!elastic &&
      (event as WheelEvent & { momentum?: boolean }).momentum === true;
    if (!deltaX && !deltaY && !momentum) {
      return;
    }
    // note that event.ctrlKey is necessary to handle pinch zooming
    const hasZoomModifier = event.metaKey || event.ctrlKey;
    const shouldZoom =
      // a horizontal-only wheel (tilt wheel, sideways two-finger scroll)
      // has nothing to zoom by; it follows the pan mappings below instead
      deltaY !== 0 &&
      (isWheelButtonHeld ||
        (!event.shiftKey &&
          (hasZoomModifier ||
            resolveInputDevice(this.app.state.inputDevice) === "mouse")));
    if (shouldZoom && !momentum) {
      const hadPan = this.direct !== null;
      this.cancelPan();
      if (!hadPan) {
        this.app.viewport.notifyPan({
          source: "wheel",
          phase: "cancel",
          deltaY: 0,
        });
      }
      this.zoomBy(deltaY);
      if (hadPan) {
        this.app.viewport.scheduleOverscrollRelease();
      }
      return;
    }

    // Shift pans horizontally; ctrl/cmd+shift pans vertically.
    if (event.shiftKey) {
      // on Mac, shift+wheel tends to result in deltaX
      const delta = deltaY || deltaX;
      this.panBy(
        hasZoomModifier ? 0 : delta,
        hasZoomModifier ? delta : 0,
        momentum,
        event.timeStamp,
      );
      return;
    }

    this.panBy(deltaX, deltaY, momentum, event.timeStamp);
  });

  private panBy = (
    deltaX: number,
    deltaY: number,
    momentum: boolean,
    time: number,
  ) => {
    const { viewport, ownerWindow } = this.app;
    if (!this.app.state.scrollConstraints?.elasticPan) {
      if (this.direct || this.momentum) {
        this.cancelPan();
      }
      viewport.panBy(deltaX, deltaY, "wheel");
      return;
    }
    if (momentum) {
      const stream = (this.momentum ??= {
        queue: [],
        ready: !this.direct && this.finishingGeneration === null,
        applying: false,
        blocked: { x: false, y: false },
      });
      stream.queue.push({ x: deltaX, y: deltaY, time });
      if (this.direct && !this.direct.finishing) {
        this.finishDirect(this.direct);
      }
      this.consumeMomentum(stream);
      return;
    }

    if (this.momentum || this.finishingGeneration !== null) {
      this.cancelPan();
    }
    if (!this.direct) {
      viewport.beginPan(time);
      this.generation++;
      this.direct = { finishing: false };
    }
    const direct = this.direct;
    this.clearIdle();
    const translated = viewport.panBy(deltaX, deltaY, "wheel", {
      time,
      onCommit: (state) => {
        direct.previous = state;
        if (!direct.finishing) {
          this.clearIdle();
          this.panTimer = ownerWindow.setTimeout(
            () => this.finishDirect(direct),
            WHEEL_PAN_IDLE,
          );
        }
      },
      isCurrent: () => this.direct === direct && this.app.isNavigationEnabled(),
    });
    if (!translated) {
      this.cancelPan();
    }
  };

  private finishDirect = (direct: DirectWheel) => {
    if (this.direct !== direct || direct.finishing) {
      return;
    }
    this.clearIdle();
    direct.finishing = true;
    const { viewport } = this.app;
    const generation = this.generation;
    this.finishingGeneration = generation;
    // The first momentum event can arrive in the same React batch as direct
    // input. Let every direct sample commit before deciding whether to append.
    this.app.setState({}, () => {
      if (this.direct !== direct) {
        return;
      }
      const current = this.app.state;
      const previous = direct.previous;
      const unchanged =
        previous &&
        current.scrollY === previous.scrollY &&
        current.zoom.value === previous.zoom.value &&
        current.scrollConstraints === previous.scrollConstraints &&
        !current.editingTextElement &&
        this.app.isNavigationEnabled();
      this.direct = null;
      viewport.notifyPan({
        source: "wheel",
        phase: unchanged ? "end" : "cancel",
        deltaY: 0,
      });
      // If the host appended paper, momentum starts in the expanded range.
      this.app.setState({}, () => {
        if (generation !== this.generation) {
          return;
        }
        this.finishingGeneration = null;
        if (this.app.state.scrollConstraints?.elasticPan) {
          viewport.releaseOverscroll();
        }
        if (this.momentum) {
          this.momentum.ready = true;
          this.consumeMomentum(this.momentum);
        }
      });
    });
  };

  private consumeMomentum = (stream: MomentumWheel) => {
    if (this.momentum !== stream || !stream.ready || stream.applying) {
      return;
    }
    if (stream.blocked.x && stream.blocked.y) {
      stream.queue.length = 0;
      return;
    }
    if (!stream.queue.length) {
      return;
    }
    stream.applying = true;
    this.app.viewport.panMomentum(
      stream.queue.splice(0),
      stream.blocked,
      () => this.momentum === stream,
      (blocked) => {
        stream.applying = false;
        stream.blocked.x ||= blocked.x;
        stream.blocked.y ||= blocked.y;
        this.consumeMomentum(stream);
      },
    );
  };

  /**
   * Prevents the browser's own zoom over the non-interactive editor while
   * letting regular scroll through (trackpad pinch is delivered as
   * ctrl+wheel).
   */
  preventBrowserZoom = (event: WheelEvent) => {
    if (event[KEYS.CTRL_OR_CMD]) {
      event.preventDefault();
    }
  };

  /** zooms around the pointer by a wheel delta (positive = zoom out) */
  private zoomBy = (deltaY: number) => {
    const { viewport } = this.app;

    const sign = Math.sign(deltaY);
    const MAX_STEP = ZOOM_STEP * 100;
    const absDelta = Math.abs(deltaY);
    let delta = deltaY;
    if (absDelta > MAX_STEP) {
      delta = MAX_STEP * sign;
    }

    // where the pointer is now — the updater below runs when React flushes,
    // by which time the pointer may have moved on (`lastPosition` is live)
    const { x: viewportX, y: viewportY } = viewport.lastPosition;

    const didTranslate = viewport.translate(
      // computed from the state the zoom applies to, not `app.state`: wheel
      // ticks arriving before React has flushed the previous one would
      // otherwise all start from the same zoom and collapse into one step
      (state) => {
        let newZoom = state.zoom.value - delta / 100;
        // increase zoom steps the more zoomed-in we are (applies to >100% only)
        newZoom +=
          Math.log10(Math.max(1, state.zoom.value)) *
          -sign *
          // reduced amplification for small deltas (small movements on a trackpad)
          Math.min(1, absDelta / 20);

        const minZoom = state.scrollConstraints?.lockZoom
          ? state.scrollConstraints.zoom
          : MIN_ZOOM;
        const nextZoom = getNormalizedZoom(Math.max(newZoom, minZoom));
        if (nextZoom === state.zoom.value) {
          // at a zoom limit there is nothing to do; flipping the bitmap-cache
          // flag would only redraw the scene on every tick
          return null;
        }

        return {
          ...getViewportForZoomWithScrollConstraints(
            { viewportX, viewportY, nextZoom },
            state,
          ),
          shouldCacheIgnoreZoom: true,
        };
      },
      {
        zoomPreConstrained: true,
        preserveScrollConstraintsSnapBack: true,
      },
    );
    if (didTranslate) {
      this.app.resetShouldCacheIgnoreZoomDebounced();
    }
  };
}
