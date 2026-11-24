import { afterAll, expect, TestRunner, vi } from "vitest";

// Vitest's polls give up after one second unless told otherwise, even inside a
// test allowed far longer, so a slow machine could fail an arrival the test
// itself would still have seen. A poll that names no timeout and starts under
// real timers inside a test is given the rest of that test's time, so it fails
// with its own error at or before the test's deadline. Everything else keeps
// Vitest's own behaviour exactly: a poll that names a timeout, one that starts
// outside a test, and one that starts under fake timers, whose clock is the
// fake one and which Vitest's poll advances on every check.

interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
  readonly message?: string;
}

// Vitest's own margin for an operation that must fail before its task does.
const BEFORE_TEST_TIMEOUT_MS = 100;

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
  const remaining =
    startTime + test.timeout - BEFORE_TEST_TIMEOUT_MS - wallClock();
  return { ...options, timeout: Math.max(remaining, 1) };
}

const waitFor = vi.waitFor;
const waitUntil = vi.waitUntil;
const poll = expect.poll;
vi.waitFor = (callback, options) => waitFor(callback, lastingItsTest(options));
vi.waitUntil = (callback, options) =>
  waitUntil(callback, lastingItsTest(options));
expect.poll = (callback, options) => poll(callback, lastingItsTest(options));

// Files that share a worker share `vi` and `expect`, and this file runs again
// for each of them, so each file puts back what it found.
afterAll(() => {
  vi.waitFor = waitFor;
  vi.waitUntil = waitUntil;
  expect.poll = poll;
});
