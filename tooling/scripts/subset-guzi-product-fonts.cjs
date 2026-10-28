const fs = require("node:fs");
const path = require("node:path");
const { Font, woff2 } = require("fonteditor-core");

const root = path.resolve(__dirname, "../..");
const page = path.join(root, "sites/guzi-product");
const corpus = ["index.html", "assets/growing-canvas.svg", "style.css"]
  .map((file) => fs.readFileSync(path.join(page, file), "utf8"))
  .join("");
const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32));
const wanted = [
  ...new Set(
    Array.from(corpus + ascii.join("") + "\u00a0·−–—‘’“”…")
      .filter(
        (character) => !/\s/u.test(character) || /[ \u00a0]/u.test(character),
      )
      .map((character) => character.codePointAt(0)),
  ),
].sort((a, b) => a - b);

function sources(family) {
  const directory = path.join(root, "packages/excalidraw/fonts", family);
  const source = fs.readFileSync(path.join(directory, "index.ts"), "utf8");
  const imports = Object.fromEntries(
    [...source.matchAll(/import (_\d+) from "\.\/(.*?)";/g)].map(
      ([, name, file]) => [name, file],
    ),
  );
  return [
    ...source.matchAll(
      /uri: (_\d+),\s*descriptors: \{\s*unicodeRange:\s*"([^"]+)"/g,
    ),
  ]
    .map(([, name, range]) => {
      const ranges = range.split(",").map((item) =>
        item
          .slice(2)
          .split("-")
          .map((value) => parseInt(value, 16)),
      );
      const codes = wanted.filter((code) =>
        ranges.some(([start, end = start]) => code >= start && code <= end),
      );
      return { file: path.join(directory, imports[name]), codes };
    })
    .filter(({ codes }) => codes.length);
}

function codepoints(font) {
  return new Set(font.get().glyf.flatMap((glyph) => glyph.unicode || []));
}

async function main() {
  await woff2.init();
  const coverage = new Set();
  const charsets = [];
  let totalBytes = 0;
  for (const [family, name, file] of [
    ["Xiaolai", "Guzi Hand CJK", "guzi-hand-cjk.woff2"],
    ["Excalifont", "Guzi Hand Latin", "guzi-hand-latin.woff2"],
  ]) {
    let merged;
    for (const { file: source, codes } of sources(family)) {
      const font = Font.create(fs.readFileSync(source), {
        type: "woff2",
        subset: codes,
        compound2simple: true,
      });
      if (merged) {
        merged.merge(font, { scale: 1 });
      } else {
        merged = font;
      }
    }
    const expected = codepoints(merged);
    Object.assign(merged.get().name, {
      fontFamily: name,
      fontSubFamily: "Regular",
      fullName: `${name} Regular`,
      postScriptName: `${name.replaceAll(" ", "")}-Regular`,
      uniqueSubFamily: `${name}-Regular-PageSubset`,
      preferredFamily: name,
      preferredSubFamily: "Regular",
    });
    merged.sort();
    const output = path.join(page, "assets/fonts", file);
    fs.writeFileSync(output, merged.write({ type: "woff2", hinting: false }));
    const actual = codepoints(
      Font.create(fs.readFileSync(output), { type: "woff2" }),
    );
    if ([...expected].some((code) => !actual.has(code))) {
      throw new Error(`Lost codepoints while writing ${file}`);
    }
    actual.forEach((code) => coverage.add(code));
    charsets.push(actual);
    const bytes = fs.statSync(output).size;
    totalBytes += bytes;
    console.log(`${file}: ${bytes} bytes, ${actual.size} codepoints`);
  }
  const missing = wanted.filter((code) => !coverage.has(code));
  const missingChinese = missing.filter((code) =>
    /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(
      String.fromCodePoint(code),
    ),
  );
  if (missingChinese.length) {
    throw new Error(
      `Missing Chinese: ${String.fromCodePoint(...missingChinese)}`,
    );
  }
  console.log(`Total: ${totalBytes} bytes; all page Chinese covered.`);
  console.log(
    `Source-absent symbols (system fallback): ${missing
      .map(
        (code) =>
          `${String.fromCodePoint(code)} U+${code.toString(16).toUpperCase()}`,
      )
      .join(", ")}`,
  );
  console.log(
    `Overlapping codepoints: ${
      [...charsets[0]].filter((code) => charsets[1].has(code)).length
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
