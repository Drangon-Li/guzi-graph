const { contextBridge, ipcRenderer } = require("electron");

const prefix = "--guzi-user-plugin-channel=";
const channel = process.argv
  .find((argument) => argument.startsWith(prefix))
  ?.slice(prefix.length);
if (!/^guzi:user-plugin:[a-f0-9-]{36}$/.test(channel || "")) {
  throw new Error("Missing isolated plugin channel");
}
let subscribed = false;
contextBridge.exposeInMainWorld("pluginRuntimeHost", {
  send(message) {
    const serialized = JSON.stringify(message);
    if (
      !serialized ||
      Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024
    ) {
      throw new Error("Plugin message exceeds 2 MiB");
    }
    ipcRenderer.send(channel, JSON.parse(serialized));
  },
  onMessage(callback) {
    if (subscribed || typeof callback !== "function") {
      throw new Error("Invalid plugin host subscription");
    }
    subscribed = true;
    ipcRenderer.on(channel, (_event, message) => callback(message));
  },
});
