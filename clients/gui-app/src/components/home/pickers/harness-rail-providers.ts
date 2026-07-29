import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";
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
  /** Non-null while this provider's managed pack is downloading or stuck on an
   *  error. The entry always stays VISIBLE and labelled - the dictation-mic
   *  treatment, not a hidden row - but this field alone does NOT decide
   *  selectability. `railEntryPackGated` does, and it gates only when
   *  `providerPackBlocksExecution` is also true; a pack downloading behind a
   *  bundled, PATH or custom binary the host would still spawn stays fully
   *  selectable and renders its progress as pure information. */
  readonly preparing: ProviderPackPreparing | null;
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

/**
 * The providers the rail renders, in order. Disabled/unavailable providers that
 * are not recoverable from the picker stay hidden. Recoverable degraded
 * providers (signed out or missing an API key) stay visible, move below the
 * ready providers, and show the model-list CTA when selected. Shared by
 * `ProviderRail` and the picker's ⌘-digit shortcut so the digits line up with
 * the badges on the SAME ordered list.
 *
 * A provider whose managed pack is still downloading also stays visible, and
 * that is load-bearing rather than cosmetic: on a first boot the host converges
 * every enabled provider (~1.6 GB), so `downloading` is the COMMON early state.
 * Hiding those rows would empty the picker on first run and then repopulate it
 * silently - the user would have no way to tell "not supported" from "arriving
 * in 30 seconds". They render gated and labelled instead, sorted below the
 * ready providers alongside the degraded ones.
 */
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
  // Asks whether the pack state BLOCKS, not whether one exists. Bare map
  // membership was coherent before the gate landed - a preparing tab was
  // unselectable, so sorting it down with the signed-out ones was honest.
  // Once a downloading pack stopped taking a runnable provider away, it made
  // the rail reorder itself throughout convergence: every enabled provider
  // sinks on a first boot and pops back up as its own install finishes, and
  // `PickerLeaderBadge` reads the rail index, so the whole set of ⌘-digits
  // reassigns once per completing pack. A user who learned that Codex is ⌘2
  // gets a different provider a minute later.
  //
  // Same predicate the tab's own appearance and click handler ask
  // (`railEntryPackGated`), so position cannot disagree with selectability.
  const deprioritized = (harness: HarnessOption): number => {
    const preparing = preparingByHarnessId.get(harness.id);
    return Number(
      railHarnessDegraded(harness, degradedHarnessIds) ||
        (preparing !== undefined && providerPackBlocksExecution(preparing)),
    );
  };
  return sortGuiHarnessesByProviderOrder(visible).toSorted(
    (left, right) => deprioritized(left) - deprioritized(right),
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

/**
 * True only while the host is probing a harness it has NO settled verdict for -
 * the one state where the picker must hold the entry inert (spinner, no click,
 * no ⌘-digit), because nothing is known about it yet.
 *
 * A probe that merely revalidates an already-settled harness reports
 * `availabilityPending` with that verdict intact (`available` stays true - see
 * `guiHarnessOptionSchema`), and must stay fully interactive: its cached model
 * list is still the best answer there is, and the host's availability cache
 * lapses every 30s, so keying the inert state on `availabilityPending` alone
 * blanked the picker on a routine background refresh.
 */
export function harnessAvailabilityUnsettled(harness: HarnessOption): boolean {
  return harness.availabilityPending && !harness.available;
}

function railHarnessVisible(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
  preparingByHarnessId: ReadonlyMap<GuiHarnessId, ProviderPackPreparing>,
): boolean {
  return (
    harness.available ||
    harnessAvailabilityUnsettled(harness) ||
    // A harness whose managed pack is still being prepared has no settled
    // availability yet either, and must stay in the rail so the user can see it
    // arriving rather than watch it pop into existence.
    preparingByHarnessId.has(harness.id) ||
    railHarnessDegraded(harness, degradedHarnessIds)
  );
}
