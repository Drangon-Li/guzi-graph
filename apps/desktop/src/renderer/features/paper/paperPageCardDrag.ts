const DRAG_THRESHOLD = 5;
const SCROLL_EDGE = 32;

export const startPaperPageCardDrag = ({
  source,
  list,
  pointer,
  onMove,
  onFinish,
}: {
  source: HTMLLIElement;
  list: HTMLOListElement;
  pointer: { pointerId: number; clientX: number; clientY: number };
  onMove: (target: string | null) => void;
  onFinish: (moved: boolean, target: string | null) => void;
}) => {
  const ownerDocument = list.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const origin = source.getBoundingClientRect();
  const offsetX = pointer.clientX - origin.left;
  const offsetY = pointer.clientY - origin.top;
  const rows = Array.from(
    list.querySelectorAll<HTMLLIElement>("li[data-page-id]"),
  );
  const sourceIndex = rows.indexOf(source);
  let x = pointer.clientX;
  let y = pointer.clientY;
  let preview: HTMLDivElement | null = null;
  let target: string | null = null;
  let frame = 0;

  const updateDrop = () => {
    const bounds = list.getBoundingClientRect();
    let next: string | null = null;
    const inside =
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom;
    if (inside) {
      for (const [index, row] of rows.entries()) {
        const rect = row.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (index < sourceIndex && y <= middle) {
          next = row.dataset.pageId!;
          break;
        }
        if (index > sourceIndex && y >= middle) {
          next = row.dataset.pageId!;
        }
      }
    }
    if (next !== target) {
      target = next;
      onMove(target);
    }
    if (!inside) {
      return 0;
    }
    const edge = Math.min(SCROLL_EDGE, bounds.height / 4);
    if (y < bounds.top + edge) {
      return -Math.ceil((bounds.top + edge - y) / 3);
    }
    return y > bounds.bottom - edge
      ? Math.ceil((y - bounds.bottom + edge) / 3)
      : 0;
  };

  const autoScroll = () => {
    frame = 0;
    const distance = updateDrop();
    const before = list.scrollTop;
    list.scrollTop += distance;
    if (list.scrollTop !== before) {
      updateDrop();
      frame = ownerWindow.requestAnimationFrame(autoScroll);
    }
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer.pointerId) {
      return;
    }
    x = event.clientX;
    y = event.clientY;
    if (!preview) {
      if (
        Math.hypot(x - pointer.clientX, y - pointer.clientY) < DRAG_THRESHOLD
      ) {
        return;
      }
      preview = ownerDocument.createElement("div");
      preview.className = "desktop-paper-page-drag-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.inert = true;
      preview.style.width = `${origin.width}px`;
      const style = ownerWindow.getComputedStyle(source);
      preview.style.color = style.color;
      preview.style.setProperty(
        "--island-bg-color",
        style.getPropertyValue("--island-bg-color"),
      );
      preview.append(source.cloneNode(true));
      ownerDocument.body.append(preview);
      source.setPointerCapture(pointer.pointerId);
      onMove(null);
    }
    event.preventDefault();
    preview.style.transform = `translate3d(${x - offsetX}px, ${
      y - offsetY
    }px, 0)`;
    const scroll = updateDrop();
    if (scroll && !frame) {
      frame = ownerWindow.requestAnimationFrame(autoScroll);
    }
  };

  const finish = (commit: boolean, notify = true) => {
    ownerWindow.removeEventListener("pointermove", move, true);
    ownerWindow.removeEventListener("pointerup", release, true);
    ownerWindow.removeEventListener("pointercancel", cancelPointer, true);
    ownerWindow.removeEventListener("blur", cancel);
    ownerWindow.removeEventListener("keydown", escape, true);
    source.removeEventListener("lostpointercapture", lostCapture);
    ownerWindow.cancelAnimationFrame(frame);
    if (preview) {
      preview.remove();
      if (source.hasPointerCapture(pointer.pointerId)) {
        source.releasePointerCapture(pointer.pointerId);
      }
    }
    if (notify) {
      onFinish(!!preview, commit ? target : null);
    }
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId === pointer.pointerId) {
      x = event.clientX;
      y = event.clientY;
      if (preview) {
        updateDrop();
      }
      finish(true);
    }
  };
  const cancel = () => finish(false);
  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === pointer.pointerId) {
      cancel();
    }
  };
  const lostCapture = (event: PointerEvent) => {
    if (event.target === source) {
      cancelPointer(event);
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  ownerWindow.addEventListener("pointermove", move, true);
  ownerWindow.addEventListener("pointerup", release, true);
  ownerWindow.addEventListener("pointercancel", cancelPointer, true);
  ownerWindow.addEventListener("blur", cancel);
  ownerWindow.addEventListener("keydown", escape, true);
  source.addEventListener("lostpointercapture", lostCapture);
  return (notify = true) => finish(false, notify);
};
