import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";
import { isHarnessRowSignedOut } from "@/lib/providers/provider-ambient-auth";
import {
  profileAccentDotInput,
  profileCommitId,
  type ProfileAccentDotInput,
} from "@/components/providers/provider-profile-model";
import {
  providerPackBlocksExecution,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";

/** Shared empty map so callers that have no provider data don't allocate one. */
export const EMPTY_PREPARING_BY_HARNESS_ID: ReadonlyMap<
  GuiHarnessId,
  ProviderPackPreparing
> = new Map();

/** Profile switching lives in the picker's profile dropdown (`@/components/providers/profile-dropdown`), never
 * the rail itself. */
export interface RailEntry {
  readonly harness: HarnessOption;
  /** Per-entry degraded state: the harness-level degraded flag (signed out / missing an API key). */
  readonly degraded: boolean;
  /** Bottom-right accent-dot data, present only when the provider has 2+ selectable profiles (progressive
   * disclosure - see the multi-profile decision log's "V1 surfaces" row). */
  readonly accentDot: ProfileAccentDotInput | null;
  /** `railEntryPackGated` does, and it gates only when `providerPackBlocksExecution` is also true. */
  readonly preparing: ProviderPackPreparing | null;
}

export function railEntryKey(harnessId: GuiHarnessId): string {
  return harnessId;
}

/** Resolves which profile is "active" for a harness with 2+ selectable profiles. */
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

function buildRailEntry(input: {
  readonly harness: HarnessOption;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly activeProfileId: string | null;
  readonly preparing: ProviderPackPreparing | null;
}): RailEntry {
  return {
    harness: input.harness,
    degraded: railHarnessDegraded(input.harness, input.degradedHarnessIds),
    accentDot: resolveAccentDot(input.profiles, input.activeProfileId),
    preparing: input.preparing,
  };
}

export interface VisibleRailEntriesInput {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly preparingByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ProviderPackPreparing
  >;
  readonly profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >;
  /** The profile whose accent color a harness's dot should reflect (the browsed harness's active profile, and the
   * composer's currently *selected* harness's profile when browsing elsewhere). */
  readonly activeProfileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>;
}

/** The rail entries to render, in order - one per visible provider. */
export function visibleRailEntries(
  input: VisibleRailEntriesInput,
): ReadonlyArray<RailEntry> {
  const {
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
    preparingByHarnessId,
    profilesByHarnessId,
    activeProfileIdByHarnessId,
  } = input;
  return visibleRailHarnesses(
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
    preparingByHarnessId,
  ).map((harness) =>
    buildRailEntry({
      harness,
      profiles: profilesByHarnessId.get(harness.id) ?? [],
      degradedHarnessIds,
      activeProfileId: activeProfileIdByHarnessId.get(harness.id) ?? null,
      preparing: preparingByHarnessId.get(harness.id) ?? null,
    }),
  );
}

/** Hiding those rows would empty the picker on first run and then repopulate it silently - the user would have
 * no way to tell "not supported" from "arriving in 30 seconds". */
export function visibleRailHarnesses(
  harnesses: ReadonlyArray<HarnessOption>,
  fallbackHarnesses: ReadonlyArray<HarnessOption>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
  preparingByHarnessId: ReadonlyMap<GuiHarnessId, ProviderPackPreparing>,
): ReadonlyArray<HarnessOption> {
  const source = harnesses.length > 0 ? harnesses : fallbackHarnesses;
  const visible = source.filter((harness) =>
    railHarnessVisible(harness, degradedHarnessIds, preparingByHarnessId),
  );
  // Asks whether the pack state blocks, not whether one exists. Same predicate the tab's own appearance and
  // click handler ask (`railEntryPackGated`), so position cannot disagree with selectability.
  const deprioritized = (harness: HarnessOption): number => {
    const preparing = preparingByHarnessId.get(harness.id);
    return Number(
      preparing !== undefined && providerPackBlocksExecution(preparing),
    );
  };
  return sortGuiHarnessesByProviderOrder(visible).toSorted(
    (left, right) => deprioritized(left) - deprioritized(right),
  );
}

/** Availability is a binary-resolution/CLI probe that never consults auth, so an installed provider whose
 * ambient account is signed out still reports `available. */
export function railHarnessDegraded(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): boolean {
  if (!harness.enabled) return false;
  return (
    isHarnessRowSignedOut(harness) ||
    degradedHarnessIds.has(harness.id) ||
    (!harness.available && harness.requiresApiKey)
  );
}

/** True only while the host is probing a harness it has NO settled verdict for - the one state where the picker
 * must hold the entry inert (spinner, no click, no ⌘-digit), because nothing is known about it yet. */
export function harnessAvailabilityUnsettled(harness: HarnessOption): boolean {
  return harness.availabilityPending && !harness.available;
}

function railHarnessVisible(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
  preparingByHarnessId: ReadonlyMap<GuiHarnessId, ProviderPackPreparing>,
): boolean {
  // Disabled is hidden, unconditionally, ahead of every other arm.
  if (!harness.enabled) return false;
  return (
    harness.available ||
    harnessAvailabilityUnsettled(harness) ||
    // A harness whose managed pack is still being prepared has no settled availability yet either, and must stay
    // in the rail so the user can see it arriving rather than watch it pop into existence.
    preparingByHarnessId.has(harness.id) ||
    railHarnessDegraded(harness, degradedHarnessIds)
  );
}
