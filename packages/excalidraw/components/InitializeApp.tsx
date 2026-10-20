import React, { useEffect, useState } from "react";

import type { Theme } from "@excalidraw/element/types";

import {
  defaultLang,
  languages,
  setLanguage,
  editorLangCodeAtom,
} from "../i18n";

import { useSetAtom } from "../editor-jotai";

import { LoadingMessage } from "./LoadingMessage";

import type { Language } from "../i18n";

interface Props {
  langCode: Language["code"];
  children: React.ReactElement;
  theme?: Theme;
}

export const InitializeApp = (props: Props) => {
  const [loading, setLoading] = useState(true);
  const setEditorLanguage = useSetAtom(editorLangCodeAtom);

  useEffect(() => {
    const updateLang = async () => {
      await setLanguage(currentLang);
      setEditorLanguage(currentLang.code);
      setLoading(false);
    };
    const currentLang =
      languages.find((lang) => lang.code === props.langCode) || defaultLang;
    updateLang();
  }, [props.langCode, setEditorLanguage]);

  return loading ? <LoadingMessage theme={props.theme} /> : props.children;
};
