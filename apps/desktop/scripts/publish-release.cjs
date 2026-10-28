const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { validateVersions, verifyRelease } = require("./release-assets.cjs");
const { version, windowsReleaseVersion } = require("../package.json");
const semver = require("semver");

const directory = path.resolve(process.argv[2] || "release-assets");
const tag = `v${version}`;
assert.equal(process.env.GITHUB_REF_NAME, tag);
assert.equal(process.env.GH_REPO, "Drangon-Li/guzi-graph");
validateVersions(version, windowsReleaseVersion);
const files = verifyRelease(directory, version, {
  windowsVersion: windowsReleaseVersion,
});
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
  const notes = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(temporary, "release-notes.txt");
  if (!process.argv[3]) {
    fs.writeFileSync(
      notes,
      `桌面版 ${tag}\n\nmacOS：${version}。${
        windowsReleaseVersion === version
          ? `Windows：${windowsReleaseVersion}。`
          : `Windows 本次无新构建，沿用已发布的 ${windowsReleaseVersion} 安装包和更新清单；Windows 关键版本会单独提升版本号。`
      }\n\n本次 macOS 版本修复更新安装重启、演示文稿导出预检、窗口事件监听、媒体资源及大文件加载相关问题。Windows ${windowsReleaseVersion} 保留此前已发布的修复。\n\n应用内更新入口：桌面设置 → 通用 → 版本与更新。v0.8.0 / v0.8.1 存在安装重启被取消的问题，请先手动安装 macOS ${version} 或 Windows ${windowsReleaseVersion}；更早版本同样建议手动安装到上述版本后再使用应用内更新。\n\nmacOS：Apple Silicon、macOS 13 或更高版本。当前仍为 ad-hoc 签名，未进行 Developer ID 签名和公证；首次安装可能需要在系统设置中允许打开。Mac 更新包使用独立 Ed25519 签名验证。Windows：x64 NSIS 安装版支持应用内更新；便携版 ZIP 需手动更新。\n`,
    );
  }
  assert.ok(fs.statSync(notes).size > 0, "Release notes must not be empty");
  if (existing.status === 0) {
    assert.equal(
      JSON.parse(existing.stdout).isDraft,
      true,
      "Refusing to replace a published release",
    );
    if (process.argv[3]) gh(["release", "edit", tag, "--notes-file", notes]);
  } else {
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
  verifyRelease(downloaded, version, { windowsVersion: windowsReleaseVersion });
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
