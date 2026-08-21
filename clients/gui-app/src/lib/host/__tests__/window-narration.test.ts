import { describe, expect, it } from "vitest";
import type {
  HostLeaseSnapshot,
  SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  deriveNoHostVariant,
  deriveWindowNarration,
  findLease,
  hostUpdateActionApplies,
  hostUpdateSkew,
  isServingLease,
  type WindowNarrationInput,
} from "@/lib/host/window-narration";

function incompatibility(
  overrides: Partial<SelectionIncompatibility>,
): SelectionIncompatibility {
  return {
    code: "protocol-major-behind",
    hostVersion: "1.0.0",
    minSupportedVersion: "1.2.0",
    ...overrides,
  };
}

function lease(overrides: Partial<HostLeaseSnapshot>): HostLeaseSnapshot {
  const base = {
    hostId: "host-a",
    status: "connecting" as const,
    dead: null,
  };
  return { ...base, ...overrides } as HostLeaseSnapshot;
}

function deadLease(
  hostId: string,
  dead: HostLeaseSnapshot["dead"],
): HostLeaseSnapshot {
  return { hostId, status: "dead", dead } as HostLeaseSnapshot;
}

function baseInput(
  overrides: Partial<WindowNarrationInput>,
): WindowNarrationInput {
  return {
    attached: true,
    effectiveHostId: null,
    targetHostId: null,
    leases: [],
    hasBeenServed: false,
    // Desktop is this module's population: the pre-serve ∅ grace is gated on
    // a shell that can actually boot a local host, and every case below that
    // does not say otherwise is describing a desktop launch.
    localHostExpected: true,
    // This machine is `host-local` throughout, so a case whose target is
    // `host-local` is a LOCAL target and one that names anything else is
    // remote - the distinction the restarting-target arm turns on, and one no
    // test can express through `localHostExpected` alone.
    localHostId: "host-local",
    ...overrides,
  };
}

describe("isServingLease", () => {
  it("is false for a null lease", () => {
    expect(isServingLease(null)).toBe(false);
  });

  it("is true for ready and degraded", () => {
    expect(isServingLease(lease({ status: "ready", dead: null }))).toBe(true);
    expect(isServingLease(lease({ status: "degraded", dead: null }))).toBe(
      true,
    );
  });

  it("is false for connecting, restarting-expected, and dead", () => {
    expect(isServingLease(lease({ status: "connecting", dead: null }))).toBe(
      false,
    );
    expect(
      isServingLease(lease({ status: "restarting-expected", dead: null })),
    ).toBe(false);
    expect(isServingLease(deadLease("host-a", { reason: "offline" }))).toBe(
      false,
    );
  });
});

describe("findLease", () => {
  it("returns null for a null hostId", () => {
    expect(findLease([lease({ hostId: "host-a" })], null)).toBeNull();
  });

  it("finds by hostId, else null", () => {
    const leases = [lease({ hostId: "host-a" }), lease({ hostId: "host-b" })];
    expect(findLease(leases, "host-b")?.hostId).toBe("host-b");
    expect(findLease(leases, "host-z")).toBeNull();
  });
});

describe("deriveWindowNarration", () => {
  it("is silent when not attached, regardless of the rest of the input", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: false,
        effectiveHostId: null,
        hasBeenServed: false,
        leases: [deadLease("host-a", { reason: "offline" })],
      }),
    );
    expect(state).toEqual({ kind: "silent" });
  });

  it("narrates no-usable-host on ∅ once the window has been served (the ∅ arm)", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: null,
        // The ∅ verdict is unconditional AFTER the window has worked once -
        // the pre-serve grace below is strictly a launch statement.
        hasBeenServed: true,
      }),
    );
    expect(state).toEqual({
      kind: "narrating",
      cause: "no-usable-host",
      variant: { kind: "offline" },
    });
  });

  describe("the pre-serve ∅ grace", () => {
    /**
     * ∅ before this window has ever been served is not automatically a
     * verdict. Two ordinary launch shapes produce it - the attach snapshot
     * landing before the fleet's first publish (empty leases), and the launch
     * reconcile cycling the local host (`restarting-expected`, unusable, with
     * no incumbent to hold at cold start) - and both used to flash "No host is
     * available" with Retry and Report issue at every single boot.
     *
     * The discriminator is whether anything has CONCLUDED: a dead lease is a
     * conclusion, an empty or merely-unsettled fleet is not.
     */
    it("narrates cold-start when nothing has concluded yet (empty fleet at launch)", () => {
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          leases: [],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      });
    });

    it("narrates cold-start while the local host is cycling (restarting-expected)", () => {
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          leases: [lease({ hostId: "host-a", status: "restarting-expected" })],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      });
    });

    it("yields to the ∅ scan as soon as ANY lease is dead - a conclusion is a verdict", () => {
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          leases: [deadLease("host-a", { reason: "offline" })],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: { kind: "offline" },
      });
    });

    it("holds the grace through a dead lease while the TARGET is restarting - the authority is waiting on purpose", () => {
      // The authority's cold-start hold answers ∅ for a bounded window while a
      // never-proven local target cycles, declining a usable fallback so the
      // app does not hop to a remote and get dragged back seconds later. So
      // this ∅ does not mean "nothing can serve" - and without this arm, one
      // retired machine anywhere in the account (dead, and every account
      // accumulates them) would put "No host is available" over a launch that
      // is going perfectly well, with a working remote sitting right there.
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          targetHostId: "host-local",
          leases: [
            lease({ hostId: "host-local", status: "restarting-expected" }),
            lease({ hostId: "host-remote", status: "ready" }),
            deadLease("host-retired", { reason: "offline" }),
          ],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      });
    });

    it("P2 FIX - yields to an ACTIONABLE verdict even while the target is restarting: an incompatible other host still gets update-host", () => {
      // The restarting-target arm has no clock, and the lease it reads can
      // stay `restarting-expected` for the outage signal's ceiling - fifteen
      // minutes, far past the authority's twenty-second hold. So whatever it
      // hides, it can hide for the whole outage. Hiding `offline` costs
      // nothing (the startup card carries the same Retry), but hiding a fix
      // the user could walk right now is a lockout with a spinner on it.
      const detail = {
        code: "protocol-major-behind",
        hostVersion: "1.2.3",
        minSupportedVersion: "1.3.0",
      } as const;
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          targetHostId: "host-local",
          leases: [
            lease({ hostId: "host-local", status: "restarting-expected" }),
            deadLease("host-remote", { reason: "incompatible", detail }),
          ],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: {
          kind: "update-host",
          hostId: "host-remote",
          isTargetHost: false,
          detail,
        },
      });
    });

    it("P2 FIX - a restarting REMOTE target is not a local launch: the arm needs the target to be this machine, which localHostExpected cannot say", () => {
      // `localHostExpected` describes the SHELL - "can this app boot some
      // local host" - and stays true on a desktop whose target is a remote.
      // The authority's own hold is local-target-only, so with a preferred
      // remote cycling and the rest of the fleet offline it derives a REAL ∅.
      // Relabelling that as cold-start put this machine's provisioning card
      // (Retry, install progress, the bootstrap log) in front of a host this
      // app has no lifecycle for, and withheld the offline recovery until the
      // remote's restart episode expired.
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          targetHostId: "host-remote",
          localHostId: "host-local",
          leases: [
            lease({ hostId: "host-remote", status: "restarting-expected" }),
            deadLease("host-local", { reason: "offline" }),
          ],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: { kind: "offline" },
      });
    });

    it("P2 FIX - and still holds it for a merely-offline fleet: the gate is the VERDICT, not the presence of a dead lease", () => {
      // The other side of the same rule, and the reason it is stated over the
      // scan's answer rather than over deadness: a retired laptop still
      // resolves to `offline`, so the launch story survives it. Losing this
      // would restore the flash the arm above was added to remove.
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          targetHostId: "host-local",
          leases: [
            lease({ hostId: "host-local", status: "restarting-expected" }),
            deadLease("host-retired", { reason: "removed" }),
          ],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      });
    });

    it("does not extend that exception past the first service - a restarting target after serving is the ∅ verdict", () => {
      // The grace is a LAUNCH statement in both of its arms. Once the window
      // has been served, ∅ is always the verdict, whatever the target's lease
      // happens to say.
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: true,
          targetHostId: "host-local",
          leases: [
            lease({ hostId: "host-local", status: "restarting-expected" }),
            deadLease("host-retired", { reason: "offline" }),
          ],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: { kind: "offline" },
      });
    });

    it("keeps update-host reachable at first launch - the grace must not swallow a dead incompatible host", () => {
      // The sharp edge of the rule above: `update-host` and `plan-restricted`
      // BOTH derive from dead leases, so a grace that ignored deadness would
      // make them unreachable on the very launch they matter most.
      const detail = {
        code: "protocol-major-behind",
        hostVersion: "1.2.3",
        minSupportedVersion: "1.3.0",
      } as const;
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          targetHostId: "host-a",
          leases: [deadLease("host-a", { reason: "incompatible", detail })],
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: {
          kind: "update-host",
          hostId: "host-a",
          isTargetHost: true,
          detail,
        },
      });
    });

    it("does not apply on a shell that cannot boot a local host", () => {
      // Web/mobile: there is no local lifecycle to be "starting", so an empty
      // concluded-nothing fleet really is "no host is available". Softening it
      // would promise a boot that cannot happen.
      const state = deriveWindowNarration(
        baseInput({
          attached: true,
          effectiveHostId: null,
          hasBeenServed: false,
          leases: [],
          localHostExpected: false,
        }),
      );
      expect(state).toEqual({
        kind: "narrating",
        cause: "no-usable-host",
        variant: { kind: "offline" },
      });
    });
  });

  it("narrates cold-start when the effective host exists but has never served and is not currently serving", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: "host-a",
        leases: [lease({ hostId: "host-a", status: "connecting", dead: null })],
        hasBeenServed: false,
      }),
    );
    expect(state).toEqual({
      kind: "narrating",
      cause: "cold-start",
      variant: { kind: "offline" },
    });
  });

  it("is silent once the effective host's lease is ready", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: "host-a",
        leases: [lease({ hostId: "host-a", status: "ready", dead: null })],
        hasBeenServed: false,
      }),
    );
    expect(state).toEqual({ kind: "silent" });
  });

  it("is silent when the effective host's lease is degraded (a degraded host IS serving)", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: "host-a",
        leases: [lease({ hostId: "host-a", status: "degraded", dead: null })],
        hasBeenServed: false,
      }),
    );
    expect(state).toEqual({ kind: "silent" });
  });

  it("latches silent once served: hasBeenServed true + a merely-connecting lease stays silent", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: "host-a",
        leases: [lease({ hostId: "host-a", status: "connecting", dead: null })],
        hasBeenServed: true,
      }),
    );
    expect(state).toEqual({ kind: "silent" });
  });

  it("the latch does not survive a return to ∅: effectiveHostId null still narrates even after hasBeenServed", () => {
    const state = deriveWindowNarration(
      baseInput({
        attached: true,
        effectiveHostId: null,
        leases: [],
        hasBeenServed: true,
      }),
    );
    expect(state).toEqual({
      kind: "narrating",
      cause: "no-usable-host",
      variant: { kind: "offline" },
    });
  });
});

describe("deriveNoHostVariant precedence", () => {
  it("1. names the TARGET host when it is dead-incompatible, even beside another incompatible host", () => {
    const targetDetail = incompatibility({ code: "target-behind" });
    const otherDetail = incompatibility({ code: "other-behind" });
    const leases = [
      deadLease("host-other", { reason: "incompatible", detail: otherDetail }),
      deadLease("host-target", {
        reason: "incompatible",
        detail: targetDetail,
      }),
    ];
    const variant = deriveNoHostVariant(leases, "host-target");
    expect(variant).toEqual({
      kind: "update-host",
      hostId: "host-target",
      detail: targetDetail,
      // Arm 1 names the target, so the card and the local lifecycle's action
      // are about the SAME machine and the Update button is offered.
      isTargetHost: true,
    });
  });

  it("2. every lease dead plan-restricted (>=1) => plan-restricted", () => {
    const leases = [
      deadLease("host-a", { reason: "plan-restricted" }),
      deadLease("host-b", { reason: "plan-restricted" }),
    ];
    const variant = deriveNoHostVariant(leases, "host-a");
    expect(variant).toEqual({ kind: "plan-restricted" });
  });

  it("3. no target incompatibility, some other lease is dead-incompatible => update-host on it", () => {
    const detail = incompatibility({ code: "other-behind" });
    const leases = [
      deadLease("host-target", { reason: "offline" }),
      deadLease("host-other", { reason: "incompatible", detail }),
    ];
    const variant = deriveNoHostVariant(leases, "host-target");
    expect(variant).toEqual({
      kind: "update-host",
      hostId: "host-other",
      detail,
      // Arm 3: the incompatible host is NOT the target, so the action - which
      // re-provisions THIS machine - must be withheld. Carried on the variant
      // rather than re-derived at the card, because `canManageHost` answers a
      // different question ("is the target this machine") and reads as this
      // guard without being one.
      isTargetHost: false,
    });
  });

  it("4. mixed offline + plan-restricted => offline", () => {
    const leases = [
      deadLease("host-a", { reason: "offline" }),
      deadLease("host-b", { reason: "plan-restricted" }),
    ];
    const variant = deriveNoHostVariant(leases, null);
    expect(variant).toEqual({ kind: "offline" });
  });

  it("5. empty lease list => offline, not plan-restricted (vacuous-every guard)", () => {
    const variant = deriveNoHostVariant([], null);
    expect(variant).toEqual({ kind: "offline" });
  });

  it("6. mixed plan-restricted target + incompatible other falls through to update-host", () => {
    const detail = incompatibility({ code: "other-behind" });
    const leases = [
      deadLease("host-target", { reason: "plan-restricted" }),
      deadLease("host-other", { reason: "incompatible", detail }),
    ];
    const variant = deriveNoHostVariant(leases, "host-target");
    expect(variant).toEqual({
      kind: "update-host",
      hostId: "host-other",
      detail,
      // Arm 3: the incompatible host is NOT the target, so the action - which
      // re-provisions THIS machine - must be withheld. Carried on the variant
      // rather than re-derived at the card, because `canManageHost` answers a
      // different question ("is the target this machine") and reads as this
      // guard without being one.
      isTargetHost: false,
    });
  });
});

describe("hostUpdateSkew / hostUpdateActionApplies", () => {
  it("names the HOST as the outdated leg when the host version is behind the client", () => {
    const detail = incompatibility({ hostVersion: "1.0.0" });
    const skew = hostUpdateSkew(detail, "1.2.0");
    expect(skew.direction).toBe("host-outdated");
    expect(hostUpdateActionApplies(detail, "1.2.0")).toBe(true);
  });

  it("names the CLIENT as the outdated leg when the host version is ahead of the client, and withholds the action", () => {
    const detail = incompatibility({ hostVersion: "2.0.0" });
    const skew = hostUpdateSkew(detail, "1.2.0");
    expect(skew.direction).toBe("client-outdated");
    expect(hostUpdateActionApplies(detail, "1.2.0")).toBe(false);
  });
});
