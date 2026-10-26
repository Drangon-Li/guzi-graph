import { useEffect, useRef, useState } from "react";

import { Button } from "@excalidraw/excalidraw";

import { translate } from "../../shared/i18n/i18n";

import type {
  DesktopSettings,
  DesktopUpdateState,
} from "../../../shared/desktop-api";

export const UpdatePanel = ({
  root,
  language,
  onInstallUpdate,
}: {
  root: HTMLElement;
  language: DesktopSettings["language"];
  onInstallUpdate: () => Promise<void>;
}) => {
  const desktop = root.ownerDocument.defaultView!.desktop;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const t = (message: string, params?: Record<string, string | number>) =>
    translate(language, message, params);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const unsubscribe = desktop.onUpdateState((next) => {
      revision.current++;
      setState(next);
      setError(null);
    });
    const snapshotRevision = revision.current;
    void desktop.getUpdateState().then(
      (next) => {
        if (active && revision.current === snapshotRevision) {
          setState(next);
        }
      },
      (cause) => {
        if (active && revision.current === snapshotRevision) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe();
    };
  }, [desktop]);

  const run = async () => {
    setPending(true);
    setError(null);
    const actionRevision = ++revision.current;
    try {
      const next =
        !error && state?.status === "downloaded"
          ? await onInstallUpdate()
          : !error && state?.status === "available"
          ? await desktop.downloadUpdate()
          : await desktop.checkForUpdates();
      if (mounted.current && next && revision.current === actionRevision) {
        setState(next);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  };
  const status = state?.status;
  const busy =
    pending ||
    status === "checking" ||
    status === "downloading" ||
    status === "installing";
  const messages = {
    idle: "检查是否有可用更新。",
    checking: "正在检查更新…",
    "up-to-date": "已是最新版本。",
    available: "新版本 {version} 可用。",
    downloading: "正在下载更新…",
    downloaded: "更新已下载，安装后将重启应用。",
    installing: "正在准备安装并重启…",
    error: "更新失败，请重试。",
    unavailable: "当前无法使用应用内更新。",
  };
  const action = error
    ? "重试检查"
    : status === "downloaded"
    ? "安装并重启"
    : status === "available" || status === "downloading"
    ? "下载更新"
    : status === "error"
    ? "重试检查"
    : "检查更新";

  return (
    <section className="desktop-settings-card desktop-update-panel">
      <h4>{t("版本与更新")}</h4>
      <div className="desktop-settings-item">
        <div className="desktop-settings-item__label">
          <span>
            {t("当前版本：{version}", {
              version: state?.currentVersion || t("正在读取…"),
            })}
          </span>
          <p role="status" aria-live="polite">
            {status
              ? t(messages[status], { version: state?.availableVersion || "" })
              : t("正在读取更新状态…")}
          </p>
        </div>
        <Button
          onSelect={() => void run()}
          disabled={busy || (!state && !error) || status === "unavailable"}
        >
          {t(action)}
        </Button>
      </div>
      {state?.status === "downloading" && (
        <div className="desktop-update-progress">
          <progress
            aria-label={t("下载进度")}
            max={100}
            value={state.progress}
          />
          {state.progress !== undefined && (
            <span>
              {t("已下载 {progress}%", {
                progress: Math.round(state.progress),
              })}
            </span>
          )}
        </div>
      )}
      {status === "downloaded" && (
        <p className="desktop-settings-note">
          {t(
            "重启前会提示保存未保存的画布；取消保存将取消本次更新，可稍后重新下载。",
          )}
        </p>
      )}
      {state?.status === "unavailable" && state.reason && (
        <p className="desktop-settings-note">{t(state.reason)}</p>
      )}
      {(error || state?.error) && (
        <p className="desktop-settings-note" role="alert">
          {t(error || state?.error || "")}
        </p>
      )}
    </section>
  );
};
