import { describe, expect, it } from "vitest";
import {
  leaseEquals,
  type ClientCompatibilityRequirement,
  type HostLeaseSnapshot,
  type SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";

/**
 * `leaseEquals` DECIDES WHETHER A LEASE CHANGE IS DELIVERED AT ALL.
 *
 * The engine's `leasesEqual` walks it per host and, when every lease compares
 * equal, skips pushing a `leases` event - so anything this function calls
 * identical is invisible to every window, permanently, until something else
 * changes.
 *
 * That makes the epoch path unusually exposed. Of the three discriminators it
 * used to compare, two are ALWAYS `null` there: a fatal frame carries method
 * canonicals rather than version strings, so `describeCompatVerdictForAuthority`
 * sets `hostVersion` and `minSupportedVersion` to null by design. The code is a
 * bare `INCOMPATIBLE` whenever the frame carried no per-method blocking reason,
 * which is exactly the epoch case. So the structured requirement was the only
 * thing that distinguished two epoch verdicts, and it was not compared.
 *
 * Every spec below is a transition that ends in a blocking dialog telling the
 * user to do the wrong thing.
 */

function requirement(
  overrides: Partial<ClientCompatibilityRequirement>,
): ClientCompatibilityRequirement {
  return {
    minimumCompatibilityEpoch: 2,
    observedCompatibilityEpoch: 1,
    failure: "below-minimum",
    observedClientKind: "desktop",
    observedClientAppVersion: "1.1.10",
    observedClientAppVersionStatus: "valid",
    minimumKnownClientAppVersion: "1.2.0-rc.2",
    upgradeChannel: "rc",
    // Default is a STABLE host so the per-field table can discriminate on
    // `hostReleaseChannel: "rc"` as the failover case: same floor, different
    // line, and that member is exactly what decides whether recovery may
    // offer an RC opt-in.
    hostReleaseChannel: "stable",
    ...overrides,
  };
}

/**
 * The shape the epoch path actually produces: bare `INCOMPATIBLE`, both
 * version fields null. Written out rather than parameterised so the three
 * near-constant discriminators are visible in the fixture itself.
 */
function incompatibleLease(
  clientCompatibility: ClientCompatibilityRequirement | null,
): HostLeaseSnapshot {
  const detail: SelectionIncompatibility = {
    code: "INCOMPATIBLE",
    hostVersion: null,
    minSupportedVersion: null,
    clientCompatibility,
  };
  return {
    hostId: "host-a",
    status: "dead",
    dead: { reason: "incompatible", detail },
  } as HostLeaseSnapshot;
}

describe("leaseEquals and the client-compatibility requirement", () => {
  it("reports a null -> structured transition as a CHANGE", () => {
    // The transition that strands the UI on `update-host`. A requirement can
    // arrive as null either because the host predates the epoch gate or
    // because `parseClientCompatibility` dropped a malformed one (it is
    // deliberately lossy rather than fatal). When a well-formed one follows,
    // the variant must move to `update-client` - and "Update host" cannot fix
    // an outdated client.
    expect(
      leaseEquals(incompatibleLease(null), incompatibleLease(requirement({}))),
    ).toBe(false);
  });

  it("reports a structured -> null transition as a CHANGE", () => {
    expect(
      leaseEquals(incompatibleLease(requirement({})), incompatibleLease(null)),
    ).toBe(false);
  });

  it("reports a RAISED FLOOR as a change, though every other field is equal", () => {
    // Host updates from floor 2 to floor 3 and its minimum-known build moves
    // with it. Same code, both versions null - so before this was compared,
    // every window kept printing "install 1.2.0-rc.2 or newer" while the host
    // required 1.3.0.
    expect(
      leaseEquals(
        incompatibleLease(requirement({})),
        incompatibleLease(
          requirement({
            minimumCompatibilityEpoch: 3,
            minimumKnownClientAppVersion: "1.3.0",
            upgradeChannel: "stable",
          }),
        ),
      ),
    ).toBe(false);
  });

  it.each([
    ["minimumCompatibilityEpoch", { minimumCompatibilityEpoch: 3 }],
    ["observedCompatibilityEpoch", { observedCompatibilityEpoch: null }],
    ["failure", { failure: "missing-epoch" as const }],
    ["observedClientKind", { observedClientKind: "cli" }],
    ["observedClientAppVersion", { observedClientAppVersion: "1.1.11" }],
    [
      "observedClientAppVersionStatus",
      { observedClientAppVersionStatus: "invalid" as const },
    ],
    ["minimumKnownClientAppVersion", { minimumKnownClientAppVersion: "1.3.0" }],
    ["upgradeChannel", { upgradeChannel: "stable" as const }],
    ["hostReleaseChannel", { hostReleaseChannel: "rc" }],
  ])("reports a change in %s", (_member, overrides) => {
    // EVERY member, not just the epoch. `hostReleaseChannel` is what decides
    // whether the recovery surface may offer an RC opt-in at all (failover
    // from a rejecting stable host to a rejecting RC host at the same floor
    // is the case that used to compare equal), the deprecated
    // `minimumKnownClientAppVersion` / `upgradeChannel` are still compared
    // because a change in any of them is a change the user would see, and
    // `observedClientAppVersionStatus` selects between the two body copies.
    expect(
      leaseEquals(
        incompatibleLease(requirement({})),
        incompatibleLease(requirement(overrides)),
      ),
    ).toBe(false);
  });

  it("treats an omitted hostReleaseChannel as equal to undefined, and unequal to a present line", () => {
    // OPTIONAL-MEMBER SEMANTICS, the reason the comparison is bare `===`
    // with no null-coalescing. A host that predates the field and one that
    // somehow sent `undefined` are the same observation; `"stable"` vs
    // absent is a real change (the recovery surface just learned which line
    // the host is on).
    const { hostReleaseChannel: _dropped, ...rest } = requirement({});
    const omitted: ClientCompatibilityRequirement = rest;
    const explicitlyUndefined = requirement({
      hostReleaseChannel: undefined,
    });
    const withStable = requirement({ hostReleaseChannel: "stable" });

    expect(
      leaseEquals(
        incompatibleLease(explicitlyUndefined),
        incompatibleLease(omitted),
      ),
    ).toBe(true);
    expect(
      leaseEquals(incompatibleLease(withStable), incompatibleLease(omitted)),
    ).toBe(false);
  });

  it("still reports two IDENTICAL requirements as equal", () => {
    // The other half, and the reason this compares member by member rather
    // than by identity: these objects cross an IPC boundary and are re-parsed
    // per delivery, so reference equality is always false. Comparing by
    // identity would make every lease event look like a change and defeat the
    // dedupe entirely.
    expect(
      leaseEquals(
        incompatibleLease(requirement({})),
        incompatibleLease(requirement({})),
      ),
    ).toBe(true);
    expect(leaseEquals(incompatibleLease(null), incompatibleLease(null))).toBe(
      true,
    );
  });

  it("leaves every non-incompatible lease comparison untouched", () => {
    // Guard against the fix widening beyond its case: a dead lease with a
    // different reason never reaches the detail comparison.
    const offline = {
      hostId: "host-a",
      status: "dead",
      dead: { reason: "offline" },
    } as HostLeaseSnapshot;
    expect(leaseEquals(offline, offline)).toBe(true);
    expect(leaseEquals(offline, incompatibleLease(requirement({})))).toBe(
      false,
    );
  });
});
