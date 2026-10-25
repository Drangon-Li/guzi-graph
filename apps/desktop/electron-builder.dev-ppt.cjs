const { build } = require("./package.json");

module.exports = {
  ...build,
  publish: null,
  appId: "local.excalidraw.desktop.dev-ppt",
  productName: "Excalidraw-Guzi Dev PPT",
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
    extraResources: [],
    extendInfo: {},
    // electron-builder expands these placeholders when packaging.
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-dev-ppt-${version}-${arch}.${ext}",
  },
  win: {
    ...build.win,
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-dev-ppt-${version}-win-${arch}.${ext}",
  },
  fileAssociations: [],
};
