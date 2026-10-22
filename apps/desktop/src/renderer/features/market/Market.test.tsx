import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { connectionConfigs, Market } from "./Market";

import type { DesktopAPI } from "../../../shared/desktop-api";
import type { PluginState } from "../../../shared/plugins";

const plugin: PluginState = {
  id: "mcp",
  name: "Guzi MCP",
  description: "Connect your canvas",
  version: "1.0.0",
  capabilities: ["Canvas tools"],
  enabled: false,
  status: "disabled",
  port: 27831,
};
const roots: HTMLElement[] = [];
const mount = (ownerDocument = document) => {
  const root = ownerDocument.createElement("div");
  ownerDocument.body.append(root);
  roots.push(root);
  let listener: (plugins: PluginState[]) => void = () => undefined;
  const unsubscribe = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(ownerDocument.defaultView!.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const desktop = {
    getPlugins: vi.fn().mockResolvedValue([plugin]),
    onPluginState: vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    }),
    setPluginEnabled: vi
      .fn()
      .mockResolvedValue([{ ...plugin, enabled: true, status: "starting" }]),
    configurePlugin: vi.fn().mockResolvedValue([{ ...plugin, port: 27832 }]),
  };
  ownerDocument.defaultView!.desktop = desktop as unknown as DesktopAPI;
  const view = render(<Market root={root} language="en" />, {
    container: root,
  });
  return {
    ...view,
    desktop,
    writeText,
    unsubscribe,
    emit: (states: PluginState[]) => act(() => listener(states)),
  };
};
afterEach(() => {
  cleanup();
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

it("enables a real plugin and reflects pushed lifecycle states", async () => {
  const view = mount();
  await view.findByText("Disabled");
  fireEvent.click(view.getByRole("switch", { name: "Enable plugin" }));
  await view.findByText("Starting");
  expect(view.desktop.setPluginEnabled).toHaveBeenCalledWith("mcp", true);
  expect(view.getByRole("switch")).toBeDisabled();
  view.emit([
    { ...plugin, enabled: true, status: "error", error: "Port is in use" },
  ]);
  expect(view.getByRole("alert")).toHaveTextContent("Port is in use");
  expect(view.getByRole("switch")).not.toBeDisabled();
  view.unmount();
  expect(view.unsubscribe).toHaveBeenCalledTimes(1);
});

it("validates port changes and sends the selected port", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const input = view.getByRole("spinbutton", { name: "Local port" });
  fireEvent.change(input, { target: { value: "80" } });
  expect(view.getByRole("button", { name: "Apply port" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "27832" } });
  fireEvent.click(view.getByRole("button", { name: "Apply port" }));
  await waitFor(() =>
    expect(view.desktop.configurePlugin).toHaveBeenCalledWith("mcp", {
      port: 27832,
    }),
  );
});

it("keeps tokens hidden until explicitly revealed and copies current connection settings", async () => {
  const view = mount();
  await view.findByText("Disabled");
  expect(view.getByRole("button", { name: "Copy token" })).toBeDisabled();
  const running: PluginState = {
    ...plugin,
    enabled: true,
    status: "running",
    endpoint: "http://127.0.0.1:27832/mcp",
    token: "secret-token",
  };
  view.emit([running]);
  expect(view.queryByText("secret-token")).not.toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Show token" }));
  expect(view.getByText("secret-token")).toBeInTheDocument();
  fireEvent.click(
    view.getByRole("button", { name: "Copy Codex configuration" }),
  );
  await waitFor(() =>
    expect(view.writeText).toHaveBeenCalledWith(
      connectionConfigs(running).codex,
    ),
  );
  expect(connectionConfigs(running).codex).not.toContain("secret-token");
  fireEvent.click(
    view.getByRole("button", {
      name: "Copy Codex desktop configuration (includes token)",
    }),
  );
  await waitFor(() =>
    expect(view.writeText).toHaveBeenCalledWith(
      expect.stringContaining('Authorization = "Bearer secret-token"'),
    ),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Copy Claude Code configuration" }),
  );
  await waitFor(() =>
    expect(view.writeText).toHaveBeenCalledWith(
      connectionConfigs(running).claude,
    ),
  );
  expect(
    JSON.parse(connectionConfigs(running).claude).mcpServers.guzi.headers
      .Authorization,
  ).toBe(`Bearer \${GUZI_MCP_TOKEN}`);
});

it("uses the mounted document's bridge and clipboard", async () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const view = mount(iframe.contentDocument!);
  await view.findByText("Disabled");
  expect(view.desktop.getPlugins).toHaveBeenCalledTimes(1);
  view.unmount();
  iframe.remove();
});

it("localizes capability labels while retaining unknown capability names", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const capabilities = [
    "list_canvases",
    "create_canvas",
    "open_canvas",
    "read_canvas",
    "apply_operations",
    "export_canvas",
    "save_canvas",
    "future_tool",
  ];
  view.emit([{ ...plugin, capabilities }]);
  for (const label of [
    "List canvases",
    "Create canvas",
    "Open canvas",
    "Read canvas",
    "Draw and edit",
    "Export canvas",
    "Save canvas",
    "future_tool",
  ]) {
    expect(view.getByText(label)).toBeInTheDocument();
  }
  expect(view.queryByText("list_canvases")).not.toBeInTheDocument();
  const root = view.container;
  view.rerender(<Market root={root} language="zh-CN" />);
  for (const label of [
    "查看画布列表",
    "创建画布",
    "打开画布",
    "读取画布",
    "绘图与修改",
    "导出画布",
    "保存画布",
    "future_tool",
  ]) {
    expect(view.getByText(label)).toBeInTheDocument();
  }
  expect(capabilities[0]).toBe("list_canvases");
});
