import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { getSystemFontId } from "@excalidraw/common";

import { DEFAULT_EDITOR_PREFERENCES, PreferencePanel } from "./PreferencePanel";

vi.mock("../../shared/ui/DesktopControls", () => ({
  DesktopSelect: ({
    label,
    value,
    options,
    onValueChange,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "queryLocalFonts");
});

it("enumerates real installed font names and saves a stable id with the family", async () => {
  const queryLocalFonts = vi.fn(async () => [
    { family: "Songti SC", fullName: "Songti SC Regular" },
    { family: "Songti SC", fullName: "Songti SC Bold" },
    { family: "Installed Test Font", fullName: "Installed Test Font" },
  ]);
  Object.defineProperty(window, "queryLocalFonts", {
    value: queryLocalFonts,
    configurable: true,
  });
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      preferences={DEFAULT_EDITOR_PREFERENCES}
      section="fonts"
      language="zh-CN"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "读取本机已安装字体" }));
  await screen.findByRole("combobox", { name: "本机字体" });
  expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("option", { name: "Songti SC" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "添加并设为默认字体" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultFontFamily: getSystemFontId("Songti SC"),
        defaultFontName: "Songti SC",
        systemFonts: [
          { id: getSystemFontId("Songti SC"), family: "Songti SC" },
        ],
      }),
    ),
  );
});

it("changes canvas defaults separately from background shortcuts", async () => {
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      preferences={DEFAULT_EDITOR_PREFERENCES}
      section="background"
      language="zh-CN"
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("默认画布背景"), {
    target: { value: "#ddeeff" },
  });
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultBackground: "#ddeeff",
        backgroundTopPicks: DEFAULT_EDITOR_PREFERENCES.backgroundTopPicks,
      }),
    ),
  );
});

it.each(["elementStroke", "elementBackground"] as const)(
  "saves transparent defaults and separate shortcuts for %s",
  async (section) => {
    const onChange = vi.fn();
    render(
      <PreferencePanel
        root={document.body}
        preferences={DEFAULT_EDITOR_PREFERENCES}
        section={section}
        language="zh-CN"
        onChange={onChange}
      />,
    );
    const colorLabel = section === "elementStroke" ? "描边" : "填充";
    fireEvent.change(screen.getByLabelText(`默认${colorLabel}颜色`), {
      target: { value: "#123456" },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [section === "elementStroke"
            ? "defaultStrokeColor"
            : "defaultElementBackground"]: "#123456",
        }),
      ),
    );
    fireEvent.click(screen.getByLabelText("默认使用透明色"));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [section === "elementStroke"
            ? "defaultStrokeColor"
            : "defaultElementBackground"]: "transparent",
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText(`${colorLabel}快捷项 1`), {
      target: { value: "#abcdef" },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [section === "elementStroke"
            ? "elementStrokeTopPicks"
            : "elementBackgroundTopPicks"]: expect.arrayContaining(["#abcdef"]),
          backgroundTopPicks: DEFAULT_EDITOR_PREFERENCES.backgroundTopPicks,
        }),
      ),
    );
  },
);

it("validates four increasing font sizes and persists them together", async () => {
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="fontSizes"
      language="zh-CN"
      onChange={onChange}
    />,
  );
  const inputs = ["S", "M", "L", "XL"].map((label) =>
    screen.getByRole<HTMLInputElement>("spinbutton", { name: `${label} 字号` }),
  );
  expect(new Set(inputs.map((input) => input.id)).size).toBe(4);
  for (const input of inputs) {
    const label = input.labels?.[0];
    expect(label?.control).toBe(input);
    expect(label?.parentElement).toBe(input.parentElement);
    expect(label).not.toContainElement(input);
  }
  fireEvent.change(screen.getByLabelText("S 字号"), {
    target: { value: "40" },
  });
  fireEvent.click(screen.getByRole("button", { name: "应用字号" }));
  expect(screen.getByRole("alert")).toHaveTextContent("依次递增");
  expect(onChange).not.toHaveBeenCalled();
  for (const [label, value] of [
    ["S", "12"],
    ["M", "18"],
    ["L", "24"],
    ["XL", "40"],
  ]) {
    fireEvent.change(screen.getByLabelText(`${label} 字号`), {
      target: { value },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "应用字号" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fontSizePresets: { sm: 12, md: 18, lg: 24, xl: 40 },
      }),
    ),
  );
});
