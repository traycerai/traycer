import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  QueryObserver,
  notifyManager,
  timeoutManager,
} from "@tanstack/react-query";
import {
  Rig,
  VARIANTS,
  checkAll,
  type RetryPolicy,
} from "@/lib/host/test-support/cloud-recovery-interleavings";
import { HeldTimers } from "@/lib/host/test-support/held-timers";
import { appLogger } from "@/lib/logger";

/**
 * The walk of the sweep's events is only as good as its guards: the held-timer
 * guard (G) and the invariants (A) to (F) must be able to fail. These cases
 * make each one fail on purpose, on the rig the walk uses.
 */

const timers = new HeldTimers();
const [DATA] = VARIANTS;

/** Runs `check` on a rig whose read is stranded, and disposes it. */
async function onStrandedRig(
  retry: RetryPolicy,
  check: (rig: Rig) => void | Promise<void>,
): Promise<void> {
  const rig = new Rig(DATA, retry, timers);
  try {
    await rig.strand();
    await check(rig);
  } finally {
    rig.dispose();
  }
}

/** A second observer of the rig's read, which never fetches, whose listener runs `listen`. */
function listenTo(rig: Rig, listen: () => void): () => void {
  const query = rig.current();
  if (query === undefined) throw new Error("the rig has no read");
  const observer = new QueryObserver(rig.client, {
    queryKey: query.queryKey,
    enabled: false,
  });
  return observer.subscribe(listen);
}

describe("the guards of the walk over the sweep's events", () => {
  beforeAll(() => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    timers.install();
  });
  afterAll(() => {
    timers.restore();
    vi.restoreAllMocks();
  });

  describe("(G) held timers and notifyManager", () => {
    it("is clean while only TanStack's own timers are held", async () => {
      await onStrandedRig("app", async (rig) => {
        await rig.run("startElsewhere");
        await rig.run("endTransient");

        expect(rig.unexpectedHold()).toBeNull();
      });
    });

    it("fails a callback handed to notifyManager", async () => {
      await onStrandedRig("off", async (rig) => {
        await rig.run("ring");
        notifyManager.schedule(() => undefined);

        expect(rig.unexpectedHold()).toContain("notifyManager");
      });
    });

    it("fails a timer set directly", async () => {
      await onStrandedRig("off", (rig) => {
        timeoutManager.setTimeout(() => undefined, 5);

        expect(rig.unexpectedHold()).toContain("(G)");
      });
    });

    it("fails a timer an observer's listener sets during a step", async () => {
      await onStrandedRig("off", async (rig) => {
        let notified = 0;
        const stop = listenTo(rig, () => {
          notified += 1;
          timeoutManager.setTimeout(() => undefined, 5);
        });
        try {
          await rig.run("ring");

          expect(notified).toBeGreaterThan(0);
          expect(rig.unexpectedHold()).toContain("(G)");
        } finally {
          stop();
        }
      });
    });

    it("fails a gc-length timer a cache listener sets while a gc fires", async () => {
      await onStrandedRig("off", async (rig) => {
        const stop = rig.client.getQueryCache().subscribe((event) => {
          if (event.type === "removed") {
            timeoutManager.setTimeout(() => undefined, 300_000);
          }
        });
        try {
          await rig.run("unobserve");
          await rig.run("gc");

          expect(rig.current()).toBeUndefined();
          expect(rig.unexpectedHold()).toContain("(G)");
        } finally {
          stop();
        }
      });
    });

    it("fails a timer a listener sets in a retry flow, and still fires the real retry", async () => {
      await onStrandedRig("app", async (rig) => {
        let strays = 0;
        let listened = false;
        const stop = listenTo(rig, () => {
          const failures = rig.current()?.state.fetchFailureCount ?? 0;
          if (failures < 1 || listened) return;
          listened = true;
          timeoutManager.setTimeout(() => {
            strays += 1;
          }, 5);
        });
        try {
          await rig.run("startElsewhere");
          await rig.run("endTransient");

          expect(listened).toBe(true);
          expect(rig.inBackoff()).toHaveLength(1);
          expect(rig.unexpectedHold()).toContain("(G)");
          expect(rig.enabled(["backoffEnds"])).toEqual(["backoffEnds"]);

          await rig.run("backoffEnds");

          expect(rig.attempts.at(-1)?.tries).toBe(2);
          expect(strays).toBe(0);
        } finally {
          stop();
        }
      });
    });
  });

  describe("the invariants", () => {
    /** An attempt record, which the cases tamper a clean rig with. */
    const attempt = (
      overrides: Partial<Rig["attempts"][number]>,
    ): Rig["attempts"][number] => ({
      id: 90,
      readId: 0,
      start: 1,
      context: "test:startElsewhere",
      sweepStarted: false,
      tries: 1,
      backoff: false,
      end: null,
      current: null,
      ...overrides,
    });

    it("pass on the stranded read", async () => {
      await onStrandedRig("off", (rig) => {
        expect(checkAll(rig)).toBeNull();
      });
    });

    it("(A) fails an attempt aborted from outside a test step or a ring", async () => {
      await onStrandedRig("off", (rig) => {
        rig.attempts.push(
          attempt({ end: { kind: "aborted", at: 2, context: "spend" } }),
        );

        expect(checkAll(rig)).toContain("(A)");
      });
    });

    it("(F) fails a ring that ended an attempt the sweep started", async () => {
      await onStrandedRig("off", (rig) => {
        rig.rings.push({
          n: 0,
          at: 5,
          readId: 0,
          arrival: "failed",
          attempt: null,
        });
        rig.attempts.push(
          attempt({
            context: "spend",
            sweepStarted: true,
            end: { kind: "aborted", at: 6, context: "ring:0" },
          }),
        );

        expect(checkAll(rig)).toContain("(F)");
      });
    });

    it("(C) fails more sweep attempts than rings that reached the read", async () => {
      await onStrandedRig("off", (rig) => {
        rig.attempts.push(attempt({ context: "ring:0", sweepStarted: true }));

        expect(checkAll(rig)).toContain("(C)");
      });
    });

    it("(E) fails an attempt the sweep started that spends no ring", async () => {
      await onStrandedRig("off", (rig) => {
        rig.rings.push({
          n: 0,
          at: 1,
          readId: 0,
          arrival: "other",
          attempt: null,
        });
        rig.attempts.push(attempt({ context: "spend", sweepStarted: true }));

        expect(checkAll(rig)).toContain("(E)");
      });
    });

    it("(B) fails a ring that met a failed read and was never asked", async () => {
      await onStrandedRig("off", (rig) => {
        rig.rings.push({
          n: 0,
          at: 99,
          readId: rig.currentReadId(),
          arrival: "failed",
          attempt: null,
        });

        expect(checkAll(rig)).toContain("(B)");
      });
    });
  });
});
