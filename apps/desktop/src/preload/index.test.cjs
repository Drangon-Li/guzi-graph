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
