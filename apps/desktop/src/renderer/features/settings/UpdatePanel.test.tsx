import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { UpdatePanel } from "./UpdatePanel";

import type {
  DesktopAPI,
  DesktopUpdateState,
} from "../../../shared/desktop-api";

const idle: DesktopUpdateState = { status: "idle", currentVersion: "0.7.4" };
const roots: HTMLElement[] = [];
const mount = (
  state: DesktopUpdateState = idle,
  snapshot = Promise.resolve(state),
  ownerDocument = document,
) => {
  const root = ownerDocument.createElement("div");
  ownerDocument.body.append(root);
  roots.push(root);
  let listener: (next: DesktopUpdateState) => void = () => {};
  const unsubscribe = vi.fn();
  const desktop = {
    getUpdateState: vi.fn(() => snapshot),
    onUpdateState: vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    }),
    checkForUpdates: vi
      .fn()
      .mockResolvedValue({ ...idle, status: "up-to-date" }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ ...idle, status: "downloaded" }),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  };
  ownerDocument.defaultView!.desktop = desktop as unknown as DesktopAPI;
  const view = render(<UpdatePanel root={root} language="en" />, {
    container: root,
  });
  return {
    ...view,
    root,
    desktop,
    unsubscribe,
    emit: (next: DesktopUpdateState) => act(() => listener(next)),
  };
};
afterEach(() => {
  cleanup();
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

it("checks, downloads, installs and reflects all lifecycle states", async () => {
  const view = mount();
  await view.findByText("Current version: 0.7.4");
  expect(view.desktop.onUpdateState.mock.invocationCallOrder[0]).toBeLessThan(
    view.desktop.getUpdateState.mock.invocationCallOrder[0],
  );
  fireEvent.click(view.getByRole("button", { name: "Check for updates" }));
  await view.findByText("You are up to date.");
  expect(view.desktop.checkForUpdates).toHaveBeenCalledTimes(1);
  view.emit({ ...idle, status: "checking" });
  expect(view.getByRole("button")).toBeDisabled();
  view.emit({ ...idle, status: "available", availableVersion: "0.8.0" });
  expect(view.getByText("Version 0.8.0 is available.")).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Download update" }));
  await view.findByText(
    "The update is downloaded. Installing will restart the app.",
  );
  expect(view.desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(
    view.getByText(/Canceling the save cancels this update/),
  ).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Install and restart" }));
  await waitFor(() =>
    expect(view.desktop.installUpdate).toHaveBeenCalledTimes(1),
  );
  view.emit({ ...idle, status: "installing" });
  expect(
    view.getByText("Preparing to install and restart…"),
  ).toBeInTheDocument();
  expect(view.getByRole("button")).toBeDisabled();
  view.emit({ ...idle, status: "available", availableVersion: "0.8.0" });
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Download update" }),
    ).not.toBeDisabled(),
  );
});

it("shows download progress and distinguishes unavailable from up to date", async () => {
  const view = mount({ ...idle, status: "downloading", progress: 42.4 });
  await view.findByText("Downloaded 42%");
  expect(view.getByRole("progressbar")).toHaveAttribute("value", "42.4");
  expect(view.getByRole("button")).toBeDisabled();
  view.emit({ ...idle, status: "downloading" });
  expect(view.getByRole("progressbar")).not.toHaveAttribute("value");
  view.emit({
    ...idle,
    status: "unavailable",
    reason: "当前构建不支持应用内更新。",
  });
  expect(view.getByText("In-app updates are unavailable.")).toBeInTheDocument();
  expect(
    view.getByText("This build does not support in-app updates."),
  ).toBeInTheDocument();
  expect(view.queryByText("You are up to date.")).not.toBeInTheDocument();
  expect(view.getByRole("button")).toBeDisabled();
});

it("retries errors and handles rejected action and initial snapshot promises", async () => {
  const view = mount({
    ...idle,
    status: "error",
    error: "检查更新失败，请稍后重试。",
  });
  await view.findByRole("alert");
  expect(view.getByRole("alert")).toHaveTextContent(
    "Could not check for updates.",
  );
  view.desktop.checkForUpdates.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(view.getByRole("button", { name: "Retry check" }));
  await waitFor(() =>
    expect(view.getByRole("alert")).toHaveTextContent("Offline"),
  );
  fireEvent.click(view.getByRole("button", { name: "Retry check" }));
  await view.findByText("You are up to date.");
  expect(view.queryByRole("alert")).not.toBeInTheDocument();
  view.unmount();
  const failed = mount(idle, Promise.reject(new Error("Bridge failed")));
  await failed.findByRole("alert");
  expect(
    failed.getByRole("button", { name: "Retry check" }),
  ).not.toBeDisabled();
});

it.each(["downloadUpdate", "installUpdate"] as const)(
  "handles %s rejection without unhandled promises",
  async (method) => {
    const view = mount({
      ...idle,
      status: method === "downloadUpdate" ? "available" : "downloaded",
    });
    await view.findByText("Current version: 0.7.4");
    view.desktop[method].mockRejectedValueOnce(new Error("Action failed"));
    fireEvent.click(view.getByRole("button"));
    await waitFor(() =>
      expect(view.getByRole("alert")).toHaveTextContent("Action failed"),
    );
    fireEvent.click(view.getByRole("button", { name: "Retry check" }));
    await view.findByText("You are up to date.");
  },
);

it("keeps pushed states ahead of stale initial and action snapshots", async () => {
  let resolve!: (next: DesktopUpdateState) => void;
  const view = mount(
    idle,
    new Promise((done) => {
      resolve = done;
    }),
  );
  view.emit({ ...idle, status: "available", availableVersion: "0.8.0" });
  await act(async () => resolve(idle));
  expect(view.getByText("Version 0.8.0 is available.")).toBeInTheDocument();
  let resolveDownload!: (next: DesktopUpdateState) => void;
  view.desktop.downloadUpdate.mockReturnValueOnce(
    new Promise((done) => {
      resolveDownload = done;
    }),
  );
  fireEvent.click(view.getByRole("button"));
  view.emit({ ...idle, status: "downloaded" });
  await act(async () =>
    resolveDownload({ ...idle, status: "downloading", progress: 99 }),
  );
  expect(
    view.getByRole("button", { name: "Install and restart" }),
  ).toBeInTheDocument();
});

it("uses the mounted document bridge, localizes interpolation, and unsubscribes", async () => {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const view = mount(
    { ...idle, status: "available", availableVersion: "0.8.0" },
    undefined,
    iframe.contentDocument!,
  );
  await view.findByText("Version 0.8.0 is available.");
  view.rerender(<UpdatePanel root={view.root} language="zh-CN" />);
  expect(view.getByText("当前版本：0.7.4")).toBeInTheDocument();
  expect(view.getByText("新版本 0.8.0 可用。")).toBeInTheDocument();
  expect(view.desktop.getUpdateState).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(view.unsubscribe).toHaveBeenCalledTimes(1);
  iframe.remove();
});

it("ignores a snapshot resolving after unmount", async () => {
  let resolve!: (next: DesktopUpdateState) => void;
  const view = mount(
    idle,
    new Promise((done) => {
      resolve = done;
    }),
  );
  view.unmount();
  await act(async () => resolve(idle));
  expect(view.unsubscribe).toHaveBeenCalledTimes(1);
});
