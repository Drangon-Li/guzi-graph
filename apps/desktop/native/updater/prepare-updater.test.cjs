const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  prepareUpdater,
  verifyArchive,
} = require("../../scripts/prepare-updater.cjs");

test(
  "rejects an altered Sparkle release before creating output",
  { skip: process.platform !== "darwin" },
  async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "guzi-updater-integrity-"),
    );
    try {
      const archivePath = path.join(temporary, "sparkle.tar.xz");
      const outputDir = path.join(temporary, "output");
      fs.writeFileSync(archivePath, "a substituted release archive");
      assert.throws(() => verifyArchive(archivePath), /SHA256 mismatch/);
      await assert.rejects(
        prepareUpdater({ archivePath, outputDir }),
        /SHA256 mismatch/,
      );
      assert(!fs.existsSync(outputDir));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);
