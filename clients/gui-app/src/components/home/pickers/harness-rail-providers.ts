import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";

/**
 * One rail entry: a harness, optionally split by a specific logged-in profile
 * (subscription). `profileId: null` is the single "just the harness" entry
 * every provider with 0/1 profiles renders - byte-identical to the pre-profile
 * rail. A provider with 2+ profiles renders one entry per profile instead
 * (see `splitRailEntriesForHarness`).
 */
export interface RailEntry {
  readonly harness: HarnessOption;
  readonly profileId: string | null;
  /** "Claude" for a single/no-profile entry, "Claude - Work" for a split one. */
  readonly label: string;
  /** Per-entry degraded state: the harness-level degraded flag OR (for a
   *  split entry) that specific profile's own auth status. */
  readonly degraded: boolean;
  /** Badge data for a split (profile-specific) entry, rendered as an
   *  initials/accent badge in place of the harness icon. `null` for the
   *  single "just the harness" entry every 0/1-profile provider renders. */
  readonly profileBadge: RailEntryProfileBadge | null;
}

export interface RailEntryProfileBadge {
  readonly profileId: string;
  readonly label: string;
  readonly email: string | null;
  readonly accentColor: string | null;
}

/** Stable identity for a rail entry - React key + ⌘-digit / active-entry match. */
export function railEntryKey(
  harnessId: GuiHarnessId,
  profileId: string | null,
): string {
  return profileId === null ? harnessId : `${harnessId}::${profileId}`;
}

/**
 * Split a single harness into its rail entries. 0/1 profiles (flag off, or a
 * provider that hasn't opted into the multi-profile capability) renders
 * exactly one entry shaped identically to today's plain harness row - the
 * progressive-disclosure gate from the decision log's "V1 surfaces" row.
 * 2+ profiles renders one entry per profile, labeled "<harness> - <profile>".
 */
function splitRailEntriesForHarness(
  harness: HarnessOption,
  profiles: ReadonlyArray<ProviderProfile>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): ReadonlyArray<RailEntry> {
  const harnessDegraded = railHarnessDegraded(harness, degradedHarnessIds);
  if (profiles.length < 2) {
    return [
      {
        harness,
        profileId: null,
        label: harness.label,
        degraded: harnessDegraded,
        profileBadge: null,
      },
    ];
  }
  return profiles.map((profile) => ({
    harness,
    // The ambient row's wire `profileId` is the literal "ambient" sentinel
    // (a stable array key for `profiles[]`), but every run/session-level
    // `profileId` field - and this rail entry's own commit target - uses
    // `null` for ambient (see `rate-limit-popover.tsx`'s identical mapping
    // and `composer-harness-memory-store.ts`'s ambient key). Passing the
    // sentinel through here would desync memory keying and the host's
    // session-chain profile match from every other ambient representation.
    profileId: profile.kind === "ambient" ? null : profile.profileId,
    label: `${harness.label} - ${profile.label}`,
    degraded: harnessDegraded || profile.auth.status !== "authenticated",
    // Uses the wire `profileId` (the "ambient" sentinel included) - unlike
    // the entry-level `profileId` above, the badge needs a stable per-row
    // identity for its accent-color hash fallback, not the switch-target key.
    profileBadge: {
      profileId: profile.profileId,
      label: profile.label,
      email: profile.identity?.email ?? null,
      accentColor: profile.accentColor,
    },
  }));
}

/**
 * The rail entries to render, in order. Disabled/unavailable providers that
 * are not recoverable from the picker stay hidden. Recoverable degraded
 * providers (signed out or missing an API key) stay visible, move below the
 * ready providers, and show the model-list CTA when selected. Shared by
 * `ProviderRail` and the picker's ⌘-digit shortcut so the digits line up with
 * the badges on the SAME ordered list. A harness's split entries (see
 * `splitRailEntriesForHarness`) stay adjacent - the ordering/degraded sort
 * below runs per-harness, then each harness expands in place.
 */
export function visibleRailEntries(
  harnesses: ReadonlyArray<HarnessOption>,
  fallbackHarnesses: ReadonlyArray<HarnessOption>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
  profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >,
): ReadonlyArray<RailEntry> {
  return visibleRailHarnesses(
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
  ).flatMap((harness) =>
    splitRailEntriesForHarness(
      harness,
      profilesByHarnessId.get(harness.id) ?? [],
      degradedHarnessIds,
    ),
  );
}

/**
 * The providers the rail renders, in order. Disabled/unavailable providers that
 * are not recoverable from the picker stay hidden. Recoverable degraded
 * providers (signed out or missing an API key) stay visible, move below the
 * ready providers, and show the model-list CTA when selected. Shared by
 * `ProviderRail` and the picker's ⌘-digit shortcut so the digits line up with
 * the badges on the SAME ordered list.
 */
export function visibleRailHarnesses(
  harnesses: ReadonlyArray<HarnessOption>,
  fallbackHarnesses: ReadonlyArray<HarnessOption>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): ReadonlyArray<HarnessOption> {
  const source = harnesses.length > 0 ? harnesses : fallbackHarnesses;
  const visible = source.filter((harness) =>
    railHarnessVisible(harness, degradedHarnessIds),
  );
  return sortGuiHarnessesByProviderOrder(visible).toSorted(
    (left, right) =>
      Number(railHarnessDegraded(left, degradedHarnessIds)) -
      Number(railHarnessDegraded(right, degradedHarnessIds)),
  );
}

export function railHarnessDegraded(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): boolean {
  return (
    !harness.available &&
    (harness.requiresApiKey || degradedHarnessIds.has(harness.id))
  );
}

function railHarnessVisible(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): boolean {
  return (
    harness.available ||
    harness.availabilityPending ||
    railHarnessDegraded(harness, degradedHarnessIds)
  );
}
