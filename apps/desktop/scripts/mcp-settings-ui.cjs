const waitForMcpReady = async (page) => {
  const ready = await page.waitForFunction(async () => {
    const service = (await window.desktop.getPlugins()).find(
      (plugin) => plugin.id === "mcp",
    );
    if (service?.status === "error") {
      throw new Error(service.error || "MCP service failed to start.");
    }
    if (!service?.enabled || service.status !== "running") return false;
    let endpoint;
    try {
      endpoint = new URL(service.endpoint);
    } catch {
      return false;
    }
    return endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" &&
      endpoint.port === String(service.port) &&
      endpoint.pathname === "/mcp"
      ? service
      : false;
  });
  try {
    return await ready.jsonValue();
  } finally {
    await ready.dispose();
  }
};

const enableMcpInSettings = async (page, port, { screenshotPath } = {}) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "桌面设置", exact: true });
  await settings.getByRole("tab", { name: "内置 MCP", exact: true }).click();
  await settings
    .getByRole("spinbutton", { name: "本地端口", exact: true })
    .fill(String(port));
  await settings.getByRole("button", { name: "应用端口", exact: true }).click();
  await settings.getByRole("switch", { name: "启用 MCP", exact: true }).click();
  await settings.getByText("运行中", { exact: true }).waitFor();
  const service = await waitForMcpReady(page);
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await settings.getByRole("button", { name: "完成", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  return service;
};

module.exports = { enableMcpInSettings, waitForMcpReady };
