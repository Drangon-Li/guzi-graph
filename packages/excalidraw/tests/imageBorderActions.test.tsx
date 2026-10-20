import { CaptureUpdateAction, isImageElement } from "@excalidraw/element";
import { DEFAULT_ELEMENT_STROKE_PICKS } from "@excalidraw/common";

import { Excalidraw } from "../index";
import { restoreElements } from "../data/restore";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { fireEvent, render, screen } from "./test-utils";

const { h } = window;

beforeEach(async () => {
  await render(<Excalidraw langCode="en" handleKeyboardGlobally />);
});

it("chooses all four image border styles directly and restores the last style with undo", () => {
  const image = API.createElement({
    type: "image",
    width: 120,
    height: 80,
    fileId: "test-border-image",
    status: "saved",
  });
  API.updateScene({
    elements: [image],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([image]);
  const panel = document.querySelector(".image-border-actions")!;
  expect(panel.querySelector('input[type="checkbox"]')).toBeNull();
  expect(panel.querySelectorAll(".image-border-styles button")).toHaveLength(4);
  expect(screen.getByLabelText("Border color")).toBeTruthy();
  expect(screen.getByText("Stroke width")).toBeTruthy();
  for (const [name, style] of [
    ["Solid border", "solid"],
    ["Short dashed border", "dotted"],
    ["Long dashed border", "dashed"],
  ] as const) {
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    expect(h.elements[0]).toMatchObject({
      imageBorder: true,
      strokeStyle: style,
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
  }
  fireEvent.click(screen.getByRole("button", { name: "No border" }));
  expect(h.elements[0]).toMatchObject({
    imageBorder: false,
    strokeStyle: "dashed",
  });
  Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("z"));
  expect(h.elements[0]).toMatchObject({
    imageBorder: true,
    strokeStyle: "dashed",
  });
  expect(restoreElements(h.elements, null)[0]).toMatchObject({
    imageBorder: true,
    strokeStyle: "dashed",
  });
});

it("enables visible borders for mixed selections while preserving each existing color", () => {
  const images = [
    API.createElement({ type: "image", strokeColor: "transparent" }),
    API.createElement({ type: "image", strokeColor: "#123456" }),
  ];
  API.setElements(images);
  API.setSelectedElements(images);
  fireEvent.click(screen.getByRole("button", { name: "Short dashed border" }));
  const updated = h.elements.filter(isImageElement);
  expect(updated.map((image) => image.strokeColor)).toEqual([
    "#1b1b1f",
    "#123456",
  ]);
  expect(
    updated.every(
      (image) => image.imageBorder && image.strokeStyle === "dotted",
    ),
  ).toBe(true);
});

it("restores native line-style controls and persists roughness independently from border visibility and dash style", () => {
  const image = API.createElement({
    type: "image",
    roughness: 1,
    width: 120,
    height: 80,
    fileId: "roughness-border-image",
    status: "saved",
  });
  API.updateScene({
    elements: [image],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([image]);
  expect(screen.getByText("Sloppiness")).toBeTruthy();
  fireEvent.click(screen.getByTitle("Cartoonist"));
  expect(h.elements[0]).toMatchObject({ roughness: 2, imageBorder: false });
  fireEvent.click(screen.getByRole("button", { name: "Long dashed border" }));
  expect(h.elements[0]).toMatchObject({
    roughness: 2,
    imageBorder: true,
    strokeStyle: "dashed",
  });
  fireEvent.click(screen.getByTitle("Architect"));
  expect(h.elements[0]).toMatchObject({
    roughness: 0,
    imageBorder: true,
    strokeStyle: "dashed",
  });
  Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("z"));
  expect(h.elements[0]).toMatchObject({
    roughness: 2,
    imageBorder: true,
    strokeStyle: "dashed",
  });
  expect(restoreElements(h.elements, null)[0]).toMatchObject({
    roughness: 2,
    imageBorder: true,
    strokeStyle: "dashed",
  });
});

it("applies a memoized color swatch to the current image after switching between equally colored images", () => {
  const first = API.createElement({ type: "image", strokeColor: "#123456" });
  const second = API.createElement({
    type: "image",
    strokeColor: "#123456",
    x: 200,
  });
  API.setElements([first, second]);
  API.setSelectedElements([first]);
  const nextColor = DEFAULT_ELEMENT_STROKE_PICKS[1];
  const swatch = document.querySelector(
    `.image-border-actions button[title="${nextColor}"]`,
  )!;
  API.setSelectedElements([second]);
  expect(
    document.querySelector(
      `.image-border-actions button[title="${nextColor}"]`,
    ),
  ).toBe(swatch);
  fireEvent.click(swatch);
  expect(
    h.elements.find((element) => element.id === first.id)?.strokeColor,
  ).toBe("#123456");
  expect(
    h.elements.find((element) => element.id === second.id)?.strokeColor,
  ).toBe(nextColor);
});
