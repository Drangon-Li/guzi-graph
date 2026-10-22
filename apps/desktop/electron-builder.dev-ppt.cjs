const path = require("node:path");

const { build } = require("./package.json");

module.exports = {
  ...build,
  appId: "local.excalidraw.desktop.dev-ppt",
  productName: "Excalidraw-Guzi Dev PPT",
  electronDist: path.join(
    path.dirname(require.resolve("electron/package.json")),
    "dist",
  ),
  directories: {
    ...build.directories,
    output: "release/dev-ppt",
  },
  extraMetadata: {
    ...build.extraMetadata,
    buildChannel: "dev-ppt",
  },
  mac: {
    ...build.mac,
    // electron-builder expands these placeholders when packaging.
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-dev-ppt-${version}-${arch}.${ext}",
  },
  fileAssociations: [],
};
