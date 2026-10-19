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
  getSettings: () => invoke("get-settings"),
  updateSettings: (settings) => invoke("update-settings", settings),
  chooseDirectory: () => invoke("choose-directory"),
  listProjects: () => invoke("list-projects"),
  openFiles: () => invoke("open-files"),
  readFile: (path) => invoke("read-file", path),
  recordOpenedFile: (path) => invoke("record-opened-file", path),
  saveFile: (request) => invoke("save-file", request),
  saveExport: (request) => invoke("save-export", request),
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
