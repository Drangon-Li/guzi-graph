import DropdownMenu from "../../components/dropdownMenu/DropdownMenu";
import { IconButton } from "../../components/IconButton";
import { FormulaIcon } from "../../components/icons";
import { isToolButtonDisabled } from "../../components/Tools";
import { t } from "../../i18n";

import type { AppClassProperties } from "../../types";

export const FormulaMenuItem = ({ app }: { app: AppClassProperties }) => (
  <DropdownMenu.Item
    onSelect={() => app.setOpenDialog({ name: "formula" })}
    icon={FormulaIcon}
    disabled={isToolButtonDisabled(app, "text")}
    data-testid="menu-insert-formula"
  >
    {t("labels.insertFormula")}
  </DropdownMenu.Item>
);

export const FormulaInsertButton = ({ app }: { app: AppClassProperties }) => {
  const label = t("labels.insertFormula");
  return (
    <IconButton
      type="button"
      icon={FormulaIcon}
      aria-label={label}
      tooltip={label}
      tooltipEnabled={app.props.desktopIntegration?.toolbarTooltips !== false}
      disabled={isToolButtonDisabled(app, "text")}
      data-testid="toolbar-formula"
      onClick={() => app.setOpenDialog({ name: "formula" })}
    />
  );
};
