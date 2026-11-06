import { clamp } from "@excalidraw/math";

export type PaperSpringAxis = {
  displacement: number;
  velocity: number;
  edge: number;
  limit: number;
};

const SPRING_FREQUENCY = 0.022;
const STOP_DISTANCE = 0.3;
const STOP_VELOCITY = 0.02;
const MAX_VELOCITY = 2;
const VELOCITY_WINDOW = 70;
const MIN_SAMPLE_SPAN = 8;

type MotionSample = { x: number; y: number; time: number };

export class PaperMotionSamples {
  private samples: MotionSample[] = [];

  clear() {
    this.samples = [];
  }

  add(sample: MotionSample) {
    const last = this.samples.at(-1);
    if (last && sample.time < last.time) {
      return;
    }
    this.samples = this.samples.filter(
      ({ time }) => sample.time - time <= VELOCITY_WINDOW,
    );
    this.samples.push(sample);
  }

  velocity(now: number) {
    const last = this.samples.at(-1);
    const first = this.samples.find(
      ({ time }) => now - time <= VELOCITY_WINDOW,
    );
    if (!first || !last || last.time - first.time < MIN_SAMPLE_SPAN) {
      return { x: 0, y: 0 };
    }
    const duration = last.time - first.time;
    return {
      x: clamp((last.x - first.x) / duration, -MAX_VELOCITY, MAX_VELOCITY),
      y: clamp((last.y - first.y) / duration, -MAX_VELOCITY, MAX_VELOCITY),
    };
  }
}

// Analytical critically damped spring in screen pixels and milliseconds.
// Solving the full elapsed interval keeps long frames stable and preserves
// the same motion when rendering at different frame rates.
export const stepPaperSpring = (axis: PaperSpringAxis, dt: number) => {
  const { displacement, velocity, limit } = axis;
  const slope = velocity + SPRING_FREQUENCY * displacement;
  const decay = Math.exp(-SPRING_FREQUENCY * dt);
  const next = (displacement + slope * dt) * decay;
  const nextVelocity = (velocity - SPRING_FREQUENCY * slope * dt) * decay;
  const direction = Math.sign(displacement || velocity);
  if (
    Math.sign(next) !== direction ||
    (Math.abs(next) <= STOP_DISTANCE && Math.abs(nextVelocity) <= STOP_VELOCITY)
  ) {
    return null;
  }
  if (Math.abs(next) > limit) {
    return { ...axis, displacement: direction * limit, velocity: 0 };
  }
  return { ...axis, displacement: next, velocity: nextVelocity };
};
