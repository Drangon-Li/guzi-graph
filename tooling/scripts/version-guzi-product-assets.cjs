const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const prettier = require("prettier");

const root = path.resolve(__dirname, "../../sites/guzi-product");
const version = (asset) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(root, asset)))
    .digest("hex")
    .slice(0, 12);

const css = path.join(root, "style.css");
fs.writeFileSync(
  css,
  prettier.format(
    fs
      .readFileSync(css, "utf8")
      .replace(
        /url\("([^"?]+)(?:\?v=[^"]+)?"\)/g,
        (_, asset) => `url("${asset}?v=${version(asset)}")`,
      ),
    { ...prettier.resolveConfig.sync(css), filepath: css },
  ),
);

const page = path.join(root, "index.html");
fs.writeFileSync(
  page,
  prettier.format(
    fs
      .readFileSync(page, "utf8")
      .replace(
        /(src|href)="([^"#?:]+)(?:\?v=[^"]*)?"/g,
        (original, attribute, asset) =>
          fs.existsSync(path.join(root, asset))
            ? `${attribute}="${asset}?v=${version(asset)}"`
            : original,
      ),
    { ...prettier.resolveConfig.sync(page), filepath: page },
  ),
);
console.log("Updated product-site asset versions.");
