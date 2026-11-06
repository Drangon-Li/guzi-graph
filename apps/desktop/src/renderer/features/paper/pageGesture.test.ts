import { PageGesture } from "./pageGesture";

describe("paper continuation intent", () => {
  it("creates on release after a continuous drag reaches 64 screen pixels", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, -40);
    gesture.update(
      { source: "pointer", phase: "move", deltaY: 103, previousPastEnd: -40 },
      35,
    );
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "move", deltaY: 1 }, 35.6);
    expect(gesture.armed).toBe(true);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 64),
    ).toBe(true);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 64),
    ).toBe(false);
  });

  it("caps direct intent and disarms below a 56 pixel retreat threshold", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 30);
    gesture.update({ source: "pointer", phase: "move", deltaY: 999 }, 94);
    expect(gesture.armed).toBe(true);
    gesture.update({ source: "pointer", phase: "move", deltaY: -8 }, 86);
    expect(gesture.armed).toBe(true);
    gesture.update({ source: "pointer", phase: "move", deltaY: -1 }, 85);
    expect(gesture.armed).toBe(false);
    for (let i = 0; i < 20; i++) {
      gesture.update({ source: "pointer", phase: "move", deltaY: 7 }, 90);
      gesture.update({ source: "pointer", phase: "move", deltaY: -7 }, 85);
    }
    expect(gesture.progress).toBe(55);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 85),
    ).toBe(false);
  });

  it("continues within one wheel stream after actual movement at the page end", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "wheel", phase: "move", deltaY: 80 }, -10);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 90);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "wheel", phase: "move", deltaY: 64 }, 154);
    expect(gesture.armed).toBe(true);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 154),
    ).toBe(true);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 80);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 180);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 180),
    ).toBe(true);
    gesture.update({ source: "wheel", phase: "move", deltaY: 10 }, 30);
    gesture.update({ source: "wheel", phase: "move", deltaY: 64 }, 94);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 94),
    ).toBe(true);
  });

  it("does not arm from one large wheel event crossing the page end", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "wheel", phase: "move", deltaY: 400 }, 120);
    expect(gesture.armed).toBe(false);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 120),
    ).toBe(false);
  });

  it("does not append if the viewport was clamped back to the hard edge before release", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 64 }, 35.6);
    expect(gesture.armed).toBe(true);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 0),
    ).toBe(false);
  });

  it.each(["pointer", "wheel"] as const)(
    "keeps a cancelled %s stream cancelled until release",
    (source) => {
      const gesture = new PageGesture();
      if (source === "pointer") {
        gesture.update({ source, phase: "begin", deltaY: 0 }, 0);
      } else {
        gesture.update({ source, phase: "move", deltaY: 10 }, 0);
      }
      gesture.update({ source, phase: "move", deltaY: 80 }, 80);
      expect(gesture.armed).toBe(true);
      gesture.cancel();
      gesture.update({ source, phase: "move", deltaY: 100 }, 180);
      expect(gesture.armed).toBe(false);
      expect(gesture.update({ source, phase: "end", deltaY: 0 }, 180)).toBe(
        false,
      );
      gesture.update(
        { source, phase: source === "pointer" ? "begin" : "move", deltaY: 0 },
        0,
      );
      gesture.update({ source, phase: "move", deltaY: 64 }, 64);
      expect(gesture.update({ source, phase: "end", deltaY: 0 }, 64)).toBe(
        true,
      );
    },
  );

  it("requires a fresh pointer begin after cancellation and ignores orphan moves", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "move", deltaY: 100 }, 100);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0);
    gesture.update({ source: "pointer", phase: "cancel", deltaY: 0 }, 100);
    gesture.update({ source: "pointer", phase: "move", deltaY: 100 }, 200);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 64 }, 64);
    expect(gesture.armed).toBe(true);
  });

  it.each(["pointer", "wheel"] as const)(
    "requires fresh direct input for a %s starting with a visible stretch",
    (source) => {
      const gesture = new PageGesture();
      gesture.update(
        { source, phase: source === "pointer" ? "begin" : "move", deltaY: 0 },
        400,
      );
      gesture.update({ source, phase: "move", deltaY: 64 }, 464);
      expect(gesture.update({ source, phase: "end", deltaY: 0 }, 464)).toBe(
        true,
      );
    },
  );

  it("disarms when retreating back inside the page or switching sources", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 120 }, 120);
    gesture.update({ source: "pointer", phase: "move", deltaY: -121 }, -1);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "wheel", phase: "move", deltaY: 120 }, 120);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 120),
    ).toBe(false);
  });
});
