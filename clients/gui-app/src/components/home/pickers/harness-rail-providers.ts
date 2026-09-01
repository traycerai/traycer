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
 * visible IN PLACE - dimmed, and showing the model-list CTA when selected.
 * Shared by `ProviderRail` and the picker's ⌘-digit shortcut so the digits
 * line up with the badges on the SAME ordered list.
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
 * providers (signed out or missing an API key) stay visible IN PLACE - dimmed,
 * and showing the model-list CTA when selected. Shared by `ProviderRail` and
 * the picker's ⌘-digit shortcut so the digits line up with the badges on the
 * SAME ordered list.
 *
 * A provider whose managed pack is still downloading also stays visible, and
 * that is load-bearing rather than cosmetic: on a first boot the host converges
 * every enabled provider (~1.6 GB), so `downloading` is the COMMON early state.
 * Hiding those rows would empty the picker on first run and then repopulate it
 * silently - the user would have no way to tell "not supported" from "arriving
 * in 30 seconds". They render gated and labelled instead, and a pack that
 * BLOCKS execution is the one thing still sorted below the ready providers -
 * see `deprioritized` for why that survived and degradation did not.
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
  // unselectable, so sorting it down was honest. Once a downloading pack
  // stopped taking a runnable provider away, it made the rail reorder itself
  // throughout convergence: every enabled provider sinks on a first boot and
  // pops back up as its own install finishes, and `PickerLeaderBadge` reads
  // the rail index, so the whole set of ⌘-digits reassigns once per completing
  // pack. A user who learned that Codex is ⌘2 gets a different provider a
  // minute later.
  //
  // Same predicate the tab's own appearance and click handler ask
  // (`railEntryPackGated`), so position cannot disagree with selectability.
  //
  // DEGRADED IS DELIBERATELY NOT A TERM HERE, for the same reason one layer
  // up. A signed-out provider used to sink to the bottom of the rail, and the
  // verdict that decides it arrives asynchronously - from a separately-timed
  // `providers.list` query, or from an auth probe landing after first paint.
  // So the row a user had just clicked would slide to the far end of the rail
  // under them, ⌘-digits reassigning as it went. A row may CHANGE APPEARANCE
  // when a late verdict lands; it may not change place.
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

/**
 * A provider the picker treats as "needs attention": visible and dimmed where
 * it already sits, browse-only, and never the automatic landing spot while a
 * ready provider exists (`resolveActiveProviderId` states that preference
 * directly - position stopped implying it once the degraded sink went).
 *
 * DISABLED PROVIDERS ARE NOT DEGRADED, they are absent - hence the early
 * return. `railHarnessVisible` ORs degradation INTO visibility so a signed-out
 * provider stays browseable and fixable; applied to a provider the user
 * switched OFF, that same OR resurrects it as a dim "setup required" tab for
 * an account nobody asked to be reminded about. Disabled means gone from the
 * picker, and dimming is reserved for a provider the user DID enable and has
 * not signed into.
 *
 * Signed-out membership (`degradedHarnessIds`, derived from
 * `isProviderAmbientSignedOut`) degrades REGARDLESS of `harness.available`.
 * Availability is a binary-resolution/CLI probe that never consults auth, so
 * an installed provider whose ambient account is signed out still reports
 * `available: true` while every turn on it would bounce off the send gate -
 * which reads the same signed-out predicate. Gating this arm on
 * `!harness.available` is what let the rail offer a fully-lit, selectable tab
 * for a provider the composer would then refuse to run.
 *
 * The API-key arm stays availability-gated: `requiresApiKey` means the
 * provider authenticates BY key, and the point of degrading it is to keep an
 * unavailable entry visible for its add-key CTA rather than hiding the row.
 *
 * SOURCE UPGRADED, PREDICATE UNCHANGED. The signed-out arm now also reads the
 * catalog row's own `authStatus` (`agent.gui.listHarnesses@7.1`), which is what
 * closes the model-picker bug: `degradedHarnessIds` comes from a separately
 * timed `providers.list` query, so a provider that signed out during that
 * query's staleness window rendered as a fully-lit, selectable tab the send
 * gate would then refuse. The row travels with the harness the rail is already
 * rendering, so it cannot lag it.
 *
 * The two sources are OR'd rather than the row REPLACING the set, and that is
 * load-bearing. `degradedHarnessIdsFromProviderStates` reads
 * `isProviderAmbientSignedOut`, which reconciles TWO signals - the
 * provider-level probe and the ambient PROFILE row - precisely because they
 * transiently disagree, and the profile row is the one that flips first. The
 * catalog row carries the provider-level verdict only, so replacing the set
 * with it would re-open the exact half-converged case that predicate exists to
 * catch. OR keeps every source, and each is definitive-only, so no source can
 * degrade a provider the other would have cleared.
 */
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
  // Disabled is hidden, unconditionally, ahead of every other arm. The host
  // already reports a disabled provider `available: false`, so the arms below
  // would hide it anyway today - but each of them is a rule about a DIFFERENT
  // question (is the binary there, is a probe running, is a pack downloading),
  // and leaving "the user turned this off" to be an emergent consequence of
  // three unrelated predicates is how it stopped holding last time.
  if (!harness.enabled) return false;
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
