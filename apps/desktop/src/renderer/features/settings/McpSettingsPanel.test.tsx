import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { connectionConfigs, McpSettingsPanel } from "./McpSettingsPanel";

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
  const view = render(<McpSettingsPanel root={root} language="en" />, {
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
  expect(
    view.queryByRole("switch", { name: "Enable plugin" }),
  ).not.toBeInTheDocument();
  expect(
    view.getByText(
      "Changing the port restarts the enabled MCP service. Port range: 1024–65535.",
    ),
  ).toBeInTheDocument();
  expect(
    view.getByText(
      "Enable MCP and keep Guzi running to connect to the current canvas.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(view.getByRole("switch", { name: "Enable MCP" }));
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

it("summarizes commands into localized capabilities without showing internal names", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const capabilities = [
    "get_capabilities",
    "list_canvases",
    "create_canvas",
    "open_canvas",
    "close_document",
    "control_canvas",
    "read_canvas",
    "apply_operations",
    "export_canvas",
    "save_canvas",
    "create_presentation",
    "read_presentation",
    "update_presentation",
    "control_presentation",
    "export_presentation",
    "save_presentation",
    "get_plugin_development_guide",
    "get_plugin_api_schema",
    "list_plugins",
    "get_plugin",
    "validate_plugin",
    "install_plugin",
    "update_plugin",
    "run_plugin_command",
    "future_tool",
  ];
  view.emit([{ ...plugin, capabilities }]);
  const chips = view.container.querySelector(".desktop-plugin-capabilities")!;
  expect(chips.children).toHaveLength(4);
  for (const label of [
    "Canvas read & write",
    "Presentations",
    "Save & export",
    "Plugin development & management",
  ]) {
    expect(view.getAllByText(label)).toHaveLength(1);
  }
  for (const command of capabilities) {
    expect(view.queryByText(command)).not.toBeInTheDocument();
  }
  const root = view.container;
  view.rerender(<McpSettingsPanel root={root} language="zh-CN" />);
  for (const label of [
    "画布读写",
    "演示文稿",
    "保存与导出",
    "插件开发与管理",
  ]) {
    expect(view.getAllByText(label)).toHaveLength(1);
  }
  view.emit([{ ...plugin, capabilities: ["future_tool"] }]);
  expect(chips.children).toHaveLength(0);
  expect(view.getByText(plugin.description)).toBeInTheDocument();
  expect(
    view.getByRole("spinbutton", { name: "本地端口" }),
  ).toBeInTheDocument();
  expect(capabilities[0]).toBe("get_capabilities");
});

it("only shows the built-in MCP service", async () => {
  const view = mount();
  await view.findByText("Disabled");
  view.emit([plugin, { ...plugin, id: "other", name: "Another service" }]);
  expect(view.getByRole("article", { name: "Guzi MCP" })).toBeInTheDocument();
  expect(
    view.queryByRole("article", { name: "Another service" }),
  ).not.toBeInTheDocument();
});
