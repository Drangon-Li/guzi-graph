import type { ViewportGesture } from "@excalidraw/excalidraw/types";

export const PAGE_PULL_THRESHOLD = 64;
export const PAGE_PULL_RESET = 56;
export const WHEEL_PAGE_IDLE = 200;

/** Wheel idle approximates release; browsers do not expose finger-up. */
export class PageGesture {
  progress = 0;
  armed = false;
  private source: ViewportGesture["source"] | null = null;
  private cancelled = false;
  private eligible = false;
  private boundarySeen = false;
  private origin = 0;
  private cooldownUntil = 0;

  get active() {
    return this.source !== null;
  }

  cancel = () => {
    this.progress = 0;
    this.armed = false;
    // Keep the stream identity until release, so Escape cannot re-arm it.
    this.cancelled = true;
  };

  update(gesture: ViewportGesture, pastEnd: number, now: number) {
    if (gesture.phase === "cancel") {
      this.cancel();
      return false;
    }
    if (
      gesture.phase === "begin" ||
      ((!this.source || (this.cancelled && this.source !== gesture.source)) &&
        gesture.source === "wheel" &&
        gesture.phase === "move")
    ) {
      this.source = gesture.source;
      this.progress = 0;
      this.armed = false;
      this.cancelled = false;
      this.eligible = gesture.source === "pointer" || now >= this.cooldownUntil;
      this.origin = Math.max(0, pastEnd);
      this.boundarySeen = pastEnd >= 0;
      // The first wheel event establishes its actual position, even if it
      // crosses the whole page. Further movement must express continuation.
      if (gesture.source === "wheel") {
        return false;
      }
    }
    if (gesture.source !== this.source) {
      this.cancel();
      return false;
    }
    if (gesture.phase === "end") {
      const create =
        !this.cancelled && this.eligible && this.armed && pastEnd >= 0;
      if (create) {
        this.cooldownUntil = now + 800;
      }
      this.progress = 0;
      this.armed = false;
      this.source = null;
      this.cancelled = false;
      return create;
    }
    if (gesture.phase !== "move" || this.cancelled || !this.eligible) {
      return false;
    }
    if (pastEnd < 0) {
      this.progress = 0;
      this.armed = false;
      this.origin = 0;
      this.boundarySeen = false;
      return false;
    }
    if (!this.boundarySeen) {
      this.boundarySeen = true;
      if (gesture.source === "wheel") {
        this.origin = pastEnd;
        return false;
      }
    }
    // Actual screen displacement, rather than summed deltas, makes retreat
    // and repeated small back-and-forth movements predictable at every zoom.
    this.progress = Math.max(0, pastEnd - this.origin);
    if (gesture.deltaY > 0 && this.progress >= PAGE_PULL_THRESHOLD) {
      this.armed = true;
    } else if (this.progress < PAGE_PULL_RESET) {
      this.armed = false;
    }
    return false;
  }
}
