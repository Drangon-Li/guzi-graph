import { PageGesture } from "./pageGesture";

describe("paper continuation intent", () => {
  it("creates on release after a continuous drag reaches 64 screen pixels", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, -40, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 103 }, 63, 10);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "move", deltaY: 1 }, 64, 20);
    expect(gesture.armed).toBe(true);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 64, 30),
    ).toBe(true);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 64, 40),
    ).toBe(false);
  });

  it("uses actual screen displacement and a 56 pixel retreat threshold", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 30, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 999 }, 94, 10);
    expect(gesture.armed).toBe(true);
    gesture.update({ source: "pointer", phase: "move", deltaY: -8 }, 86, 20);
    expect(gesture.armed).toBe(true);
    gesture.update({ source: "pointer", phase: "move", deltaY: -1 }, 85, 30);
    expect(gesture.armed).toBe(false);
    for (let i = 0; i < 20; i++) {
      gesture.update(
        { source: "pointer", phase: "move", deltaY: 10 },
        90,
        40 + i * 2,
      );
      gesture.update(
        { source: "pointer", phase: "move", deltaY: -10 },
        85,
        41 + i * 2,
      );
    }
    expect(gesture.progress).toBe(55);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 85, 100),
    ).toBe(false);
  });

  it("continues within one wheel stream after actual movement at the page end", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "wheel", phase: "move", deltaY: 80 }, -10, 0);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 90, 10);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "wheel", phase: "move", deltaY: 64 }, 154, 20);
    expect(gesture.armed).toBe(true);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 154, 220),
    ).toBe(true);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 80, 230);
    gesture.update({ source: "wheel", phase: "move", deltaY: 100 }, 180, 240);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 180, 440),
    ).toBe(false);
    gesture.update({ source: "wheel", phase: "move", deltaY: 10 }, 30, 1100);
    gesture.update({ source: "wheel", phase: "move", deltaY: 64 }, 94, 1110);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 94, 1310),
    ).toBe(true);
  });

  it("does not arm from one large wheel event crossing the page end", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "wheel", phase: "move", deltaY: 400 }, 120, 0);
    expect(gesture.armed).toBe(false);
    expect(
      gesture.update({ source: "wheel", phase: "end", deltaY: 0 }, 120, 200),
    ).toBe(false);
  });

  it.each(["pointer", "wheel"] as const)(
    "keeps a cancelled %s stream cancelled until release",
    (source) => {
      const gesture = new PageGesture();
      if (source === "pointer") {
        gesture.update({ source, phase: "begin", deltaY: 0 }, 0, 0);
      } else {
        gesture.update({ source, phase: "move", deltaY: 10 }, 0, 0);
      }
      gesture.update({ source, phase: "move", deltaY: 80 }, 80, 10);
      expect(gesture.armed).toBe(true);
      gesture.cancel();
      gesture.update({ source, phase: "move", deltaY: 100 }, 180, 20);
      expect(gesture.armed).toBe(false);
      expect(
        gesture.update({ source, phase: "end", deltaY: 0 }, 180, 220),
      ).toBe(false);
      gesture.update(
        { source, phase: source === "pointer" ? "begin" : "move", deltaY: 0 },
        0,
        250,
      );
      gesture.update({ source, phase: "move", deltaY: 64 }, 64, 260);
      expect(gesture.update({ source, phase: "end", deltaY: 0 }, 64, 460)).toBe(
        true,
      );
    },
  );

  it("requires a fresh pointer begin after cancellation and ignores orphan moves", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "move", deltaY: 100 }, 100, 0);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0, 10);
    gesture.update({ source: "pointer", phase: "cancel", deltaY: 0 }, 100, 20);
    gesture.update({ source: "pointer", phase: "move", deltaY: 100 }, 200, 30);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0, 40);
    gesture.update({ source: "pointer", phase: "move", deltaY: 64 }, 64, 50);
    expect(gesture.armed).toBe(true);
  });

  it.each(["pointer", "wheel"] as const)(
    "uses the visible page end as origin for a fresh %s at low zoom",
    (source) => {
      const gesture = new PageGesture();
      gesture.update(
        { source, phase: source === "pointer" ? "begin" : "move", deltaY: 0 },
        400,
        0,
      );
      gesture.update({ source, phase: "move", deltaY: 64 }, 464, 10);
      expect(
        gesture.update({ source, phase: "end", deltaY: 0 }, 464, 210),
      ).toBe(true);
    },
  );

  it("disarms when retreating back inside the page or switching sources", () => {
    const gesture = new PageGesture();
    gesture.update({ source: "pointer", phase: "begin", deltaY: 0 }, 0, 0);
    gesture.update({ source: "pointer", phase: "move", deltaY: 120 }, 120, 10);
    gesture.update({ source: "pointer", phase: "move", deltaY: -121 }, -1, 20);
    expect(gesture.armed).toBe(false);
    gesture.update({ source: "wheel", phase: "move", deltaY: 120 }, 120, 30);
    expect(
      gesture.update({ source: "pointer", phase: "end", deltaY: 0 }, 120, 40),
    ).toBe(false);
  });
});
