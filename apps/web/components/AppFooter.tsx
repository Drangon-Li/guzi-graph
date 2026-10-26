import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { isExcalidrawPlusSignedUser } from "../app_constants";
import { SINGLE_USER_MODE } from "../singleUser";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {SINGLE_USER_MODE ? (
            <span style={{ fontSize: 12, color: "var(--color-gray-60)" }}>
              数据保存在本浏览器，请定期导出备份
            </span>
          ) : (
            !isExcalidrawPlusSignedUser && <EncryptedIcon />
          )}
        </div>
      </Footer>
    );
  },
);
