const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { verifyRelease } = require("./release-assets.cjs");
const { version } = require("../package.json");
const semver = require("semver");

const directory = path.resolve(process.argv[2] || "release-assets");
const tag = `v${version}`;
assert.equal(process.env.GITHUB_REF_NAME, tag);
assert.equal(process.env.GH_REPO, "Drangon-Li/guzi-graph");
const files = verifyRelease(directory, version);
const gh = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const existing = spawnSync(
  "gh",
  ["release", "view", tag, "--json", "isDraft"],
  { encoding: "utf8" },
);
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "guzi-release-verification-"),
);
try {
  if (existing.status === 0) {
    assert.equal(
      JSON.parse(existing.stdout).isDraft,
      true,
      "Refusing to replace a published release",
    );
  } else {
    const notes = path.join(temporary, "release-notes.txt");
    fs.writeFileSync(
      notes,
      `桌面版 ${tag}\n\n更新内容请见本次 Release 的提交记录。\n\n应用内更新：桌面设置 → 通用 → 版本与更新。macOS 和 Windows 均支持检查、下载、确认保存后安装并重启。\n\nv0.7.4 及更早版本需要先手动安装一次 v0.8.0 或更新版本，此后可以在软件内升级。macOS 当前仍为 ad-hoc 签名，未进行 Developer ID 签名和公证；首次安装可能需要在系统设置中允许打开。应用内 Mac 更新包使用独立 Ed25519 签名验证。\n\nmacOS：Apple Silicon、macOS 12 或更高版本。Windows：x64 NSIS 安装版支持应用内更新；便携版 ZIP 需手动更新。\n`,
    );
    gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      "--title",
      `Excalidraw-Guzi ${tag}`,
      "--notes-file",
      notes,
      "--generate-notes",
    ]);
  }
  gh([
    "release",
    "upload",
    tag,
    ...files.map((name) => path.join(directory, name)),
    "--clobber",
  ]);
  const downloaded = path.join(temporary, "downloaded");
  fs.mkdirSync(downloaded);
  gh(["release", "download", tag, "--dir", downloaded]);
  verifyRelease(downloaded, version);
  const latest = JSON.parse(gh(["release", "view", "--json", "tagName"]));
  assert.ok(
    semver.valid(latest.tagName) && semver.gt(version, latest.tagName),
    "Refusing to replace latest with an older or equal version",
  );
  gh(["release", "edit", tag, "--draft=false", "--latest"]);
  console.log(
    `Published https://github.com/Drangon-Li/guzi-graph/releases/tag/${tag}`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
