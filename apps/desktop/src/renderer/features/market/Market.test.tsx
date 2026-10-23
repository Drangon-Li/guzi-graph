import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { Market } from "./Market";

import type { DesktopAPI } from "../../../shared/desktop-api";
import type {
  UserPluginPackage,
  UserPluginState,
} from "../../../shared/plugins";

const plugin: UserPluginState = {
  manifest: {
    id: "canvas-helper",
    name: "Canvas helper",
    description: "Tools for this canvas",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["canvas:read"],
    commands: [{ id: "inspect", title: "Inspect canvas" }],
  },
  enabled: false,
  status: "disabled",
};
const pkg: UserPluginPackage = {
  manifest: plugin.manifest,
  source: "export function activate() {}",
};
const roots: HTMLElement[] = [];
const mount = (ownerDocument = document, loadError?: Error) => {
  const root = ownerDocument.createElement("div");
  ownerDocument.body.append(root);
  roots.push(root);
  let listener: (plugins: UserPluginState[]) => void = () => undefined;
  const unsubscribe = vi.fn();
  const desktop = {
    getPlugins: vi.fn(),
    onPluginState: vi.fn(),
    getUserPlugins: loadError
      ? vi.fn().mockRejectedValue(loadError)
      : vi.fn().mockResolvedValue([plugin]),
    onUserPluginState: vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    }),
    setUserPluginEnabled: vi
      .fn()
      .mockResolvedValue([{ ...plugin, enabled: true, status: "starting" }]),
    runUserPluginCommand: vi.fn().mockResolvedValue({ count: 1 }),
    installUserPlugin: vi.fn().mockResolvedValue([plugin]),
    removeUserPlugin: vi.fn().mockResolvedValue([]),
  };
  ownerDocument.defaultView!.desktop = desktop as unknown as DesktopAPI;
  const view = render(<Market root={root} language="en" />, {
    container: root,
  });
  return {
    ...view,
    desktop,
    unsubscribe,
    emit: (states: UserPluginState[]) => act(() => listener(states)),
  };
};
afterEach(() => {
  cleanup();
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

it("shows local plugins and directs MCP configuration to settings", async () => {
  const view = mount();
  await view.findByText("Disabled");
  expect(
    view.getByRole("article", { name: "Canvas helper" }),
  ).toBeInTheDocument();
  expect(view.queryByText("Guzi MCP")).not.toBeInTheDocument();
  expect(view.queryByText("Connection settings")).not.toBeInTheDocument();
  expect(view.desktop.getPlugins).not.toHaveBeenCalled();
  expect(view.desktop.onPluginState).not.toHaveBeenCalled();
  expect(view.getByText(/Settings → Built-in MCP/)).toBeInTheDocument();
});

it("enables and disables local plugins while reflecting lifecycle errors", async () => {
  const view = mount();
  await view.findByText("Disabled");
  expect(view.getByRole("button", { name: "Inspect canvas" })).toBeDisabled();
  fireEvent.click(view.getByRole("switch", { name: "Enable plugin" }));
  await view.findByText("Starting");
  expect(view.desktop.setUserPluginEnabled).toHaveBeenCalledWith(
    "canvas-helper",
    true,
  );
  expect(view.getByRole("switch")).not.toBeDisabled();
  expect(view.getByRole("switch")).toBeChecked();
  view.emit([
    { ...plugin, enabled: true, status: "error", error: "Activation failed" },
  ]);
  expect(view.getByRole("alert")).toHaveTextContent("Activation failed");
  expect(view.getByRole("switch")).not.toBeDisabled();
  view.desktop.setUserPluginEnabled.mockResolvedValueOnce([plugin]);
  fireEvent.click(view.getByRole("switch"));
  await view.findByText("Disabled");
  expect(view.desktop.setUserPluginEnabled).toHaveBeenLastCalledWith(
    "canvas-helper",
    false,
  );
  view.unmount();
  expect(view.unsubscribe).toHaveBeenCalledTimes(1);
});

it("runs declared commands and exposes command failures", async () => {
  const view = mount();
  await view.findByText("Disabled");
  view.emit([{ ...plugin, enabled: true, status: "running" }]);
  fireEvent.click(view.getByRole("button", { name: "Inspect canvas" }));
  await view.findByText("Command completed.");
  expect(view.desktop.runUserPluginCommand).toHaveBeenCalledWith(
    "canvas-helper",
    "inspect",
  );
  view.desktop.runUserPluginCommand.mockRejectedValueOnce(
    new Error("Canvas unavailable"),
  );
  fireEvent.click(view.getByRole("button", { name: "Inspect canvas" }));
  expect(await view.findByRole("alert")).toHaveTextContent(
    "Canvas unavailable",
  );
});

it("imports JSON packages without overwriting and leaves new plugins disabled", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const file = new File([JSON.stringify(pkg)], "helper.json", {
    type: "application/json",
  });
  fireEvent.change(view.getByLabelText("Choose plugin package"), {
    target: { files: [file] },
  });
  await view.findByText("Plugin imported. Enable it to run commands.");
  expect(view.desktop.installUserPlugin).toHaveBeenCalledWith(pkg, false);
  expect(view.getByRole("switch")).not.toBeChecked();
});

it("reports malformed packages and installation errors", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const input = view.getByLabelText("Choose plugin package");
  fireEvent.change(input, {
    target: { files: [new File(["{"], "broken.json")] },
  });
  expect(await view.findByRole("alert")).toHaveTextContent(
    "The plugin package is not valid JSON.",
  );
  expect(view.desktop.installUserPlugin).not.toHaveBeenCalled();
  view.desktop.installUserPlugin.mockRejectedValueOnce(
    new Error("Plugin already installed"),
  );
  fireEvent.change(input, {
    target: { files: [new File([JSON.stringify(pkg)], "helper.json")] },
  });
  await waitFor(() =>
    expect(view.getByRole("alert")).toHaveTextContent(
      "Plugin already installed",
    ),
  );
  expect(view.desktop.installUserPlugin).toHaveBeenCalledWith(pkg, false);
});

it("requires local confirmation before uninstalling", async () => {
  const view = mount();
  await view.findByText("Disabled");
  fireEvent.click(view.getByRole("button", { name: "Uninstall plugin" }));
  expect(view.desktop.removeUserPlugin).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(
    view.queryByRole("button", { name: "Confirm uninstall" }),
  ).not.toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Uninstall plugin" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm uninstall" }));
  await view.findByText("No plugins installed.");
  expect(view.desktop.removeUserPlugin).toHaveBeenCalledWith("canvas-helper");
});

it("uses the mounted document's bridge and file reader", async () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const view = mount(iframe.contentDocument!);
  await view.findByText("Disabled");
  const iframeWindow = iframe.contentDocument!.defaultView!;
  const readAsText = vi.spyOn(iframeWindow.FileReader.prototype, "readAsText");
  fireEvent.change(view.getByLabelText("Choose plugin package"), {
    target: {
      files: [new iframeWindow.File([JSON.stringify(pkg)], "helper.json")],
    },
  });
  await waitFor(() =>
    expect(view.desktop.installUserPlugin).toHaveBeenCalledWith(pkg, false),
  );
  expect(readAsText).toHaveBeenCalledTimes(1);
  expect(view.desktop.getUserPlugins).toHaveBeenCalledTimes(1);
  view.unmount();
  iframe.remove();
});

it("allows disabling a plugin while a command is still pending", async () => {
  const view = mount();
  await view.findByText("Disabled");
  view.emit([{ ...plugin, enabled: true, status: "running" }]);
  let rejectCommand!: (error: Error) => void;
  view.desktop.runUserPluginCommand.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectCommand = reject;
      }),
  );
  fireEvent.click(view.getByRole("button", { name: "Inspect canvas" }));
  expect(view.getByRole("button", { name: "Inspect canvas" })).toBeDisabled();
  expect(view.getByRole("switch")).not.toBeDisabled();
  expect(
    view.getByRole("button", { name: "Uninstall plugin" }),
  ).not.toBeDisabled();
  view.desktop.setUserPluginEnabled.mockResolvedValueOnce([plugin]);
  fireEvent.click(view.getByRole("switch"));
  await view.findByText("Disabled");
  expect(view.desktop.setUserPluginEnabled).toHaveBeenCalledWith(
    "canvas-helper",
    false,
  );
  await act(async () => rejectCommand(new Error("Plugin stopped")));
  expect(view.getByRole("switch")).not.toBeChecked();
  expect(view.getByRole("switch")).not.toBeDisabled();
});

it("rejects packages larger than 2 MiB before reading their contents", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const readAsText = vi.spyOn(
    document.defaultView!.FileReader.prototype,
    "readAsText",
  );
  const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.json");
  fireEvent.change(view.getByLabelText("Choose plugin package"), {
    target: { files: [file] },
  });
  expect(await view.findByRole("alert")).toHaveTextContent(
    "The plugin package must not exceed 2 MiB.",
  );
  expect(readAsText).not.toHaveBeenCalled();
  expect(view.desktop.installUserPlugin).not.toHaveBeenCalled();
});

it("shows configuration errors instead of treating a failed load as an empty list", async () => {
  const view = mount(document, new Error("Plugin configuration is damaged"));
  expect(await view.findByRole("alert")).toHaveTextContent(
    "Plugin configuration is damaged",
  );
  expect(view.queryByText("No plugins installed.")).not.toBeInTheDocument();
});

it("allows canceling startup after the enabled state arrives while the enable request is pending", async () => {
  const view = mount();
  await view.findByText("Disabled");
  let resolveEnable!: (states: UserPluginState[]) => void;
  view.desktop.setUserPluginEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveEnable = resolve;
      }),
  );
  fireEvent.click(view.getByRole("switch"));
  expect(view.getByRole("switch")).toBeDisabled();
  expect(view.getByRole("switch")).not.toBeChecked();
  view.emit([{ ...plugin, enabled: true, status: "starting" }]);
  expect(view.getByRole("switch")).toBeChecked();
  expect(view.getByRole("switch")).not.toBeDisabled();
  expect(view.getByRole("button", { name: "Inspect canvas" })).toBeDisabled();
  view.desktop.setUserPluginEnabled.mockResolvedValueOnce([plugin]);
  fireEvent.click(view.getByRole("switch"));
  await view.findByText("Disabled");
  expect(view.desktop.setUserPluginEnabled).toHaveBeenLastCalledWith(
    "canvas-helper",
    false,
  );
  await act(async () => resolveEnable([plugin]));
});

it("shows localized permission names while retaining API keys in tooltips", async () => {
  const view = mount();
  await view.findByText("Disabled");
  const permissionsPlugin: UserPluginState = {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      permissions: [
        "canvas:read",
        "canvas:write",
        "presentation:read",
        "presentation:write",
        "storage",
      ],
    },
  };
  view.emit([permissionsPlugin]);
  const labels = [
    ["canvas:read", "Read canvases", "读取画布"],
    ["canvas:write", "Edit canvases", "编辑画布"],
    ["presentation:read", "Read presentations", "读取演示文稿"],
    ["presentation:write", "Edit presentations", "编辑演示文稿"],
    ["storage", "Store plugin data", "保存插件数据"],
  ];
  for (const [key, label] of labels) {
    expect(view.getByTitle(key)).toHaveTextContent(label);
    expect(view.queryByText(key)).not.toBeInTheDocument();
  }
  view.desktop.getUserPlugins.mockResolvedValueOnce([permissionsPlugin]);
  await act(async () => {
    view.rerender(<Market root={view.container} language="zh-CN" />);
  });
  for (const [key, , label] of labels) {
    expect(view.getByTitle(key)).toHaveTextContent(label);
  }
});
