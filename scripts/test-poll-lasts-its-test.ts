import { expect, TestRunner, vi } from "vitest";

// Vitest's polls give up after one second unless told otherwise, even inside a
// test allowed far longer, so a slow machine could fail an arrival the test
// itself would still have seen. A poll that names no timeout and starts under
// real timers inside a test is given the rest of that test's time, so it fails
// with its own error by the test's deadline; one that starts in the test's
// last second gets Vitest's own default, as without this file, and can end as
// the test's timeout instead. A poll in the test's `beforeEach` is given the
// test's remaining time too, because Vitest does not expose the hook's own
// start, so it can keep checking after that hook's timeout has failed it.
// Everything else keeps Vitest's own behaviour exactly: a
// poll that names a timeout, one that starts outside a test, and one that
// starts under fake timers, whose clock is the fake one and which Vitest's
// poll advances on every check.

interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
  readonly message?: string;
}

// Vitest's own default timeout.
const DEFAULT_TIMEOUT_MS = 1_000;
// Vitest's own margin for an operation that must fail before its task does.
const BEFORE_TEST_TIMEOUT_MS = 100;
// Marks a function this file installed. Files that share a worker share `vi`
// and `expect` and run this file each, so a later run finds the mark and
// leaves the function as it is instead of wrapping it again.
const INSTALLED = Symbol.for("traycer.test-poll-lasts-its-test");

// Read before any test can replace it: the test's start time is on this clock.
const wallClock = Date.now;

function lastingItsTest<Options extends number | PollOptions | undefined>(
  options: Options,
): Options | PollOptions {
  if (typeof options === "number" || options?.timeout !== undefined) {
    return options;
  }
  if (vi.isFakeTimers()) return options;
  const test = TestRunner.getCurrentTest();
  const startTime = test?.result?.startTime;
  if (test === undefined || startTime === undefined) return options;
  if (!(test.timeout > 0) || !Number.isFinite(test.timeout)) return options;
  // The start is stamped before the test's beforeEach hooks, which its own
  // timeout does not count, so the rest is never cut below Vitest's default.
  const remaining =
    startTime + test.timeout - BEFORE_TEST_TIMEOUT_MS - wallClock();
  return { ...options, timeout: Math.max(remaining, DEFAULT_TIMEOUT_MS) };
}

function installed(fn: object): boolean {
  return INSTALLED in fn;
}

function marked<Fn extends object>(fn: Fn): Fn {
  Object.defineProperty(fn, INSTALLED, { value: true });
  return fn;
}

if (!installed(vi.waitFor)) {
  const waitFor = vi.waitFor;
  vi.waitFor = marked<typeof vi.waitFor>((callback, options) =>
    waitFor(callback, lastingItsTest(options)),
  );
}
if (!installed(vi.waitUntil)) {
  const waitUntil = vi.waitUntil;
  vi.waitUntil = marked<typeof vi.waitUntil>((callback, options) =>
    waitUntil(callback, lastingItsTest(options)),
  );
}
if (!installed(expect.poll)) {
  const poll = expect.poll;
  expect.poll = marked<typeof expect.poll>((callback, options) =>
    poll(callback, lastingItsTest(options)),
  );
}
