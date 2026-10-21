const { spawn } = require("node:child_process");
const path = require("node:path");
const electron = require("electron");
const vite = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const server = spawn(process.execPath, [vite], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});
let desktop;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  desktop?.kill();
  server.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", () => {
  desktop?.kill();
});
(async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:4317")).ok) {
        desktop = spawn(electron, ["."], {
          stdio: "inherit",
          cwd: path.join(__dirname, ".."),
          env: {
            ...process.env,
            EXCALIDRAW_DESKTOP_DEV_URL: "http://127.0.0.1:4317",
          },
        });
        desktop.on("exit", () => {
          stop();
        });
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  stop();
  throw new Error("Vite server did not become ready");
})();
