import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SettingsPanel } from "./SettingsPanel";

import type { DesktopAPI, DesktopSettings } from "../../../shared/desktop-api";

beforeEach(() => {
  document.defaultView!.desktop = {
    getUpdateState: vi
      .fn()
      .mockResolvedValue({ status: "idle", currentVersion: "0.7.4" }),
    onUpdateState: vi.fn(() => () => {}),
  } as unknown as DesktopAPI;
});
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

it("navigates categories with the keyboard and saves individual tool and file settings", async () => {
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
  await screen.findByText("当前版本：0.7.4");
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

it("opens the built-in MCP settings category", async () => {
  const getPlugins = vi.fn().mockResolvedValue([]);
  document.defaultView!.desktop = {
    ...document.defaultView!.desktop,
    getPlugins,
    onPluginState: () => () => {},
  } as unknown as DesktopAPI;
  render(
    <SettingsPanel
      root={document.body}
      settings={settings}
      onChange={async () => settings}
      onChangeDirectory={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "内置 MCP" }));
  expect(
    screen.getByRole("tabpanel", { name: "内置 MCP" }),
  ).toBeInTheDocument();
  await screen.findByText("内置 MCP 暂不可用。");
  expect(getPlugins).toHaveBeenCalledTimes(1);
});

it("places version and updates in General after appearance and language", async () => {
  render(
    <SettingsPanel
      root={document.body}
      settings={settings}
      onChange={async () => settings}
      onChangeDirectory={async () => {}}
    />,
  );
  await screen.findByText("当前版本：0.7.4");
  expect(
    screen.getByRole("heading", { name: "版本与更新" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("tab", { name: "版本与更新" }),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("heading", { name: "外观" })
      .compareDocumentPosition(
        screen.getByRole("heading", { name: "版本与更新" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
