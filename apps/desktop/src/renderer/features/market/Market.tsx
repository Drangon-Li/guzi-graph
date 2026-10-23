import { useEffect, useRef, useState } from "react";

import { Button } from "@excalidraw/excalidraw";

import { translate } from "../../shared/i18n/i18n";

import type { DesktopLanguage } from "../../shared/i18n/i18n";
import type {
  UserPluginPackage,
  UserPluginState,
} from "../../../shared/plugins";

const permissionLabels = {
  "canvas:read": { "zh-CN": "读取画布", en: "Read canvases" },
  "canvas:write": { "zh-CN": "编辑画布", en: "Edit canvases" },
  "presentation:read": { "zh-CN": "读取演示文稿", en: "Read presentations" },
  "presentation:write": { "zh-CN": "编辑演示文稿", en: "Edit presentations" },
  storage: { "zh-CN": "保存插件数据", en: "Store plugin data" },
};

const statusLabels = {
  disabled: "已停用",
  starting: "启动中",
  running: "运行中",
  error: "出错",
};

const UserPluginCard = ({
  plugin,
  root,
  language,
  onChange,
}: {
  plugin: UserPluginState;
  root: HTMLElement;
  language: DesktopLanguage;
  onChange: (plugins: UserPluginState[]) => void;
}) => {
  const t = (message: string) => translate(language, message);
  const desktop = root.ownerDocument.defaultView!.desktop;
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const update = async (operation: () => Promise<UserPluginState[]>) => {
    setLifecyclePending(true);
    setError("");
    setFeedback("");
    try {
      onChange(await operation());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("插件操作失败，请重试。"),
      );
    } finally {
      setLifecyclePending(false);
    }
  };
  const run = async (commandId: string) => {
    setCommandPending(true);
    setError("");
    setFeedback("");
    try {
      await desktop.runUserPluginCommand(plugin.manifest.id, commandId);
      setFeedback(t("命令已完成。"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("插件命令失败，请重试。"),
      );
    } finally {
      setCommandPending(false);
    }
  };
  const busy = lifecyclePending || plugin.status === "starting";
  return (
    <article className="desktop-market-card" aria-label={plugin.manifest.name}>
      <header>
        <div>
          <h2>
            {plugin.manifest.name} <small>v{plugin.manifest.version}</small>
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
            aria-label={t("启用插件")}
            checked={plugin.enabled}
            disabled={!plugin.enabled && (busy || commandPending)}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void update(() =>
                desktop.setUserPluginEnabled(plugin.manifest.id, enabled),
              );
            }}
          />
          {t("启用插件")}
        </label>
      </header>
      <p>{plugin.manifest.description}</p>
      <p className="desktop-market-hint">{plugin.manifest.id}</p>
      {plugin.manifest.permissions.length > 0 && (
        <section aria-label={t("插件权限")}>
          <h3>{t("插件权限")}</h3>
          <div className="desktop-plugin-capabilities">
            {plugin.manifest.permissions.map((permission) => (
              <span key={permission} title={permission}>
                {permissionLabels[permission][language]}
              </span>
            ))}
          </div>
        </section>
      )}
      {plugin.error && <p role="alert">{plugin.error}</p>}
      {plugin.manifest.commands.length > 0 && (
        <section aria-label={t("插件命令")}>
          <h3>{t("插件命令")}</h3>
          <div className="desktop-plugin-copy-actions">
            {plugin.manifest.commands.map((command) => (
              <Button
                key={command.id}
                disabled={busy || commandPending || plugin.status !== "running"}
                onSelect={() => void run(command.id)}
              >
                {command.title}
              </Button>
            ))}
          </div>
        </section>
      )}
      <div className="desktop-plugin-actions">
        {confirmRemove ? (
          <div
            className="desktop-plugin-remove-confirm"
            role="group"
            aria-label={t("确认卸载插件")}
          >
            <p>{t("卸载后将删除此插件的本地文件。")}</p>
            <Button
              disabled={busy}
              onSelect={() =>
                void update(() => desktop.removeUserPlugin(plugin.manifest.id))
              }
            >
              {t("确认卸载")}
            </Button>
            <Button disabled={busy} onSelect={() => setConfirmRemove(false)}>
              {t("取消")}
            </Button>
          </div>
        ) : (
          <Button disabled={busy} onSelect={() => setConfirmRemove(true)}>
            {t("卸载插件")}
          </Button>
        )}
      </div>
      {feedback && <p role="status">{feedback}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
};

export const Market = ({
  root,
  language,
}: {
  root: HTMLElement;
  language: DesktopLanguage;
}) => {
  const [plugins, setPlugins] = useState<UserPluginState[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const t = (message: string) => translate(language, message);
  useEffect(() => {
    const desktop = root.ownerDocument.defaultView!.desktop;
    let mounted = true;
    let received = false;
    const unsubscribe = desktop.onUserPluginState((states) => {
      if (!mounted) {
        return;
      }
      received = true;
      setPlugins(states);
      setError("");
      setLoading(false);
    });
    void desktop
      .getUserPlugins()
      .then((states) => {
        if (mounted && !received) {
          setPlugins(states);
        }
      })
      .catch((cause) => {
        if (mounted && !received) {
          setError(
            cause instanceof Error
              ? cause.message
              : translate(language, "无法读取插件，请重新打开插件市场。"),
          );
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
  }, [root, language]);
  const importPackage = async (file: File) => {
    setImporting(true);
    setError("");
    setFeedback("");
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error(t("请选择 .json 插件包。"));
      }
      if (file.size > 2 * 1024 * 1024) {
        throw new Error(t("插件包不能超过 2 MiB。"));
      }
      const ownerWindow = root.ownerDocument.defaultView!;
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new ownerWindow.FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t("无法读取插件包。")));
        reader.readAsText(file);
      });
      let pkg: UserPluginPackage;
      try {
        pkg = JSON.parse(source) as UserPluginPackage;
      } catch {
        throw new Error(t("插件包不是有效的 JSON。"));
      }
      setPlugins(await ownerWindow.desktop.installUserPlugin(pkg, false));
      setFeedback(t("插件已导入，启用后即可运行。"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("导入插件失败，请检查插件包。"),
      );
    } finally {
      setImporting(false);
    }
  };
  return (
    <div className="desktop-market">
      <section className="desktop-market-intro" aria-label={t("本地插件")}>
        <div>
          <h2>{t("本地 JavaScript 插件")}</h2>
          <p>
            {t("导入 .json 插件包，为画布添加命令。新安装的插件默认停用。")}
          </p>
        </div>
        <Button
          disabled={importing || loading}
          onSelect={() => fileInput.current?.click()}
        >
          {importing ? t("正在导入…") : t("导入插件包…")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label={t("选择插件包")}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) {
              void importPackage(file);
            }
          }}
        />
      </section>
      <aside className="desktop-market-development">
        <h3>{t("开发插件")}</h3>
        <p>
          {t("前往设置 → 内置 MCP 启用服务，再通过 MCP 读取插件开发指南。")}
        </p>
        <p>
          {t("开发指南")}：<code>get_plugin_development_guide</code>
          {" · "}
          {t("API 与插件包格式")}：<code>get_plugin_api_schema</code>
        </p>
      </aside>
      {loading && <p role="status">{t("正在读取插件…")}</p>}
      {error && <p role="alert">{error}</p>}
      {feedback && <p role="status">{feedback}</p>}
      {!loading && !error && plugins.length === 0 && (
        <p>{t("没有已安装的插件。")}</p>
      )}
      {plugins.map((plugin) => (
        <UserPluginCard
          key={plugin.manifest.id}
          plugin={plugin}
          root={root}
          language={language}
          onChange={setPlugins}
        />
      ))}
    </div>
  );
};
