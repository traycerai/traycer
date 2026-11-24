import { describe, expect, it, vi } from "vitest";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface PollEnd {
  readonly message: string;
  readonly beforeTestTimeout: boolean;
  readonly afterMs: number;
}

describe.each(KINDS)("$name", (kind) => {
  let noArrival: PollEnd | null = null;
  let lateStart: PollEnd | null = null;

  // The poll's timer is due before the test's, so the poll's rejection is
  // read while the test's signal is still unaborted, however late both run.
  async function recordEnd(
    signal: AbortSignal,
    record: (end: PollEnd) => void,
  ): Promise<void> {
    const started = Date.now();
    try {
      await kind.until(() => false, undefined);
    } catch (error) {
      record({
        message: error instanceof Error ? error.message : String(error),
        beforeTestTimeout: !signal.aborted,
        afterMs: Date.now() - started,
      });
      throw error;
    }
  }

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
    // A 200 ms poll checks at most once at the start and once per interval;
    // one stretched to its test would check about fifty times.
    expect(calls).toBeLessThanOrEqual(1 + 200 / INTERVAL_MS);
  });

  it.fails(
    "fails when nothing arrives",
    async ({ signal }) => {
      noArrival = null;
      await recordEnd(signal, (end) => {
        noArrival = end;
      });
    },
    NO_ARRIVAL_TEST_MS,
  );

  it("failed that poll with its own error at its test's timeout", () => {
    expect(noArrival).toMatchObject({
      message: expect.stringContaining(kind.ownError),
      beforeTestTimeout: true,
    });
    expect(noArrival?.afterMs).toBeGreaterThanOrEqual(NO_ARRIVAL_TEST_MS - 500);
  });

  it.fails(
    "fails a poll started late in its test",
    async ({ signal }) => {
      lateStart = null;
      await sleep(LATE_START_MS);
      await recordEnd(signal, (end) => {
        lateStart = end;
      });
    },
    NO_ARRIVAL_TEST_MS,
  );

  it("gave the late poll only what was left of its test", () => {
    // Given the test's whole timeout, the late poll would still be running
    // when the test timed out, and would end after the test's signal aborted.
    expect(lateStart).toMatchObject({
      message: expect.stringContaining(kind.ownError),
      beforeTestTimeout: true,
    });
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
