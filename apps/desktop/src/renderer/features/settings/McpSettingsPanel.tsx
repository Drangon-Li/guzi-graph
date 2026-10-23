import { useEffect, useState } from "react";

import { Button } from "@excalidraw/excalidraw";

import { translate } from "../../shared/i18n/i18n";

import type { DesktopLanguage } from "../../shared/i18n/i18n";
import type { PluginState } from "../../../shared/plugins";

export const connectionConfigs = (plugin: PluginState) => ({
  codex: `[mcp_servers.guzi]\nurl = ${JSON.stringify(
    plugin.endpoint,
  )}\nbearer_token_env_var = "GUZI_MCP_TOKEN"`,
  codexDesktop: `[mcp_servers.guzi]\nurl = ${JSON.stringify(
    plugin.endpoint,
  )}\nhttp_headers = { Authorization = ${JSON.stringify(
    `Bearer ${plugin.token}`,
  )} }`,
  cli: `codex mcp add guzi --url '${plugin.endpoint}' --bearer-token-env-var GUZI_MCP_TOKEN`,
  claude: JSON.stringify(
    {
      mcpServers: {
        guzi: {
          type: "http",
          url: plugin.endpoint,
          headers: { Authorization: `Bearer \${GUZI_MCP_TOKEN}` },
        },
      },
    },
    null,
    2,
  ),
});

const capabilityGroups = [
  {
    label: { "zh-CN": "画布读写", en: "Canvas read & write" },
    commands: [
      "list_canvases",
      "create_canvas",
      "open_canvas",
      "close_document",
      "control_canvas",
      "read_canvas",
      "apply_operations",
    ],
  },
  {
    label: { "zh-CN": "演示文稿", en: "Presentations" },
    commands: [
      "create_presentation",
      "read_presentation",
      "update_presentation",
      "control_presentation",
    ],
  },
  {
    label: { "zh-CN": "保存与导出", en: "Save & export" },
    commands: [
      "save_canvas",
      "export_canvas",
      "save_presentation",
      "export_presentation",
    ],
  },
  {
    label: { "zh-CN": "插件开发与管理", en: "Plugin development & management" },
    commands: [
      "get_plugin_development_guide",
      "get_plugin_api_schema",
      "list_plugins",
      "get_plugin",
      "validate_plugin",
      "install_plugin",
      "update_plugin",
      "run_plugin_command",
    ],
  },
];

const statusLabels = {
  disabled: "已停用",
  starting: "启动中",
  running: "运行中",
  error: "出错",
};

const PluginCard = ({
  plugin,
  root,
  language,
  onChange,
}: {
  plugin: PluginState;
  root: HTMLElement;
  language: DesktopLanguage;
  onChange: (plugins: PluginState[]) => void;
}) => {
  const t = (message: string) => translate(language, message);
  const desktop = root.ownerDocument.defaultView!.desktop;
  const [port, setPort] = useState(String(plugin.port));
  const [showToken, setShowToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setPort(String(plugin.port)), [plugin.port]);
  useEffect(() => setShowToken(false), [plugin.token, plugin.status]);
  const update = async (operation: () => Promise<PluginState[]>) => {
    setPending(true);
    setError("");
    setFeedback("");
    try {
      onChange(await operation());
    } catch {
      setError(t("MCP 设置失败，请重试。"));
    } finally {
      setPending(false);
    }
  };
  const copy = async (value: string) => {
    setFeedback("");
    setError("");
    try {
      await root.ownerDocument.defaultView!.navigator.clipboard.writeText(
        value,
      );
      setFeedback(t("已复制"));
    } catch {
      setError(t("复制失败，请检查剪贴板权限。"));
    }
  };
  const validPort =
    /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535;
  const connected =
    plugin.status === "running" && !!plugin.endpoint && !!plugin.token;
  const configs = connectionConfigs(plugin);
  return (
    <article className="desktop-market-card" aria-label={plugin.name}>
      <header>
        <div>
          <h2>
            {plugin.name} <small>v{plugin.version}</small>
          </h2>
          <span
            className={`desktop-plugin-status is-${plugin.status}`}
            role="status"
          >
            {t(statusLabels[plugin.status])}
          </span>
        </div>
        <label className="desktop-plugin-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label={t("启用 MCP")}
            checked={plugin.enabled}
            disabled={pending || plugin.status === "starting"}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void update(() => desktop.setPluginEnabled(plugin.id, enabled));
            }}
          />
          {t("启用 MCP")}
        </label>
      </header>
      <p>{t(plugin.description)}</p>
      <div className="desktop-plugin-capabilities">
        {capabilityGroups
          .filter((group) =>
            plugin.capabilities.some((capability) =>
              group.commands.includes(capability),
            ),
          )
          .map((group) => (
            <span key={group.label.en}>{group.label[language]}</span>
          ))}
      </div>
      {plugin.error && <p role="alert">{plugin.error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validPort) {
            void update(() =>
              desktop.configurePlugin(plugin.id, { port: Number(port) }),
            );
          }
        }}
      >
        <label>
          {t("本地端口")}
          <input
            aria-label={t("本地端口")}
            type="number"
            min="1024"
            max="65535"
            value={port}
            disabled={pending || plugin.status === "starting"}
            onChange={(event) => setPort(event.currentTarget.value)}
          />
        </label>
        <Button
          type="submit"
          onSelect={() => undefined}
          disabled={
            !validPort ||
            pending ||
            plugin.status === "starting" ||
            Number(port) === plugin.port
          }
        >
          {t("应用端口")}
        </Button>
      </form>
      <p className="desktop-market-hint">
        {t("启用后修改端口会重启 MCP 服务。端口范围：1024–65535。")}
      </p>
      {plugin.id === "mcp" && (
        <section
          className="desktop-plugin-connection"
          aria-label={t("连接设置")}
        >
          <h3>{t("连接设置")}</h3>
          <p>{t("启用 MCP 并保持 Guzi 运行，即可连接当前画布。")}</p>
          <div className="desktop-plugin-value">
            <span>Endpoint</span>
            <code>{plugin.endpoint || t("启用后可用")}</code>
            <Button
              disabled={!connected}
              onSelect={() => void copy(plugin.endpoint!)}
            >
              {t("复制地址")}
            </Button>
          </div>
          <div className="desktop-plugin-value">
            <span>Token</span>
            <code>
              {connected
                ? showToken
                  ? plugin.token
                  : "••••••••••••••••"
                : t("启用后可用")}
            </code>
            <Button
              disabled={!connected}
              onSelect={() => setShowToken(!showToken)}
            >
              {showToken ? t("隐藏 Token") : t("显示 Token")}
            </Button>
            <Button
              disabled={!connected}
              onSelect={() => void copy(plugin.token!)}
            >
              {t("复制 Token")}
            </Button>
          </div>
          <p className="desktop-market-hint">
            {t("Token 允许访问画布，请仅交给你信任的客户端。")}
          </p>
          <h3>{t("配置客户端")}</h3>
          <p>
            {t(
              "在启动客户端的终端设置环境变量，再复制对应配置。Claude Code 的项目配置文件为 .mcp.json；Codex 配置文件为 ~/.codex/config.toml。",
            )}
          </p>
          <pre>
            <code>export GUZI_MCP_TOKEN='&lt;{t("复制的 Token")}&gt;'</code>
          </pre>
          <p className="desktop-market-hint">
            {t(
              "客户端进程必须继承此环境变量；从 Dock 启动的应用不会继承终端变量。",
            )}
          </p>
          <div className="desktop-plugin-copy-actions">
            <Button
              disabled={!connected}
              onSelect={() => void copy(configs.codex)}
            >
              {t("复制 Codex 配置")}
            </Button>
            <Button
              disabled={!connected}
              onSelect={() => void copy(configs.codexDesktop)}
            >
              {t("复制 Codex 桌面配置（含 Token）")}
            </Button>
            <Button
              disabled={!connected}
              onSelect={() => void copy(configs.cli)}
            >
              {t("复制 Codex 命令")}
            </Button>
            <Button
              disabled={!connected}
              onSelect={() => void copy(configs.claude)}
            >
              {t("复制 Claude Code 配置")}
            </Button>
          </div>
        </section>
      )}
      <p role="status" className="desktop-market-hint">
        {feedback}
      </p>
      {error && <p role="alert">{error}</p>}
    </article>
  );
};

export const McpSettingsPanel = ({
  root,
  language,
}: {
  root: HTMLElement;
  language: DesktopLanguage;
}) => {
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const t = (message: string) => translate(language, message);
  useEffect(() => {
    const desktop = root.ownerDocument.defaultView!.desktop;
    let mounted = true;
    let received = false;
    const unsubscribe = desktop.onPluginState((states) => {
      received = true;
      setPlugins(states.filter((plugin) => plugin.id === "mcp"));
      setError(false);
      setLoading(false);
    });
    void desktop
      .getPlugins()
      .then((states) => {
        if (mounted && !received) {
          setPlugins(states.filter((plugin) => plugin.id === "mcp"));
        }
      })
      .catch(() => {
        if (mounted && !received) {
          setError(true);
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [root]);
  return (
    <div className="desktop-market desktop-mcp-settings">
      {loading && <p role="status">{t("正在读取 MCP 设置…")}</p>}
      {error && <p role="alert">{t("无法读取内置 MCP，请重新打开设置。")}</p>}
      {!loading && !error && plugins.length === 0 && (
        <p>{t("内置 MCP 暂不可用。")}</p>
      )}
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          plugin={plugin}
          root={root}
          language={language}
          onChange={(states) =>
            setPlugins(states.filter((plugin) => plugin.id === "mcp"))
          }
        />
      ))}
    </div>
  );
};
