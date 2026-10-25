const { createMacUpdateAdapter } = require("./update-mac.cjs");
const { createWindowsUpdateAdapter } = require("./update-windows.cjs");

function createUpdateController({
  app,
  buildChannel,
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  emit = () => {},
  requestClose,
  translate = (message) => message,
  createAdapter,
}) {
  const reason =
    !app.isPackaged || buildChannel
      ? "当前构建不支持应用内更新。"
      : platform !== "win32" && !(platform === "darwin" && arch === "arm64")
      ? "当前平台不支持应用内更新。"
      : null;
  let state = {
    status: reason ? "unavailable" : "idle",
    currentVersion: app.getVersion(),
    ...(reason ? { reason: translate(reason) } : {}),
  };
  let adapter;
  let retiring;
  let operation;
  let generation = 0;
  let installRequested = false;
  let installing;
  let cleanup = Promise.resolve();
  let cleanupPending = false;
  let blockedQuit = false;
  const publish = (next) => {
    state = { currentVersion: state.currentVersion, ...next };
    emit({ ...state });
  };
  const getState = () => ({ ...state });
  const fail = (action) => {
    const messages = {
      check: "检查更新失败，请稍后重试。",
      download: "下载更新失败，请稍后重试。",
      install: "安装更新失败，请重新下载后重试。",
    };
    publish({
      status: "error",
      ...(state.availableVersion
        ? { availableVersion: state.availableVersion }
        : {}),
      error: translate(messages[action]),
    });
  };
  const getAdapter = () => {
    if (!adapter) {
      const token = generation;
      const options = {
        resourcesPath,
        execPath,
        onQuitRejected: () => {
          blockedQuit = true;
        },
        emit: (next) => {
          if (token !== generation) return;
          if (next.status === "error") {
            fail(installRequested ? "install" : operation?.action || "check");
          } else if (next.status !== "installing") {
            publish({
              ...next,
              ...(next.availableVersion ||
              !state.availableVersion ||
              next.status === "up-to-date"
                ? {}
                : { availableVersion: state.availableVersion }),
            });
          }
        },
      };
      adapter = createAdapter
        ? createAdapter(options)
        : platform === "darwin"
        ? createMacUpdateAdapter(options)
        : createWindowsUpdateAdapter(options);
    }
    return adapter;
  };
  const run = (action) => {
    if (reason || installRequested) return Promise.resolve(getState());
    if (operation) return operation.promise;
    if (state.status === "downloaded") return Promise.resolve(getState());
    if (action === "download" && state.status !== "available")
      return Promise.resolve(getState());
    const token = generation;
    publish({
      status: action === "check" ? "checking" : "downloading",
      ...(action === "download"
        ? { availableVersion: state.availableVersion, progress: 0 }
        : {}),
    });
    const record = { action };
    operation = record;
    if (retiring) finishCleanup();
    record.promise = cleanup
      .then(() => {
        if (token === generation) return getAdapter()[action]();
      })
      .catch(() => {
        if (token === generation) fail(action);
      })
      .then(() => getState())
      .finally(() => {
        if (operation === record) operation = undefined;
      });
    return record.promise;
  };
  const finishCleanup = () => {
    if (cleanupPending) return;
    cleanupPending = true;
    const previous = retiring;
    cleanup = Promise.resolve()
      .then(() => previous.cancel())
      .then(() => {
        if (retiring === previous) retiring = undefined;
      })
      .finally(() => {
        cleanupPending = false;
      });
    cleanup.catch(() => {});
  };
  const cancel = () => {
    generation++;
    installRequested = false;
    installing = undefined;
    operation = undefined;
    retiring = adapter || retiring;
    adapter = undefined;
    if (retiring) finishCleanup();
    return cleanup;
  };
  return {
    getState,
    consumeBlockedQuit() {
      const blocked = blockedQuit;
      blockedQuit = false;
      return blocked;
    },
    checkForUpdates: () => run("check"),
    downloadUpdate: () => run("download"),
    async installUpdate() {
      if (installRequested || state.status !== "downloaded") return;
      installRequested = true;
      publish({
        status: "installing",
        availableVersion: state.availableVersion,
      });
      requestClose();
    },
    isInstallPending: () => installRequested,
    confirmInstall() {
      if (!installRequested) return Promise.resolve(false);
      if (installing) return installing;
      const token = generation;
      installing = Promise.resolve()
        .then(() => {
          if (token === generation) return getAdapter().install();
        })
        .then(() => token === generation && installRequested)
        .catch(() => {
          if (token === generation) {
            cancel();
            fail("install");
          }
          return false;
        });
      return installing;
    },
    cancelInstall() {
      if (!installRequested) return;
      const availableVersion = state.availableVersion;
      cancel().catch(() => fail("install"));
      publish({ status: "available", availableVersion });
    },
    async cancelForQuit() {
      try {
        await cancel();
        if (!reason && state.status !== "up-to-date") {
          publish(
            state.availableVersion
              ? {
                  status: "available",
                  availableVersion: state.availableVersion,
                }
              : { status: "idle" },
          );
        }
      } catch (error) {
        fail("install");
        throw error;
      }
    },
  };
}

module.exports = { createUpdateController };
