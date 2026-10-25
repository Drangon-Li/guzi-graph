const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const files = ["src/main", "src/main/i18n", "src/preload"].flatMap(
  (directory) =>
    fs
      .readdirSync(path.join(desktop, directory))
      .filter((name) => name.endsWith(".test.cjs"))
      .map((name) => path.join(directory, name)),
);
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: desktop,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
