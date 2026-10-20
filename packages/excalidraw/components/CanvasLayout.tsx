import { createContext, useContext, useState } from "react";

import "./CanvasLayout.scss";

import type { ReactNode, Ref } from "react";

const SidebarDockContext = createContext<HTMLDivElement | null>(null);
export const useSidebarDockContainer = () => useContext(SidebarDockContext);

export const CanvasLayout = ({
  children,
  viewportRef,
  dockSidebar,
  sidebarOpen,
}: {
  children: ReactNode;
  viewportRef: Ref<HTMLDivElement>;
  dockSidebar: boolean;
  sidebarOpen: boolean;
}) => {
  const [dockContainer, setDockContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const open = dockSidebar && sidebarOpen;
  return (
    <SidebarDockContext.Provider value={dockSidebar ? dockContainer : null}>
      <div className="excalidraw-canvas-surface" ref={viewportRef}>
        {children}
      </div>
      <div
        className="excalidraw-sidebar-dock"
        data-open={open}
        aria-hidden={!open}
        inert={!open}
        ref={setDockContainer}
      />
    </SidebarDockContext.Provider>
  );
};
