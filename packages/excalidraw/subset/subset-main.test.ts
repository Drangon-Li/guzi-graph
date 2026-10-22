import { Buffer as NodeBuffer } from "node:buffer";

import { toBase64 } from "./subset-shared.chunk";

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  loadWoff2: vi.fn(),
  loadHbSubset: vi.fn(),
}));

vi.mock("../workers", () => ({
  WorkerPool: { create: mocks.createPool },
}));
vi.mock("./woff2/woff2-loader", () => ({ default: mocks.loadWoff2 }));
vi.mock("./harfbuzz/harfbuzz-loader", () => ({
  default: mocks.loadHbSubset,
}));
vi.mock("./subset-worker.chunk", () => ({
  WorkerUrl: new URL("https://example.com/subset-worker.js"),
}));

const bytes = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 31) % 256);
const dataUrl = (buffer: ArrayBuffer) =>
  `data:font/woff2;base64,${NodeBuffer.from(buffer).toString("base64")}`;

describe("font subsetting runtime selection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("Worker", vi.fn());
    vi.stubEnv("VITE_DISABLE_FONT_SUBSETTING", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("embeds complete font bytes without workers or Wasm when desktop disables subsetting", async () => {
    vi.stubEnv("VITE_DISABLE_FONT_SUBSETTING", "true");
    const { subsetWoff2GlyphsByCodepoints } = await import("./subset-main");
    const font = bytes(256 * 1024 + 7);
    const before = font.slice();
    const result = await subsetWoff2GlyphsByCodepoints(font.buffer, [0x4e2d]);
    expect(result).toBe(dataUrl(before.buffer));
    expect(font).toEqual(before);
    expect(font.buffer.byteLength).toBe(before.byteLength);
    expect(mocks.createPool).not.toHaveBeenCalled();
    expect(mocks.loadWoff2).not.toHaveBeenCalled();
    expect(mocks.loadHbSubset).not.toHaveBeenCalled();
  });

  it.each([undefined, "false"])(
    "preserves the Web worker subsetting path for flag %s",
    async (flag) => {
      vi.stubEnv("VITE_DISABLE_FONT_SUBSETTING", flag);
      const subset = bytes(17).buffer;
      const postMessage = vi.fn().mockResolvedValue(subset);
      mocks.createPool.mockReturnValue({ postMessage });
      const { subsetWoff2GlyphsByCodepoints } = await import("./subset-main");
      const font = bytes(1024);
      const result = await subsetWoff2GlyphsByCodepoints(font.buffer, [65, 66]);
      expect(mocks.createPool).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        {
          command: "SUBSET",
          arrayBuffer: expect.any(ArrayBuffer),
          codePoints: [65, 66],
        },
        { transfer: [expect.any(ArrayBuffer)] },
      );
      expect(postMessage.mock.calls[0][0].arrayBuffer).not.toBe(font.buffer);
      expect(result).toBe(dataUrl(subset));
    },
  );

  it("preserves main-thread subsetting when Web Workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const decompressed = bytes(19);
    const subset = bytes(7);
    const compressed = bytes(5);
    const decompress = vi.fn().mockReturnValue(decompressed);
    const compress = vi.fn().mockReturnValue(compressed);
    const subsetGlyphs = vi.fn().mockReturnValue(subset);
    mocks.loadWoff2.mockResolvedValue({ decompress, compress });
    mocks.loadHbSubset.mockResolvedValue({ subset: subsetGlyphs });
    const { subsetWoff2GlyphsByCodepoints } = await import("./subset-main");
    const font = bytes(1024);
    expect(await subsetWoff2GlyphsByCodepoints(font.buffer, [65])).toBe(
      dataUrl(compressed.buffer),
    );
    expect(decompress).toHaveBeenCalledWith(font.buffer);
    expect(subsetGlyphs).toHaveBeenCalledWith(
      decompressed.buffer,
      new Set([65]),
    );
    expect(compress).toHaveBeenCalledWith(subset.buffer);
    expect(mocks.createPool).not.toHaveBeenCalled();
  });
});

describe("complete font base64 encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([0, 128 * 1024 + 7, 1024 * 1024 + 3])(
    "preserves all %i bytes through browser encoding without Buffer",
    async (length) => {
      const font = bytes(length);
      const expected = dataUrl(font.buffer);
      vi.stubGlobal("Buffer", undefined);
      const result = await toBase64(font.buffer);
      expect(result).toBe(expected);
      expect(NodeBuffer.from(result.split(",")[1], "base64")).toEqual(
        NodeBuffer.from(font.buffer),
      );
    },
  );
});
