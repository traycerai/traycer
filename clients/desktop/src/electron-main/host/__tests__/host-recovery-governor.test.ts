import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  BREAKER_MAX_CONSECUTIVE_GRANTS,
  RESPAWN_BACKOFF_MS,
  SUSTAINED_HEALTH_MS,
  createHostRecoveryGovernor,
  type HostProcessLiveness,
  type HostRecoveryGovernor,
} from "../host-recovery-governor";

const DEAD: HostProcessLiveness = "dead";

function makeGovernor(verdict: () => HostProcessLiveness): {
  governor: HostRecoveryGovernor;
  advance: (ms: number) => void;
} {
  let clock = 1_000_000;
  const governor = createHostRecoveryGovernor({
    readLiveness: () => Promise.resolve(verdict()),
    now: () => clock,
  });
  return {
    governor,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Drives `count` grants, waiting out each backoff. */
async function drainGrants(
  governor: HostRecoveryGovernor,
  advance: (ms: number) => void,
  count: number,
): Promise<number> {
  let granted = 0;
  for (let i = 0; i < count; i += 1) {
    const decision = await governor.requestRespawn("test");
    if (decision.kind === "granted") granted += 1;
    advance(RESPAWN_BACKOFF_MS[RESPAWN_BACKOFF_MS.length - 1]);
  }
  return granted;
}

describe("createHostRecoveryGovernor", () => {
  it("refuses to restart a host whose process exists, however long it stays unreachable", async () => {
    // THE invariant. An unreachable host may simply be busy, and the whole
    // incident this module exists for was a watchdog that could not tell the
    // difference and guessed "dead" every time.
    const { governor, advance } = makeGovernor(() => "alive");

    for (let i = 0; i < 20; i += 1) {
      const decision = await governor.requestRespawn("health-monitor");
      expect(decision).toEqual({ kind: "denied", reason: "alive" });
      advance(600_000);
    }
    // Refusals must not consume budget: the host was never at fault.
    expect(governor.isTripped).toBe(false);
  });

  it("never grants while the process exists, even after budget was spent on a dead one", async () => {
    let verdict: HostProcessLiveness = DEAD;
    const { governor, advance } = makeGovernor(() => verdict);

    await drainGrants(governor, advance, 2);
    verdict = "alive";

    const decision = await governor.requestRespawn("test");
    expect(decision.kind).toBe("denied");
    expect(decision.kind === "denied" && decision.reason).toBe("alive");
  });

  it("grants the first recovery immediately, then paces the rest", async () => {
    const { governor, advance } = makeGovernor(() => DEAD);

    expect((await governor.requestRespawn("first")).kind).toBe("granted");

    const tooSoon = await governor.requestRespawn("second");
    expect(tooSoon.kind).toBe("denied");
    expect(tooSoon.kind === "denied" && tooSoon.reason).toBe("backoff");

    advance(RESPAWN_BACKOFF_MS[1]);
    expect((await governor.requestRespawn("second")).kind).toBe("granted");
  });

  it("trips after the consecutive-grant limit - the breaker is actually reachable", async () => {
    // A window-based breaker ("N in M minutes") could never fire once the
    // backoff spaced grants beyond the window, so the promised "give up and
    // let the user decide" state never arrived. Counting consecutive grants
    // composes with any backoff.
    const { governor, advance } = makeGovernor(() => DEAD);

    const granted = await drainGrants(
      governor,
      advance,
      BREAKER_MAX_CONSECUTIVE_GRANTS,
    );
    expect(granted).toBe(BREAKER_MAX_CONSECUTIVE_GRANTS);

    const decision = await governor.requestRespawn("one too many");
    expect(decision).toEqual({ kind: "denied", reason: "tripped" });
    expect(governor.isTripped).toBe(true);
  });

  it("does not forgive the budget for a single healthy observation", async () => {
    // The exact re-arming bug: each freshly spawned host answered one probe
    // before stalling again, which reset the counter, so the loop was endless.
    const { governor, advance } = makeGovernor(() => DEAD);

    for (let i = 0; i < BREAKER_MAX_CONSECUTIVE_GRANTS; i += 1) {
      expect((await governor.requestRespawn("attempt")).kind).toBe("granted");
      governor.noteHealthy();
      governor.noteUnhealthy();
      advance(RESPAWN_BACKOFF_MS[RESPAWN_BACKOFF_MS.length - 1]);
    }

    expect((await governor.requestRespawn("attempt")).kind).toBe("denied");
    expect(governor.isTripped).toBe(true);
  });

  it("forgives the budget once the host stays healthy for the sustained window", async () => {
    const { governor, advance } = makeGovernor(() => DEAD);
    await drainGrants(governor, advance, BREAKER_MAX_CONSECUTIVE_GRANTS);
    expect((await governor.requestRespawn("trip it")).kind).toBe("denied");
    expect(governor.isTripped).toBe(true);

    // Continuous reachability across the window: real recovery.
    governor.noteHealthy();
    advance(SUSTAINED_HEALTH_MS);
    governor.noteHealthy();

    expect(governor.isTripped).toBe(false);
    expect((await governor.requestRespawn("after recovery")).kind).toBe(
      "granted",
    );
  });

  it("restarts the sustained-health clock when reachability breaks", async () => {
    const { governor, advance } = makeGovernor(() => DEAD);
    await drainGrants(governor, advance, BREAKER_MAX_CONSECUTIVE_GRANTS);

    // Healthy, but interrupted before the window elapses - a flapping host
    // must not accumulate credit across its outages.
    governor.noteHealthy();
    advance(SUSTAINED_HEALTH_MS / 2);
    governor.noteUnhealthy();
    governor.noteHealthy();
    advance(SUSTAINED_HEALTH_MS / 2);
    governor.noteHealthy();

    expect((await governor.requestRespawn("still flapping")).kind).toBe(
      "denied",
    );
  });

  it("refunds a grant that never became a restart", async () => {
    const { governor } = makeGovernor(() => DEAD);
    expect((await governor.requestRespawn("deferred")).kind).toBe("granted");

    // Another process held the CLI lock: nothing was restarted, so neither the
    // attempt count nor the backoff should be charged.
    governor.releaseGrant();

    expect((await governor.requestRespawn("retry")).kind).toBe("granted");
  });
});
