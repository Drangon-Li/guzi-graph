import clsx from "clsx";
import { createPortal } from "react-dom";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";

import {
  CLASSES,
  EVENT,
  isDevEnv,
  KEYS,
  updateObject,
} from "@excalidraw/common";

import { useUIAppState } from "../../context/ui-appState";
import { atom, useSetAtom } from "../../editor-jotai";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import { useApp, useEditorInterface, useExcalidrawSetAppState } from "../App";
import { Island } from "../Island";
import { useSidebarDockContainer } from "../CanvasLayout";

import { SidebarHeader } from "./SidebarHeader";
import { SidebarTabTrigger } from "./SidebarTabTrigger";
import { SidebarTabTriggers } from "./SidebarTabTriggers";
import { SidebarTrigger } from "./SidebarTrigger";
import { SidebarPropsContext } from "./common";
import { SidebarTabs } from "./SidebarTabs";
import { SidebarTab } from "./SidebarTab";

import "./Sidebar.scss";

import type { SidebarProps, SidebarPropsContextValue } from "./common";

/**
 * Flags whether the currently rendered Sidebar is docked or not, for use
 * in upstream components that need to act on this (e.g. LayerUI to shift the
 * UI). We use an atom because of potential host app sidebars (for the default
 * sidebar we could just read from appState.defaultSidebarDockedPreference).
 *
 * Since we can only render one Sidebar at a time, we can use a simple flag.
 */
export const isSidebarDockedAtom = atom(false);

export const SidebarInner = forwardRef(
  (
    {
      name,
      children,
      onDock,
      docked,
      className,
      closing = false,
      ...rest
    }: SidebarProps & { closing?: boolean } & Omit<
        React.RefAttributes<HTMLDivElement>,
        "onSelect"
      >,
    ref: React.ForwardedRef<HTMLDivElement>,
  ) => {
    if (isDevEnv() && onDock && docked == null) {
      console.warn(
        "Sidebar: `docked` must be set when `onDock` is supplied for the sidebar to be user-dockable. To hide this message, either pass `docked` or remove `onDock`",
      );
    }

    const setAppState = useExcalidrawSetAppState();
    const app = useApp();
    const layoutDock = useSidebarDockContainer();
    const effectiveDocked = !!layoutDock || docked;

    const setIsSidebarDockedAtom = useSetAtom(isSidebarDockedAtom);

    useLayoutEffect(() => {
      setIsSidebarDockedAtom(!!effectiveDocked && !closing);
      return () => {
        setIsSidebarDockedAtom(false);
      };
    }, [setIsSidebarDockedAtom, effectiveDocked, closing]);

    const headerPropsRef = useRef<SidebarPropsContextValue>(
      {} as SidebarPropsContextValue,
    );
    headerPropsRef.current.onCloseRequest = () => {
      setAppState({ openSidebar: null });
      app.focusContainer();
    };
    headerPropsRef.current.onDock = (isDocked) => onDock?.(isDocked);
    // renew the ref object if the following props change since we want to
    // rerender. We can't pass down as component props manually because
    // the <Sidebar.Header/> can be rendered upstream.
    headerPropsRef.current = updateObject(headerPropsRef.current, {
      docked: effectiveDocked,
      // explicit prop to rerender on update
      shouldRenderDockButton: !layoutDock && !!onDock && docked != null,
    });

    const islandRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => {
      return islandRef.current!;
    });

    const editorInterface = useEditorInterface();

    const closeLibrary = useCallback(() => {
      const isDialogOpen = !!app.ownerDocument.querySelector(".Dialog");

      // Prevent closing if any dialog is open
      if (isDialogOpen) {
        return;
      }
      setAppState({ openSidebar: null });
    }, [setAppState, app]);

    useOutsideClick(
      islandRef,
      useCallback(
        (event) => {
          // If click on the library icon, do nothing so that LibraryButton
          // can toggle library menu
          if (
            closing ||
            (event.target as Element).closest(".sidebar-trigger")
          ) {
            return;
          }
          if (
            !effectiveDocked ||
            (!layoutDock && !editorInterface.canFitSidebar)
          ) {
            closeLibrary();
          }
        },
        [
          closeLibrary,
          effectiveDocked,
          layoutDock,
          editorInterface.canFitSidebar,
          closing,
        ],
      ),
    );

    useEffect(() => {
      if (closing) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (
          event.key === KEYS.ESCAPE &&
          (!effectiveDocked || (!layoutDock && !editorInterface.canFitSidebar))
        ) {
          closeLibrary();
        }
      };
      app.ownerDocument.addEventListener(EVENT.KEYDOWN, handleKeyDown);
      return () => {
        app.ownerDocument.removeEventListener(EVENT.KEYDOWN, handleKeyDown);
      };
    }, [
      closeLibrary,
      effectiveDocked,
      layoutDock,
      editorInterface.canFitSidebar,
      app,
      closing,
    ]);

    return (
      <Island
        {...rest}
        className={clsx(
          CLASSES.SIDEBAR,
          { "sidebar--docked": effectiveDocked, "sidebar--closing": closing },
          className,
        )}
        // on mobile the sidebar shouldn't push the viewport around even
        // when opened (it's treated as a temporary overlay)
        data-viewport-ui={
          !closing && !layoutDock && editorInterface.formFactor !== "phone"
            ? "side"
            : undefined
        }
        data-viewport-ui-name={
          !closing && !layoutDock && editorInterface.formFactor !== "phone"
            ? "sidebar"
            : undefined
        }
        ref={islandRef}
      >
        <SidebarPropsContext.Provider value={headerPropsRef.current}>
          {children}
        </SidebarPropsContext.Provider>
      </Island>
    );
  },
);
SidebarInner.displayName = "SidebarInner";

export const Sidebar = Object.assign(
  forwardRef((props: SidebarProps, ref: React.ForwardedRef<HTMLDivElement>) => {
    const appState = useUIAppState();
    const app = useApp();
    const layoutDock = useSidebarDockContainer();
    const isOpen = appState.openSidebar?.name === props.name;
    const [retained, setRetained] = useState(isOpen);
    useLayoutEffect(() => {
      if (isOpen) {
        setRetained(true);
        return;
      }
      if (
        appState.openSidebar ||
        app.ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setRetained(false);
        return;
      }
      const timer = app.ownerWindow.setTimeout(() => setRetained(false), 180);
      return () => app.ownerWindow.clearTimeout(timer);
    }, [isOpen, appState.openSidebar, app]);

    const { onStateChange } = props;

    const refPrevOpenSidebar = useRef(appState.openSidebar);
    useEffect(() => {
      if (
        // closing sidebar
        ((!appState.openSidebar &&
          refPrevOpenSidebar?.current?.name === props.name) ||
          // opening current sidebar
          (appState.openSidebar?.name === props.name &&
            refPrevOpenSidebar?.current?.name !== props.name) ||
          // switching tabs or switching to a different sidebar
          refPrevOpenSidebar.current?.name === props.name) &&
        appState.openSidebar !== refPrevOpenSidebar.current
      ) {
        onStateChange?.(
          appState.openSidebar?.name !== props.name
            ? null
            : appState.openSidebar,
        );
      }
      refPrevOpenSidebar.current = appState.openSidebar;
    }, [appState.openSidebar, onStateChange, props.name]);

    const [mounted, setMounted] = useState(false);
    useLayoutEffect(() => {
      setMounted(true);
      return () => setMounted(false);
    }, []);

    // We want to render in the next tick (hence `mounted` flag) so that it's
    // guaranteed to happen after unmount of the previous sidebar (in case the
    // previous sidebar is mounted after the next one). This is necessary to
    // prevent flicker of subcomponents that support fallbacks
    // (e.g. SidebarHeader). This is because we're using flags to determine
    // whether prefer the fallback component or not (otherwise both will render
    // initially), and the flag won't be reset in time if the unmount order
    // it not correct.
    //
    // Alternative, and more general solution would be to namespace the fallback
    // HoC so that state is not shared between subcomponents when the wrapping
    // component is of the same type (e.g. Sidebar -> SidebarHeader).
    const closing = !isOpen && !appState.openSidebar && retained;
    const shouldRender = mounted && (isOpen || closing);

    if (!shouldRender) {
      return null;
    }

    const content = (
      <div
        className="sidebar-transition-shell"
        inert={closing}
        aria-hidden={closing || undefined}
      >
        <SidebarInner {...props} ref={ref} key={props.name} closing={closing} />
      </div>
    );
    return layoutDock ? createPortal(content, layoutDock) : content;
  }),
  {
    Header: SidebarHeader,
    TabTriggers: SidebarTabTriggers,
    TabTrigger: SidebarTabTrigger,
    Tabs: SidebarTabs,
    Tab: SidebarTab,
    Trigger: SidebarTrigger,
  },
);
Sidebar.displayName = "Sidebar";
