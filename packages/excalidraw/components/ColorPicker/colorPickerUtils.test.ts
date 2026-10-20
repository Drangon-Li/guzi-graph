import { COLOR_PALETTE } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { getMostUsedCustomColors } from "./colorPickerUtils";

it("counts text highlights independently from fills and excludes transparent or deleted runs", () => {
  const text = {
    type: "text",
    strokeColor: "#123456",
    backgroundColor: "#456789",
    richText: {
      version: 1,
      paragraphs: [
        {
          runs: [
            { text: "first", background: "#abcdef" },
            { text: "second", background: "#abcdef" },
            { text: "none", background: "transparent" },
            { text: "other", background: "#fedcba" },
          ],
        },
      ],
    },
  } as ExcalidrawElement;
  const deleted = {
    ...text,
    isDeleted: true,
    richText: {
      version: 1,
      paragraphs: [{ runs: [{ text: "deleted", background: "#112233" }] }],
    },
  } as ExcalidrawElement;
  expect(
    getMostUsedCustomColors([text, deleted], "textHighlight", COLOR_PALETTE),
  ).toEqual(["#abcdef", "#fedcba"]);
  expect(
    getMostUsedCustomColors([text], "elementBackground", COLOR_PALETTE),
  ).toEqual(["#456789"]);
  expect(
    getMostUsedCustomColors(
      [
        text,
        { type: "rectangle", strokeColor: "#778899" } as ExcalidrawElement,
      ],
      "tableText",
      COLOR_PALETTE,
    ),
  ).toEqual(["#123456"]);
});
