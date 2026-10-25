const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

test("preload exposes the current platform without adding a platform IPC", async () => {
  const source = await fs.readFile(path.join(__dirname, "index.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    let desktop;
    const calls = [];
    vm.runInNewContext(source, {
      process: { platform },
      require: (name) => {
        assert.equal(name, "electron");
        return {
          contextBridge: {
            exposeInMainWorld: (key, value) => {
              assert.equal(key, "desktop");
              desktop = value;
            },
          },
          ipcRenderer: {
            invoke: (...args) => calls.push(args),
          },
        };
      },
    });
    assert.equal(desktop.platform, platform);
    assert.deepEqual(calls, []);
    desktop.getSettings();
    assert.deepEqual(calls, [["desktop:get-settings"]]);
  }
});

test("update bridge actions accept no renderer arguments and unsubscribe update listeners", async () => {
  const source = await fs.readFile(path.join(__dirname, "index.cjs"), "utf8");
  let desktop;
  const calls = [];
  const listeners = new Map();
  vm.runInNewContext(source, {
    process: { platform: "darwin" },
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_key, value) => {
          desktop = value;
        },
      },
      ipcRenderer: {
        invoke: (...args) => calls.push(args),
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          assert.equal(listeners.get(channel), listener);
          listeners.delete(channel);
        },
      },
    }),
  });
  for (const [method, channel] of [
    ["getUpdateState", "get-update-state"],
    ["checkForUpdates", "check-for-updates"],
    ["downloadUpdate", "download-update"],
    ["installUpdate", "install-update"],
  ]) {
    desktop[method]({
      feed: "https://attacker.invalid",
      path: "/tmp/not-an-update",
    });
    assert.deepEqual(calls.at(-1), [`desktop:${channel}`]);
  }
  let received;
  const unsubscribe = desktop.onUpdateState((state) => {
    received = state;
  });
  const state = { status: "downloading", progress: 45 };
  listeners.get("desktop:update-state")({ sender: "not exposed" }, state);
  assert.equal(received, state);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.throws(() => desktop.onUpdateState(null), /回调/);
});
