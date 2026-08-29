import { describe, expect, it } from "vitest";
import {
  FLEET_ACTIVE_POLL_MS,
  FLEET_IDLE_POLL_MS,
  fleetPollDelayMs,
} from "@/lib/host/fleet-update/fleet-poll-policy";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

// G10(b): `restarting` and `reconnecting` — the two views `phaseKind` produces
// from the SAME host phase depending on this client's own connectivity vantage
// — must earn the identical cadence. That equality is what makes
// `use-fleet-update-views.ts`'s cadence probe legitimate in pinning
// `connected: true` unconditionally: if the two lanes ever diverged, a probe
// that always claims `connected: true` would silently mispredict the
// `reconnecting` cadence.

function activeView(overrides: Partial<FleetUpdateView>): FleetUpdateView {
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: "downloading",
    qualified: false,
    ...overrides,
  };
}

describe("fleetPollDelayMs — restarting vs reconnecting", () => {
  it("both earn the ACTIVE cadence, not just one of them", () => {
    const restarting = activeView({ kind: "restarting" });
    const reconnecting = activeView({ kind: "reconnecting" });
    expect(fleetPollDelayMs(restarting)).toBe(FLEET_ACTIVE_POLL_MS);
    expect(fleetPollDelayMs(reconnecting)).toBe(FLEET_ACTIVE_POLL_MS);
  });

  it("the two cadences are the SAME NUMBER, not merely two numbers that happen to both be 'fast'", () => {
    const restarting = activeView({ kind: "restarting" });
    const reconnecting = activeView({ kind: "reconnecting" });
    expect(fleetPollDelayMs(restarting)).toBe(fleetPollDelayMs(reconnecting));
  });

  it("a QUALIFIED restarting/reconnecting view — evidence we cannot refresh — drops to the idle cadence, identically for both", () => {
    const restarting = activeView({ kind: "restarting", qualified: true });
    const reconnecting = activeView({ kind: "reconnecting", qualified: true });
    expect(fleetPollDelayMs(restarting)).toBe(FLEET_IDLE_POLL_MS);
    expect(fleetPollDelayMs(reconnecting)).toBe(FLEET_IDLE_POLL_MS);
  });
});
