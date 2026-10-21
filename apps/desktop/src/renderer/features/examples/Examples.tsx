import { useState } from "react";

import { translate } from "../../shared/i18n/i18n";

import { bundledExamples } from "./catalog";

import "./Examples.scss";

import type { DesktopLanguage } from "../../shared/i18n/i18n";

export const Examples = ({
  language,
  onOpen,
}: {
  language: DesktopLanguage;
  onOpen: (title: string, content: string) => Promise<unknown>;
}) => {
  const [opening, setOpening] = useState(false);
  const t = (message: string) => translate(language, message);
  return (
    <div className="desktop-project-grid">
      {bundledExamples.map((example) => (
        <article className="desktop-file-card" key={example.id}>
          <button
            className="desktop-file-open"
            disabled={opening}
            onClick={async () => {
              setOpening(true);
              try {
                await onOpen(t(example.title), example.content);
              } finally {
                setOpening(false);
              }
            }}
            title={t("打开未保存的副本")}
          >
            <span className="desktop-file-preview" aria-hidden="true">
              <img src={example.preview} alt="" />
            </span>
            <span className="desktop-file-title">{t(example.title)}</span>
            <span className="desktop-file-category desktop-example-description">
              {t(example.description)}
            </span>
          </button>
        </article>
      ))}
    </div>
  );
};
