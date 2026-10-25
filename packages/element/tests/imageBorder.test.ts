import "@excalidraw/element";
import rough from "roughjs/bin/rough";

import { newImageElement } from "../src/newElement";
import {
  drawImageBorder,
  getImageBorderDrawable,
  getImageBorderStyle,
} from "../src/imageBorder";

it("keeps image borders inside cropped bounds and scales the dash style", () => {
  const image = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 120,
    height: 60,
    strokeWidth: 4,
    strokeStyle: "dashed",
    roundness: { type: 3 },
  });
  expect(getImageBorderStyle(image)).toMatchObject({
    inset: 2,
    width: 116,
    height: 56,
    strokeWidth: 4,
    dash: [32, 16],
  });
});

it("does not draw borders on existing images until enabled", () => {
  const context = document.createElement("canvas").getContext("2d")!;
  const stroke = vi.spyOn(context, "stroke");
  const image = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 120,
    height: 60,
  });
  drawImageBorder(context, image, "light");
  expect(stroke).not.toHaveBeenCalled();
  drawImageBorder(
    context,
    { ...image, imageBorder: true, strokeColor: "#123456" },
    "light",
  );
  expect(stroke).toHaveBeenCalledTimes(1);
});

it("restores canvas state when drawing a hand-drawn border throws", () => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const image = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 120,
    height: 60,
    imageBorder: true,
    roughness: 2,
  });
  const rc = rough.canvas(canvas);
  vi.spyOn(rc, "draw").mockImplementation(() => {
    context.translate(10, 20);
    throw new Error("drawing failed");
  });
  context.translate(5, 7);
  context.filter = "blur(2px)";
  const transform = context.getTransform();
  expect(() => drawImageBorder(context, image, "light", rc)).toThrow(
    "drawing failed",
  );
  expect(context.getTransform()).toEqual(transform);
  expect(context.filter).toBe("blur(2px)");
});

it("exports the same inset border for a cropped, rotated and flipped image", async () => {
  const { exportScene } = await import("@excalidraw/excalidraw/scene/export");
  const image = {
    ...newImageElement({
      type: "image",
      x: 20,
      y: 30,
      width: 120,
      height: 60,
      imageBorder: true,
      roughness: 0,
      strokeWidth: 4,
      strokeStyle: "dashed",
      roundness: { type: 3 },
      scale: [-1, 1],
      crop: {
        x: 20,
        y: 10,
        width: 120,
        height: 60,
        naturalWidth: 200,
        naturalHeight: 100,
      },
    }),
    fileId: "border-image" as import("../src/types").FileId,
    strokeColor: "#123456",
    angle: (Math.PI / 6) as import("@excalidraw/math").Radians,
  };
  const svg = await exportScene({
    type: "svg",
    config: { canvasBackgroundColor: false },
    data: {
      elements: [image],
      files: {
        [image.fileId]: {
          id: image.fileId,
          mimeType: "image/png",
          dataURL:
            "data:image/png;base64,AA==" as import("@excalidraw/excalidraw/types").DataURL,
          created: 1,
        },
      },
    },
  });
  const border = svg.querySelector('rect[stroke="#123456"]')!;
  expect(border).not.toBeNull();
  expect(border.getAttribute("width")).toBe("116");
  expect(border.getAttribute("height")).toBe("56");
  expect(border.getAttribute("stroke-width")).toBe("4");
  expect(border.getAttribute("stroke-dasharray")).toBe("32 16");
  expect(
    Number(border.getAttribute("transform")!.match(/rotate\(([^ ]+)/)![1]),
  ).toBeCloseTo(30);
  expect(svg.querySelector("use")?.getAttribute("transform")).toContain(
    "scale(-1 1)",
  );
});

it.each(["solid", "dotted", "dashed"] as const)(
  "shares the seeded hand-drawn %s border between scaled Canvas and cropped, rotated, flipped SVG",
  async (strokeStyle) => {
    const { exportScene } = await import("@excalidraw/excalidraw/scene/export");
    const image = newImageElement({
      type: "image",
      x: 20,
      y: 30,
      width: 120,
      height: 60,
      fileId: "sketch-border" as import("../src/types").FileId,
      imageBorder: true,
      roughness: 2,
      strokeColor: "#123456",
      strokeWidth: 4,
      strokeStyle,
      seed: 42,
      roundness: { type: 3 },
      scale: [-1, 1],
      angle: (Math.PI / 6) as import("@excalidraw/math").Radians,
      crop: {
        x: 20,
        y: 10,
        width: 120,
        height: 60,
        naturalWidth: 200,
        naturalHeight: 100,
      },
    });
    const drawable = getImageBorderDrawable(image, "light")!;
    expect(drawable.options).toMatchObject({
      roughness: 2,
      seed: 42,
      strokeLineDash: getImageBorderStyle(image).dash,
      strokeWidth: 4,
    });
    expect(getImageBorderDrawable(image, "light")?.sets).toEqual(drawable.sets);
    expect(
      getImageBorderDrawable({ ...image, roughness: 1 }, "light")?.sets,
    ).not.toEqual(drawable.sets);
    expect(
      getImageBorderDrawable({ ...image, imageBorder: false }, "light"),
    ).toBeNull();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const rc = rough.canvas(canvas);
    const draw = vi.spyOn(rc, "draw");
    const curve = vi.spyOn(context, "bezierCurveTo");
    context.scale(2, 2);
    context.rotate(image.angle);
    const transform = context.getTransform();
    drawImageBorder(context, image, "light", rc);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][0].sets).toEqual(drawable.sets);
    expect(curve).toHaveBeenCalled();
    expect(context.getTransform()).toEqual(transform);
    const svg = await exportScene({
      type: "svg",
      config: { canvasBackgroundColor: false },
      data: {
        elements: [image],
        files: {
          "sketch-border": {
            id: image.fileId!,
            mimeType: "image/png",
            dataURL:
              "data:image/png;base64,AA==" as import("@excalidraw/excalidraw/types").DataURL,
            created: 1,
          },
        },
      },
    });
    const paths = Array.from(svg.querySelectorAll('path[stroke="#123456"]'));
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(
      rough
        .generator()
        .toPaths(drawable)
        .map((path) => path.d),
    );
    expect(paths[0].parentElement?.getAttribute("transform")).toContain(
      "scale(-1 1)",
    );
    expect(paths[0].parentElement?.getAttribute("transform")).toContain(
      "translate(20 10)",
    );
    expect(
      Number(
        paths[0].parentElement
          ?.getAttribute("transform")
          ?.match(/rotate\(([^ ]+)/)?.[1],
      ),
    ).toBeCloseTo(30);
    expect(paths[0].getAttribute("stroke-dasharray") ?? "").toBe(
      getImageBorderStyle(image).dash.join(" "),
    );
    const none = await exportScene({
      type: "svg",
      config: { canvasBackgroundColor: false },
      data: {
        elements: [{ ...image, imageBorder: false }],
        files: {
          "sketch-border": {
            id: image.fileId!,
            mimeType: "image/png",
            dataURL:
              "data:image/png;base64,AA==" as import("@excalidraw/excalidraw/types").DataURL,
            created: 1,
          },
        },
      },
    });
    expect(
      none.querySelector('path[stroke="#123456"],rect[stroke="#123456"]'),
    ).toBeNull();
  },
);
