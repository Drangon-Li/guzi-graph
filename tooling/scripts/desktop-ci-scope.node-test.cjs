const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { selectScope } = require("./desktop-ci-scope.cjs");

const windows = "apps/desktop/scripts/release-update-windows.cjs";
const mac = "apps/desktop/scripts/release-update-mac.cjs";
const diff = (...changes) => `${changes.flat().join("\0")}\0`;

test("only modified release scripts in pull requests skip the full build", () => {
  for (const changes of [
    [["M", windows]],
    [["M", mac]],
    [
      ["M", windows],
      ["M", mac],
    ],
  ]) {
    assert.equal(selectScope("pull_request", diff(...changes)).full, false);
  }
});

test("all other event types run the full build", () => {
  for (const event of [
    "push",
    "workflow_dispatch",
    "schedule",
    "pull_request_target",
    "merge_group",
    "",
    undefined,
  ]) {
    assert.equal(selectScope(event, diff(["M", windows])).full, true);
  }
});

test("empty pull request diffs run the full build", () => {
  assert.equal(selectScope("pull_request", "").full, true);
});

test("mixed changes and other paths run the full build", () => {
  for (const filename of [
    ".github/workflows/desktop-windows.yml",
    "apps/desktop/package.json",
    `${windows}.backup`,
    ` ${windows}`,
    `${windows}\n`,
    "a path\twith whitespace\nand 日本語.cjs",
  ]) {
    assert.equal(
      selectScope("pull_request", diff(["M", windows], ["M", filename])).full,
      true,
    );
  }
});

test("added, deleted, type-changed and other statuses run the full build", () => {
  for (const status of ["A", "D", "T", "U", "X", "B", "M100"]) {
    assert.equal(
      selectScope("pull_request", diff([status, windows])).full,
      true,
    );
  }
});

test("renames and copies run the full build even between allowed paths", () => {
  for (const status of ["R100", "R050", "C100"]) {
    assert.equal(
      selectScope("pull_request", diff([status, windows, mac])).full,
      true,
    );
  }
  assert.equal(
    selectScope("pull_request", diff(["D", windows], ["A", mac])).full,
    true,
  );
});

test("malformed NUL-delimited output is reported rather than accepted", () => {
  for (const nameStatus of [
    `M\0${windows}`,
    "M\0",
    "M\0\0",
    `?\0${windows}\0`,
    `R100\0${windows}\0`,
    `M\0${windows}\0M\0`,
    `M\0${windows}\0\0`,
  ]) {
    assert.throws(
      () => selectScope("pull_request", nameStatus),
      /Malformed Git diff:/,
    );
  }
});

test("CLI fails closed when the merge parent cannot be read", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-ci-scope-"));
  try {
    const output = path.join(directory, "github-output");
    const stdout = execFileSync(
      process.execPath,
      [path.join(__dirname, "desktop-ci-scope.cjs")],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: output,
        },
      },
    );
    assert.match(stdout, /Cannot read HEAD\^1\.\.HEAD/);
    assert.equal(readFileSync(output, "utf8"), "full=true\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI requires a merge and compares its first parent against the whole PR", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-ci-scope-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI Scope Test",
        GIT_AUTHOR_EMAIL: "ci-scope@example.invalid",
        GIT_COMMITTER_NAME: "CI Scope Test",
        GIT_COMMITTER_EMAIL: "ci-scope@example.invalid",
      },
    });
  const classify = () =>
    execFileSync(
      process.execPath,
      [path.join(__dirname, "desktop-ci-scope.cjs")],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: path.join(directory, "github-output"),
        },
      },
    );
  try {
    git("init", "--initial-branch=main");
    mkdirSync(path.dirname(path.join(directory, windows)), { recursive: true });
    writeFileSync(path.join(directory, windows), "initial\n");
    git("add", windows);
    git("commit", "-m", "Initial release script");
    git("checkout", "-b", "release-script");
    writeFileSync(path.join(directory, windows), "modified\n");
    git("add", windows);
    git("commit", "-m", "Modify release script");
    assert.match(classify(), /HEAD is not a two-parent merge commit/);
    git("checkout", "main");
    git("merge", "--no-ff", "release-script", "-m", "Synthetic PR merge");
    assert.match(classify(), /full=false/);
    assert.equal(
      readFileSync(path.join(directory, "github-output"), "utf8"),
      "full=true\nfull=false\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
