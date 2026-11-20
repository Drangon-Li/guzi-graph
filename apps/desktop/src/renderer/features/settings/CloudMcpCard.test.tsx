import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CloudMcpCard, cloudErrorMessage } from "./CloudMcpCard";

import type { CloudState, DesktopAPI } from "../../../shared/desktop-api";

const signedOut: CloudState = {
  signedIn: false,
  user: null,
  enabled: false,
  connection: "signed_out",
  error: "",
  deviceId: "device-1",
  endpoint: "https://mcp.guzilab.com/graph",
  accountUrl: "https://account.guzilab.com",
};
const signedIn: CloudState = {
  ...signedOut,
  signedIn: true,
  enabled: true,
  connection: "online",
  user: {
    id: "usr_1",
    username: "alice",
    nickname: "",
    email: "a@example.com",
  },
};

const mount = (initial: CloudState) => {
  let listener: (state: CloudState) => void = () => undefined;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const desktop = {
    getCloudState: vi.fn().mockResolvedValue(initial),
    onCloudState: vi.fn((callback) => {
      listener = callback;
      return () => undefined;
    }),
    requestCloudCode: vi.fn().mockResolvedValue({ cooldownSeconds: 60 }),
    cloudLogin: vi.fn().mockResolvedValue(signedIn),
    cloudLoginWithCode: vi.fn().mockResolvedValue(signedIn),
    cloudRegister: vi.fn().mockResolvedValue(signedIn),
    cloudLogout: vi.fn().mockResolvedValue(signedOut),
    setCloudEnabled: vi.fn().mockResolvedValue({ ...signedIn, enabled: false }),
    listCloudTokens: vi.fn().mockResolvedValue([
      {
        id: "mtk_1",
        name: "Laptop Claude Code",
        hint: "gzm_graph_abcde…wxyz",
        deviceId: "device-1",
        createdAt: 1,
        lastUsedAt: null,
      },
    ]),
    createCloudToken: vi.fn().mockResolvedValue({
      token: "gzm_graph_SECRET",
      endpoint: "https://mcp.guzilab.com/graph",
      item: {
        id: "mtk_2",
        name: "New",
        hint: "gzm_graph_SECRE…CRET",
        deviceId: null,
        createdAt: 2,
        lastUsedAt: null,
      },
      configs: {
        claudeCode: "claude mcp add …",
        json: "{}",
        codex: "[mcp_servers.guzi_graph]",
        codexEnv: "",
        envName: "GUZI_GRAPH_MCP_TOKEN",
      },
    }),
    revokeCloudToken: vi.fn().mockResolvedValue({ ok: true }),
    openCloudAccount: vi.fn().mockResolvedValue(undefined),
  };
  window.desktop = desktop as unknown as DesktopAPI;
  const root = document.createElement("div");
  document.body.append(root);
  render(<CloudMcpCard root={root} language="en" />, { container: root });
  return {
    desktop,
    writeText,
    emit: (state: CloudState) => act(() => listener(state)),
  };
};

afterEach(cleanup);

it("strips the Electron IPC prefix from server messages", () => {
  expect(
    cloudErrorMessage(
      new Error(
        "Error invoking remote method 'desktop:cloud-login': Error: 账号或密码不正确。",
      ),
    ),
  ).toBe("账号或密码不正确。");
});

it("signs in with a trimmed identifier and shows server errors", async () => {
  const { desktop } = mount(signedOut);
  await screen.findByRole("tab", { name: "Sign in" });
  desktop.cloudLogin.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'desktop:cloud-login': Error: 账号或密码不正确。",
    ),
  );
  fireEvent.change(screen.getByLabelText("Username / email"), {
    target: { value: "  alice " },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("账号或密码不正确。")).toBeInTheDocument();
  expect(desktop.cloudLogin).toHaveBeenCalledWith({
    identifier: "alice",
    password: "secret123",
  });
});

it("registers with an emailed code", async () => {
  const { desktop } = mount(signedOut);
  fireEvent.click(await screen.findByRole("tab", { name: "Create account" }));
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "a@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await waitFor(() =>
    expect(desktop.requestCloudCode).toHaveBeenCalledWith({
      purpose: "register",
      email: "a@example.com",
    }),
  );
  expect(
    await screen.findByRole("button", { name: /Resend in/ }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Code"), {
    target: { value: "123456" },
  });
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "alice" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "secret123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create and sign in" }));
  await waitFor(() =>
    expect(desktop.cloudRegister).toHaveBeenCalledWith({
      username: "alice",
      password: "secret123",
      email: "a@example.com",
      code: "123456",
    }),
  );
});

it("shows the account, endpoint and tokens once signed in, and reveals a new token once", async () => {
  const { desktop, writeText } = mount(signedIn);
  expect(await screen.findByText("Online")).toBeInTheDocument();
  expect(screen.getByText("https://mcp.guzilab.com/graph")).toBeInTheDocument();
  expect(await screen.findByText("Laptop Claude Code")).toBeInTheDocument();
  expect(screen.getByText(/this computer only/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
  fireEvent.click(screen.getByLabelText("Only forward to this computer"));
  fireEvent.click(screen.getByRole("button", { name: "New token" }));
  expect(await screen.findByText("gzm_graph_SECRET")).toBeInTheDocument();
  expect(desktop.createCloudToken).toHaveBeenCalledWith({
    name: "New",
    bindDevice: true,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Copy Claude Code command" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("claude mcp add …"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("gzm_graph_SECRET")).not.toBeInTheDocument();
});

it("toggles cloud MCP, follows pushed state and signs out", async () => {
  const { desktop, emit } = mount(signedIn);
  const toggle = await screen.findByRole("switch", {
    name: "Enable cloud MCP",
  });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(desktop.setCloudEnabled).toHaveBeenCalledWith(false),
  );
  emit({ ...signedIn, connection: "reconnecting" });
  expect(await screen.findByText("Reconnecting")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(desktop.cloudLogout).toHaveBeenCalled());
});
