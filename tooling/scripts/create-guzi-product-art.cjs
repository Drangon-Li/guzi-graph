const fs = require("node:fs");
const path = require("node:path");
const rough = require("roughjs/bundled/rough.cjs.js");

if (require("roughjs/package.json").version !== "4.6.4") {
  throw new Error(
    "The product illustration uses RoughJS 4.6.4 for stable strokes.",
  );
}

const output = path.resolve(
  __dirname,
  "../../sites/guzi-product/assets/growing-canvas.svg",
);
const generator = rough.generator();
const palette = {
  ink: "#272E25",
  blue: "#1971C2",
  green: "#2F9E44",
  ochre: "#C88A24",
  red: "#E03131",
};
const elements = [];
let seed = 15743;

const escape = (value) =>
  String(value).replace(/[&<>\"]/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character];
  });

function draw(method, args, start, end, options = {}) {
  const drawable = generator[method](...args, {
    seed: seed++,
    roughness: 1.15,
    bowing: 0.85,
    stroke: palette.ink,
    strokeWidth: 1.8,
    preserveVertices: true,
    ...options,
  });
  for (const [index, part] of generator.toPaths(drawable).entries()) {
    const filled = part.fill !== "none";
    const hachure = drawable.sets[index].type === "fillSketch";
    const timing =
      filled || hachure
        ? `data-reveal="${start}"`
        : `data-draw="" data-start="${start}" data-end="${end}"`;
    elements.push(
      `  <path ${timing} d="${escape(
        part.d.replace(/-?\d+\.\d+/g, (number) =>
          Number(Number(number).toFixed(2)),
        ),
      )}" fill="${part.fill || "none"}" stroke="${
        part.stroke || "none"
      }" stroke-width="${part.strokeWidth || 0}"/>`,
    );
  }
}

function text(value, x, y, size, reveal, options = {}) {
  const { color = palette.ink, rotate = 0, anchor = "start" } = options;
  const transform = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : "";
  elements.push(
    `  <text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" data-reveal="${reveal}"${transform}>${escape(
      value,
    )}</text>`,
  );
}

function arrow(points, head, start, end, color = palette.ink) {
  draw("path", [points], start, end, { stroke: color });
  draw("linearPath", [head], end - 0.035, end, { stroke: color });
}

// One stalk links the grain at the bottom to the ripening panicle above.
elements.push('  <g data-art-stage="grain">');
draw(
  "path",
  ["M130 372 C104 321 120 258 144 204 C157 175 163 145 158 125"],
  0,
  0.22,
  { stroke: palette.green, strokeWidth: 2.2 },
);
draw(
  "path",
  ["M123 322 C79 313 78 286 80 267 C108 272 123 295 123 322 Z"],
  0.03,
  0.18,
  {
    stroke: palette.green,
    fill: "#D3E8C7",
    fillStyle: "hachure",
    hachureGap: 7,
    fillWeight: 0.6,
  },
);
draw(
  "path",
  ["M123 292 C150 287 173 269 177 247 C146 252 126 266 123 292 Z"],
  0.05,
  0.21,
  {
    stroke: palette.green,
    fill: "#D3E8C7",
    fillStyle: "hachure",
    hachureGap: 7,
    fillWeight: 0.6,
  },
);
draw(
  "path",
  ["M152 208 C169 181 175 152 164 126 C156 110 142 107 131 116"],
  0.07,
  0.23,
  { stroke: palette.ochre, strokeWidth: 2 },
);
const grains = [
  [137, 125, 18, 29, -24],
  [158, 135, 18, 29, 24],
  [143, 151, 18, 28, -27],
  [163, 160, 18, 29, 25],
  [140, 175, 17, 27, -27],
  [156, 185, 17, 28, 30],
  [131, 198, 16, 25, -30],
];
for (const [index, [x, y, width, height, rotation]] of grains.entries()) {
  elements.push(`  <g transform="rotate(${rotation} ${x} ${y})">`);
  draw("ellipse", [x, y, width, height], 0.08 + index * 0.012, 0.24, {
    stroke: palette.ochre,
    strokeWidth: 1.4,
    fill: "#F2D18E",
    fillStyle: "solid",
    roughness: 0.8,
  });
  elements.push("  </g>");
}
draw("ellipse", [131, 375, 30, 44], 0.01, 0.1, {
  stroke: palette.ochre,
  fill: "#F2D18E",
  fillStyle: "hachure",
  hachureGap: 5,
  fillWeight: 0.65,
});
draw("path", ["M124 389 Q132 378 137 361"], 0.02, 0.12, {
  stroke: palette.ochre,
  strokeWidth: 1.2,
});
draw("path", ["M93 399 Q126 405 159 398"], 0.04, 0.15, {
  stroke: palette.ink,
  strokeWidth: 1.3,
});
elements.push("  </g>");

elements.push('  <g data-art-stage="idea">');
arrow(
  "M189 227 C211 210 233 207 257 208",
  [
    [245, 199],
    [259, 208],
    [246, 218],
  ],
  0.15,
  0.31,
  palette.ochre,
);
draw("ellipse", [350, 205, 177, 91], 0.21, 0.37, {
  stroke: palette.blue,
  fill: "#D8E9F4",
  fillStyle: "hachure",
  hachureGap: 10,
  fillWeight: 0.7,
  roughness: 1.25,
});
text("一个想法", 350, 214, 27, 0.31, {
  anchor: "middle",
  color: palette.blue,
  rotate: -2,
});
draw(
  "path",
  ["M287 154 L283 143 M310 146 L311 134 M331 146 L338 137"],
  0.29,
  0.36,
  { stroke: palette.ochre, strokeWidth: 1.6 },
);
elements.push("  </g>");

elements.push('  <g data-art-stage="connections">');
arrow(
  "M441 196 C472 192 465 120 507 120",
  [
    [494, 112],
    [508, 120],
    [494, 129],
  ],
  0.33,
  0.48,
  palette.blue,
);
text("联想", 451, 142, 17, 0.4, { color: palette.blue, rotate: -9 });
draw("rectangle", [515, 77, 174, 87], 0.39, 0.54, {
  stroke: palette.ink,
  fill: "#F3EFE5",
  fillStyle: "solid",
});
text("找到关联", 602, 129, 27, 0.48, { anchor: "middle", rotate: 1 });
arrow(
  "M701 119 C742 116 717 208 757 208",
  [
    [745, 199],
    [758, 208],
    [744, 216],
  ],
  0.47,
  0.62,
  palette.green,
);
text("连接", 727, 150, 17, 0.53, { color: palette.green, rotate: 10 });
draw(
  "path",
  ["M764 168 Q848 163 930 170 L929 247 Q844 251 762 245 Z"],
  0.53,
  0.68,
  {
    stroke: palette.green,
    fill: "#D3E8C7",
    fillStyle: "hachure",
    hachureGap: 11,
    fillWeight: 0.65,
  },
);
text("连成知识", 846, 216, 27, 0.62, {
  anchor: "middle",
  color: palette.green,
  rotate: 1,
});
arrow(
  "M378 254 C434 313 682 320 797 262",
  [
    [784, 264],
    [799, 261],
    [795, 275],
  ],
  0.6,
  0.76,
  palette.ink,
);
text("慢慢长大", 575, 294, 19, 0.67, { anchor: "middle", rotate: 1 });
elements.push("  </g>");

elements.push('  <g data-art-stage="table" transform="rotate(-1 580 408)">');
text("把想法，放在一起看", 438, 335, 19, 0.69);
draw("rectangle", [435, 351, 287, 123], 0.67, 0.82, { strokeWidth: 1.5 });
draw("rectangle", [438, 353, 280, 34], 0.69, 0.81, {
  stroke: "none",
  fill: "#D3E8C7",
  fillStyle: "solid",
});
draw("line", [435, 388, 722, 388], 0.71, 0.82, { strokeWidth: 1.3 });
draw("line", [435, 430, 722, 430], 0.73, 0.84, { strokeWidth: 1.3 });
draw("line", [550, 352, 550, 474], 0.71, 0.83, { strokeWidth: 1.3 });
draw("line", [641, 352, 641, 474], 0.72, 0.84, { strokeWidth: 1.3 });
text("想法", 454, 377, 19, 0.75);
text("线索", 571, 377, 19, 0.75);
text("下一步", 653, 377, 19, 0.75);
text("一粒谷子", 451, 417, 20, 0.78);
text("阅读", 573, 417, 19, 0.78, { color: palette.blue });
text("发芽", 661, 417, 19, 0.78, { color: palette.green });
text("一张白板", 451, 458, 20, 0.81);
text("联结", 573, 458, 19, 0.81, { color: palette.blue });
text("生长", 661, 458, 19, 0.81, { color: palette.green });
elements.push("  </g>");

elements.push('  <g data-art-stage="subcanvas" transform="rotate(4 851 414)">');
draw("path", ["M782 335 L918 335 L936 354 L935 480 L783 477 Z"], 0.74, 0.88, {
  stroke: palette.ochre,
  strokeWidth: 1.6,
  fill: "#FFF3BF",
  fillStyle: "solid",
});
draw(
  "linearPath",
  [
    [
      [918, 335],
      [918, 355],
      [936, 354],
    ],
  ],
  0.8,
  0.89,
  { stroke: palette.ochre, strokeWidth: 1.3 },
);
text("再展开一层", 858, 375, 21, 0.84, { anchor: "middle" });
draw("rectangle", [801, 397, 115, 61], 0.81, 0.92, {
  stroke: palette.ochre,
  strokeWidth: 1.4,
  fill: "#F3EFE5",
  fillStyle: "hachure",
  hachureGap: 10,
  fillWeight: 0.45,
});
text("更多想法", 858, 435, 20, 0.88, {
  anchor: "middle",
  color: palette.ochre,
});
draw("path", ["M922 413 L922 399 L908 399 M922 399 L911 410"], 0.85, 0.96, {
  stroke: palette.ochre,
  strokeWidth: 1.2,
});
draw("ellipse", [811, 337, 10, 10], 0.79, 0.86, {
  stroke: palette.red,
  strokeWidth: 1.2,
  fill: "#E03131",
  fillStyle: "solid",
  roughness: 0.4,
});
elements.push("  </g>");

elements.push('  <g data-art-stage="signature">');
text("谷子白板", 97, 463, 55, 0.84, { rotate: -3 });
draw("path", ["M105 478 Q218 472 326 473"], 0.82, 0.98, {
  stroke: palette.ochre,
  strokeWidth: 2.1,
});
text("让想法，长成知识。", 104, 509, 20, 0.92, { rotate: -1 });
elements.push("  </g>");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 540" role="img" aria-labelledby="guzi-growing-title guzi-growing-description" fill="none" stroke-linecap="round" stroke-linejoin="round" font-family="Guzi Hand, Xiaolai, sans-serif">
  <title id="guzi-growing-title">谷子白板：让一个想法长成知识</title>
  <desc id="guzi-growing-description">一株谷子从种子发芽，连接到一个想法、找到关联、连成知识三个手绘节点。箭头下方是一张整理线索与下一步的小表格，以及一张可继续展开的子画布便签。</desc>
${elements.join("\n")}
</svg>
`;
fs.writeFileSync(output, svg);
console.log(
  `Created ${path.relative(process.cwd(), output)} (${Buffer.byteLength(
    svg,
  )} bytes).`,
);
