import { getLanguage } from "../i18n";

import { useAppProps } from "./App";

import "./PreferenceConfigureButton.scss";

import type { PreferenceSection } from "../types";

export const PreferenceConfigureButton = ({
  section,
}: {
  section: PreferenceSection;
}) => {
  const { desktopIntegration } = useAppProps();
  const labels = {
    fonts: ["配置字体", "Configure fonts"],
    background: ["配置画布背景", "Configure canvas background"],
    elementStroke: ["配置描边颜色", "Configure stroke colors"],
    elementBackground: ["配置填充颜色", "Configure fill colors"],
    fontSizes: ["配置字号", "Configure font sizes"],
  };
  const label = labels[section][getLanguage().code.startsWith("zh") ? 0 : 1];
  return (
    <button
      type="button"
      className="preference-configure-button"
      aria-label={label}
      title={label}
      onClick={() => desktopIntegration?.onConfigurePreferences?.(section)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M14.5 6.5a5 5 0 0 0-6 6L3 18a2.1 2.1 0 0 0 3 3l5.5-5.5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z" />
      </svg>
    </button>
  );
};
