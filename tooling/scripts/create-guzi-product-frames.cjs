const fs = require("node:fs");
const path = require("node:path");
const rough = require("roughjs/bundled/rough.cjs.js");

const generator = rough.generator();
const directory = path.resolve(__dirname, "../../sites/guzi-product/assets");
const frames = [
  ["sketch-paper", 800, 420, "#8a957a", 2, 0.8, 2601, 3],
  ["sketch-cell", 240, 90, "#71836a", 1.1, 0.55, 2602, 1.5],
  ["sketch-note", 300, 96, "#728d66", 1.7, 0.85, 2603, 3],
];

for (const [
  name,
  width,
  height,
  color,
  strokeWidth,
  roughness,
  seed,
  inset,
] of frames) {
  const drawing = generator.rectangle(
    inset,
    inset,
    width - inset * 2,
    height - inset * 2,
    {
      seed,
      roughness,
      bowing: 0.7,
      stroke: color,
      strokeWidth,
    },
  );
  const paths = generator.toPaths(drawing).map((part) => {
    const d = part.d.replace(/-?\d+\.\d+/g, (number) =>
      Number(Number(number).toFixed(2)),
    );
    return `<path d="${d}" fill="none" stroke="${part.stroke}" stroke-width="${part.strokeWidth}" vector-effect="non-scaling-stroke"/>`;
  });
  fs.writeFileSync(
    path.join(directory, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" stroke-linecap="round" stroke-linejoin="round">${paths.join(
      "",
    )}</svg>\n`,
  );
}
