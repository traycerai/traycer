import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCredentialMintOutcome } from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import {
  appHostCredentialMintFlow,
  noteHostCredentialState,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "../host-credential-provisioning";

afterEach(() => {
  setHostCredentialMintRunner(null);
  resetHostCredentialProvisioning();
});

function provisionedOutcome(): HostCredentialMintOutcome {
  return {
    kind: "provisioned",
    token: "tok",
    refreshToken: "ref",
    familyId: "family-1",
    provisionedAt: "2026-07-08T12:00:00.000Z",
    expiresIn: 900,
  };
}

describe("appHostCredentialMintFlow single-flight policy", () => {
  it("resolves unavailable when no runner is installed", async () => {
    const outcome = await appHostCredentialMintFlow({
      hostId: "host-1",
      reason: "missing",
    });
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("collapses concurrent notices for the same host into ONE runner call", async () => {
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const a = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "missing",
    });
    const b = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "missing",
    });
    const c = appHostCredentialMintFlow({
      hostId: "host-shared",
      reason: "needs-reauth",
    });

    expect(runner).toHaveBeenCalledTimes(1);

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    const results = await Promise.all([a, b, c]);
    // Single delivery: exactly one joiner receives the credential.
    expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
    // Joiners now get `pending-elsewhere`: a credential WAS minted for this
    // host, so nothing they asked for failed and they must not spend their one
    // attempt on it.
    expect(results.filter((r) => r.kind === "pending-elsewhere")).toHaveLength(
      2,
    );
    expect(results.find((r) => r.kind === "provisioned")).toEqual(
      provisionedOutcome(),
    );
  });

  it("hands the provisioned credential to exactly one of N joiners", async () => {
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const joiners = Array.from({ length: 5 }, () =>
      appHostCredentialMintFlow({ hostId: "host-once", reason: "missing" }),
    );
    expect(runner).toHaveBeenCalledTimes(1);

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    const results = await Promise.all(joiners);
    expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "pending-elsewhere")).toHaveLength(
      4,
    );
  });

  it("tells a joiner that did not win what is LEFT of the winner's claim", async () => {
    // The THIRD `pending-elsewhere` producer - the per-caller claim gate,
    // distinct from the stale-ask branch and the ladder. The tests above
    // exercise it but only count `kind`, so a regression returning 0 (spin
    // before delivery could land) or the full TTL (idle a host through a
    // claim already partly spent) passed all of them.
    //
    // The wait matters most exactly here: if the winner closes before
    // delivering, the transport drops the credential and nothing else wakes
    // these joiners, so re-asking as the claim lapses is the only thing that
    // keeps the last surviving transport from stranding.
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
      promise: Promise<HostCredentialMintOutcome> | null;
    } = { resolve: null, promise: null };
    const runner = vi.fn(() => {
      const promise = new Promise<HostCredentialMintOutcome>((resolve) => {
        deferred.resolve = resolve;
      });
      deferred.promise = promise;
      return promise;
    });
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    let clock = realNow();
    try {
      const start = clock;
      Date.now = () => clock;

      const joiners = Array.from({ length: 3 }, () =>
        appHostCredentialMintFlow({
          hostId: "host-joiner-wait",
          reason: "missing",
        }),
      );
      expect(runner).toHaveBeenCalledTimes(1);

      // Advance the clock BETWEEN the winner stamping its adoption claim and
      // the joiners reading what is left of it. Elapsed time is the whole
      // point: with a frozen clock the remainder equals the full TTL, and
      // the assertion below could not tell a correct answer apart from a
      // producer that ignores how much of the claim is already spent - which
      // is exactly the regression it exists to catch.
      //
      // The two hops are load-bearing and deliberately match the flow's own
      // chain, `runner().catch().then(register)`. One hop lands BEFORE
      // registration and stamps the claim at the advanced time, which yields
      // the full TTL and looks like a passing-but-vacuous assertion; two
      // land after it and before the per-caller gates, which run on the
      // promise registration resolves.
      //
      // This is coupled to that chain's length, and that is an accepted
      // trade: if a hop is ever added or removed the advance lands on the
      // wrong side and this test FAILS loudly with the full TTL rather than
      // silently going vacuous. Read a 60_000 here as "the chain moved",
      // not as "the producer is fine".
      const runnerPromise = deferred.promise;
      if (runnerPromise === null) {
        throw new Error("runner promise was never captured");
      }
      void runnerPromise
        .then(() => undefined)
        .then(() => {
          clock = start + 8_000;
        });

      const resolveRunner = deferred.resolve;
      if (resolveRunner === null) {
        throw new Error("runner was never started");
      }
      resolveRunner(provisionedOutcome());

      const results = await Promise.all(joiners);
      expect(results.filter((r) => r.kind === "provisioned")).toHaveLength(1);
      const losers = results.filter((r) => r.kind === "pending-elsewhere");
      expect(losers).toHaveLength(2);
      for (const loser of losers) {
        expect(loser).toEqual({
          kind: "pending-elsewhere",
          retryAfterMs: 52_000,
        });
      }
    } finally {
      Date.now = realNow;
    }
  });

  it("generation-scopes an in-flight attempt across reset (sign-out) so it resolves unavailable, not handed to the next identity", async () => {
    const deferred: {
      resolve: ((outcome: HostCredentialMintOutcome) => void) | null;
    } = { resolve: null };
    const runner = vi.fn(
      () =>
        new Promise<HostCredentialMintOutcome>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    setHostCredentialMintRunner(runner);

    const inFlight = appHostCredentialMintFlow({
      hostId: "host-gen",
      reason: "missing",
    });
    expect(runner).toHaveBeenCalledTimes(1);

    resetHostCredentialProvisioning();

    const resolveRunner = deferred.resolve;
    if (resolveRunner === null) {
      throw new Error("runner was never started");
    }
    resolveRunner(provisionedOutcome());

    await expect(inFlight).resolves.toEqual({ kind: "unavailable" });

    // Not poisoned: a fresh attempt for the same host is offered again under
    // the new generation, and gets its own runner call.
    const after = appHostCredentialMintFlow({
      hostId: "host-gen",
      reason: "missing",
    });
    const resolveAfter = deferred.resolve;
    if (resolveAfter === null) {
      throw new Error("post-reset runner was never started");
    }
    expect(runner).toHaveBeenCalledTimes(2);
    resolveAfter(provisionedOutcome());
    await expect(after).resolves.toEqual(provisionedOutcome());
  });

  it("does not memoize a settled outcome — a later call for the same host re-invokes the runner", async () => {
    // Provisioning is no longer step-up gated and there is no decline memo:
    // an attempt that already settled must not stop a later transport from
    // trying again (e.g. a transient network error on first connect should
    // not strand a host on the client lease for the rest of the app run).
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("does not single-flight across different hostIds", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await Promise.all([
      appHostCredentialMintFlow({ hostId: "host-a", reason: "missing" }),
      appHostCredentialMintFlow({ hostId: "host-b", reason: "missing" }),
    ]);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("maps a thrown runner to unavailable and still frees the host for a later attempt", async () => {
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.reject(new Error("mint crashed")),
    );
    setHostCredentialMintRunner(runner);

    await expect(
      appHostCredentialMintFlow({ hostId: "host-1", reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(runner).toHaveBeenCalledTimes(1);
  });
});

/**
 * The window between a mint SETTLING and the host actually adopting the
 * credential.
 *
 * `attemptsByHostId` is cleared the moment the mint resolves, but the
 * credential still has to ride a live socket to the host. In between, the app
 * looks to any newly-constructed transport exactly as it does before a first
 * mint - and a per-`WsStreamClient` "already attempted" set cannot close this,
 * because a fresh client starts with an empty one and the renderer routinely
 * builds several against one host. Two mints then race, and the server
 * supersedes older credentials on every mint, so they can revoke one another
 * and leave the host holding nothing at all.
 */
describe("appHostCredentialMintFlow adoption claim", () => {
  it("refuses a second mint while a freshly minted credential is still in flight", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start;

      // Transport 1 mints and receives the credential; the host has NOT adopted
      // it yet, so it is still reporting `needs-reauth` on any ack in flight.
      const first = await appHostCredentialMintFlow({
        hostId: "host-adopting",
        reason: "needs-reauth",
      });
      expect(first.kind).toBe("provisioned");
      expect(runner).toHaveBeenCalledTimes(1);

      // A DIFFERENT transport - fresh instance, empty per-instance bookkeeping -
      // sees that same stale `needs-reauth` a second into the claim and asks.
      Date.now = () => start + 1_000;
      const second = await appHostCredentialMintFlow({
        hostId: "host-adopting",
        reason: "needs-reauth",
      });

      // `pending-elsewhere`, NOT `unavailable`: the second transport has not
      // spent its one attempt on this, because nothing was attempted and nothing
      // failed - a delivery is simply already in flight. retryAfterMs is what
      // is LEFT of the 60s claim (59s) - a caller trusting the full TTL here
      // would idle a host through a claim that is already partly spent, and
      // one trusting a stray 0 would spin before delivery had any chance to
      // land.
      expect(second).toEqual({
        kind: "pending-elsewhere",
        retryAfterMs: 59_000,
      });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("allows the next mint once the claim's TTL has passed", async () => {
    // The claim must not become a latch. This used to be driven by an `active`
    // report; that release is gone (see `noteHostCredentialState`) because the
    // report carries nothing to correlate it with, so the TTL is now the only
    // thing that ends a claim.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    try {
      await appHostCredentialMintFlow({
        hostId: "host-cycle",
        reason: "needs-reauth",
      });
      expect(runner).toHaveBeenCalledTimes(1);

      Date.now = () => realNow() + 61_000;
      await appHostCredentialMintFlow({
        hostId: "host-cycle",
        reason: "needs-reauth",
      });
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not release the claim on a repeated needs-reauth ack", async () => {
    // A host still asking is not proof of delivery - its ask may simply
    // predate the credential now on its way. Under the TTL-only design NO
    // report releases a claim (`noteHostCredentialState` is inert); `active`
    // is pinned separately below because it is the one report that looks like
    // proof of delivery and still is not.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-still-asking",
      reason: "needs-reauth",
    });
    noteHostCredentialState("host-still-asking", "needs-reauth");
    noteHostCredentialState("host-still-asking", "missing");

    await appHostCredentialMintFlow({
      hostId: "host-still-asking",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("a held claim answers pending-elsewhere whatever state the host reports", async () => {
    // Requirement (1) of the TTL-only design: while a claim is held, no
    // transport may mint - and none may be told `unavailable` either, or it
    // burns its attempt on a claim it had no part in.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start;
      await appHostCredentialMintFlow({
        hostId: "host-held",
        reason: "needs-reauth",
      });
      expect(runner).toHaveBeenCalledTimes(1);

      // Both reasons probe the SAME held claim at the SAME instant, so both
      // owe the SAME remainder of the 60s claim (10s elapsed -> 50s left) -
      // the reason on the ask does not reset or extend someone else's claim.
      Date.now = () => start + 10_000;
      for (const reason of ["missing", "needs-reauth"] as const) {
        expect(
          await appHostCredentialMintFlow({ hostId: "host-held", reason }),
        ).toEqual({ kind: "pending-elsewhere", retryAfterMs: 50_000 });
      }
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("an active report does NOT release the claim - only the TTL does", async () => {
    // The double-mint sequence this closes needs no account switch: sockets
    // report their `openAck` state independently with no cross-socket
    // ordering, so a delayed `active(A)` observed before A was burned can be
    // delivered after B was minted. Released on that, B's claim vanishes and a
    // third socket's already-formed `needs-reauth` mints C, superseding B.
    // With nothing on the report to correlate against, it is not trusted.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start;
      await appHostCredentialMintFlow({
        hostId: "host-stale-active",
        reason: "needs-reauth",
      });

      noteHostCredentialState("host-stale-active", "active");

      // retryAfterMs still tracks the ORIGINAL claim's remainder (60s minus
      // the 5s elapsed) - the stale `active` neither released the claim nor
      // re-armed it with a fresh 60s.
      Date.now = () => start + 5_000;
      expect(
        await appHostCredentialMintFlow({
          hostId: "host-stale-active",
          reason: "needs-reauth",
        }),
      ).toEqual({ kind: "pending-elsewhere", retryAfterMs: 55_000 });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("expires the claim after the TTL so a stalled delivery cannot strand the host", async () => {
    // The liveness half. T1 mints and dies before delivery; if the claim never
    // expired, and the only surviving transport had already asked, the host
    // would sit on the client lease until the app restarted.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    const realNow = Date.now;
    try {
      await appHostCredentialMintFlow({
        hostId: "host-stalled",
        reason: "needs-reauth",
      });
      expect(runner).toHaveBeenCalledTimes(1);

      Date.now = () => realNow() + 61_000;
      await appHostCredentialMintFlow({
        hostId: "host-stalled",
        reason: "needs-reauth",
      });
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not honour a claim left over from a superseded generation", async () => {
    // The half of the stale-`active` problem that IS closable here: a claim is
    // only ever honoured for the generation it was taken under, so nothing
    // from a previous account can block the current one's mint.
    //
    // The other half is NOT fixed and cannot be from this module -
    // `onHostCredentialState(hostId, state)` carries no provenance, so a
    // delayed `active` produced before a burn/account-switch is
    // indistinguishable from a fresh one and will still release a current
    // claim. Closing that needs the report to carry which credential it is
    // about, across the shared-transport boundary. Recorded here rather than
    // asserted away.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-generations",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(1);

    resetHostCredentialProvisioning();
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-generations",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("does not hold a claim for a mint that produced no credential", async () => {
    // Nothing is in flight after an `unavailable`, so nothing should be
    // waited for - a failed attempt must stay retryable by a later transport.
    const runner = vi.fn((): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
    );
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-failed",
      reason: "missing",
    });
    await appHostCredentialMintFlow({
      hostId: "host-failed",
      reason: "missing",
    });

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("a sign-out reset clears an outstanding claim", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    await appHostCredentialMintFlow({
      hostId: "host-reset",
      reason: "needs-reauth",
    });

    resetHostCredentialProvisioning();
    setHostCredentialMintRunner(runner);

    await appHostCredentialMintFlow({
      hostId: "host-reset",
      reason: "needs-reauth",
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

/**
 * The escalation ladder between COMPLETED mints for one host.
 *
 * The re-arm edge (`ws-stream-client` clears its per-host attempt marker on
 * every transition back into `missing`/`needs-reauth`) makes the silent mint
 * repeatable on purpose - a burn must be repairable more than once per app
 * run. Left ungoverned beyond the 60s adoption TTL, a cloud that persistently
 * refuses delegated credentials cycles mint -> adopt -> refuse -> burn ->
 * re-arm at that 60s floor indefinitely. Each COMPLETED mint instead doubles
 * the wait before the next one is allowed - 2m after the 2nd completed mint,
 * 4m, 8m, ... capped at an hour (`mintBackoffWaitMs`:
 * `completedMints <= 1 -> 0`, else `60_000 * 2 ** (completedMints - 1)`,
 * capped at `MINT_BACKOFF_MAX_MS`).
 *
 * The quiet-period mechanism is DECAY, not a full reset: every full 30-minute
 * quiet window (`MINT_BACKOFF_QUIET_DECAY_MS`) removes exactly one rung
 * (`completedMints -= decayedRungs`, `lastMintedAt` advanced by the decayed
 * windows), and the REMAINING rung is re-checked against its own wait from
 * that advanced timestamp - a high rung can still be in backoff right after a
 * decay if its own wait has not elapsed yet. A fixed, per-rung decay (rather
 * than the old design's reset-to-zero on a threshold that scaled with the
 * current wait) is what stops a flap slower than that scaling threshold from
 * farming a full reset and pinning itself at rung one forever.
 *
 * Every test here uses fake timers rather than the `Date.now = ...` override
 * the suites above use, because several of them need to advance PAST the 60s
 * adoption-claim TTL while staying INSIDE (or outside) the ladder's own,
 * independently-sized window - the two must be told apart deliberately, not
 * left to coincide.
 */
describe("appHostCredentialMintFlow mint escalation ladder", () => {
  it("imposes no extra wait after the first completed mint, then escalates 120s -> 240s", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    vi.useFakeTimers();
    try {
      const hostId = "host-ladder";
      vi.setSystemTime(0);

      // 1st mint: completedMints becomes 1, and the ladder demands nothing
      // extra for the very next attempt (`completedMints <= 1 -> 0` wait).
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(1);

      // Past the 60s adoption claim, and the ladder still imposes no extra
      // wait of its own - straight through to the runner.
      vi.setSystemTime(60_001);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(2);
      // completedMints is now 2: the ladder's NEXT wait is 120s
      // (60_000 * 2 ** (2 - 1)).

      // One millisecond short of the ladder opening, so retryAfterMs is 1 -
      // the LADDER's remainder, not the adoption claim's, which expired
      // 60s ago. Pinning the number is what tells those two apart; a bare
      // `kind` check reads the same either way.
      vi.setSystemTime(60_001 + 120_000 - 1);
      await expect(
        appHostCredentialMintFlow({ hostId, reason: "missing" }),
      ).resolves.toEqual({ kind: "pending-elsewhere", retryAfterMs: 1 });
      expect(runner).toHaveBeenCalledTimes(2);

      vi.setSystemTime(60_001 + 120_000);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(3);
      // completedMints is now 3: the wait DOUBLES to 240s
      // (60_000 * 2 ** (3 - 1)).
      const thirdMintAt = 60_001 + 120_000;

      // Past the 60s adoption claim (which alone would already have cleared)
      // but still inside the ladder's 240s wait - isolating the ladder from
      // the adoption claim, since only the ladder can still be blocking here.
      vi.setSystemTime(thirdMintAt + 150_000);
      await expect(
        appHostCredentialMintFlow({ hostId, reason: "missing" }),
        // 240s wait, 150s of it spent: 90s left. A regression handing back
        // the FULL rung wait here would idle the caller for another 240s,
        // and one handing back 0 would spin it against a closed ladder.
      ).resolves.toEqual({ kind: "pending-elsewhere", retryAfterMs: 90_000 });
      expect(runner).toHaveBeenCalledTimes(3);

      vi.setSystemTime(thirdMintAt + 240_000);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ~3-minute flap cadence still climbs every reachable rung rather than resetting", async () => {
    // Contrast with the OLD design: a threshold that scaled with the current
    // wait (`max(wait, 60s) * 2`) could be out-waited by a sufficiently slow
    // flap, silently resetting completedMints back to zero on every cycle and
    // pinning the ladder at rung one forever. The fixed 30-minute decay
    // window cannot be farmed the same way by a cadence this fast - none of
    // these gaps (at most 4 minutes) come anywhere near 30 minutes, so no
    // decay fires and every completed mint climbs the ladder exactly on
    // schedule.
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    vi.useFakeTimers();
    try {
      const hostId = "host-ladder-flap";
      // Required wait before each successive mint (mintBackoffWaitMs of the
      // PRIOR completedMints): 1 -> 0, 2 -> 120s, 3 -> 240s, 4 -> 480s.
      // Flap just past each one - never long enough to approach the 30-minute
      // decay window.
      const requiredWaits = [0, 120_000, 240_000, 480_000];
      let now = 0;
      vi.setSystemTime(now);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      let calls = 1;
      expect(runner).toHaveBeenCalledTimes(calls);

      for (const wait of requiredWaits) {
        now += Math.max(wait, 60_000) + 1;
        vi.setSystemTime(now);
        await appHostCredentialMintFlow({ hostId, reason: "missing" });
        calls += 1;
        expect(runner).toHaveBeenCalledTimes(calls);
      }
      // completedMints is now 5, having climbed every rung without ever
      // being reset back to 1 by the interim gaps.
    } finally {
      vi.useRealTimers();
    }
  });

  it("decays exactly one rung per full 30-minute quiet window, and does not admit until the decayed rung's OWN wait also elapses", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    vi.useFakeTimers();
    try {
      const hostId = "host-ladder-decay";
      // Climb to completedMints === 6 using gaps that never approach the
      // 30-minute decay window: required waits 0, 120s, 240s, 480s, 960s.
      const requiredWaits = [0, 120_000, 240_000, 480_000, 960_000];
      let now = 0;
      vi.setSystemTime(now);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      let calls = 1;
      expect(runner).toHaveBeenCalledTimes(calls);
      for (const wait of requiredWaits) {
        now += Math.max(wait, 60_000) + 1;
        vi.setSystemTime(now);
        await appHostCredentialMintFlow({ hostId, reason: "missing" });
        calls += 1;
        expect(runner).toHaveBeenCalledTimes(calls);
      }
      // completedMints is now 6. Its ladder wait would be
      // 60_000 * 2 ** 5 = 1_920_000ms - MORE than the 1_800_000ms decay
      // window, so decay always intervenes before that raw wait is ever
      // satisfied: at 1_800_000ms elapsed, one rung decays away
      // (completedMints -> 5, its clock advanced to the decay boundary), and
      // THAT rung's own wait (960_000ms) governs from there.
      const sixthMintAt = now;

      // Just short of the decay window: no decay yet, and the raw (undecayed)
      // wait for rung 6 (1_920_000ms) is nowhere close to satisfied either.
      vi.setSystemTime(sixthMintAt + 1_800_000 - 1);
      await expect(
        appHostCredentialMintFlow({ hostId, reason: "missing" }),
        // Rung 6's UNDECAYED wait (1_920_000) minus the 1_799_999 elapsed.
        // This is the one of the three that reads the pre-decay entry, so
        // it is also the one that would silently change if decay ever fired
        // a millisecond early.
      ).resolves.toEqual({ kind: "pending-elsewhere", retryAfterMs: 120_001 });
      expect(runner).toHaveBeenCalledTimes(calls);

      // Exactly at the decay window: one rung decays (6 -> 5), but the
      // decayed rung's own wait (960_000ms) has had ZERO time to elapse from
      // its advanced clock - decaying must not double as admission.
      vi.setSystemTime(sixthMintAt + 1_800_000);
      await expect(
        appHostCredentialMintFlow({ hostId, reason: "missing" }),
        // The FULL 960_000 of the decayed rung, because `mintInBackoff`
        // rewrites the entry's clock to the decay boundary before
        // `remainingBackoffMs` reads it - so the decayed rung's wait starts
        // here rather than being partly spent. This number is the sharpest
        // statement of "decaying is not admission": had decay doubled as
        // admission the call would not be `pending-elsewhere` at all, and
        // had it left the clock alone the remainder would be 0.
      ).resolves.toEqual({ kind: "pending-elsewhere", retryAfterMs: 960_000 });
      expect(runner).toHaveBeenCalledTimes(calls);

      // Still short of the decayed rung's own 960_000ms wait.
      vi.setSystemTime(sixthMintAt + 1_800_000 + 960_000 - 1);
      await expect(
        appHostCredentialMintFlow({ hostId, reason: "missing" }),
        // 1ms left of the decayed rung. Note this depends on the assertion
        // ABOVE having already run: that call is what persisted the decayed
        // entry, so the remainder here is measured from the decay boundary
        // rather than from the sixth mint. Reordering these two would change
        // this number, which is the point of writing it down.
      ).resolves.toEqual({ kind: "pending-elsewhere", retryAfterMs: 1 });
      expect(runner).toHaveBeenCalledTimes(calls);

      // Now the decayed rung's own wait has elapsed too: admitted. This is
      // also the ladder's practical ceiling under this arithmetic - the mint
      // that lands here increments the (already-decayed) completedMints of 5
      // back to 6, never organically past it, because any rung whose raw
      // wait exceeds the fixed decay window is unreachable by waiting alone
      // (decay always fires first and knocks it back down).
      vi.setSystemTime(sixthMintAt + 1_800_000 + 960_000);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      calls += 1;
      expect(runner).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetHostCredentialProvisioning clears the ladder", async () => {
    const runner = vi.fn(() => Promise.resolve(provisionedOutcome()));
    setHostCredentialMintRunner(runner);
    vi.useFakeTimers();
    try {
      const hostId = "host-ladder-app-reset";
      vi.setSystemTime(0);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(1);

      vi.setSystemTime(60_001);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(2);
      // completedMints is now 2: an un-reset ladder would demand a further
      // 120s (on top of the 60s adoption claim) before the next mint.

      resetHostCredentialProvisioning();
      setHostCredentialMintRunner(runner);

      // Barely past the 60s adoption claim the reset mint itself set - if the
      // ladder had survived the reset this would still be well short of its
      // 120s wait and resolve `pending-elsewhere` with no runner call.
      vi.setSystemTime(60_001 + 1);
      await appHostCredentialMintFlow({ hostId, reason: "missing" });
      expect(runner).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
