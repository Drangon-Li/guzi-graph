import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SettingsPanel } from "./SettingsPanel";

import type { DesktopSettings } from "../../../shared/desktop-api";

afterEach(cleanup);

const settings: DesktopSettings = {
  rootDirectory: "/drawings",
  theme: "dark",
  language: "zh-CN",
  toolPanelDock: "floating",
  toolPanelWidth: 280,
  toolbarTooltips: true,
  selectionToolbar: true,
  stickyNoteMode: "note",
  structuredExportFormat: "json",
  includeInferredStructure: true,
  skipRemoveConfirmation: false,
  skipTrashConfirmation: false,
};

it("navigates categories with the keyboard and saves individual tool and file settings", () => {
  const onChange = vi.fn(async () => settings);
  const onChangeDirectory = vi.fn(async () => {});
  render(
    <SettingsPanel
      root={document.body}
      settings={settings}
      onChange={onChange}
      onChangeDirectory={onChangeDirectory}
    />,
  );
  const general = screen.getByRole("tab", { name: "通用" });
  fireEvent.keyDown(general, { key: "ArrowDown" });
  const tools = screen.getByRole("tab", { name: "画布与工具" });
  expect(tools).toHaveFocus();
  expect(tools).toHaveAttribute("aria-selected", "true");
  fireEvent.click(
    screen.getByRole("switch", { name: "显示工具名称和快捷键提示" }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ toolbarTooltips: false });
  fireEvent.click(screen.getByRole("switch", { name: "显示选区悬浮工具栏" }));
  expect(onChange).toHaveBeenLastCalledWith({ selectionToolbar: false });
  fireEvent.click(screen.getByRole("radio", { name: "子画布图钉" }));
  expect(onChange).toHaveBeenLastCalledWith({ stickyNoteMode: "subcanvas" });
  fireEvent.keyDown(tools, { key: "End" });
  expect(
    screen.getByRole("tabpanel", { name: "文件与导出" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择文件夹…" }));
  expect(onChangeDirectory).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("tab", { name: "文件与导出" }), {
    key: "Home",
  });
  expect(general).toHaveFocus();
  expect(screen.getByRole("tabpanel", { name: "通用" })).toBeInTheDocument();
});

it("edits drawing defaults within settings and keeps save failures visible", async () => {
  const onChange = vi.fn(async (): Promise<DesktopSettings | null> => null);
  render(
    <SettingsPanel
      root={document.body}
      settings={settings}
      onChange={onChange}
      onChangeDirectory={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "字体与颜色" }));
  fireEvent.click(screen.getByRole("radio", { name: "字号" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "S 字号" }), {
    target: { value: "14" },
  });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "应用字号" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("设置保存失败"),
  );
  expect(onChange).toHaveBeenCalledWith({
    editorPreferences: expect.objectContaining({
      fontSizePresets: expect.objectContaining({ sm: 14 }),
    }),
  });
  expect(
    screen.getByRole("tabpanel", { name: "字体与颜色" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
