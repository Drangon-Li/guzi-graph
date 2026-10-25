const { spawnSync } = require("node:child_process");
const path = require("node:path");

const channel = process.argv[2];
if (!["test", "dev-ppt"].includes(channel)) {
  throw new Error("Expected build channel: test or dev-ppt");
}
const vite = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const result = spawnSync(process.execPath, [vite, "build"], {
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, VITE_DESKTOP_BUILD_CHANNEL: channel },
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
