const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { translate } = require("./i18n.cjs");
const english = require("./en.json");

test("native translations cover application messages and preserve interpolation in both languages", () => {
  for (const file of ["main.cjs", "storage.cjs", "pdf.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const match of source.matchAll(
      /"([^"\\\n]*[\u4e00-\u9fff][^"\\\n]*)"/g,
    ))
      assert.equal(typeof english[match[1]], "string", `${file}: ${match[1]}`);
  }
  assert.equal(
    translate("en", "关于 {name}", { name: "Excalidraw" }),
    "About Excalidraw",
  );
  assert.equal(
    translate("zh-CN", "关于 {name}", { name: "Excalidraw" }),
    "关于 Excalidraw",
  );
});
