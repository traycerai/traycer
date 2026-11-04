import { afterEach, beforeEach } from "vitest";

// The in-process settings-lock waits sleep on the real clock. This file moves
// that clock forward without `vi.useFakeTimers()`: Vitest arms each test on its
// own ref'd timeout, and a global fake clock would fire that timeout too.
//
// `Date.now` stays on wall time, plus any jump below. A deadline that never
// sleeps (the holder vanishes and the acquire retries at once) still expires.
// A timer scheduled by the lock, or by the deadline file's probe, jumps to its
// deadline. A timer scheduled by the breaker or concurrent-write files (their
// `delay()` races against a real filesystem park) advances one millisecond per
// turn, so the park still gets the event loop. Unref'd timers are the
// background release retries. They ride along while a ref'd timer is already
// pulling the clock, and a lone one does not pull it, so a 60s "out of reach"
// retry stays unfired. `setImmediate` stays real and is the pump.

const FAST_FILES = ["cli-config-lock.ts", "store-lock-deadlines.test.ts"];
const SLOW_FILES = [
  "store-lock-breakers.test.ts",
  "store-concurrent-writes.test.ts",
];
const SLOW_STEP_MS = 1;

interface ScheduledTimer {
  id: number;
  at: number;
  fast: boolean;
  refed: boolean;
  cleared: boolean;
  fire: () => void;
}

interface ClockHandle {
  readonly clockHandle: true;
  readonly timer: ScheduledTimer;
  unref: () => ClockHandle;
  ref: () => ClockHandle;
}

type ClockKind = "fast" | "slow" | "real";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;
const realDateNow = Date.now;
const handles = new WeakSet<object>();

let installed = false;
// Wall-clock origin, and the base `Date.now` adds jumps onto. `Date.now()` is
// `base + (realNow - realOrigin)`, which is wall time until a jump adds to `base`.
let realOrigin = 0;
let base = 0;
let nextId = 1;
let timers: ScheduledTimer[] = [];
let pumpScheduled = false;

function current(): number {
  return base + (realDateNow() - realOrigin);
}

function clockKind(stack: string | undefined): ClockKind {
  if (stack === undefined) return "real";
  for (const name of FAST_FILES) {
    if (stack.includes(name)) return "fast";
  }
  for (const name of SLOW_FILES) {
    if (stack.includes(name)) return "slow";
  }
  return "real";
}

function isClockHandle(value: object): value is ClockHandle {
  return handles.has(value);
}

function hasRefedTimer(): boolean {
  for (const timer of timers) {
    if (timer.refed && !timer.cleared) return true;
  }
  return false;
}

function nextRefed(): ScheduledTimer | undefined {
  let next: ScheduledTimer | undefined;
  for (const timer of timers) {
    if (!timer.refed || timer.cleared) continue;
    if (
      next === undefined ||
      timer.at < next.at ||
      (timer.at === next.at && timer.id < next.id)
    ) {
      next = timer;
    }
  }
  return next;
}

function armPump(): void {
  if (pumpScheduled || !installed || !hasRefedTimer()) return;
  pumpScheduled = true;
  realSetImmediate(pump);
}

function pump(): void {
  pumpScheduled = false;
  if (!installed) return;
  const next = nextRefed();
  if (next === undefined) return;
  const gap = next.at - current();
  if (gap > 0) {
    base += next.fast || gap <= SLOW_STEP_MS ? gap : SLOW_STEP_MS;
  }
  const stamp = current();
  const due: ScheduledTimer[] = [];
  for (const timer of timers) {
    if (!timer.cleared && timer.at <= stamp) due.push(timer);
  }
  due.sort((left, right) => left.at - right.at || left.id - right.id);
  for (const timer of due) timer.cleared = true;
  if (due.length > 0) timers = timers.filter((timer) => !timer.cleared);
  for (const timer of due) timer.fire();
  armPump();
}

function clockSetTimeout(
  handler: TimerHandler,
  timeoutMs: number | undefined,
  ...args: unknown[]
) {
  if (typeof handler !== "function") {
    return realSetTimeout(handler, timeoutMs, ...args);
  }
  const kind = clockKind(new Error().stack);
  if (kind === "real") {
    return realSetTimeout(handler, timeoutMs, ...args);
  }
  const run = handler;
  const delay = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
  const timer: ScheduledTimer = {
    id: nextId,
    at: current() + delay,
    fast: kind === "fast",
    refed: true,
    cleared: false,
    fire: () => {
      Reflect.apply(run, undefined, args);
    },
  };
  nextId += 1;
  timers.push(timer);
  const handle: ClockHandle = {
    clockHandle: true,
    timer,
    unref: () => {
      timer.refed = false;
      return handle;
    },
    ref: () => {
      timer.refed = true;
      armPump();
      return handle;
    },
  };
  handles.add(handle);
  armPump();
  return handle;
}

function clockClearTimeout(
  handle: Parameters<typeof clearTimeout>[0] | undefined,
): void {
  if (typeof handle === "object" && handle !== null && isClockHandle(handle)) {
    handle.timer.cleared = true;
    return;
  }
  realClearTimeout(handle);
}

function install(): void {
  if (installed) return;
  installed = true;
  realOrigin = realDateNow();
  base = realOrigin;
  timers = [];
  nextId = 1;
  Date.now = () => current();
  // The global timer signatures are the DOM overloads (a numeric id). Node's
  // runtime returns an object, and so does the clock. Reflect.set keeps that
  // object without a cast through `unknown`.
  Reflect.set(globalThis, "setTimeout", clockSetTimeout);
  Reflect.set(globalThis, "clearTimeout", clockClearTimeout);
}

function restore(): void {
  if (!installed) return;
  installed = false;
  timers = [];
  pumpScheduled = false;
  Date.now = realDateNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

beforeEach(() => {
  install();
});

afterEach(() => {
  restore();
});
