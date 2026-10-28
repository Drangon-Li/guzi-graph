const fs = require("node:fs");
const path = require("node:path");
const rough = require("roughjs/bundled/rough.cjs.js");

if (require("roughjs/package.json").version !== "4.6.4") {
  throw new Error("Feature artwork requires RoughJS 4.6.4 for stable strokes.");
}

const outputDirectory = path.resolve(
  __dirname,
  "../../sites/guzi-product/assets",
);
const colors = {
  paper: "#F3EFE5",
  ink: "#272E25",
  blue: "#1971C2",
  green: "#2F9E44",
  yellow: "#C88A24",
  purple: "#7950C1",
  blueWash: "#D6E8F4",
  greenWash: "#D9E9CE",
  yellowWash: "#F9E7AD",
  purpleWash: "#E5DBF1",
};
const escape = (value) =>
  String(value).replace(
    /[&<>\"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      }[c]),
  );

function illustration(name, title, description, initialSeed, paint) {
  const generator = rough.generator();
  const nodes = [];
  let seed = initialSeed;
  const add = (markup) => nodes.push(markup);
  const group = (name, paintGroup, transform = "") => {
    add(
      `<g data-art-stage="${name}"${
        transform ? ` transform="${transform}"` : ""
      }>`,
    );
    paintGroup();
    add("</g>");
  };
  const draw = (method, args, start, end, options = {}) => {
    const drawable = generator[method](...args, {
      seed: seed++,
      roughness: 1.1,
      bowing: 0.8,
      stroke: colors.ink,
      strokeWidth: 1.9,
      preserveVertices: true,
      ...options,
    });
    generator.toPaths(drawable).forEach((part, index) => {
      const fill =
        part.fill !== "none" || drawable.sets[index].type === "fillSketch";
      const timing = fill
        ? `data-reveal="${start}"`
        : `data-draw="" data-start="${start}" data-end="${end}"`;
      const d = part.d.replace(/-?\d+\.\d+/g, (number) =>
        Number(Number(number).toFixed(2)),
      );
      add(
        `<path ${timing} d="${d}" fill="${part.fill || "none"}" stroke="${
          part.stroke || "none"
        }" stroke-width="${part.strokeWidth || 0}"/>`,
      );
    });
  };
  const text = (
    value,
    x,
    y,
    size,
    reveal,
    color = colors.ink,
    anchor = "middle",
  ) => {
    add(
      `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" data-reveal="${reveal}">${escape(
        value,
      )}</text>`,
    );
  };
  const arrow = (d, head, start, end, color = colors.ink) => {
    draw("path", [d], start, end, { stroke: color });
    draw("linearPath", [head], end - 0.04, end, { stroke: color });
  };
  const box = (x, y, width, height, start, end, color, wash) => {
    draw("rectangle", [x, y, width, height], start, end, {
      stroke: color || colors.ink,
      ...(wash
        ? { fill: wash, fillStyle: "hachure", hachureGap: 11, fillWeight: 0.65 }
        : {}),
    });
  };
  const mountain = (x, y, width, height, start, end) => {
    box(x, y, width, height, start, end, colors.ink);
    draw(
      "polygon",
      [
        [
          [x + 8, y + height - 10],
          [x + width * 0.38, y + height * 0.3],
          [x + width * 0.65, y + height - 10],
        ],
      ],
      start + 0.03,
      end,
      {
        stroke: colors.green,
        fill: colors.greenWash,
        fillStyle: "hachure",
        hachureGap: 9,
        fillWeight: 0.6,
      },
    );
    draw(
      "linearPath",
      [
        [
          [x + width * 0.53, y + height * 0.69],
          [x + width * 0.72, y + height * 0.42],
          [x + width - 9, y + height - 10],
        ],
      ],
      start + 0.06,
      end,
      { stroke: colors.green },
    );
    draw(
      "ellipse",
      [x + width * 0.78, y + height * 0.25, 21, 21],
      start + 0.04,
      end,
      {
        stroke: colors.yellow,
        fill: colors.yellowWash,
        fillStyle: "solid",
        strokeWidth: 1.4,
      },
    );
  };

  paint({ add, group, draw, text, arrow, box, mountain });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 480" role="img" aria-labelledby="guzi-feature-${name}-title guzi-feature-${name}-desc" fill="none" stroke-linecap="round" stroke-linejoin="round" font-family="Guzi Hand, Xiaolai, sans-serif">
<title id="guzi-feature-${name}-title">${escape(title)}</title>
<desc id="guzi-feature-${name}-desc">${escape(description)}</desc>
${nodes.join("\n")}
</svg>
`;
  const output = path.join(outputDirectory, `feature-${name}.svg`);
  fs.writeFileSync(output, svg);
  console.log(
    `${path.basename(output)}: ${Buffer.byteLength(svg)} bytes, ${
      (svg.match(/<path /g) || []).length
    } paths`,
  );
}

illustration(
  "start",
  "随手开始：矩阵、图片和表格",
  "小工具条下，二乘二矩阵、手绘山景图片和任务表格依次出现在同一张白板。",
  21401,
  ({ group, draw, text, box, mountain }) => {
    group("toolbar", () => {
      box(153, 36, 454, 57, 0, 0.15);
      draw(
        "path",
        ["M184 51 L184 78 L192 70 L199 80 L204 76 L196 66 L207 63 Z"],
        0.02,
        0.14,
        { strokeWidth: 1.5 },
      );
      draw("line", [229, 48, 229, 81], 0.02, 0.14, { strokeWidth: 1.2 });
      box(253, 51, 24, 24, 0.03, 0.15, colors.blue, colors.blueWash);
      draw("ellipse", [318, 63, 25, 25], 0.04, 0.16);
      draw("path", ["M351 74 L378 51 M367 52 L380 50 L379 63"], 0.05, 0.16);
      text("T", 418, 76, 32, 0.08);
      draw(
        "path",
        ["M459 76 L476 49 L484 54 L467 80 Z M475 51 L480 56"],
        0.07,
        0.17,
        { stroke: colors.yellow, strokeWidth: 1.6 },
      );
      draw(
        "path",
        ["M519 52 L542 52 L542 76 L519 76 Z M530 52 L530 76 M519 64 L542 64"],
        0.08,
        0.18,
        { stroke: colors.green, strokeWidth: 1.5 },
      );
      draw("path", ["M568 72 Q579 52 591 72 M568 58 L570 54"], 0.09, 0.19, {
        stroke: colors.purple,
      });
    });
    group("matrix", () => {
      text("矩阵", 195, 143, 32, 0.19, colors.blue);
      box(61, 164, 269, 230, 0.16, 0.43, colors.blue);
      draw("rectangle", [64, 167, 130, 111], 0.2, 0.36, {
        stroke: "none",
        fill: colors.blueWash,
        fillStyle: "solid",
      });
      draw("rectangle", [197, 281, 129, 109], 0.25, 0.4, {
        stroke: "none",
        fill: colors.yellowWash,
        fillStyle: "solid",
      });
      draw("line", [195, 165, 195, 394], 0.23, 0.42, { stroke: colors.blue });
      draw("line", [61, 279, 330, 279], 0.26, 0.44, { stroke: colors.blue });
      text("今天", 127, 231, 29, 0.31, colors.blue);
      text("本周", 264, 231, 29, 0.34);
      text("再想想", 127, 346, 28, 0.37);
      text("先放这", 264, 346, 28, 0.4, colors.yellow);
    });
    group("image", () => {
      text("图片", 523, 143, 32, 0.43, colors.green);
      mountain(382, 164, 286, 130, 0.41, 0.65);
    });
    group("table", () => {
      text("表格", 525, 336, 32, 0.65, colors.purple);
      box(382, 354, 286, 93, 0.61, 0.88, colors.ink);
      draw("rectangle", [385, 357, 280, 38], 0.65, 0.83, {
        stroke: "none",
        fill: colors.greenWash,
        fillStyle: "solid",
      });
      draw("line", [382, 397, 668, 397], 0.7, 0.9, { strokeWidth: 1.4 });
      draw("line", [568, 355, 568, 446], 0.73, 0.93, { strokeWidth: 1.4 });
      text("下一步", 472, 386, 28, 0.78);
      text("状态", 618, 386, 28, 0.8);
      text("记下想法", 475, 432, 28, 0.85);
      draw(
        "linearPath",
        [
          [
            [604, 419],
            [615, 430],
            [635, 410],
          ],
        ],
        0.85,
        0.96,
        { stroke: colors.green, strokeWidth: 2.4 },
      );
    });
  },
);

illustration(
  "ai",
  "你和 AI，在同一张画布上整理思路",
  "蓝色 YOU 彩铅与紫色 AI 彩铅沿两条可见轨迹，在同一张画布上共同连接问题、关联与结构。",
  32911,
  ({ add, group, draw, text, arrow, box }) => {
    group("canvas", () => {
      box(166, 91, 439, 302, 0.02, 0.25, colors.ink);
      draw(
        "path",
        ["M179 107 L188 107 M179 107 L179 116 M583 376 L591 376 L591 368"],
        0.1,
        0.24,
        { stroke: colors.yellow, strokeWidth: 1.4 },
      );
    });
    group("shared-thinking", () => {
      draw("ellipse", [275, 214, 136, 82], 0.17, 0.42, {
        stroke: colors.blue,
        fill: colors.blueWash,
        fillStyle: "hachure",
        hachureGap: 11,
        fillWeight: 0.6,
      });
      text("问题", 275, 225, 32, 0.28, colors.blue);
      arrow(
        "M345 207 Q375 186 404 189",
        [
          [393, 180],
          [405, 189],
          [392, 198],
        ],
        0.3,
        0.54,
        colors.blue,
      );
      box(414, 148, 134, 77, 0.37, 0.62, colors.purple, colors.purpleWash);
      text("关联", 481, 196, 32, 0.48, colors.purple);
      arrow(
        "M481 234 Q484 261 463 279",
        [
          [464, 266],
          [462, 280],
          [476, 277],
        ],
        0.49,
        0.71,
        colors.purple,
      );
      box(365, 288, 159, 69, 0.57, 0.8, colors.green, colors.greenWash);
      text("结构", 445, 333, 32, 0.68, colors.green);
      draw("path", ["M282 267 C281 315 308 324 351 323"], 0.56, 0.8, {
        stroke: colors.blue,
        strokeWidth: 1.5,
      });
    });
    group("pen-routes", () => {
      // Each route is a single continuous subpath so getPointAtLength stays smooth.
      add(
        `<path data-pen-route="you" data-draw="" data-start="0.08" data-end="0.84" d="M110 350 C145 350 158 341 180 321 S225 291 243 270" fill="none" stroke="${colors.blue}" stroke-width="1.8"/>`,
      );
      add(
        `<path data-pen-route="ai" data-draw="" data-start="0.08" data-end="0.88" d="M655 288 C629 287 615 278 594 255 S573 207 556 191" fill="none" stroke="${colors.purple}" stroke-width="1.8"/>`,
      );
    });
    const pencil = (who, x, y, angle, color, wash) => {
      add(
        `<g data-scene-pen="${who}" transform="translate(${x} ${y}) rotate(${angle})" data-pen-tip="0 0">`,
      );
      draw(
        "polygon",
        [
          [
            [-11, -28],
            [-11, -115],
            [0, -121],
            [11, -115],
            [11, -28],
          ],
        ],
        0.03,
        0.18,
        {
          stroke: color,
          fill: wash,
          fillStyle: "solid",
          roughness: 0.6,
          strokeWidth: 1.6,
        },
      );
      draw("path", ["M-11 -28 L0 0 L11 -28 Z"], 0.04, 0.18, {
        stroke: colors.yellow,
        fill: colors.yellowWash,
        fillStyle: "solid",
        roughness: 0.4,
        strokeWidth: 1.2,
      });
      draw("path", ["M-3 -9 L0 0 L3 -9 Z"], 0.04, 0.18, {
        stroke: color,
        fill: color,
        fillStyle: "solid",
        roughness: 0.3,
        strokeWidth: 1,
      });
      draw(
        "path",
        ["M-4 -112 L-4 -32 M4 -112 L4 -32 M-10 -107 L10 -107"],
        0.06,
        0.2,
        { stroke: color, strokeWidth: 1.2, roughness: 0.6 },
      );
      text(who.toUpperCase(), 0, -139, 28, 0.07, color);
      add("</g>");
    };
    pencil("you", 110, 350, -10, colors.blue, colors.blueWash);
    pencil("ai", 655, 288, 12, colors.purple, colors.purpleWash);
    text("你提出问题，AI 帮你整理", 380, 450, 28, 0.9);
  },
);

illustration(
  "knowledge",
  "把论文、方法与自己的理解，连成研究地图",
  "论文在画布中央，向方法、实验表格、图片和自己的理解四周展开，图片上别着折角图钉。",
  47303,
  ({ add, group, draw, text, arrow, box, mountain }) => {
    group("paper", () => {
      box(282, 175, 190, 106, 0.03, 0.26, colors.blue, colors.blueWash);
      text("一篇论文", 377, 240, 34, 0.17, colors.blue);
      draw("path", ["M308 258 Q378 263 448 257"], 0.16, 0.31, {
        stroke: colors.blue,
        strokeWidth: 1.3,
      });
    });
    group("methods", () => {
      arrow(
        "M280 198 Q246 171 218 145",
        [
          [221, 159],
          [217, 144],
          [231, 148],
        ],
        0.2,
        0.43,
        colors.green,
      );
      box(70, 78, 166, 79, 0.29, 0.48, colors.green, colors.greenWash);
      text("方法", 153, 128, 32, 0.39, colors.green);
      text("怎么做到？", 151, 197, 24, 0.45);
    });
    group("experiment", () => {
      arrow(
        "M475 200 Q520 178 541 153",
        [
          [528, 160],
          [542, 152],
          [541, 168],
        ],
        0.31,
        0.55,
        colors.purple,
      );
      text("实验", 599, 94, 32, 0.45, colors.purple);
      box(521, 112, 157, 146, 0.4, 0.64, colors.purple);
      draw("rectangle", [524, 115, 151, 40], 0.43, 0.59, {
        stroke: "none",
        fill: colors.purpleWash,
        fillStyle: "solid",
      });
      draw(
        "path",
        ["M521 158 L678 158 M521 207 L678 207 M599 113 L599 258"],
        0.45,
        0.65,
        { stroke: colors.purple, strokeWidth: 1.3 },
      );
      text("方案", 559, 146, 28, 0.5);
      text("观察", 639, 146, 28, 0.5);
      text("A", 560, 194, 28, 0.55);
      text("B", 560, 243, 28, 0.6);
      draw(
        "path",
        ["M625 189 L636 178 L650 187 M624 232 L635 240 L650 226"],
        0.55,
        0.7,
        { stroke: colors.green, strokeWidth: 2 },
      );
    });
    group("image-pin", () => {
      arrow(
        "M291 265 C245 296 233 312 220 331",
        [
          [233, 324],
          [219, 332],
          [221, 317],
        ],
        0.46,
        0.69,
        colors.ink,
      );
      mountain(66, 306, 182, 116, 0.56, 0.77);
      add('<g transform="translate(216 275)">');
      draw(
        "polygon",
        [
          [
            [8, 16],
            [32, 15],
            [39, 23],
            [40, 51],
            [8, 52],
          ],
        ],
        0.65,
        0.82,
        {
          stroke: colors.yellow,
          strokeWidth: 1.4,
          fill: colors.yellowWash,
          fillStyle: "solid",
          roughness: 0.65,
        },
      );
      draw(
        "linearPath",
        [
          [
            [32, 15],
            [32, 24],
            [39, 23],
          ],
        ],
        0.68,
        0.84,
        { stroke: colors.yellow, strokeWidth: 1 },
      );
      draw("ellipse", [19, 15, 8, 8], 0.7, 0.85, {
        stroke: colors.purple,
        fill: colors.purple,
        fillStyle: "solid",
        roughness: 0.35,
        strokeWidth: 1,
      });
      add("</g>");
    });
    group("understanding", () => {
      arrow(
        "M395 285 C410 315 420 322 444 336",
        [
          [437, 323],
          [445, 337],
          [430, 336],
        ],
        0.59,
        0.8,
        colors.yellow,
      );
      box(363, 347, 278, 79, 0.69, 0.9, colors.yellow, colors.yellowWash);
      text("自己的理解", 503, 397, 32, 0.8, colors.yellow);
      draw("path", ["M526 336 C578 324 602 302 600 272"], 0.76, 0.95, {
        stroke: colors.purple,
        strokeWidth: 1.5,
      });
      text("再验证", 640, 310, 24, 0.86, colors.purple);
    });
  },
);

illustration(
  "present",
  "把画布里的思路，讲成一场清楚的汇报",
  "左侧白板内容进入手绘投影幕，问题、方法、结论成为三张放映页，下方保留三页缩略图。",
  58127,
  ({ group, draw, text, arrow, box }) => {
    group("source-canvas", () => {
      box(37, 183, 125, 145, 0.02, 0.23, colors.ink);
      text("画布", 100, 221, 28, 0.12);
      draw("ellipse", [73, 262, 32, 27], 0.1, 0.3, { stroke: colors.blue });
      draw(
        "path",
        ["M92 255 L120 243 L140 257 M93 272 L121 290 L140 278"],
        0.15,
        0.34,
        { stroke: colors.green, strokeWidth: 1.6 },
      );
      arrow(
        "M167 253 Q184 243 203 253",
        [
          [192, 245],
          [205, 253],
          [191, 261],
        ],
        0.24,
        0.42,
        colors.yellow,
      );
    });
    group("projection", () => {
      draw("line", [205, 60, 705, 60], 0.15, 0.36, {
        strokeWidth: 5,
        roughness: 0.6,
      });
      box(210, 66, 489, 274, 0.2, 0.43, colors.ink);
      draw("path", ["M455 341 L455 359 M446 359 L464 359"], 0.34, 0.48, {
        strokeWidth: 1.6,
      });
      text("一张图，讲清思路", 455, 120, 32, 0.34);
      draw("path", ["M260 135 Q455 139 649 134"], 0.35, 0.51, {
        stroke: colors.yellow,
        strokeWidth: 1.4,
      });
    });
    group("slide-content", () => {
      box(236, 178, 117, 88, 0.38, 0.58, colors.blue, colors.blueWash);
      text("问题", 295, 232, 30, 0.46, colors.blue);
      arrow(
        "M359 221 L384 221",
        [
          [375, 214],
          [386, 221],
          [375, 229],
        ],
        0.46,
        0.63,
        colors.blue,
      );
      box(392, 178, 119, 88, 0.49, 0.68, colors.green, colors.greenWash);
      text("方法", 452, 232, 30, 0.57, colors.green);
      arrow(
        "M517 221 L543 221",
        [
          [533, 214],
          [545, 221],
          [533, 229],
        ],
        0.57,
        0.73,
        colors.green,
      );
      box(550, 178, 122, 88, 0.61, 0.78, colors.purple, colors.purpleWash);
      text("结论", 611, 232, 30, 0.68, colors.purple);
      text("1 / 3", 661, 316, 24, 0.72);
    });
    group("thumbnails", () => {
      const slides = [
        [211, "问题", colors.blue, colors.blueWash],
        [382, "方法", colors.green, colors.greenWash],
        [553, "结论", colors.purple, colors.purpleWash],
      ];
      slides.forEach(([x, label, color, wash], index) => {
        const start = 0.7 + index * 0.06;
        box(x, 374, 146, 76, start, start + 0.14, color, wash);
        text(label, x + 73, 423, 30, start + 0.08, color);
      });
    });
  },
);
