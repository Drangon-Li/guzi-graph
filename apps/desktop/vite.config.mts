import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";

const modules = [
  "common",
  "element",
  "math",
  "utils",
  "fractional-indexing",
  "laser-pointer",
];

const pdfRoot = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const pdfAssets = ["cmaps", "standard_fonts", "wasm", "iccs"].flatMap(
  (directory) =>
    readdirSync(path.join(pdfRoot, directory)).map((name) => ({
      fileName: `pdfjs/${directory}/${name}`,
      source: path.join(pdfRoot, directory, name),
    })),
);
pdfAssets.push({
  fileName: "pdfjs/LICENSE",
  source: path.join(pdfRoot, "LICENSE"),
});

export default defineConfig({
  base: "./",
  publicDir: false,
  define: {
    "import.meta.env.VITE_DISABLE_FONT_SUBSETTING": JSON.stringify("true"),
  },
  resolve: {
    alias: [
      ...modules.flatMap((name) => [
        {
          find: new RegExp(`^@excalidraw/${name}$`),
          replacement: path.resolve(
            __dirname,
            `../../packages/${name}/src/index.ts`,
          ),
        },
        {
          find: new RegExp(`^@excalidraw/${name}/(.*)`),
          replacement: path.resolve(__dirname, `../../packages/${name}/src/$1`),
        },
      ]),
      {
        find: /^@excalidraw\/excalidraw$/,
        replacement: path.resolve(
          __dirname,
          "../../packages/excalidraw/index.tsx",
        ),
      },
      {
        find: /^@excalidraw\/excalidraw\/(.*)/,
        replacement: path.resolve(__dirname, "../../packages/excalidraw/$1"),
      },
    ],
    dedupe: ["react", "react-dom", "jotai"],
  },
  plugins: [
    {
      name: "desktop-pdf-resources",
      generateBundle() {
        for (const asset of pdfAssets) {
          this.emitFile({
            type: "asset",
            fileName: asset.fileName,
            source: readFileSync(asset.source),
          });
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = request.url?.split("?")[0];
          const asset = pdfAssets.find((item) => `/${item.fileName}` === url);
          if (!asset) {
            return next();
          }
          response.setHeader(
            "Content-Type",
            asset.fileName.endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream",
          );
          response.end(readFileSync(asset.source));
        });
      },
    },
    react(),
    svgr(),
    {
      name: "desktop-development-csp",
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (!context.server) {
            return html;
          }
          return html
            .replace(
              "script-src 'self' 'wasm-unsafe-eval'",
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
            )
            .replace(
              "connect-src 'self'",
              "connect-src 'self' ws://127.0.0.1:4317",
            );
        },
      },
    },
  ],
  server: { host: "127.0.0.1", port: 4317, strictPort: true },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        assetFileNames(asset) {
          if (asset.name?.endsWith(".woff2")) {
            return `fonts/${asset.name.split("-")[0]}/[name][extname]`;
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
