import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { SlideNotesPopover } from "./SlideNotes";

import type { ComponentProps } from "react";

let anchor: HTMLButtonElement;
let container: HTMLDivElement;

const makeProps = (
  mode: "preview" | "edit" = "edit",
): ComponentProps<typeof SlideNotesPopover> => ({
  id: "slide-notes",
  anchor,
  container,
  title: "Introduction",
  notes: "First line\nSecond line",
  mode,
  language: "en",
  onChange: vi.fn(),
  onEditingEnd: vi.fn(),
  onClose: vi.fn(),
  onMouseEnter: vi.fn(),
  onMouseLeave: vi.fn(),
});

beforeEach(() => {
  anchor = document.createElement("button");
  container = document.createElement("div");
  document.body.append(anchor, container);
});

afterEach(() => {
  cleanup();
  anchor.remove();
  container.remove();
  vi.restoreAllMocks();
});

it("previews literal multiline notes in the portal without moving focus", () => {
  const props = makeProps("preview");
  const notes = "First line\n<img src=x onerror=alert(1)>";
  anchor.focus();
  render(<SlideNotesPopover {...props} notes={notes} />);

  const preview = screen.getByRole("tooltip");
  expect(preview.parentElement).toBe(container);
  expect(preview.querySelector("img")).toBeNull();
  expect(
    preview.querySelector(".desktop-slide-notes-preview")?.textContent,
  ).toBe(notes);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(anchor).toHaveFocus();

  fireEvent.mouseOver(preview);
  fireEvent.mouseOut(preview);
  expect(props.onMouseEnter).toHaveBeenCalledTimes(1);
  expect(props.onMouseLeave).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(anchor, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledWith();
});

it("focuses the editor and reports edits and the end of editing separately", () => {
  const props = makeProps();
  const view = render(<SlideNotesPopover {...props} mode="preview" />);
  view.rerender(<SlideNotesPopover {...props} />);

  expect(
    screen.getByRole("dialog", { name: "Notes for Introduction" }),
  ).toBeInTheDocument();
  const textarea = screen.getByRole("textbox", {
    name: "Notes for Introduction",
  });
  const done = screen.getByRole("button", { name: "Done" });
  expect(textarea).toHaveFocus();
  expect(textarea).toHaveValue(props.notes);

  fireEvent.change(textarea, { target: { value: "New line\n" } });
  expect(props.onChange).toHaveBeenCalledWith("New line\n");
  expect(props.onClose).not.toHaveBeenCalled();

  act(() => done.focus());
  expect(props.onEditingEnd).toHaveBeenCalledTimes(1);
  fireEvent.click(done);
  expect(props.onClose).toHaveBeenCalledWith(true);
});

it("lets Escape finish composition before dismissing the editor", () => {
  const props = makeProps();
  render(<SlideNotesPopover {...props} />);
  const textarea = screen.getByRole("textbox");
  fireEvent.compositionStart(textarea);
  fireEvent.keyDown(textarea, { key: "Escape", isComposing: true });
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.compositionEnd(textarea);
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledWith(true);
});

it("dismisses on an outside pointer press without stealing focus", () => {
  const props = makeProps();
  const onPointerDown = vi.fn();
  render(
    <div onPointerDown={onPointerDown}>
      <SlideNotesPopover {...props} />
    </div>,
  );
  const textarea = screen.getByRole("textbox");

  fireEvent.pointerDown(textarea);
  fireEvent.pointerDown(anchor);
  expect(onPointerDown).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();

  fireEvent.pointerDown(document.body);
  expect(props.onClose).toHaveBeenCalledWith();
});

it("keeps the popover at its anchor and inside the viewport after scrolling", () => {
  const anchorBounds = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(6, 240, 18, 18));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 320, 96),
  );
  render(<SlideNotesPopover {...makeProps("preview")} />);
  const preview = screen.getByRole("tooltip");

  expect(preview.style.left).toBe("8px");
  expect(preview.style.top).toBe("138px");
  anchorBounds.mockReturnValue(new DOMRect(window.innerWidth - 20, 2, 18, 18));
  fireEvent.scroll(container);
  expect(preview.style.left).toBe(`${window.innerWidth - 328}px`);
  expect(preview.style.top).toBe("26px");
});

it("aligns with the notes button horizontally and clears the whole slide card vertically", () => {
  const card = document.createElement("li");
  card.className = "desktop-slide-item";
  card.append(anchor);
  container.append(card);
  const cardBounds = vi
    .spyOn(card, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(320, 250, 176, 146));
  const anchorBounds = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(460, 372, 18, 18));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 320, 96),
  );
  render(<SlideNotesPopover {...makeProps("preview")} />);
  const preview = screen.getByRole("tooltip");

  expect(preview.style.left).toBe("158px");
  expect(preview.style.top).toBe("148px");

  cardBounds.mockReturnValue(new DOMRect(320, 10, 176, 146));
  anchorBounds.mockReturnValue(new DOMRect(460, 132, 18, 18));
  fireEvent.resize(window);
  expect(preview.style.top).toBe("162px");
});

it("isolates editing and clipboard events while allowing the save shortcut", () => {
  const props = makeProps();
  const onKey = vi.fn();
  const onClipboard = vi.fn();
  const clipboardTypes = ["copy", "cut", "paste"];
  render(<SlideNotesPopover {...props} />);
  const textarea = screen.getByRole("textbox");

  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKey);
  clipboardTypes.forEach((type) =>
    document.addEventListener(type, onClipboard),
  );
  try {
    expect(fireEvent.keyDown(textarea, { key: "Backspace" })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "z", metaKey: true })).toBe(true);
    fireEvent.keyUp(textarea, { key: "Backspace" });
    for (const type of clipboardTypes) {
      expect(
        fireEvent(
          textarea,
          new Event(type, { bubbles: true, cancelable: true }),
        ),
      ).toBe(true);
    }
    expect(onKey).not.toHaveBeenCalled();
    expect(onClipboard).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    expect(onKey).toHaveBeenCalledTimes(2);
  } finally {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKey);
    clipboardTypes.forEach((type) =>
      document.removeEventListener(type, onClipboard),
    );
  }
});
