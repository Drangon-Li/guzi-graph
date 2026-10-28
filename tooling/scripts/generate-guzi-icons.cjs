const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const prettier = require("prettier");

const root = path.resolve(__dirname, "../..");
const source = path.join(root, "assets/branding/guzi-whiteboard.png");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "guzi-icons-"));
const sizes = [16, 32, 64, 128, 180, 192, 256, 512, 1024];
const pngs = new Map();

const write = (relativePath, data) => {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
};

try {
  for (const size of sizes) {
    const destination = path.join(temporary, `${size}.png`);
    execFileSync("sips", [
      "--resampleHeightWidth",
      String(size),
      String(size),
      source,
      "--out",
      destination,
    ]);
    pngs.set(size, fs.readFileSync(destination));
  }

  const representations = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ];
  const chunks = representations.map(([type, size]) => {
    const png = pngs.get(size);
    const header = Buffer.alloc(8);
    header.write(type);
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(
    8 + chunks.reduce((total, chunk) => total + chunk.length, 0),
    4,
  );
  write(
    "apps/desktop/resources/icon.icns",
    Buffer.concat([icnsHeader, ...chunks]),
  );

  // Share PNG bytes so the two platform containers cannot drift apart.
  const icoSizes = [16, 32, 64, 128, 256];
  const icoHeader = Buffer.alloc(6 + icoSizes.length * 16);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(icoSizes.length, 4);
  let offset = icoHeader.length;
  icoSizes.forEach((size, index) => {
    const png = pngs.get(size);
    const entry = 6 + index * 16;
    icoHeader[entry] = size === 256 ? 0 : size;
    icoHeader[entry + 1] = size === 256 ? 0 : size;
    icoHeader.writeUInt16LE(1, entry + 4);
    icoHeader.writeUInt16LE(32, entry + 6);
    icoHeader.writeUInt32LE(png.length, entry + 8);
    icoHeader.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  const ico = Buffer.concat([
    icoHeader,
    ...icoSizes.map((size) => pngs.get(size)),
  ]);
  write("apps/desktop/resources/icon.ico", ico);
  write("apps/web/public/favicon.ico", ico);
  write("sites/guzi-product/assets/favicon.ico", ico);

  const webReferences = new Map();
  for (const [name, size] of [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["android-chrome-192x192.png", 192],
    ["android-chrome-512x512.png", 512],
  ]) {
    write(`apps/web/public/${name}`, pngs.get(size));
    if (size !== 512) {
      const hash = createHash("sha256")
        .update(pngs.get(size))
        .digest("hex")
        .slice(0, 12);
      const stem = name.slice(0, -4);
      const versioned = `${stem}-${hash}.png`;
      write(`apps/web/public/${versioned}`, pngs.get(size));
      webReferences.set(stem, versioned);
    }
  }
  // PWA icon URLs must be real filenames for the manifest precache glob.
  for (const relative of ["apps/web/index.html", "apps/web/vite.config.mts"]) {
    const filename = path.join(root, relative);
    let content = fs.readFileSync(filename, "utf8");
    for (const [stem, versioned] of webReferences) {
      content = content.replace(
        new RegExp(`${stem}(?:-[a-f0-9]{12})?\\.png(?:\\?v=[^\"]*)?`, "g"),
        versioned,
      );
    }
    fs.writeFileSync(
      filename,
      prettier.format(content, {
        ...prettier.resolveConfig.sync(filename),
        filepath: filename,
      }),
    );
  }
  write("packages/excalidraw/assets/guzi-logo.png", pngs.get(256));
  write("sites/guzi-product/assets/guzi-logo.png", pngs.get(256));
  write("sites/guzi-product/assets/favicon-32x32.png", pngs.get(32));
  write("sites/guzi-product/assets/apple-touch-icon.png", pngs.get(180));
  write(
    "apps/web/public/favicon.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,${pngs
      .get(256)
      .toString("base64")}"/></svg>\n`,
  );
  console.log("Generated Guzi web, macOS and Windows icons from one source.");
} finally {
  for (const filename of fs.readdirSync(temporary)) {
    fs.unlinkSync(path.join(temporary, filename));
  }
  fs.rmdirSync(temporary);
}
