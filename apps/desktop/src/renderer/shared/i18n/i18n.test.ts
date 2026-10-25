import { translate } from "./i18n";

it("translates UI templates while preserving user titles and parameter values", () => {
  expect(translate("en", "关闭 {title}", { title: "未命名" })).toBe(
    "Close 未命名",
  );
  expect(
    translate("zh-CN", "发现 {count} 份未保存的恢复草稿。", { count: 2 }),
  ).toBe("发现 2 份未保存的恢复草稿。");
  expect(translate("en", "User document title")).toBe("User document title");
  expect(translate("en", "关闭 {title}")).toBe("Close {title}");
});

it("translates platform-specific trash descriptions and dynamic shortcuts", () => {
  expect(
    translate("en", "「{title}」将移到废纸篓，并从项目页移除。", {
      title: "Sketch",
    }),
  ).toBe("“Sketch” will move to the Trash and be removed from Projects.");
  expect(
    translate("en", "「{title}」将移到回收站，并从项目页移除。", {
      title: "Sketch",
    }),
  ).toBe("“Sketch” will move to the Recycle Bin and be removed from Projects.");
  expect(
    translate("en", "项目页 · {shortcut}", { shortcut: "Ctrl+Shift+P" }),
  ).toBe("Projects · Ctrl+Shift+P");
});
