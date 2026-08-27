import { describe, expect, it } from "vitest";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionKindLabel,
  hostOptionStatusWord,
  hostOptionUpdateBadge,
  isHostOptionSelectable,
} from "@/components/settings/host-scope/host-option-model";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The picker row's status word, which had NO coverage at all — and that is
 * half of why it survived P3.4's vocabulary census as a third, unnamed status
 * vocabulary.
 *
 * What it used to do was answer a ROUTE question in STATUS words: `connectable`
 * decided whether to speak, and the word was `unreachable` or `requires
 * upgrade`. The incoherence that produced is the reason this file exists: a
 * registry-only host whose health line read "Reported reachable" carried the
 * word "unreachable" in the same row, because two layers were answering
 * different questions in one voice.
 *
 * The split ruled for this pass: ROUTE decides interactivity
 * (`isHostOptionSelectable`), STATUS decides words (`hostOptionStatusWord`,
 * keyed on the lease-derived `health.state`). Both halves are pinned here, and
 * the crossing test at the bottom is the one that would have caught the
 * original defect.
 */

function option(overrides: {
  readonly state?: HostHealthState;
  readonly settingUp?: boolean;
  readonly connectable?: boolean;
  readonly planRestricted?: boolean;
}) {
  return hostScopeOptionFixture({
    hostId: "host-a",
    settingUp: overrides.settingUp ?? false,
    connectable: overrides.connectable ?? true,
    planRestricted: overrides.planRestricted ?? false,
    health: {
      state: overrides.state ?? "online",
      label: "irrelevant to the word",
      detail: null,
      tone: "idle",
      live: false,
    },
  });
}

describe("hostOptionStatusWord — the row speaks the health vocabulary", () => {
  it.each([
    ["restarting", "restarting"],
    ["offline", "offline"],
    ["local-only", "requires upgrade"],
    ["update-required", "update required"],
    ["removed", "removed"],
    ["stopped", "stopped"],
    ["not-installed", "not installed"],
  ] as const)("says %s → %s", (state, word) => {
    expect(
      hostOptionStatusWord(option({ state }), AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe(word);
  });

  /**
   * Silence is a decision here, not a gap, and each of the four has its own
   * reason — which is why they are asserted rather than left to the absence of
   * a test.
   */
  it.each([
    // Nothing to add: the dot carries it.
    ["online"],
    // Pickable and will dial. The muted dot already withholds the liveness
    // claim (F26); a word would turn a nuance into a warning.
    ["reported-reachable"],
    // A blind cloud read is not something a person acts on from a picker.
    ["unknown"],
    // A WINDOW-scope fact the global narrator owns — repeating it on every
    // row is the layered-narration class this epic deletes.
    ["viewer-offline"],
  ] as const)("stays silent for %s", (state) => {
    expect(
      hostOptionStatusWord(option({ state }), AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBeNull();
  });

  /**
   * M5, ruled at P3.1. A machine mid-install is not "offline" in any sense a
   * person can act on, and `settingUp` is a MUTATION-LANE fact rather than a
   * status one — which is why it sits outside the table instead of in it.
   */
  it("lets setting up outrank every health state", () => {
    expect(
      hostOptionStatusWord(
        option({ state: "offline", settingUp: true }),
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      ),
    ).toBe("setting up");
    expect(
      hostOptionStatusWord(
        option({ state: "online", settingUp: true }),
        AVAILABLE_HOST_ROW_SURFACE_STATE,
      ),
    ).toBe("setting up");
  });

  /**
   * THE regression, stated directly.
   *
   * A registry-only host: the account reports it reachable, this client has no
   * route to it. The old word for that row was "unreachable" while its health
   * line said "Reported reachable" — one row, two vocabularies, contradicting
   * each other. The row is now silent about the route and INERT for the intents
   * where picking it could only fail, which is the ruled partition.
   */
  it("no longer contradicts its own health line on an undialable reported-reachable host", () => {
    const host = option({ state: "reported-reachable", connectable: false });

    expect(
      hostOptionStatusWord(host, AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBeNull();
    expect(
      hostOptionStatusWord(host, AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).not.toBe("unreachable");
    // The refusal is carried by legality, not by a word.
    expect(
      isHostOptionSelectable(host, "bind", AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe(false);
    expect(
      isHostOptionSelectable(host, "pin", AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe(false);
    // ...and viewing it is still legal: that is how you get back to it.
    expect(
      isHostOptionSelectable(host, "view", AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe(true);
  });

  /**
   * Route and status are now INDEPENDENT, which is the whole ruling. The word
   * must not move when only dialability moves.
   */
  it("keeps the word fixed to health while the route varies underneath it", () => {
    for (const connectable of [true, false]) {
      expect(
        hostOptionStatusWord(
          option({ state: "offline", connectable }),
          AVAILABLE_HOST_ROW_SURFACE_STATE,
        ),
      ).toBe("offline");
      expect(
        hostOptionStatusWord(
          option({ state: "online", connectable }),
          AVAILABLE_HOST_ROW_SURFACE_STATE,
        ),
      ).toBeNull();
    }
  });

  /**
   * `local-only` names the REMEDY, not the symptom. One word covering both
   * this and `offline` is what sent free-tier users to debug a network fault
   * over a billing limit — and it must not depend on the client-side
   * `planRestricted` flag, which is only one of the two ways to learn it.
   */
  it("names the upgrade for local-only regardless of the client-side plan flag", () => {
    for (const planRestricted of [true, false]) {
      expect(
        hostOptionStatusWord(
          option({ state: "local-only", planRestricted }),
          AVAILABLE_HOST_ROW_SURFACE_STATE,
        ),
      ).toBe("requires upgrade");
    }
  });
});

describe("hostOptionKindLabel — unchanged, and deliberately route-side", () => {
  it("names this machine", () => {
    expect(
      hostOptionKindLabel(
        hostScopeOptionFixture({ hostId: "host-a", isLocalMachine: true }),
      ),
    ).toBe("This machine");
  });

  it("falls back to Host when no directory entry says otherwise", () => {
    expect(
      hostOptionKindLabel(
        hostScopeOptionFixture({
          hostId: "host-a",
          isLocalMachine: false,
          entry: null,
        }),
      ),
    ).toBe("Host");
  });
});

// G4: the selector row's update badge, decorated from `FleetUpdateView` alone.
// The `unknown`-with-`lastKnownKind` case is the one the independent cold
// review's finding 4 named directly: a pre-`@1.3` peer (`unknown`, no
// retained phase) must render NOTHING — the noise case a blank badge exists
// to avoid claiming.
describe("hostOptionUpdateBadge", () => {
  function viewOf(overrides: Partial<FleetUpdateView>): FleetUpdateView {
    return { ...UNKNOWN_FLEET_UPDATE_VIEW, ...overrides };
  }

  // `qualified: false` explicitly here — `viewOf`'s base
  // (`UNKNOWN_FLEET_UPDATE_VIEW`) carries `qualified: true`, and production
  // change 7 (`hostOptionUpdateBadge` now retains-badges ANY qualified view,
  // not only a `kind: "unknown"` one) means a live-phase fixture that forgot
  // to override `qualified` would silently exercise the RETAINED arm instead
  // of the live one, reading "last seen updating" where the test's own title
  // promises "updating".
  it("a LIVE updating phase reads 'updating'", () => {
    expect(
      hostOptionUpdateBadge(viewOf({ kind: "downloading", qualified: false })),
    ).toBe("updating");
  });

  it("a retained (last-known) updating phase reads 'last seen updating'", () => {
    expect(
      hostOptionUpdateBadge(
        viewOf({ kind: "unknown", lastKnownKind: "downloading" }),
      ),
    ).toBe("last seen updating");
  });

  it("a retained failed attempt reads 'last seen update failed'", () => {
    expect(
      hostOptionUpdateBadge(
        viewOf({ kind: "unknown", lastKnownKind: "failed" }),
      ),
    ).toBe("last seen update failed");
  });

  it("a LIVE failed attempt reads 'update failed' (no 'last seen' prefix — it is current)", () => {
    expect(
      hostOptionUpdateBadge(viewOf({ kind: "failed", qualified: false })),
    ).toBe("update failed");
  });

  // Production change 7: a QUALIFIED view carrying a non-`unknown` kind (a
  // stale-but-not-yet-decayed read - `projectFleetUpdateView`'s `qualified`
  // flag is deliberately independent of `kind`) must retain-badge exactly
  // like the `kind: "unknown"` case above, not render the present-tense live
  // word. This is the case `viewOf`'s own default (`qualified: true`) was
  // silently exercising in the two "LIVE" fixtures above before they pinned
  // `qualified: false` explicitly.
  it("a QUALIFIED (stale-but-not-decayed) downloading view reads 'last seen updating', never the present-tense word", () => {
    expect(
      hostOptionUpdateBadge(viewOf({ kind: "downloading", qualified: true })),
    ).toBe("last seen updating");
  });

  it("A BARE unknown with NO retained phase renders NULL — the pre-@1.3-peer noise case", () => {
    expect(
      hostOptionUpdateBadge(viewOf({ kind: "unknown", lastKnownKind: null })),
    ).toBeNull();
  });

  it("a retained terminal 'complete' or 'idle' phase also renders null — nothing worth badging about the past", () => {
    expect(
      hostOptionUpdateBadge(
        viewOf({ kind: "unknown", lastKnownKind: "complete" }),
      ),
    ).toBeNull();
    expect(
      hostOptionUpdateBadge(viewOf({ kind: "unknown", lastKnownKind: "idle" })),
    ).toBeNull();
  });

  it("an idle (up-to-date) host renders no badge at all", () => {
    expect(hostOptionUpdateBadge(viewOf({ kind: "idle" }))).toBeNull();
  });
});
