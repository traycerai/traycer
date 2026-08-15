import { describe, expect, it } from "vitest";
import { createStreamRebuildBackoff } from "@/lib/host/stream-rebuild-backoff";

// Every case below dials ONE endpoint repeatedly unless it says otherwise;
// the identity is what scopes a streak, so holding it fixed is what makes
// these the same tests they were before the parameter existed.
const HOST = "host-a";

describe("createStreamRebuildBackoff", () => {
  it("recovers immediately from a single quick close", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0, HOST);

    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
  });

  it("doubles the delay from the second consecutive quick close", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0, HOST);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);

    backoff.markBuilt(200, HOST);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);

    backoff.markBuilt(400, HOST);
    expect(backoff.nextRebuildDelayMs(500)).toBe(2000);

    backoff.markBuilt(600, HOST);
    expect(backoff.nextRebuildDelayMs(700)).toBe(4000);
  });

  it("caps the delay at 30000ms no matter how long the streak runs", () => {
    const backoff = createStreamRebuildBackoff();
    backoff.markBuilt(0, HOST);

    let nowMs = 0;
    // The cap (30000) is reached well before ten quick closes; run enough of
    // them to prove the ceiling holds rather than merely approaching it.
    for (let i = 0; i < 10; i += 1) {
      nowMs += 100;
      backoff.nextRebuildDelayMs(nowMs);
      backoff.markBuilt(nowMs, HOST);
    }

    nowMs += 100;
    expect(backoff.nextRebuildDelayMs(nowMs)).toBe(30000);
  });

  it("resets the streak once a client lives at least 30000ms before closing", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0, HOST);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
    backoff.markBuilt(200, HOST);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);

    // This client survived >= 30000ms since it was built, so its close is a
    // healthy one and resets the streak.
    backoff.markBuilt(300, HOST);
    expect(backoff.nextRebuildDelayMs(30300)).toBe(0);

    // The streak restarts from zero: the very next quick close is still an
    // immediate rebuild, exactly like a fresh backoff instance.
    backoff.markBuilt(30400, HOST);
    expect(backoff.nextRebuildDelayMs(30500)).toBe(0);
    backoff.markBuilt(30600, HOST);
    expect(backoff.nextRebuildDelayMs(30700)).toBe(1000);
  });

  it("clears a streak built against one endpoint when the next build dials another", () => {
    const backoff = createStreamRebuildBackoff();

    // Host A is failing terminally: four quick closes, so the streak is well
    // past the point where a rebuild is paced.
    backoff.markBuilt(0, HOST);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
    backoff.markBuilt(200, HOST);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);
    backoff.markBuilt(400, HOST);
    expect(backoff.nextRebuildDelayMs(500)).toBe(2000);

    // Someone picks a different machine. Its first stumble is ITS first, not
    // host A's fourth - without the reset this would be 4000ms of unexplained
    // dead popover on a host that has done nothing wrong.
    backoff.markBuilt(600, "host-b");
    expect(backoff.nextRebuildDelayMs(700)).toBe(0);

    // The new endpoint then accrues its own streak from zero.
    backoff.markBuilt(800, "host-b");
    expect(backoff.nextRebuildDelayMs(900)).toBe(1000);
  });

  it("scopes the streak to the endpoint even when the pick returns to a bad host", () => {
    const backoff = createStreamRebuildBackoff();

    backoff.markBuilt(0, HOST);
    expect(backoff.nextRebuildDelayMs(100)).toBe(0);
    backoff.markBuilt(200, HOST);
    expect(backoff.nextRebuildDelayMs(300)).toBe(1000);

    backoff.markBuilt(400, "host-b");
    expect(backoff.nextRebuildDelayMs(500)).toBe(0);

    // Back to host A. The streak is not resumed - this instance keeps one
    // endpoint's history, not a per-host ledger, so returning starts over.
    // Stated as a test because it is a deliberate limit rather than an
    // oversight: the alternative is unbounded per-host state on a hook that
    // outlives no pick.
    backoff.markBuilt(600, HOST);
    expect(backoff.nextRebuildDelayMs(700)).toBe(0);
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
    backoff.markBuilt(150, HOST);
    expect(backoff.nextRebuildDelayMs(200)).toBe(1000);
  });
});
