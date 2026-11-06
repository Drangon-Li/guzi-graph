import type { ViewportGesture } from "@excalidraw/excalidraw/types";

export const PAGE_PULL_THRESHOLD = 64;
export const PAGE_PULL_RESET = 56;
const EDGE_EPSILON = 1e-8;

export class PageGesture {
  progress = 0;
  armed = false;
  private source: ViewportGesture["source"] | null = null;
  private cancelled = false;
  private atEnd = false;

  get active() {
    return this.source !== null;
  }

  cancel = () => {
    this.progress = 0;
    this.armed = false;
    // Escape suppresses this stream until its physical release.
    this.cancelled = true;
  };

  update(gesture: ViewportGesture, pastEnd: number) {
    const atEnd = pastEnd >= -EDGE_EPSILON;
    if (gesture.phase === "cancel") {
      this.cancel();
      this.source = null;
      return false;
    }
    if (
      gesture.phase === "begin" ||
      (!this.source && gesture.source === "wheel" && gesture.phase === "move")
    ) {
      this.source = gesture.source;
      this.progress = 0;
      this.armed = false;
      this.cancelled = false;
      this.atEnd = atEnd;
      // A wheel event reaching the edge establishes its baseline. The
      // following direct travel expresses an intent to continue the paper.
      return false;
    }
    if (gesture.source !== this.source) {
      this.cancel();
      return false;
    }
    if (gesture.phase === "end") {
      const create = !this.cancelled && this.armed && pastEnd > EDGE_EPSILON;
      this.progress = 0;
      this.armed = false;
      this.source = null;
      return create;
    }
    if (gesture.phase !== "move" || this.cancelled) {
      return false;
    }
    if (!atEnd) {
      this.progress = 0;
      this.armed = false;
      this.atEnd = false;
      return false;
    }
    if (!this.atEnd) {
      this.atEnd = true;
      if (gesture.source === "wheel") {
        return false;
      }
      this.progress = Math.min(0, gesture.previousPastEnd ?? 0);
    }
    this.progress =
      gesture.deltaY < 0 && pastEnd <= EDGE_EPSILON
        ? 0
        : Math.min(
            PAGE_PULL_THRESHOLD,
            Math.max(0, this.progress + gesture.deltaY),
          );
    if (
      gesture.deltaY > 0 &&
      this.progress + EDGE_EPSILON >= PAGE_PULL_THRESHOLD
    ) {
      this.armed = true;
    } else if (this.progress + EDGE_EPSILON < PAGE_PULL_RESET) {
      this.armed = false;
    }
    return false;
  }
}
