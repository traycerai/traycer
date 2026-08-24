import { describe, expect, it } from "vitest";
import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  railHarnessDegraded,
  resolveActiveProfileForHarness,
  visibleRailEntries,
  visibleRailHarnesses,
} from "@/components/home/pickers/harness-rail-providers";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";

const NO_ACTIVE_PROFILE_OVERRIDES = new Map<GuiHarnessId, string | null>();
const NO_PREPARING = new Map<GuiHarnessId, ProviderPackPreparing>();

function harness(id: "claude" | "codex"): HarnessOption {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    availabilityPending: false,
  };
}

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

describe("visibleRailEntries", () => {
  it("renders exactly one entry per provider, regardless of profile count", () => {
    const entries = visibleRailEntries({
      harnesses: [harness("claude")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: NO_PREPARING,
      profilesByHarnessId: new Map([
        [
          "claude",
          [
            profile("ambient", "ambient", "Claude Terminal account"),
            profile("work-uuid", "managed", "Work"),
          ],
        ],
      ]),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    // The rail no longer splits by profile - one tab for Claude, full stop.
    // Profile switching lives in the picker's profile dropdown.
    expect(entries).toHaveLength(1);
    expect(entries[0].harness.id).toBe("claude");
  });

  it("renders no accent dot for a harness under 2 profiles - byte-identical to today", () => {
    const entries = visibleRailEntries({
      harnesses: [harness("codex")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: NO_PREPARING,
      profilesByHarnessId: new Map([
        ["codex", [profile("ambient", "ambient", "Codex Terminal account")]],
      ]),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries).toEqual([
      {
        harness: harness("codex"),
        degraded: false,
        accentDot: null,
        preparing: null,
      },
    ]);
  });

  it("colors the accent dot from the resolved active profile for 2+ profiles", () => {
    const entries = visibleRailEntries({
      harnesses: [harness("claude")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: NO_PREPARING,
      profilesByHarnessId: new Map([
        [
          "claude",
          [
            profile("ambient", "ambient", "Claude Terminal account"),
            profile("work-uuid", "managed", "Work"),
          ],
        ],
      ]),
      activeProfileIdByHarnessId: new Map<GuiHarnessId, string | null>([
        ["claude", "work-uuid"],
      ]),
    });

    expect(entries[0].accentDot).toEqual({
      profileId: "work-uuid",
      accentColor: null,
      label: "Work",
    });
  });

  it("falls back to the harness's first selectable profile (ambient) when no active profile is supplied", () => {
    const entries = visibleRailEntries({
      harnesses: [harness("claude")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: NO_PREPARING,
      profilesByHarnessId: new Map([
        [
          "claude",
          [
            profile("ambient", "ambient", "Claude Terminal account"),
            profile("work-uuid", "managed", "Work"),
          ],
        ],
      ]),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries[0].accentDot).toEqual({
      profileId: "ambient",
      accentColor: null,
      label: "Claude Terminal account",
    });
  });
});

describe("visibleRailEntries: managed-pack readiness", () => {
  function unavailable(id: "claude" | "codex"): HarnessOption {
    return { ...harness(id), available: false };
  }
  // `fallbackRunnable: false` on purpose: this block is about the provider
  // that has NO binary yet (see the comment below), which is exactly the case
  // that still gates.
  const downloading: ProviderPackPreparing = {
    kind: "downloading",
    percent: 42,
    retryAtMs: null,
    reason: null,
    fallbackRunnable: false,
  };

  // The load-bearing one. On a first boot the host converges EVERY enabled
  // provider (~1.6 GB), so a provider that is downloading is also
  // `available: false` - it has no binary yet. Under the pre-R11 visibility
  // rule that combination is invisible, which would empty the picker on first
  // run and then silently repopulate it. The user must see the row and be told
  // why it is not pickable.
  it("keeps a downloading provider VISIBLE even though it has no binary yet", () => {
    const entries = visibleRailEntries({
      harnesses: [unavailable("claude")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: new Map([["claude", downloading]]),
      profilesByHarnessId: new Map(),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].harness.id).toBe("claude");
    expect(entries[0].preparing).toEqual(downloading);
  });

  it("carries a null percent through untouched - the live-sibling observer state", () => {
    const entries = visibleRailEntries({
      harnesses: [unavailable("claude")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: new Map([
        [
          "claude",
          {
            kind: "downloading",
            percent: null,
            retryAtMs: null,
            reason: null,
            fallbackRunnable: false,
          },
        ],
      ]),
      profilesByHarnessId: new Map(),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    // Must stay null, never coerced to 0 - a 0% bar and an unknown-progress
    // spinner say different things, and only one of them is true.
    expect(entries[0].preparing?.percent).toBeNull();
  });

  it("sorts a preparing provider below the ready ones", () => {
    // Preparing `codex`, which sorts FIRST canonically. Preparing `claude`
    // here - as this test used to - asserted the order the canonical sort
    // already produces, so it passed with the deprioritization removed
    // entirely.
    const entries = visibleRailEntries({
      harnesses: [harness("claude"), unavailable("codex")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: new Map([["codex", downloading]]),
      profilesByHarnessId: new Map(),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries.map((entry) => entry.harness.id)).toEqual([
      "claude",
      "codex",
    ]);
  });

  // P5. The rail deprioritized on "has a pack state at all", which was
  // coherent while a preparing tab was unselectable. Once a download behind a
  // runnable binary stopped taking the provider away, that rule made the rail
  // reorder itself throughout a first-boot convergence - every provider sinks,
  // then pops back up as its own install finishes - and `PickerLeaderBadge`
  // reads the rail index, so every Cmd-digit reassigns each time.
  //
  // The control below is the whole point: the SAME downloading state, differing
  // only in whether a runnable binary exists, must sort differently.
  const downloadingBehindRunnableBinary: ProviderPackPreparing = {
    kind: "downloading",
    percent: 30,
    retryAtMs: null,
    reason: null,
    fallbackRunnable: true,
  };

  it("does not move a provider that is downloading behind a runnable binary", () => {
    // Preparing the provider that sorts FIRST canonically. Doing it to the one
    // that already sorts last proves nothing - the expected order would hold
    // whether or not anything was deprioritized.
    const order = (preparing: ProviderPackPreparing): readonly string[] =>
      visibleRailEntries({
        harnesses: [harness("claude"), harness("codex")],
        fallbackHarnesses: [],
        degradedHarnessIds: new Set(),
        preparingByHarnessId: new Map([["codex", preparing]]),
        profilesByHarnessId: new Map(),
        activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
      }).map((entry) => entry.harness.id);

    expect(order(downloadingBehindRunnableBinary)).toEqual(["codex", "claude"]);
    // ...and a pack that genuinely blocks still sinks, so this is a narrowing
    // rather than a removal.
    expect(order(downloading)).toEqual(["claude", "codex"]);
  });

  it("leaves a ready provider's entry with preparing: null", () => {
    const entries = visibleRailEntries({
      harnesses: [harness("codex")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set(),
      preparingByHarnessId: new Map([["claude", downloading]]),
      profilesByHarnessId: new Map(),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries[0].preparing).toBeNull();
  });
});

describe("railHarnessDegraded", () => {
  it("degrades a signed-out provider even while its harness reports available", () => {
    // Availability probes binary presence, never auth - an installed but
    // signed-out provider (Copilot after a real logout) keeps reporting
    // `available: true`. The signed-out set must degrade WITHOUT the
    // availability gate, or the rail offers a fully-lit, selectable tab for a
    // provider the send gate then refuses to run.
    expect(
      railHarnessDegraded(harness("claude"), new Set<GuiHarnessId>(["claude"])),
    ).toBe(true);
  });

  it("keeps a healthy available provider non-degraded", () => {
    expect(railHarnessDegraded(harness("claude"), new Set())).toBe(false);
  });

  it("keeps the API-key arm availability-gated", () => {
    const apiKeyHarness: HarnessOption = {
      ...harness("codex"),
      requiresApiKey: true,
    };
    // An available API-key provider is running on SOME key - not degraded.
    expect(railHarnessDegraded(apiKeyHarness, new Set())).toBe(false);
    // Unavailable, it stays visible-but-degraded for the add-key CTA.
    expect(
      railHarnessDegraded({ ...apiKeyHarness, available: false }, new Set()),
    ).toBe(true);
  });

  it("leaves an unavailable keyless provider non-degraded - the hidden path", () => {
    expect(
      railHarnessDegraded({ ...harness("codex"), available: false }, new Set()),
    ).toBe(false);
  });
});

describe("railHarnessDegraded: catalog-row authStatus (agent.gui.listHarnesses@7.1)", () => {
  it("degrades on a definitive unauthenticated row even when the providers.list-derived set is empty - the staleness-window fix", () => {
    const signedOut: HarnessOption = {
      ...harness("claude"),
      authStatus: "unauthenticated",
    };
    // Empty set: no other source flags this provider, which is exactly the
    // window a separately-timed `providers.list` query can lag through.
    expect(railHarnessDegraded(signedOut, new Set())).toBe(true);
  });

  it("still degrades when providers.list-derived membership flags it and the row's own authStatus is absent (old host)", () => {
    const noRowVerdict: HarnessOption = { ...harness("claude") };
    expect(noRowVerdict.authStatus).toBeUndefined();
    expect(
      railHarnessDegraded(noRowVerdict, new Set<GuiHarnessId>(["claude"])),
    ).toBe(true);
  });

  it("still degrades when providers.list-derived membership flags it even though the row's own authStatus reads authenticated - the two sources are OR'd, not one replacing the other", () => {
    const rowSaysAuthenticated: HarnessOption = {
      ...harness("claude"),
      authStatus: "authenticated",
    };
    expect(
      railHarnessDegraded(
        rowSaysAuthenticated,
        new Set<GuiHarnessId>(["claude"]),
      ),
    ).toBe(true);
  });

  it("does NOT degrade on a row's unknown authStatus - fail-open, non-definitive", () => {
    const unknownRow: HarnessOption = {
      ...harness("claude"),
      authStatus: "unknown",
    };
    expect(railHarnessDegraded(unknownRow, new Set())).toBe(false);
  });

  it("does NOT degrade on a row's unavailable authStatus - fail-open, non-definitive", () => {
    const unavailableRow: HarnessOption = {
      ...harness("claude"),
      authStatus: "unavailable",
    };
    expect(railHarnessDegraded(unavailableRow, new Set())).toBe(false);
  });

  it("widening authStatus to unknown/unavailable would also widen visibility - asserted through visibleRailHarnesses, not just degradation", () => {
    // A sticky-enabled provider reporting `available: false` (no CLI
    // installed) with a non-definitive row verdict must stay HIDDEN, not
    // merely non-degraded - `railHarnessVisible` ORs degraded into
    // visibility, so widening the predicate to `unknown`/`unavailable` would
    // give this provider a permanent, un-runnable tab.
    const unreachable: HarnessOption = {
      ...harness("claude"),
      available: false,
      authStatus: "unknown",
    };
    const visible = visibleRailHarnesses(
      [unreachable],
      [],
      new Set(),
      new Map(),
    );
    expect(visible).toEqual([]);

    // Contrast: a DEFINITIVE unauthenticated row on the same unreachable
    // provider keeps it visible - that is the "recoverable, needs
    // attention" case the degraded set exists to surface.
    const signedOutUnreachable: HarnessOption = {
      ...harness("claude"),
      available: false,
      authStatus: "unauthenticated",
    };
    const visibleSignedOut = visibleRailHarnesses(
      [signedOutUnreachable],
      [],
      new Set(),
      new Map(),
    );
    expect(visibleSignedOut.map((h) => h.id)).toEqual(["claude"]);
  });
});

describe("railHarnessDegraded / visibleRailHarnesses: explicitly-off gate (enablementMode)", () => {
  it("does not degrade or show an explicitly-off, signed-out, unavailable provider", () => {
    const explicitlyOff: HarnessOption = {
      ...harness("claude"),
      available: false,
      authStatus: "unauthenticated",
      enablementMode: "off",
    };
    expect(railHarnessDegraded(explicitlyOff, new Set())).toBe(false);
    expect(
      visibleRailHarnesses([explicitlyOff], [], new Set(), new Map()),
    ).toEqual([]);
  });

  // Load-bearing: gating on `enabled` instead of `enablementMode` would break
  // this one - an `auto` provider with no detected account is `enabled: false`
  // too, and it must stay visible as the "sign in to enable" offer.
  it("still degrades and shows an auto-mode, signed-out provider even though enabled is false", () => {
    const autoUndetected: HarnessOption = {
      ...harness("claude"),
      enabled: false,
      authStatus: "unauthenticated",
      enablementMode: "auto",
    };
    expect(railHarnessDegraded(autoUndetected, new Set())).toBe(true);
    expect(
      visibleRailHarnesses([autoUndetected], [], new Set(), new Map()).map(
        (h) => h.id,
      ),
    ).toEqual(["claude"]);
  });

  it("still degrades and shows a sticky-on, signed-out provider", () => {
    const stickyOn: HarnessOption = {
      ...harness("claude"),
      authStatus: "unauthenticated",
      enablementMode: "on",
    };
    expect(railHarnessDegraded(stickyOn, new Set())).toBe(true);
    expect(
      visibleRailHarnesses([stickyOn], [], new Set(), new Map()).map(
        (h) => h.id,
      ),
    ).toEqual(["claude"]);
  });

  it("keeps the other two degradation arms unaffected by an explicit off - the gate is narrow", () => {
    // degradedHarnessIds membership still degrades under enablementMode: "off".
    const offButFlagged: HarnessOption = {
      ...harness("claude"),
      enablementMode: "off",
    };
    expect(
      railHarnessDegraded(offButFlagged, new Set<GuiHarnessId>(["claude"])),
    ).toBe(true);

    // Unavailable + requiresApiKey still degrades under enablementMode: "off".
    const offApiKeyUnavailable: HarnessOption = {
      ...harness("codex"),
      available: false,
      requiresApiKey: true,
      enablementMode: "off",
    };
    expect(railHarnessDegraded(offApiKeyUnavailable, new Set())).toBe(true);
  });

  it("behaves exactly as before on an old host with no authStatus/enablementMode", () => {
    const oldHost: HarnessOption = { ...harness("claude") };
    expect(oldHost.authStatus).toBeUndefined();
    expect(oldHost.enablementMode).toBeUndefined();
    expect(railHarnessDegraded(oldHost, new Set())).toBe(false);
    expect(
      railHarnessDegraded(oldHost, new Set<GuiHarnessId>(["claude"])),
    ).toBe(true);
  });
});

describe("visibleRailEntries: signed-out while available", () => {
  it("sinks a signed-out-but-available provider below the ready ones", () => {
    // Degrading codex, which sorts FIRST canonically (see the pack-readiness
    // block above) - proving the deprioritization fires without
    // `available: false`.
    const entries = visibleRailEntries({
      harnesses: [harness("claude"), harness("codex")],
      fallbackHarnesses: [],
      degradedHarnessIds: new Set<GuiHarnessId>(["codex"]),
      preparingByHarnessId: NO_PREPARING,
      profilesByHarnessId: new Map(),
      activeProfileIdByHarnessId: NO_ACTIVE_PROFILE_OVERRIDES,
    });

    expect(entries.map((entry) => entry.harness.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(entries[1].degraded).toBe(true);
  });
});

describe("resolveActiveProfileForHarness", () => {
  const profilesWithAmbient = [
    profile("ambient", "ambient", "Claude Terminal account"),
    profile("work-uuid", "managed", "Work"),
  ];
  const managedOnlyProfiles = [
    profile("a-uuid", "managed", "A"),
    profile("b-uuid", "managed", "B"),
  ];

  it("returns null outright under 2 profiles - profile identity has no meaning there", () => {
    expect(
      resolveActiveProfileForHarness(
        [profile("ambient", "ambient", "Claude Terminal account")],
        "anything",
        "anything",
      ),
    ).toBeNull();
  });

  it("prefers the browsed profile id when it belongs to this harness", () => {
    expect(
      resolveActiveProfileForHarness(profilesWithAmbient, "work-uuid", null),
    ).toBe("work-uuid");
  });

  it("falls back to the selected profile id when the browsed one doesn't belong here", () => {
    expect(
      resolveActiveProfileForHarness(
        profilesWithAmbient,
        "stale-from-another-harness",
        "work-uuid",
      ),
    ).toBe("work-uuid");
  });

  it("falls back to the ambient profile (commit id null) when neither matches", () => {
    expect(
      resolveActiveProfileForHarness(profilesWithAmbient, "nope", "nope-2"),
    ).toBeNull();
  });

  it("falls back to the first selectable profile for an all-managed harness", () => {
    expect(
      resolveActiveProfileForHarness(managedOnlyProfiles, "nope", "nope-2"),
    ).toBe("a-uuid");
  });
});

describe("profileCommitId", () => {
  it("maps the ambient profile to the null commit id, not the wire sentinel", () => {
    expect(
      profileCommitId(profile("ambient", "ambient", "Terminal")),
    ).toBeNull();
  });

  it("keeps a managed profile's own profileId as its commit id", () => {
    expect(profileCommitId(profile("work-uuid", "managed", "Work"))).toBe(
      "work-uuid",
    );
  });
});
