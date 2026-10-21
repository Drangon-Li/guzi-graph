import { actionInsertTable } from "../../actions/actionTable";

import { getLanguage } from "../../i18n";

import { IconButton } from "../../components/IconButton";

import type { AppClassProperties } from "../../types";

export const TableInsertButton = ({ app }: { app: AppClassProperties }) => {
  const label = getLanguage().code === "en" ? "Insert table" : "插入表格";
  return (
    <IconButton
      type="button"
      aria-label={label}
      tooltip={`${label} (H)`}
      keyBindingLabel="H"
      aria-keyshortcuts="H"
      tooltipEnabled={app.props.desktopIntegration?.toolbarTooltips !== false}
      data-testid="toolbar-table"
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
        </svg>
      }
      onClick={() => {
        app.syncActionResult(
          actionInsertTable.perform(
            app.scene.getElementsIncludingDeleted(),
            app.state,
            undefined,
            app,
          ),
        );
      }}
    />
  );
};
