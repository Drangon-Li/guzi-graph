import { createRoot } from "react-dom/client";

const root = globalThis.document.getElementById("root")!;
const ownerWindow = root.ownerDocument.defaultView!;
ownerWindow.EXCALIDRAW_ASSET_PATH = new ownerWindow.URL(
  "./",
  ownerWindow.location.href,
).href;

void (async () => {
  const { setFileSystemAdapter } = await import("@excalidraw/excalidraw");
  setFileSystemAdapter({
    fileSave: async (blob, options) => {
      const saved = await ownerWindow.desktop.saveExport({
        name: options.name,
        extension: options.extension,
        data: await blob.arrayBuffer(),
      });
      if (!saved) {
        throw new ownerWindow.DOMException("已取消导出", "AbortError");
      }
      return null;
    },
  });
  const { App } = await import("./app/App");
  createRoot(root).render(<App root={root} />);
})();
