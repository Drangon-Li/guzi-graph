const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { build, devDependencies } = require("../package.json");

test("Windows NSIS retains both document associations and macOS target", () => {
  assert.deepEqual(build.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.deepEqual(build.mac.target, [{ target: "dmg", arch: ["arm64"] }]);
  assert.deepEqual(build.fileAssociations.map(({ ext }) => ext).sort(), [
    "excalidraw",
    "guzi-presentation",
  ]);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(devDependencies.electron, "44.7.2");
  assert.equal(devDependencies["electron-builder"], "26.15.3");
});

test("isolated channels use target Electron downloads and distinct Windows names", () => {
  for (const filename of [
    "electron-builder.testing.cjs",
    "electron-builder.dev-ppt.cjs",
  ]) {
    const channel = require(path.join("..", filename));
    assert.equal(channel.electronDist, undefined);
    assert.notEqual(channel.appId, build.appId);
    assert.notEqual(channel.win.artifactName, build.win.artifactName);
    assert.deepEqual(channel.fileAssociations, []);
  }
});

test("Windows icon contains the unchanged PNG representations from the macOS icon", () => {
  const resources = path.resolve(__dirname, "../resources");
  const icns = fs.readFileSync(path.join(resources, "icon.icns"));
  const pngs = [];
  for (let position = 8; position < icns.length; ) {
    const size = icns.readUInt32BE(position + 4);
    pngs.push(icns.subarray(position + 8, position + size));
    position += size;
  }
  const ico = fs.readFileSync(path.join(resources, "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.ok(count > 0);
  let includes256 = false;
  for (let index = 0; index < count; index++) {
    const position = 6 + 16 * index;
    const size = ico.readUInt32LE(position + 8);
    const offset = ico.readUInt32LE(position + 12);
    const png = ico.subarray(offset, offset + size);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(pngs.some((source) => source.equals(png)));
    if (ico[position] === 0 && ico[position + 1] === 0) {
      includes256 = true;
    }
  }
  assert.equal(includes256, true);
});
