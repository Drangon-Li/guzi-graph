import { fireEvent, render, waitFor } from "@testing-library/react";

import { FONT_FAMILY } from "@excalidraw/common";

import { SceneFontPicker } from "../components/SceneFontPicker";

const integration = {
  onReplaceSceneFont: vi.fn(),
  sceneFontLabel: "替换当前页字体",
};
const state = { currentItemFontFamily: FONT_FAMILY.Excalifont };

vi.mock("../components/App", () => ({
  useAppProps: () => ({ langCode: "zh-CN", desktopIntegration: integration }),
}));
vi.mock("../hooks/useAppStateValue", () => ({
  useAppStateValue: () => state.currentItemFontFamily,
}));
vi.mock("../components/FontPicker/FontPickerList", () => ({
  FontPickerList: ({
    onHover,
    onSelect,
    selectedFontFamily,
  }: {
    onHover: (value: number) => void;
    onSelect: (value: number) => void;
    selectedFontFamily: number;
  }) => (
    <button
      type="button"
      aria-pressed={selectedFontFamily === FONT_FAMILY.Nunito}
      onPointerEnter={() => onHover(FONT_FAMILY.Nunito)}
      onClick={() => onSelect(FONT_FAMILY.Nunito)}
    >
      Nunito
    </button>
  ),
}));

describe("scene font picker", () => {
  beforeEach(() => {
    state.currentItemFontFamily = FONT_FAMILY.Excalifont;
    integration.onReplaceSceneFont.mockReset().mockResolvedValue(undefined);
  });

  it("shows the current editor default instead of a previous local selection", () => {
    const view = render(<SceneFontPicker />);
    fireEvent.click(view.getByRole("button", { name: "选择字体并替换" }));
    expect(view.getByRole("button", { name: "Nunito" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    state.currentItemFontFamily = FONT_FAMILY.Nunito;
    view.rerender(<SceneFontPicker />);
    expect(view.getByRole("button", { name: "Nunito" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps hover local and invokes replacement exactly once on selection", async () => {
    const view = render(<SceneFontPicker />);
    expect(view.getByText("仅替换当前层，跳过锁定文字。")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "选择字体并替换" }));
    fireEvent.pointerEnter(view.getByRole("button", { name: "Nunito" }));
    expect(integration.onReplaceSceneFont).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Nunito" }));
    await waitFor(() =>
      expect(integration.onReplaceSceneFont).toHaveBeenCalledTimes(1),
    );
    expect(integration.onReplaceSceneFont).toHaveBeenCalledWith(
      FONT_FAMILY.Nunito,
    );
    expect(view.queryByRole("button", { name: "Nunito" })).toBeNull();
  });

  it("shows replacement failures", async () => {
    integration.onReplaceSceneFont.mockRejectedValueOnce(
      new Error("字体加载失败"),
    );
    const view = render(<SceneFontPicker />);
    fireEvent.click(view.getByRole("button", { name: "选择字体并替换" }));
    fireEvent.click(view.getByRole("button", { name: "Nunito" }));
    expect(await view.findByRole("alert")).toHaveTextContent("字体加载失败");
  });
});
