import { expect, TestRunner, vi } from "vitest";

// Vitest's polls give up after one second unless told otherwise, even inside a
// test allowed far longer, so one outcome hung on two clocks and a slow machine
// could fail an arrival the test itself would still have seen. A poll that
// names no timeout lasts as long as the test or hook running it; one that names
// its own timeout keeps it.

interface Bounded {
  readonly timeout?: number;
  readonly interval?: number;
  readonly message?: string;
}

// The largest delay a timer accepts. Outside a test (a hook), or in a test with
// no timeout, the poll is bounded by its runner's own timeout, not by a shorter one.
const UNBOUNDED_MS = 2_147_483_647;

function containingTimeout(): number {
  const timeout = TestRunner.getCurrentTest()?.timeout ?? 0;
  return timeout > 0 ? timeout : UNBOUNDED_MS;
}

function lastingItsTest(options: number | Bounded | undefined): Bounded {
  if (typeof options === "number") return { timeout: options };
  return { ...options, timeout: options?.timeout ?? containingTimeout() };
}

const waitFor = vi.waitFor;
const waitUntil = vi.waitUntil;
const poll = expect.poll;
vi.waitFor = (callback, options) => waitFor(callback, lastingItsTest(options));
vi.waitUntil = (callback, options) =>
  waitUntil(callback, lastingItsTest(options));
expect.poll = (callback, options) => poll(callback, lastingItsTest(options));
