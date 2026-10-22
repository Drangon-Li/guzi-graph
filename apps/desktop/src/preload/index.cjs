const { contextBridge, ipcRenderer } = require("electron");

const invoke = (name, ...args) =>
  ipcRenderer.invoke(`desktop:${name}`, ...args);
const listen = (name, callback) => {
  if (typeof callback !== "function") throw new TypeError("需要回调函数。");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`desktop:${name}`, listener);
  return () => ipcRenderer.removeListener(`desktop:${name}`, listener);
};

contextBridge.exposeInMainWorld("desktop", {
  getPlugins: () => invoke("get-plugins"),
  setPluginEnabled: (id, enabled) => invoke("set-plugin-enabled", id, enabled),
  configurePlugin: (id, configuration) =>
    invoke("configure-plugin", id, configuration),
  onPluginState: (callback) => listen("plugin-state", callback),
  onPluginRequest: (callback) => listen("plugin-request", callback),
  onPluginRequestCancelled: (callback) =>
    listen("plugin-request-cancelled", callback),
  respondPluginRequest: (response) =>
    ipcRenderer.send("desktop:plugin-response", response),
  setPluginHostReady: (ready) => invoke("set-plugin-host-ready", ready),
  getSettings: () => invoke("get-settings"),
  updateSettings: (settings) => invoke("update-settings", settings),
  chooseDirectory: () => invoke("choose-directory"),
  listProjects: () => invoke("list-projects"),
  openFiles: () => invoke("open-files"),
  readFile: (path) => invoke("read-file", path),
  recordOpenedFile: (path) => invoke("record-opened-file", path),
  saveFile: (request) => invoke("save-file", request),
  saveExport: (request) => invoke("save-export", request),
  savePdf: (request) => invoke("save-pdf", request),
  exportPdf: (request) => invoke("export-pdf", request),
  editText: (command) => invoke("edit-text", command),
  removeFile: (path, mode) => invoke("remove-file", path, mode),
  renameFile: (path, name) => invoke("rename-file", path, name),
  moveFile: (path, category) => invoke("move-file", path, category),
  createFolder: (category) => invoke("create-folder", category),
  revealFile: (path) => invoke("reveal-file", path),
  getSession: () => invoke("get-session"),
  setSession: (session) => invoke("set-session", session),
  listDrafts: () => invoke("list-drafts"),
  writeDraft: (draft) => invoke("write-draft", draft),
  deleteDraft: (id) => invoke("delete-draft", id),
  takePendingFiles: () => invoke("take-pending-files"),
  onCommand: (callback) => listen("command", callback),
  onFilesOpened: (callback) => listen("files-opened", callback),
  confirmClose: () => ipcRenderer.send("desktop:confirm-close"),
  cancelClose: () => ipcRenderer.send("desktop:cancel-close"),
});
