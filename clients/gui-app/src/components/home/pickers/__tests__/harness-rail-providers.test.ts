import { describe, expect, it } from "vitest";
import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  resolveActiveProfileForHarness,
  visibleRailEntries,
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
