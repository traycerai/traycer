/**
 * The chime duck as a unit on the gain's schedule, with the REAL durations of
 * shipped chimes. The param is a recording stand-in that evaluates the
 * schedule the way an `AudioParam` does, so the assertions read the gain at a
 * moment rather than the order of calls.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ChimeDuck, type ScheduledParam } from "../output";
import { MIX_TUNING } from "../mix-tuning";
import { chimeSeconds } from "./wav-seconds";

interface ParamEvent {
  readonly kind: "set" | "ramp";
  readonly value: number;
  readonly time: number;
}

class RecordingParam implements ScheduledParam {
  events: ParamEvent[] = [];
  clock = 0;

  get value(): number {
    return this.valueAt(this.clock);
  }

  valueAt(time: number): number {
    let previousValue = 1;
    let previousTime = 0;
    for (const event of this.events) {
      if (event.kind === "set") {
        if (event.time > time) break;
      } else if (event.time > time) {
        const span = event.time - previousTime;
        return span <= 0
          ? event.value
          : previousValue +
              ((event.value - previousValue) * (time - previousTime)) / span;
      }
      previousValue = event.value;
      previousTime = event.time;
    }
    return previousValue;
  }

  cancelAndHoldAtTime(cancelTime: number): void {
    const held = this.valueAt(cancelTime);
    this.events = this.events.filter((event) => event.time <= cancelTime);
    this.events.push({ kind: "set", value: held, time: cancelTime });
  }

  cancelScheduledValues(cancelTime: number): void {
    this.events = this.events.filter((event) => event.time < cancelTime);
  }

  setValueAtTime(value: number, startTime: number): void {
    this.events.push({ kind: "set", value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.events.push({ kind: "ramp", value, time: endTime });
  }
}

const { gain, attackSeconds, releaseSeconds } = MIX_TUNING.duck;
const NOW = 100;
const EPSILON = 1e-6;

let param: RecordingParam;
let duck: ChimeDuck;

beforeEach(() => {
  param = new RecordingParam();
  duck = new ChimeDuck(param);
});

function duckAt(time: number, seconds: number): void {
  param.clock = time;
  duck.duck(time, seconds);
}

describe("the chime duck", () => {
  it("holds for exactly the chime's real length, then releases over the release time", () => {
    const seconds = chimeSeconds("beacon");
    expect(seconds).toBeGreaterThan(attackSeconds);

    duckAt(NOW, seconds);

    expect(param.valueAt(NOW)).toBe(1);
    expect(param.valueAt(NOW + attackSeconds)).toBeCloseTo(gain, 6);
    expect(param.valueAt(NOW + seconds - EPSILON)).toBeCloseTo(gain, 6);
    expect(param.valueAt(NOW + seconds + releaseSeconds / 2)).toBeCloseTo(
      (gain + 1) / 2,
      6,
    );
    expect(param.valueAt(NOW + seconds + releaseSeconds)).toBeCloseTo(1, 6);
  });

  it("holds a second chime's duck until whichever ends last", () => {
    const long = chimeSeconds("beacon");
    const short = chimeSeconds("bloop");
    expect(long).toBeGreaterThan(short + 0.2);

    // The short one arrives while the long one is held: the long one's end rules.
    duckAt(NOW, long);
    duckAt(NOW + 0.1, short);
    expect(param.valueAt(NOW + long - EPSILON)).toBeCloseTo(gain, 6);
    expect(param.valueAt(NOW + long + releaseSeconds)).toBeCloseTo(1, 6);

    // The long one arrives while the short one is held: the long one's end rules.
    param = new RecordingParam();
    duck = new ChimeDuck(param);
    duckAt(NOW, short);
    duckAt(NOW + 0.1, long);
    const end = NOW + 0.1 + long;
    expect(param.valueAt(end - EPSILON)).toBeCloseTo(gain, 6);
    expect(param.valueAt(end + releaseSeconds)).toBeCloseTo(1, 6);
  });

  it("takes a chime during the release down from where the music has got to", () => {
    const seconds = chimeSeconds("beacon");
    duckAt(NOW, seconds);
    const midRelease = NOW + seconds + releaseSeconds / 2;
    const midValue = param.valueAt(midRelease);

    duckAt(midRelease, seconds);

    expect(param.valueAt(midRelease)).toBeCloseTo(midValue, 6);
    // Down from there, never back up first.
    expect(param.valueAt(midRelease + attackSeconds / 2)).toBeLessThan(
      midValue,
    );
    expect(param.valueAt(midRelease + attackSeconds)).toBeCloseTo(gain, 6);
    expect(param.valueAt(midRelease + seconds + releaseSeconds)).toBeCloseTo(
      1,
      6,
    );
  });
});
