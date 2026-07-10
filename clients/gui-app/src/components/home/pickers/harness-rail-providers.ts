import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";
import {
  profileAccentDotInput,
  profileCommitId,
  type ProfileAccentDotInput,
} from "@/components/providers/provider-profile-model";

/**
 * One rail entry: a provider-level tab. The rail always renders exactly one
 * entry per provider - the pre-multi-profile shape - regardless of how many
 * profiles (subscriptions) that provider has. Profile switching lives in the
 * picker's profile dropdown (`@/components/providers/profile-dropdown`),
 * never the rail itself.
 */
export interface RailEntry {
  readonly harness: HarnessOption;
  /** Per-entry degraded state: the harness-level degraded flag (signed out /
   *  missing an API key). Profile-level auth issues surface in the dropdown,
   *  not here. */
  readonly degraded: boolean;
  /** Bottom-right accent-dot data, present only when the provider has 2+
   *  selectable profiles (progressive disclosure - see the multi-profile
   *  decision log's "V1 surfaces" row). `null` renders no dot at all. */
  readonly accentDot: ProfileAccentDotInput | null;
}

/** Stable identity for a rail entry - React key + ⌘-digit / active-entry match. */
export function railEntryKey(harnessId: GuiHarnessId): string {
  return harnessId;
}

/**
 * Resolves which profile is "active" for a harness with 2+ selectable
 * profiles: the reducer's browsed `activeProfileId` if it belongs to this
 * harness, else the composer's already-committed `selectedProfileId` if it
 * belongs to this harness, else the harness's first selectable profile
 * (typically its ambient row). Returns `null` outright under 2 profiles -
 * profile identity has no meaning there (progressive disclosure).
 */
export function resolveActiveProfileForHarness(
  profiles: ReadonlyArray<ProviderProfile>,
  browsedProfileId: string | null,
  selectedProfileId: string | null,
): string | null {
  if (profiles.length < 2) return null;
  const matchBrowsed = profiles.find(
    (profile) => profileCommitId(profile) === browsedProfileId,
  );
  if (matchBrowsed !== undefined) return profileCommitId(matchBrowsed);
  const matchSelected = profiles.find(
    (profile) => profileCommitId(profile) === selectedProfileId,
  );
  if (matchSelected !== undefined) return profileCommitId(matchSelected);
  const first = profiles.at(0);
  return first === undefined ? null : profileCommitId(first);
}

function resolveAccentDot(
  profiles: ReadonlyArray<ProviderProfile>,
  activeProfileId: string | null,
): ProfileAccentDotInput | null {
  if (profiles.length < 2) return null;
  const dotProfile =
    profiles.find((profile) => profileCommitId(profile) === activeProfileId) ??
    profiles.at(0);
  if (dotProfile === undefined) return null;
  return profileAccentDotInput(dotProfile);
}

function buildRailEntry(
  harness: HarnessOption,
  profiles: ReadonlyArray<ProviderProfile>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
  activeProfileId: string | null,
): RailEntry {
  return {
    harness,
    degraded: railHarnessDegraded(harness, degradedHarnessIds),
    accentDot: resolveAccentDot(profiles, activeProfileId),
  };
}

export interface VisibleRailEntriesInput {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >;
  /**
   * The profile whose accent color a harness's dot should reflect (the
   * browsed harness's active profile, and the composer's currently
   * *selected* harness's profile when browsing elsewhere); any other harness
   * falls back to its first selectable profile (typically ambient).
   */
  readonly activeProfileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>;
}

/**
 * The rail entries to render, in order - one per visible provider. Disabled/
 * unavailable providers that are not recoverable from the picker stay hidden.
 * Recoverable degraded providers (signed out or missing an API key) stay
 * visible, move below the ready providers, and show the model-list CTA when
 * selected. Shared by `ProviderRail` and the picker's ⌘-digit shortcut so the
 * digits line up with the badges on the SAME ordered list.
 */
export function visibleRailEntries(
  input: VisibleRailEntriesInput,
): ReadonlyArray<RailEntry> {
  const {
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
    profilesByHarnessId,
    activeProfileIdByHarnessId,
  } = input;
  return visibleRailHarnesses(
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
  ).map((harness) =>
    buildRailEntry(
      harness,
      profilesByHarnessId.get(harness.id) ?? [],
      degradedHarnessIds,
      activeProfileIdByHarnessId.get(harness.id) ?? null,
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
