const path = require("node:path");

const { build } = require("./package.json");

module.exports = {
  ...build,
  appId: "local.excalidraw.desktop.test",
  productName: "Excalidraw-Guzi Test",
  electronDist: path.join(
    path.dirname(require.resolve("electron/package.json")),
    "dist",
  ),
  directories: {
    ...build.directories,
    output: "release/test",
  },
  extraMetadata: {
    ...build.extraMetadata,
    buildChannel: "test",
  },
  mac: {
    ...build.mac,
    // electron-builder expands these placeholders when packaging.
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-test-${version}-${arch}.${ext}",
  },
  fileAssociations: [],
};
