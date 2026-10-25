import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { DEFAULT_STYLE_PRESETS } from "../../shared/config/stylePresets";

import { StylePresetPanel } from "./StylePresetPanel";

afterEach(cleanup);

it("persists recorded shortcuts and rejects duplicates", async () => {
  const onChange = vi.fn(async () => {});
  render(
    <StylePresetPanel
      root={document.body}
      presets={DEFAULT_STYLE_PRESETS}
      language="zh-CN"
      onChange={onChange}
    />,
  );
  const shortcut = screen.getByRole("textbox", { name: "快捷键 实线箭头" });
  fireEvent.keyDown(shortcut, { key: "3", code: "Digit3", altKey: true });
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "solid-arrow", shortcut: "Alt+3" }),
      DEFAULT_STYLE_PRESETS[1],
    ]),
  );
  onChange.mockClear();
  fireEvent.keyDown(shortcut, { key: "2", code: "Digit2", altKey: true });
  expect(screen.getByRole("alert")).toHaveTextContent("此快捷键已被占用");
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps editing keys inside the panel and preserves Tab navigation", () => {
  const onCanvasKeyDown = vi.fn();
  const onChange = vi.fn(async () => {});
  render(
    <div onKeyDown={onCanvasKeyDown}>
      <StylePresetPanel
        root={document.body}
        presets={DEFAULT_STYLE_PRESETS}
        language="en"
        onChange={onChange}
      />
    </div>,
  );
  const name = screen.getByRole("textbox", { name: "Preset name 实线箭头" });
  fireEvent.keyDown(name, { key: "v" });
  const shortcut = screen.getByRole("textbox", { name: "Shortcut 实线箭头" });
  expect(fireEvent.keyDown(shortcut, { key: "Tab" })).toBe(true);
  expect(onCanvasKeyDown).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it("applies palette colors and their shades to the chosen preset", async () => {
  const onChange = vi.fn(async () => {});
  render(
    <StylePresetPanel
      root={document.body}
      presets={DEFAULT_STYLE_PRESETS}
      language="en"
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Color 实线箭头 — Common colors",
  });
  fireEvent.click(trigger);
  expect(
    screen.queryByRole("button", { name: "Transparent transparent" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Blue #1971c2" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "solid-arrow", strokeColor: "#1971c2" }),
      DEFAULT_STYLE_PRESETS[1],
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Blue shade 2 #a5d8ff" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "solid-arrow", strokeColor: "#a5d8ff" }),
      DEFAULT_STYLE_PRESETS[1],
    ]),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});
