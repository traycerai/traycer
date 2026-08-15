import { describe, expect, it } from "vitest";
import { createStreamRebuildBackoff } from "@/lib/host/stream-rebuild-backoff";

describe("createStreamRebuildBackoff", () => {
  it("recovers immediately from a single quick close", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0);

    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
  });

  it("doubles the delay from the second consecutive quick close", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);

    backoff.markBuilt(200);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);

    backoff.markBuilt(400);
    expect(backoff.nextRebuildDelayMs(500)).toBe(2000);

    backoff.markBuilt(600);
    expect(backoff.nextRebuildDelayMs(700)).toBe(4000);
  });

  it("caps the delay at 30000ms no matter how long the streak runs", () => {
    const backoff = createStreamRebuildBackoff();
    backoff.markBuilt(0);

    let nowMs = 0;
    // The cap (30000) is reached well before ten quick closes; run enough of
    // them to prove the ceiling holds rather than merely approaching it.
    for (let i = 0; i < 10; i += 1) {
      nowMs += 100;
      backoff.nextRebuildDelayMs(nowMs);
      backoff.markBuilt(nowMs);
    }

    nowMs += 100;
    expect(backoff.nextRebuildDelayMs(nowMs)).toBe(30000);
  });

  it("resets the streak once a client lives at least 30000ms before closing", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
    backoff.markBuilt(200);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);

    // This client survived >= 30000ms since it was built, so its close is a
    // healthy one and resets the streak.
    backoff.markBuilt(300);
    expect(backoff.nextRebuildDelayMs(30300)).toBe(0);

    // The streak restarts from zero: the very next quick close is still an
    // immediate rebuild, exactly like a fresh backoff instance.
    backoff.markBuilt(30400);
    expect(backoff.nextRebuildDelayMs(30500)).toBe(0);
    backoff.markBuilt(30600);
    expect(backoff.nextRebuildDelayMs(30700)).toBe(1000);
  });

  it("treats a close before any markBuilt as a close since time zero", () => {
    const backoff = createStreamRebuildBackoff();

    // `builtAt` defaults to 0, so this first close is measured against time
    // zero exactly like a real client built at time zero would be: it is
    // close enough to zero to count as a quick close, but a single quick
    // close always rebuilds instantly regardless of streak.
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
    // The streak DID advance from that unmarked close - a second quick close
    // right after backs off, proving the first one was counted rather than
    // ignored for lack of a prior `markBuilt`.
    backoff.markBuilt(150);
    expect(backoff.nextRebuildDelayMs(200)).toBe(1000);
  });
});
