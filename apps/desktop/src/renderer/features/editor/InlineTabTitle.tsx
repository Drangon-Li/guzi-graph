import { useLayoutEffect, useRef, useState } from "react";

import { translate } from "../../shared/i18n/i18n";

import "./InlineTabTitle.scss";

import type { DesktopLanguage } from "../../shared/i18n/i18n";

import type { CanvasDocument } from "../workspace/workspace";

export const InlineTabTitle = ({
  document,
  language = "zh-CN",
  selected,
  onActivate,
  onRename,
}: {
  document: CanvasDocument;
  language?: DesktopLanguage;
  selected: boolean;
  onActivate: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
}) => {
  const t = (message: string) => translate(language, message);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const phase = useRef<"idle" | "editing" | "pending">("idle");
  const composing = useRef(false);
  const restoreFocus = useRef(false);
  const width = useRef(0);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState(document.title);

  useLayoutEffect(() => {
    if (editing) {
      input.current!.focus();
      input.current!.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const finish = () => {
    phase.current = "idle";
    setPending(false);
    setEditing(false);
  };
  const submit = async () => {
    if (phase.current !== "editing") {
      return;
    }
    phase.current = "pending";
    if (value.trim() === document.title) {
      finish();
      return;
    }
    setPending(true);
    try {
      await onRename(document.id, value.trim());
    } finally {
      restoreFocus.current =
        restoreFocus.current &&
        input.current?.ownerDocument.activeElement === input.current;
      finish();
    }
  };
  const status = (
    <span className="desktop-tab-status">
      {document.saving ? "↻" : document.dirty ? "●" : ""}
    </span>
  );
  const sleepLabel = t("已休眠，选择此标签以唤醒");
  const sleep = document.asleep && (
    <svg
      className="desktop-tab-sleep"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label={sleepLabel}
    >
      <path
        d="M13.5 2.5C7 2 3.5 4.5 3.5 8.5a4 4 0 0 0 4 4c4 0 6.5-3.5 6-10Z"
        fill="currentColor"
      />
      <path d="m2.5 13.5 7-7" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );

  if (editing) {
    return (
      <div className="desktop-tab-edit" style={{ width: width.current }}>
        {status}
        {sleep}
        <input
          ref={input}
          aria-label={t("画布名称")}
          aria-busy={pending}
          value={value}
          readOnly={pending}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onBlur={() => {
            restoreFocus.current = false;
            void submit();
          }}
          onKeyUp={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            ) {
              return;
            }
            if (event.key === "Escape" && phase.current === "editing") {
              event.preventDefault();
              restoreFocus.current = true;
              finish();
            } else if (event.key === "Enter") {
              event.preventDefault();
              restoreFocus.current = true;
              void submit();
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      ref={button}
      role="tab"
      aria-selected={selected}
      onClick={() => onActivate(document.id)}
      onDoubleClick={(event) => {
        event.preventDefault();
        width.current = event.currentTarget.getBoundingClientRect().width;
        phase.current = "editing";
        composing.current = false;
        restoreFocus.current = false;
        setValue(document.title);
        setEditing(true);
      }}
      title={[
        document.path || t("尚未保存"),
        t("双击重命名"),
        ...(document.asleep ? [sleepLabel] : []),
      ].join(" · ")}
    >
      {status}
      {sleep}
      <span>{document.title}</span>
    </button>
  );
};
