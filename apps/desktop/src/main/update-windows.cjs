const silencedUpdaters = new WeakSet();

function createWindowsUpdateAdapter({
  emit,
  updater = require("electron-updater").autoUpdater,
  quitEvents = require("electron").autoUpdater,
  installTimeoutMs = 15000,
  onQuitRejected = () => {},
}) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  let pending;
  let checkResult;
  let cancelled = false;
  let ready = false;
  let installPromise;
  let rejectInstall;
  let installTimer;
  let installFailed = false;
  const settle = (error) => {
    const current = pending;
    pending = undefined;
    if (error) current?.reject(error);
    else current?.resolve();
  };
  const listeners = {
    "checking-for-update": () => emit({ status: "checking" }),
    "update-available": (info) => {
      emit({ status: "available", availableVersion: info.version });
    },
    "update-not-available": () => {
      emit({ status: "up-to-date" });
    },
    "download-progress": (progress) => {
      if (
        !Number.isFinite(progress.percent) ||
        progress.percent < 0 ||
        progress.percent > 100
      ) {
        settle(new Error("Invalid update progress"));
        return;
      }
      emit({ status: "downloading", progress: progress.percent });
    },
    "update-downloaded": (info) => {
      ready = true;
      emit({
        status: "downloaded",
        availableVersion: info.version,
        progress: 100,
      });
      if (pending?.action === "download") settle();
    },
    error: (error) => {
      emit({ status: "error" });
      settle(error);
      clearTimeout(installTimer);
      if (installPromise) installFailed = true;
      rejectInstall?.(error);
    },
  };
  for (const [event, listener] of Object.entries(listeners))
    updater.on(event, listener);
  const run = (action) => {
    if (cancelled) return Promise.reject(new Error("Update cancelled"));
    if (pending) return pending.promise;
    const record = { action };
    record.promise = new Promise((resolve, reject) =>
      Object.assign(record, { resolve, reject }),
    );
    pending = record;
    Promise.resolve()
      .then(() =>
        action === "check"
          ? updater.checkForUpdates()
          : updater.downloadUpdate(checkResult?.cancellationToken),
      )
      .then((result) => {
        if (action === "check") {
          checkResult = result;
          if (cancelled) checkResult?.cancellationToken?.cancel();
          if (pending === record)
            settle(result ? undefined : new Error("Updater did not start"));
        } else if (pending === record && !result) {
          settle(new Error("Updater did not start"));
        }
      })
      .catch((error) => {
        if (pending === record) settle(error);
      });
    return record.promise;
  };
  const beforeQuit = () => {
    clearTimeout(installTimer);
    if (cancelled || installFailed || !installPromise) {
      onQuitRejected();
    } else {
      resolveInstall?.();
    }
  };
  let resolveInstall;
  quitEvents.on("before-quit-for-update", beforeQuit);
  return {
    check: () => run("check"),
    download: () => run("download"),
    install() {
      if (cancelled || !ready)
        return Promise.reject(new Error("Update is not ready"));
      if (installPromise) return installPromise;
      installPromise = new Promise((resolve, reject) => {
        resolveInstall = resolve;
        rejectInstall = reject;
      });
      installTimer = setTimeout(() => {
        installFailed = true;
        rejectInstall(new Error("Install timed out"));
      }, installTimeoutMs);
      installTimer.unref?.();
      try {
        updater.quitAndInstall(true, true);
      } catch (error) {
        clearTimeout(installTimer);
        installFailed = true;
        rejectInstall(error);
      }
      return installPromise;
    },
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(installTimer);
      checkResult?.cancellationToken?.cancel();
      settle(new Error("Update cancelled"));
      rejectInstall?.(new Error("Update cancelled"));
      for (const [event, listener] of Object.entries(listeners))
        updater.removeListener(event, listener);
      if (installPromise) {
        // BaseUpdater schedules app.quit even if an asynchronous NSIS spawn fails.
        setImmediate(() =>
          quitEvents.removeListener("before-quit-for-update", beforeQuit),
        );
      } else {
        quitEvents.removeListener("before-quit-for-update", beforeQuit);
      }
      if (!silencedUpdaters.has(updater)) {
        silencedUpdaters.add(updater);
        updater.on("error", () => {});
      }
    },
  };
}

module.exports = { createWindowsUpdateAdapter };
