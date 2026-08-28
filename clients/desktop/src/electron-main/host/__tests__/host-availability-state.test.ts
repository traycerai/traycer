import { describe, expect, it } from "vitest";
import {
  DEMOTE_AFTER_CONSECUTIVE_BUSY,
  foldHostAvailability,
  needsReprobe,
  INITIAL_HOST_AVAILABILITY_STATE,
  type HostAvailabilityState,
} from "../host-availability-state";
import type { PublishedHostPresence } from "../host-endpoint-reachability";

function fold(
  ...presences: readonly PublishedHostPresence[]
): HostAvailabilityState {
  return presences.reduce<HostAvailabilityState>(
    foldHostAvailability,
    INITIAL_HOST_AVAILABILITY_STATE,
  );
}

/**
 * The verdict policy from int #48, isolated from timers and the filesystem.
 *
 * Every case here is a statement about what the RENDERER is told, because that
 * is where the 2026-08-11 damage happened: a host answering RPCs in
 * milliseconds was reported as gone, and every chat it owned went read-only
 * for two hours.
 */
describe("foldHostAvailability", () => {
  it("publishes available as soon as the endpoint answers", () => {
    expect(fold("available")).toMatchObject({
      published: "available",
      degraded: false,
    });
  });

  it("holds available through a single busy observation (hysteresis)", () => {
    // One refused connect is a blip - host mid-GC, a full socket backlog, a
    // loopback probe that lost a race with a burst of per-request dials. It
    // must not be visible to the user at all.
    const state = fold("available", "busy");
    expect(state.published).toBe("available");
    // ...but it IS degraded, which is what keeps a re-probe scheduled. Reading
    // `published` alone here is how a held verdict becomes one nothing ever
    // revisits.
    expect(state.degraded).toBe(true);
    expect(needsReprobe(state)).toBe(true);
  });

  it("degrades to busy - never to absent - once failures corroborate", () => {
    const state = fold(
      "available",
      ...Array<PublishedHostPresence>(DEMOTE_AFTER_CONSECUTIVE_BUSY).fill(
        "busy",
      ),
    );
    expect(state.published).toBe("busy");
  });

  it("never reports absence for a live process, however long it stays busy", () => {
    // The load-bearing assertion of the whole ticket. A hundred consecutive
    // unanswered probes against a process that demonstrably exists still means
    // "there is a host here" - the only thing they prove is that it is slow.
    const state = fold(
      "available",
      ...Array<PublishedHostPresence>(100).fill("busy"),
    );
    expect(state.published).toBe("busy");
  });

  it("recovers on a single success, with no relaunch and no cooldown", () => {
    const busy = fold("available", "busy", "busy");
    expect(busy.published).toBe("busy");
    const recovered = foldHostAvailability(busy, "available");
    expect(recovered).toMatchObject({
      published: "available",
      consecutiveBusy: 0,
      degraded: false,
    });
    expect(needsReprobe(recovered)).toBe(false);
  });

  it("publishes busy immediately for a host that has never answered", () => {
    // Nothing to protect: there is no working session to shield, and claiming
    // a host answers when it has never been observed answering would be a lie
    // in the opposite direction.
    expect(fold("busy").published).toBe("busy");
  });

  it("reports absence immediately - a dead host is positive evidence, not a missed observation", () => {
    // The 2026-08-08 protection. A genuinely dead host must keep locking
    // promptly; hysteresis here would let tiles dial a corpse.
    expect(fold("available", "absent")).toEqual(
      INITIAL_HOST_AVAILABILITY_STATE,
    );
    expect(fold("available", "busy", "busy", "absent").published).toBeNull();
  });

  it("re-arms hysteresis after a recovery, so the next blip is absorbed too", () => {
    const state = fold("available", "busy", "busy", "available", "busy");
    expect(state.published).toBe("available");
    expect(state.consecutiveBusy).toBe(1);
  });
});
