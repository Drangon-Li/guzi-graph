const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createUpdateController } = require("./update.cjs");
const { createMacUpdateAdapter, MAC_UPDATE_FEED } = require("./update-mac.cjs");
const { createWindowsUpdateAdapter } = require("./update-windows.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function controllerHarness(options = {}) {
  const calls = {
    check: 0,
    download: 0,
    install: 0,
    cancel: 0,
    close: 0,
    adapters: 0,
  };
  let emit;
  const adapter = {
    async check() {
      calls.check++;
      emit({ status: "available", availableVersion: "0.8.0" });
    },
    async download() {
      calls.download++;
      emit({ status: "downloaded", availableVersion: "0.8.0", progress: 100 });
    },
    async install() {
      calls.install++;
    },
    async cancel() {
      calls.cancel++;
    },
  };
  const states = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "0.7.4" },
    platform: "darwin",
    arch: "arm64",
    requestClose: () => calls.close++,
    emit: (state) => states.push(state),
    createAdapter: (options) => {
      calls.adapters++;
      emit = options.emit;
      return adapter;
    },
    ...options,
  });
  return { controller, calls, adapter, states, emit: (value) => emit(value) };
}
async function ready(h) {
  await h.controller.checkForUpdates();
  await h.controller.downloadUpdate();
}

test("updates are unavailable in development, test channels, and unsupported architectures without loading adapters", async () => {
  for (const options of [
    { app: { isPackaged: false, getVersion: () => "0.7.4" } },
    { buildChannel: "test" },
    { buildChannel: "dev-ppt" },
    { platform: "linux" },
    { arch: "x64" },
  ]) {
    const h = controllerHarness(options);
    assert.equal((await h.controller.checkForUpdates()).status, "unavailable");
    await h.controller.downloadUpdate();
    await h.controller.installUpdate();
    assert.equal(h.calls.adapters, 0);
    assert.equal(h.calls.close, 0);
  }
  assert.equal(
    controllerHarness({ platform: "win32", arch: "x64" }).controller.getState()
      .status,
    "idle",
  );
});

test("checking and downloading are idempotent and publish bounded progress without exposing mutable state", async () => {
  const h = controllerHarness();
  const check = deferred();
  h.adapter.check = () => {
    h.calls.check++;
    return check.promise;
  };
  const first = h.controller.checkForUpdates();
  assert.equal(h.controller.checkForUpdates(), first);
  await tick();
  assert.equal(h.calls.check, 1);
  h.emit({ status: "available", availableVersion: "0.8.0" });
  check.resolve();
  assert.equal((await first).availableVersion, "0.8.0");
  const snapshot = h.controller.getState();
  snapshot.status = "error";
  assert.equal(h.controller.getState().status, "available");
  const download = deferred();
  h.adapter.download = () => {
    h.calls.download++;
    return download.promise;
  };
  const downloading = h.controller.downloadUpdate();
  assert.equal(h.controller.downloadUpdate(), downloading);
  await tick();
  h.emit({ status: "downloading", progress: 25 });
  assert.equal(h.controller.getState().progress, 25);
  h.emit({ status: "downloaded", availableVersion: "0.8.0", progress: 100 });
  download.resolve();
  assert.equal((await downloading).status, "downloaded");
  assert.equal(h.calls.download, 1);
});

test("install requests only close the window; saving confirmation is required and duplicate clicks install once", async () => {
  const h = controllerHarness();
  await h.controller.installUpdate();
  assert.equal(h.calls.close, 0);
  await ready(h);
  await Promise.all([
    h.controller.installUpdate(),
    h.controller.installUpdate(),
  ]);
  assert.equal(h.calls.close, 1);
  assert.equal(h.calls.install, 0);
  const first = h.controller.confirmInstall();
  assert.equal(h.controller.confirmInstall(), first);
  assert.equal(await first, true);
  assert.equal(h.calls.install, 1);
});

test("cancelled saving disarms the helper and later ordinary quit cannot install", async () => {
  const h = controllerHarness();
  await ready(h);
  await h.controller.installUpdate();
  h.controller.cancelInstall();
  assert.equal(h.controller.getState().status, "available");
  await h.controller.cancelForQuit();
  assert.equal(await h.controller.confirmInstall(), false);
  assert.equal(h.calls.install, 0);
  assert.equal(h.calls.cancel, 1);
});

test("late install acknowledgement after cancellation is ignored and ordinary exit awaits native cancellation", async () => {
  const h = controllerHarness();
  const install = deferred();
  const cancel = deferred();
  h.adapter.install = () => {
    h.calls.install++;
    return install.promise;
  };
  h.adapter.cancel = () => {
    h.calls.cancel++;
    return cancel.promise;
  };
  await ready(h);
  await h.controller.installUpdate();
  const confirming = h.controller.confirmInstall();
  await tick();
  h.controller.cancelInstall();
  let quitReady = false;
  const quitting = h.controller.cancelForQuit().then(() => {
    quitReady = true;
  });
  install.resolve();
  assert.equal(await confirming, false);
  await tick();
  assert.equal(quitReady, false);
  cancel.resolve();
  await quitting;
  assert.equal(h.calls.cancel, 1);
});

test("bad downloads and failed installation report friendly errors and preserve the app", async () => {
  const h = controllerHarness();
  await h.controller.checkForUpdates();
  h.adapter.download = async () => {
    throw new Error("sha512 mismatch at /private/user/cache");
  };
  assert.equal(
    (await h.controller.downloadUpdate()).error,
    "下载更新失败，请稍后重试。",
  );
  assert.equal(h.calls.close, 0);
  h.adapter.download = async () =>
    h.emit({ status: "downloaded", availableVersion: "0.8.0" });
  await ready(h);
  h.adapter.install = async () => {
    throw new Error("installer unavailable");
  };
  await h.controller.installUpdate();
  assert.equal(await h.controller.confirmInstall(), false);
  assert.equal(
    h.controller.getState().error,
    "安装更新失败，请重新下载后重试。",
  );
  assert.equal(h.controller.isInstallPending(), false);
});

test("failed cancellation blocks ordinary exit instead of implicitly installing", async () => {
  const h = controllerHarness();
  await ready(h);
  h.adapter.cancel = async () => {
    throw new Error("helper did not acknowledge cancel");
  };
  await assert.rejects(h.controller.cancelForQuit(), /acknowledge/);
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.calls.install, 0);
  await assert.rejects(h.controller.cancelForQuit(), /acknowledge/);
});

function macHarness(createAdapter = createMacUpdateAdapter) {
  const children = [];
  const states = [];
  const adapter = createAdapter({
    execPath: "/Applications/Guzi.app/Contents/MacOS/Guzi",
    resourcesPath: "/Applications/Guzi.app/Contents/Resources",
    emit: (state) => states.push(state),
    spawnHelper: (file, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, {
        file,
        args,
        options,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        unref: () => (child.unreferenced = true),
      });
      child.commands = "";
      child.stdin.on("data", (data) => (child.commands += data.toString()));
      child.event = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
      children.push(child);
      return child;
    },
  });
  return { adapter, children, states };
}

test("macOS uses a detached bundled helper with the fixed release feed and bounded progress", async () => {
  const h = macHarness();
  const checking = h.adapter.check();
  const child = h.children[0];
  assert.equal(child.unreferenced, true);
  assert.equal(child.options.detached, true);
  assert.equal(
    child.file,
    "/Applications/Guzi.app/Contents/Resources/updater/Guzi Updater.app/Contents/MacOS/guzi-updater",
  );
  assert.deepEqual(child.args, [
    "--mode",
    "check",
    "--host",
    "/Applications/Guzi.app",
    "--feed",
    MAC_UPDATE_FEED,
  ]);
  child.event({ event: "available", version: "0.8.0" });
  child.event({ event: "done", status: "available" });
  await checking;
  const downloading = h.adapter.download();
  const download = h.children[1];
  download.event({ event: "available", version: "0.8.0" });
  download.event({ event: "downloading", progress: 0.25 });
  assert.equal(h.states.at(-1).progress, 25);
  download.event({ event: "downloaded", version: "0.8.0" });
  await downloading;
  assert.equal(download.commands, "");
  const installing = h.adapter.install();
  assert.equal(download.commands, '{"command":"install"}\n');
  download.event({ event: "installing" });
  await installing;
  await h.adapter.cancel();
  assert.equal(download.commands, '{"command":"install"}\n');
  assert.equal(download.stdout.destroyed, true);
});

test("macOS no-update helper completes without downloading or installing", async () => {
  const h = macHarness();
  const checking = h.adapter.check();
  h.children[0].event({ event: "up-to-date" });
  h.children[0].event({ event: "done", status: "up-to-date" });
  await checking;
  assert.equal(h.states.at(-1).status, "up-to-date");
  await h.adapter.cancel();
  assert.equal(h.children[0].commands, "");
  await assert.rejects(h.adapter.install(), /not ready/);
});

test("macOS cancellation waits for cleaned-up acknowledgement and ignores late installing events", async () => {
  const h = macHarness();
  const downloading = h.adapter.download();
  const child = h.children[0];
  child.event({ event: "downloaded", version: "0.8.0" });
  await downloading;
  const installing = h.adapter.install();
  const rejected = assert.rejects(installing, /cancelled/);
  let done = false;
  const cancelling = h.adapter.cancel().then(() => (done = true));
  child.event({ event: "installing" });
  await tick();
  assert.equal(done, false);
  child.event({ event: "cancelled" });
  child.event({ event: "done", status: "cancelled" });
  await Promise.all([cancelling, rejected]);
  assert.equal(child.commands, '{"command":"install"}\n{"command":"cancel"}\n');
});

test("macOS rejects malformed, oversized and invalid-progress helper events and requests cancellation", async () => {
  for (const output of [
    "not-json\n",
    "x".repeat(65537),
    '{"event":"downloading","progress":2}\n',
    '{"event":"installing"}\n',
    '{"event":"unknown"}\n',
  ]) {
    const h = macHarness();
    const result = h.adapter.download();
    const rejected = assert.rejects(result);
    const child = h.children[0];
    child.stdout.write(output);
    assert.equal(child.commands, '{"command":"cancel"}\n');
    child.event({ event: "done", status: "cancelled" });
    await rejected;
    assert.equal(h.states.at(-1).status, "error");
  }
});

test("macOS helper crash invalidates a downloaded update", async () => {
  const h = macHarness();
  const downloading = h.adapter.download();
  const child = h.children[0];
  child.event({ event: "downloaded", version: "0.8.0" });
  await downloading;
  child.emit("exit", 1);
  assert.equal(h.states.at(-1).status, "error");
  await assert.rejects(h.adapter.install(), /not ready/);
});

function windowsHarness() {
  const updater = new EventEmitter();
  const quitEvents = new EventEmitter();
  const states = [];
  const calls = { check: 0, download: 0, install: [], cancelled: 0 };
  updater.checkForUpdates = async () => {
    calls.check++;
    updater.emit("update-available", { version: "0.8.0" });
    return { cancellationToken: { cancel: () => calls.cancelled++ } };
  };
  updater.downloadUpdate = async () => {
    calls.download++;
    updater.emit("download-progress", { percent: 20 });
    updater.emit("update-downloaded", { version: "0.8.0" });
    return ["cached-installer.exe"];
  };
  updater.quitAndInstall = (...args) => calls.install.push(args);
  const adapter = createWindowsUpdateAdapter({
    updater,
    quitEvents,
    emit: (state) => states.push(state),
  });
  return { adapter, updater, quitEvents, states, calls };
}

test("Windows disables implicit downloads and quit installation, then explicitly installs with relaunch", async () => {
  const h = windowsHarness();
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  await h.adapter.check();
  assert.equal(h.calls.download, 0);
  await h.adapter.download();
  assert.equal(h.states.at(-1).status, "downloaded");
  assert.deepEqual(h.calls.install, []);
  const installing = h.adapter.install();
  assert.equal(h.adapter.install(), installing);
  assert.deepEqual(h.calls.install, [[true, true]]);
  h.quitEvents.emit("before-quit-for-update");
  await installing;
  await h.adapter.cancel();
});

test("Windows cancelled ready update cannot install on later exit and has no accumulated error listeners", async () => {
  const h = windowsHarness();
  await h.adapter.check();
  await tick();
  await h.adapter.download();
  await h.adapter.cancel();
  assert.equal(h.calls.cancelled, 1);
  await assert.rejects(h.adapter.install(), /not ready/);
  h.updater.emit("error", new Error("late cancellation"));
  assert.deepEqual(h.calls.install, []);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  const again = createWindowsUpdateAdapter({
    updater: h.updater,
    quitEvents: h.quitEvents,
    emit: () => {},
  });
  await again.cancel();
  assert.equal(h.updater.listenerCount("error"), 1);
});

test("Windows integrity errors reject downloads and installation errors do not acknowledge exit", async () => {
  const h = windowsHarness();
  await h.adapter.check();
  h.updater.downloadUpdate = async () => {
    throw new Error("sha512 checksum mismatch");
  };
  await assert.rejects(h.adapter.download(), /checksum/);
  await assert.rejects(h.adapter.install(), /not ready/);
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "0.8.0" });
    return ["cached-installer.exe"];
  };
  await h.adapter.download();
  h.updater.quitAndInstall = () =>
    h.updater.emit("error", new Error("installer failed"));
  await assert.rejects(h.adapter.install(), /installer failed/);
  await h.adapter.cancel();
});

test("macOS failed package validation completes cleanup and does not prevent normal exit", async () => {
  const h = macHarness();
  const downloading = h.adapter.download();
  const rejected = assert.rejects(downloading, /failure/);
  h.children[0].event({
    event: "error",
    code: 3002,
    message: "invalid signature",
  });
  const cancelled = h.adapter.cancel();
  h.children[0].event({ event: "done", status: "error" });
  await Promise.all([rejected, cancelled]);
  await h.adapter.cancel();
  assert.equal(h.states.at(-1).status, "error");
});

test("a later exit can recover when previously timed-out native cancellation has completed", async () => {
  const h = controllerHarness();
  await ready(h);
  let cleaned = false;
  h.adapter.cancel = async () => {
    if (!cleaned) throw new Error("cancel timed out");
  };
  await assert.rejects(h.controller.cancelForQuit(), /timed out/);
  cleaned = true;
  await h.controller.cancelForQuit();
  assert.equal(h.calls.install, 0);
});

test("Windows late native quit after cancelled installation is explicitly rejected once", async () => {
  const updater = new EventEmitter();
  const quitEvents = new EventEmitter();
  let blocked = 0;
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "0.8.0" });
    return {};
  };
  updater.downloadUpdate = async () => {
    updater.emit("update-downloaded", { version: "0.8.0" });
    return ["installer.exe"];
  };
  updater.quitAndInstall = () => {};
  const adapter = createWindowsUpdateAdapter({
    updater,
    quitEvents,
    emit() {},
    onQuitRejected: () => blocked++,
  });
  await adapter.check();
  await adapter.download();
  const rejected = assert.rejects(adapter.install(), /cancelled/);
  await adapter.cancel();
  quitEvents.emit("before-quit-for-update");
  assert.equal(blocked, 1);
  await rejected;
  await tick();
  assert.equal(quitEvents.listenerCount("before-quit-for-update"), 0);
});

test("macOS helper paths stay POSIX when the host defaults to Windows paths", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const loaded = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "update-mac.cjs"), "utf8"),
    {
      module: loaded,
      require: (name) => (name === "node:path" ? path.win32 : require(name)),
      Buffer,
      setTimeout,
      clearTimeout,
    },
  );
  const h = macHarness(loaded.exports.createMacUpdateAdapter);
  const checking = h.adapter.check();
  const child = h.children[0];
  assert.equal(
    child.file,
    "/Applications/Guzi.app/Contents/Resources/updater/Guzi Updater.app/Contents/MacOS/guzi-updater",
  );
  assert.equal(child.args[3], "/Applications/Guzi.app");
  child.event({ event: "up-to-date" });
  child.event({ event: "done", status: "up-to-date" });
  await checking;
});
