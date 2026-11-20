const { build } = require("./package.json");

module.exports = {
  ...build,
  publish: null,
  appId: "local.excalidraw.desktop.test",
  productName: "Excalidraw-Guzi Test",
  directories: {
    ...build.directories,
    output: "release/test",
  },
  extraMetadata: {
    ...build.extraMetadata,
    buildChannel: "test",
    // app.name comes from the packaged package.json, and macOS safeStorage uses
    // the "<app.name> Safe Storage" Keychain item, so rename it here too or this
    // build shares (and gets blocked by) the stable app's Keychain item.
    productName: "Excalidraw-Guzi Test",
  },
  mac: {
    ...build.mac,
    extraResources: [],
    extendInfo: {},
    // electron-builder expands these placeholders when packaging.
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-test-${version}-${arch}.${ext}",
  },
  win: {
    ...build.win,
    // eslint-disable-next-line no-template-curly-in-string
    artifactName: "Excalidraw-Guzi-test-${version}-win-${arch}.${ext}",
  },
  fileAssociations: [],
};
