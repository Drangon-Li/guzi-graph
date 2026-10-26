import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import ExcalidrawApp from "./App";
import { SINGLE_USER_MODE } from "./singleUser";

const mountApp = async () => {
  if (!SINGLE_USER_MODE) {
    await import("./sentry");
  }

  window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
  const rootElement = document.getElementById("root")!;
  const root = createRoot(rootElement);
  registerSW();
  root.render(
    <StrictMode>
      <ExcalidrawApp />
    </StrictMode>,
  );
};

mountApp();
