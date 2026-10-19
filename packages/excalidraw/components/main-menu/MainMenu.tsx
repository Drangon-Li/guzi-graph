import React from "react";

import { composeEventHandlers } from "@excalidraw/common";

import { useTunnels } from "../../context/tunnels";
import { useUIAppState } from "../../context/ui-appState";
import { t } from "../../i18n";
import {
  useAppProps,
  useEditorInterface,
  useExcalidrawSetAppState,
} from "../App";
import { UserList } from "../UserList";
import DropdownMenu from "../dropdownMenu/DropdownMenu";
import DropdownMenuSub from "../dropdownMenu/DropdownMenuSub";
import {
  DropdownMenuContentPropsContext,
  PersistentMenuContext,
} from "../dropdownMenu/common";
import { getToolPanelDock, ToolPanelDockControls } from "../ToolPanel";
import { withInternalFallback } from "../hoc/withInternalFallback";
import { HamburgerMenuIcon } from "../icons";

import * as DefaultItems from "./DefaultItems";

const MainMenu = Object.assign(
  withInternalFallback(
    "MainMenu",
    ({
      children,
      onSelect,
    }: {
      children?: React.ReactNode;
      /**
       * Called when any menu item is selected (clicked on).
       */
      onSelect?: (event: Event) => void;
    }) => {
      const { MainMenuTunnel } = useTunnels();
      const editorInterface = useEditorInterface();
      const appState = useUIAppState();
      const appProps = useAppProps();
      const setAppState = useExcalidrawSetAppState();
      const toolPanel = appProps.desktopIntegration?.toolPanel;
      const dock = getToolPanelDock(
        toolPanel,
        appState,
        editorInterface.formFactor === "phone",
      );

      if (dock !== "floating") {
        return (
          <MainMenuTunnel.In>
            <PersistentMenuContext.Provider value={true}>
              <DropdownMenuContentPropsContext.Provider value={{ onSelect }}>
                <div className="dropdown-menu main-menu tool-panel-menu">
                  {children}
                </div>
              </DropdownMenuContentPropsContext.Provider>
            </PersistentMenuContext.Provider>
          </MainMenuTunnel.In>
        );
      }

      return (
        <MainMenuTunnel.In>
          <DropdownMenu open={appState.openMenu === "canvas"}>
            <DropdownMenu.Trigger
              onToggle={() => {
                setAppState({
                  openMenu: appState.openMenu === "canvas" ? null : "canvas",
                  openPopup: null,
                  openDialog: null,
                });
              }}
              data-testid="main-menu-trigger"
              className="main-menu-trigger"
            >
              {HamburgerMenuIcon}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              onClickOutside={() => setAppState({ openMenu: null })}
              onSelect={composeEventHandlers(onSelect, () => {
                setAppState({ openMenu: null });
              })}
              className="main-menu"
              align="start"
            >
              {toolPanel && editorInterface.formFactor !== "phone" && (
                <div className="tool-panel-floating-header">
                  <span>{toolPanel.labels.title}</span>
                  <ToolPanelDockControls
                    options={toolPanel}
                    onChange={(next) => {
                      toolPanel.onDockChange(next);
                      setAppState({ openMenu: null });
                    }}
                  />
                </div>
              )}
              {children}
              {editorInterface.formFactor === "phone" &&
                appState.collaborators.size > 0 && (
                  <fieldset className="UserList-Wrapper">
                    <legend>{t("labels.collaborators")}</legend>
                    <UserList
                      mobile={true}
                      collaborators={appState.collaborators}
                      userToFollow={appProps.userToFollow?.socketId || null}
                      currentUserControls={appProps.currentUserControls}
                    />
                  </fieldset>
                )}
            </DropdownMenu.Content>
          </DropdownMenu>
        </MainMenuTunnel.In>
      );
    },
  ),
  {
    Trigger: DropdownMenu.Trigger,
    Item: DropdownMenu.Item,
    ItemLink: DropdownMenu.ItemLink,
    ItemCustom: DropdownMenu.ItemCustom,
    Group: DropdownMenu.Group,
    Separator: DropdownMenu.Separator,
    Sub: DropdownMenuSub,
    DefaultItems,
  },
);

export default MainMenu;
