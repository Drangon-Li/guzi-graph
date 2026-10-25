import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { FONT_FAMILY, getSystemFontId } from "@excalidraw/common";

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
  const replaceFonts = vi.fn(async () => {});
  render(
    <PreferencePanel
      root={document.body}
      preferences={DEFAULT_EDITOR_PREFERENCES}
      section="fonts"
      language="zh-CN"
      onChange={onChange}
      onApplyFontToOpenDocuments={replaceFonts}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "读取本机已安装字体" }));
  await screen.findByRole("combobox", { name: "本机字体" });
  expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("option", { name: "Songti SC" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "添加并设为默认字体" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "同时替换已打开文档" }));
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
  expect(replaceFonts).toHaveBeenCalledWith(getSystemFontId("Songti SC"));
});

const chooseDefaultFont = () =>
  fireEvent.change(screen.getByRole("combobox", { name: "默认字体" }), {
    target: { value: String(FONT_FAMILY.Nunito) },
  });

it("asks before changing the default and cancels without changing documents", () => {
  const onChange = vi.fn();
  const replaceFonts = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="fonts"
      language="zh-CN"
      onChange={onChange}
      onApplyFontToOpenDocuments={replaceFonts}
    />,
  );
  chooseDefaultFont();
  expect(screen.getByRole("group", { name: "应用默认字体" })).toHaveTextContent(
    "全部已打开文档",
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(replaceFonts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("group", { name: "应用默认字体" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "默认字体" })).toHaveValue(
    String(DEFAULT_EDITOR_PREFERENCES.defaultFontFamily),
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(replaceFonts).not.toHaveBeenCalled();
});

it.each([false, true])(
  "persists the default before optionally replacing open documents (%s)",
  async (replaceExisting) => {
    const calls: string[] = [];
    const onChange = vi.fn(async () => {
      calls.push("save");
    });
    const replaceFonts = vi.fn(async () => {
      calls.push("replace");
    });
    render(
      <PreferencePanel
        root={document.body}
        section="fonts"
        language="zh-CN"
        onChange={onChange}
        onApplyFontToOpenDocuments={replaceFonts}
      />,
    );
    chooseDefaultFont();
    fireEvent.click(
      screen.getByRole("button", {
        name: replaceExisting ? "同时替换已打开文档" : "仅用于新内容",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "应用默认字体" })).toBeNull(),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultFontFamily: FONT_FAMILY.Nunito }),
    );
    expect(calls).toEqual(replaceExisting ? ["save", "replace"] : ["save"]);
    if (replaceExisting) {
      expect(replaceFonts).toHaveBeenCalledWith(FONT_FAMILY.Nunito);
    }
    expect(screen.getByRole("combobox", { name: "默认字体" })).toHaveValue(
      String(FONT_FAMILY.Nunito),
    );
  },
);

it("does not replace existing text when saving the default fails", async () => {
  const replaceFonts = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="fonts"
      language="zh-CN"
      onChange={async () => {
        throw new Error("设置保存失败");
      }}
      onApplyFontToOpenDocuments={replaceFonts}
    />,
  );
  chooseDefaultFont();
  fireEvent.click(screen.getByRole("button", { name: "同时替换已打开文档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("设置保存失败");
  expect(replaceFonts).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "默认字体" })).toHaveValue(
    String(DEFAULT_EDITOR_PREFERENCES.defaultFontFamily),
  );
});

it("waits for persistence and prevents duplicate font replacements", async () => {
  let finishSave!: () => void;
  const onChange = vi.fn(
    () => new Promise<void>((resolve) => (finishSave = resolve)),
  );
  const replaceFonts = vi.fn(async () => {});
  render(
    <PreferencePanel
      root={document.body}
      section="fonts"
      language="zh-CN"
      onChange={onChange}
      onApplyFontToOpenDocuments={replaceFonts}
    />,
  );
  chooseDefaultFont();
  const apply = screen.getByRole("button", { name: "同时替换已打开文档" });
  fireEvent.click(apply);
  fireEvent.click(apply);
  expect(apply).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(replaceFonts).not.toHaveBeenCalled();
  await act(async () => finishSave());
  expect(replaceFonts).toHaveBeenCalledTimes(1);
});

it("reports a replacement failure separately from the saved default", async () => {
  render(
    <PreferencePanel
      root={document.body}
      section="fonts"
      language="zh-CN"
      onChange={async () => {}}
      onApplyFontToOpenDocuments={async () => {
        throw new Error("字体无法加载");
      }}
    />,
  );
  chooseDefaultFont();
  fireEvent.click(screen.getByRole("button", { name: "同时替换已打开文档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "默认字体已保存，但替换已有文字失败：字体无法加载",
  );
  expect(screen.getByRole("combobox", { name: "默认字体" })).toHaveValue(
    String(FONT_FAMILY.Nunito),
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
  fireEvent.click(
    screen.getByRole("button", { name: "默认画布背景 — 常用颜色" }),
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
    fireEvent.click(
      screen.getByRole("button", { name: `默认${colorLabel}颜色 — 常用颜色` }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "关闭色板" }));
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
    fireEvent.click(
      screen.getByRole("button", { name: `${colorLabel}快捷项 1 — 常用颜色` }),
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

it("offers common colors and shades for defaults and new shortcuts without transparent canvas backgrounds", async () => {
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="background"
      language="zh-CN"
      onChange={onChange}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "默认画布背景 — 常用颜色" }),
  );
  expect(screen.queryByRole("button", { name: "透明 transparent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "蓝色 #a5d8ff" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultBackground: "#a5d8ff" }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "蓝色 深浅 4 #228be6" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultBackground: "#228be6" }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭色板" }));
  fireEvent.click(
    screen.getByRole("button", { name: "新颜色快捷项 — 常用颜色" }),
  );
  expect(screen.queryByRole("button", { name: "透明 transparent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "红色 #ffc9c9" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭色板" }));
  expect(screen.getByRole("button", { name: "添加快捷项" })).toBeDisabled();
});

it("saves a chosen common color as a new shortcut and keeps the existing picks", async () => {
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="elementBackground"
      language="en"
      preferences={{
        ...DEFAULT_EDITOR_PREFERENCES,
        elementBackgroundTopPicks: ["transparent"],
      }}
      onChange={onChange}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "New color shortcut — Common colors" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Green #b2f2bb" }));
  fireEvent.click(screen.getByRole("button", { name: "Close color palette" }));
  fireEvent.click(screen.getByRole("button", { name: "Add shortcut" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elementBackgroundTopPicks: ["transparent", "#b2f2bb"],
      }),
    ),
  );
});

it("keeps a shortcut palette open after a family change so its shade can be adjusted", async () => {
  const onChange = vi.fn();
  render(
    <PreferencePanel
      root={document.body}
      section="elementStroke"
      language="en"
      onChange={onChange}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Stroke shortcut 1 — Common colors" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Blue #1971c2" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elementStrokeTopPicks: [
          "#1971c2",
          ...DEFAULT_EDITOR_PREFERENCES.elementStrokeTopPicks.slice(1),
        ],
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Blue shade 2 #a5d8ff" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elementStrokeTopPicks: [
          "#a5d8ff",
          ...DEFAULT_EDITOR_PREFERENCES.elementStrokeTopPicks.slice(1),
        ],
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Transparent transparent" }),
  );
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elementStrokeTopPicks: [
          "transparent",
          ...DEFAULT_EDITOR_PREFERENCES.elementStrokeTopPicks.slice(1),
        ],
      }),
    ),
  );
});
