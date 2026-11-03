// page.waitForFunction only checks whether the predicate's return value is
// truthy. An async predicate returns a Promise, which is always truthy, so it
// resolves on the first poll with whatever the Promise settles to (e.g. false
// while a service is still starting). Poll async page state explicitly.
const pollPage = async (
  page,
  predicate,
  arg,
  { timeout = 30000, interval = 100, description = "page state" } = {},
) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate, arg);
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeout}ms waiting for ${description}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

const waitForMcpReady = (page, options) =>
  pollPage(
    page,
    async () => {
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
    },
    undefined,
    { description: "the MCP service to run", ...options },
  );

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

module.exports = { enableMcpInSettings, pollPage, waitForMcpReady };
