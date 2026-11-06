import {
  PaperMotionSamples,
  stepPaperSpring,
} from "../components/App.viewportPaper";

describe("paper spring", () => {
  it("preserves release velocity and follows the same trajectory at different frame rates", () => {
    const initial = { displacement: 32, velocity: 0.5, edge: 0, limit: 80 };
    expect(stepPaperSpring(initial, 1)!.displacement).toBeGreaterThan(32);
    const half = stepPaperSpring(initial, 16)!;
    const twoSteps = stepPaperSpring(half, 17)!;
    const oneStep = stepPaperSpring(initial, 33)!;
    expect(twoSteps.displacement).toBeCloseTo(oneStep.displacement, 10);
    expect(twoSteps.velocity).toBeCloseTo(oneStep.velocity, 10);
    expect(stepPaperSpring(initial, 2000)).toBeNull();
  });

  it("uses recent screen motion and rejects stale or insufficient samples", () => {
    const samples = new PaperMotionSamples();
    samples.add({ x: 0, y: 0, time: 50 });
    samples.add({ x: 3, y: 9, time: 52 });
    expect(samples.velocity(52)).toEqual({ x: 0, y: 0 });
    samples.add({ x: 12, y: 30, time: 80 });
    expect(samples.velocity(80)).toEqual({ x: 0.4, y: 1 });
    expect(samples.velocity(160)).toEqual({ x: 0, y: 0 });
  });
});
