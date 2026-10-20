import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { StylePresetPanel } from "./StylePresetPanel";
import { DEFAULT_STYLE_PRESETS } from "./stylePresets";

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
