const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const releaseScripts = new Set([
  "apps/desktop/scripts/release-update-windows.cjs",
  "apps/desktop/scripts/release-update-mac.cjs",
]);

function selectScope(eventName, nameStatus) {
  if (eventName !== "pull_request") {
    return {
      full: true,
      reason: "Only pull requests may skip the full build.",
    };
  }
  if (nameStatus === "") {
    return { full: true, reason: "No changed files; running the full build." };
  }
  if (!nameStatus.endsWith("\0")) {
    throw new Error("Malformed Git diff: missing NUL terminator.");
  }

  const fields = nameStatus.slice(0, -1).split("\0");
  let releaseScriptsOnly = true;
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error("Malformed Git diff: invalid change status.");
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
      const filename = fields[index++];
      if (!filename) {
        throw new Error("Malformed Git diff: missing changed path.");
      }
      if (status !== "M" || !releaseScripts.has(filename)) {
        releaseScriptsOnly = false;
      }
    }
  }

  return {
    full: !releaseScriptsOnly,
    reason: releaseScriptsOnly
      ? "Only release-update scripts were modified; skipping the full build."
      : "Changes require the full build.",
  };
}

function main() {
  let scope;
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    let nameStatus = "";
    if (eventName === "pull_request") {
      const gitOptions = {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      };
      const commit = execFileSync(
        "git",
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        gitOptions,
      )
        .trim()
        .split(/\s+/);
      if (commit.length !== 3) {
        throw new Error("HEAD is not a two-parent merge commit.");
      }
      nameStatus = execFileSync(
        "git",
        ["diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"],
        gitOptions,
      );
    }
    scope = selectScope(eventName, nameStatus);
  } catch (error) {
    const reason =
      error.message.startsWith("Malformed Git diff:") ||
      error.message === "HEAD is not a two-parent merge commit."
        ? error.message
        : "Cannot read HEAD^1..HEAD (Git error or missing parent).";
    scope = { full: true, reason: `${reason} Running the full build.` };
  }

  console.log(scope.reason);
  console.log(`full=${scope.full}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${scope.full}\n`);
  }
}

module.exports = { selectScope };

if (require.main === module) {
  main();
}
