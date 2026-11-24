import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The setup file scripts/test-poll-lasts-its-test.ts, through its real
// consumers: vi.waitFor, vi.waitUntil and expect.poll as every test calls them.

interface PollKind {
  readonly name: string;
  readonly ownError: string;
  readonly until: (
    check: () => boolean,
    options: { readonly timeout: number } | undefined,
  ) => Promise<unknown>;
}

const KINDS: readonly PollKind[] = [
  {
    name: "vi.waitFor",
    ownError: "not yet",
    until: (check, options) =>
      vi.waitFor(() => {
        if (!check()) throw new Error("not yet");
      }, options),
  },
  {
    name: "vi.waitUntil",
    ownError: "Timed out in waitUntil!",
    until: (check, options) => vi.waitUntil(check, options),
  },
  {
    name: "expect.poll",
    ownError: "expected false to be true",
    until: (check, options) => expect.poll(check, options).toBe(true),
  },
];

const INTERVAL_MS = 50;
const NO_ARRIVAL_TEST_MS = 2_500;
const LATE_START_MS = 1_500;
// The poll's own margin before its test's timeout.
const BEFORE_TEST_TIMEOUT_MS = 100;
// A hook has its own timeout, so the poll it runs can end at the test's
// budget without racing the test's deadline.
const HOOK_MS = 10_000;

interface PollEnd {
  readonly message: string;
  readonly afterMs: number;
  readonly calls: number;
}

// Runs a poll that never sees its condition, from the test's own beforeEach:
// the poll's budget is its test's, and the test reads how it ended.
async function pollToItsEnd(kind: PollKind): Promise<PollEnd> {
  let calls = 0;
  const started = Date.now();
  try {
    await kind.until(() => {
      calls += 1;
      return false;
    }, undefined);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      afterMs: Date.now() - started,
      calls,
    };
  }
  throw new Error("a poll whose condition never holds settled");
}

// A poll checks once at its start and at most once per interval after it.
function mostChecksWithin(budgetMs: number): number {
  return 1 + Math.floor(budgetMs / INTERVAL_MS);
}

describe.each(KINDS)("$name", (kind) => {
  it("waits out an arrival later than Vitest's one second", async () => {
    let arrived = false;
    setTimeout(() => {
      arrived = true;
    }, 1_500);
    await kind.until(() => arrived, undefined);
    expect(arrived).toBe(true);
  });

  it("keeps a timeout the poll names", async () => {
    let calls = 0;
    await expect(
      kind.until(
        () => {
          calls += 1;
          return false;
        },
        { timeout: 200 },
      ),
    ).rejects.toThrow();
    // One stretched to its test would check about fifty times.
    expect(calls).toBeLessThanOrEqual(mostChecksWithin(200));
  });

  describe("with nothing arriving", () => {
    let end: PollEnd | null = null;
    beforeEach(async () => {
      end = await pollToItsEnd(kind);
    }, HOOK_MS);

    it(
      "fails with its own error at its test's timeout, past Vitest's one second",
      () => {
        expect(end?.message).toContain(kind.ownError);
        expect(end?.afterMs).toBeGreaterThanOrEqual(
          NO_ARRIVAL_TEST_MS - BEFORE_TEST_TIMEOUT_MS - 400,
        );
      },
      NO_ARRIVAL_TEST_MS,
    );
  });

  describe("started late in its test", () => {
    let end: PollEnd | null = null;
    beforeEach(async () => {
      await sleep(LATE_START_MS);
      end = await pollToItsEnd(kind);
    }, HOOK_MS);

    it(
      "is given only what is left of its test",
      () => {
        expect(end?.message).toContain(kind.ownError);
        // Given its test's whole timeout instead, it would check about fifty times.
        expect(end?.calls).toBeLessThanOrEqual(
          mostChecksWithin(
            NO_ARRIVAL_TEST_MS - BEFORE_TEST_TIMEOUT_MS - LATE_START_MS,
          ),
        );
      },
      NO_ARRIVAL_TEST_MS,
    );
  });

  it("leaves a fake clock as Vitest's own poll does, so a timer due past its second does not fire", async () => {
    vi.useFakeTimers();
    try {
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 3_000);
      const before = Date.now();
      await expect(kind.until(() => fired, undefined)).rejects.toThrow();
      expect(fired).toBe(false);
      // Vitest's default: one second of checks, each moving the clock one interval.
      expect(Date.now() - before).toBeLessThanOrEqual(1_000 + INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
