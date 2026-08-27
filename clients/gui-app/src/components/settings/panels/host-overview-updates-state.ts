import { useState } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import {
  isMatchingStableRelease,
  isSameReleaseLine,
} from "@traycer-clients/shared/host-version/release-line";
import type {
  HostAvailableManifest,
  HostIncludePreReleasesSource,
  HostUpdateCheckResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type { VersionPickerProps } from "@/components/settings/panels/host-overview-advanced";
import type { HostVersionRow } from "@/components/settings/panels/host-version-rows";
import { VERSION_LIST_PREVIEW } from "@/components/settings/panels/host-settings-panel-model";
import {
  describeCliShellFailure,
  type CliShellFailure,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  useHostUpdateCheckQuery,
  useHostUpdateInstall,
} from "@/components/settings/panels/host-overview-rpc";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * A host's update story: what it can install, and installing it.
 *
 * Check now shells `host available --json` on the SCOPED host and the answer is
 * rendered as a version list with a per-row Install — the same list the local
 * recovery console has always shown for this computer, now available for a
 * remote host too, because `host.update.check` returns the whole manifest and
 * not just `latest`.
 *
 * It replaces a free-text version field that wrote `desiredVersion` to the
 * account registry. That control could not show what was installable, so it
 * accepted anything shaped like a version and found out later; and it was the
 * one update path that did not go through the host, which is why it needed its
 * own validation mirroring a server-side regex. Picking from what the host says
 * it has needs neither.
 *
 * What that costs, stated plainly: an OFFLINE host can no longer be pinned. The
 * pin was applied by the host's own reconciler on its next check-in and so
 * worked without a route, and this does not. The auto-update policy beside it
 * still does.
 *
 * The check is a QUERY: the list populates itself. See
 * `useHostUpdateCheckQuery` for why that overrode the "spawns a process, so ask
 * first" rule `host.doctor` still follows, and for what bounds the cost. Check
 * now is a forced refetch, which is the one thing that ignores `staleTime`.
 *
 * WHERE THE ANSWER GOES is split, and that split is the point. The card body
 * gets one line and at most two buttons — the state, Update now when there is
 * something to install, Check now — and the eleven-row version table it used to
 * hold open moved into the Advanced disclosure. A permanently-expanded list of
 * every historical version, with no way to collapse it, answered a question
 * ("which exact build do I want to pin to?") almost nobody asks, at the cost of
 * burying the one ("am I up to date?") everybody does.
 *
 * The state lives HERE rather than in either consumer because both read it: the
 * summary row needs `latest`, and the picker needs the whole manifest. This hook
 * is what keeps them from drifting into two checks with two answers.
 */
export function useHostOverviewUpdates(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  /** The scoped host this panel is showing — see the override reset below. */
  readonly hostId: string | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  /** Whether this host is worth asking at all — the page owns that gate. */
  readonly enabled: boolean;
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  readonly busy: boolean;
}): HostOverviewUpdatesState {
  const { client, hostName, installedVersion } = input;
  const [showAllVersions, setShowAllVersions] = useState(false);
  // `undefined` until the user touches the checkbox: the DEFAULT is the host's
  // own derivation, not a value this component picked. Only a deliberate
  // interaction produces `true`/`false`, which is what makes unchecking able to
  // exclude RC rows on a host whose default includes them.
  const [includePreReleasesOverride, setIncludePreReleasesOverride] = useState<
    boolean | undefined
  >(undefined);
  // The override belongs to the host it was expressed about. Settings can swap
  // the scoped host under a subtree `HostScopeGate` keeps mounted, and a filter
  // carried across that swap would silently apply one machine's decision to
  // another — worse, an explicit `false` would suppress the new host's RC rows
  // while its checkbox rendered the reason for a host no longer on screen.
  // Adjust-during-render on a changed input, the same shape as the discovered
  // refusal below; an effect would render one frame under the wrong filter.
  const [overrideHostId, setOverrideHostId] = useState(input.hostId);
  if (overrideHostId !== input.hostId) {
    setOverrideHostId(input.hostId);
    setIncludePreReleasesOverride(undefined);
  }
  // The INSTALL side's two failure lifetimes, deliberately kept apart. The
  // check's equivalents are no longer state at all — they are read straight off
  // the query's latest answer below.
  //
  // `installDiscovered` is STICKY: `cli-unavailable` and `externally-managed`
  // are facts about how this host is set up, not about this attempt, and
  // neither is knowable before we try. Once either is seen the whole region
  // retires and says so, because for an externally-managed host there is no
  // fallback control left to point at: it skips the update reconciler
  // outright, so neither this list nor the auto-update switch reaches it.
  // Leaving Check-now behind would keep offering the one action we have just
  // been told can never lead anywhere.
  //
  // Sticky is not PERMANENT, though — `HostScopeGate` keeps this subtree
  // mounted across disconnect/reconnect, so a latch that nothing refutes
  // would outlive the CLI being installed and the host restarted. The
  // `discoveredAt` stamp is what lets a check answer that arrived AFTER the
  // refusal clear it below; the ok answer TanStack retained from before the
  // install must not count as fresh evidence.
  const [installDiscovered, setInstallDiscovered] = useState<{
    readonly reason: OverviewDegradeReason;
    readonly discoveredAt: number;
  } | null>(null);
  // NOT sticky: `cli-failed` and `invalid-output` say this attempt went wrong,
  // not that the mechanism is unavailable, so the controls stay.
  const [installFailure, setInstallFailure] = useState<CliShellFailure | null>(
    null,
  );

  const checkQuery = useHostUpdateCheckQuery({
    client,
    enabled: input.enabled && input.checkDegrade === null,
    includePreReleases: includePreReleasesOverride,
  });
  const installMutation = useHostUpdateInstall(client);

  // Derived from the latest answer rather than accumulated across attempts.
  //
  // A query re-asks on its own schedule, so state that only ever LATCHED a
  // failure would outlive the condition that produced it: a host that gains a
  // Traycer CLI would keep a retired region until the page was remounted, and a
  // one-off `cli-failed` would keep its message under a list that had since
  // refreshed successfully. What the host last said is the whole truth here.
  const check = readCheckResponse(checkQuery.data ?? null);
  const manifest = check.manifest;
  // A check that SUCCEEDED after the refusal was discovered refutes
  // `cli-unavailable` — installing the CLI and restarting the host must not
  // leave the region retired until the user leaves the scope and returns.
  // Adjust-during-render, same as the panel's other derived corrections.
  if (
    checkRefutesDiscoveredRefusal({
      discovered: installDiscovered,
      manifest: check.manifest,
      checkDataUpdatedAt: checkQuery.dataUpdatedAt,
    })
  ) {
    setInstallDiscovered(null);
  }
  // Any one of these retires the region. `installDegrade` counts even though
  // checking would still work: learning about a version this host can never
  // install is not a capability, it is a tease.
  const degrade = resolveRegionDegrade({
    installDiscovered: installDiscovered?.reason ?? null,
    checkSticky: check.sticky,
    checkDegrade: input.checkDegrade,
    installDegrade: input.installDegrade,
  });
  const transientFailure = installFailure ?? check.transient;
  // `isFetching`, not `isPending`: a forced Check now over an answer already in
  // hand leaves `isPending` false, and the button would never show it was busy.
  const checking = checkQuery.isFetching;

  const runCheck = (): void => {
    void checkQuery.refetch();
  };

  const install = (version: string): void => {
    installMutation.mutate(
      { version, force: false },
      {
        // MOUNTED UI state only. The `host.status` invalidation this
        // used to do moved to `useHostUpdateInstall`'s hook-level
        // `onSuccess`: an install outlives a Settings scope switch,
        // which remounts this panel under its host key, and TanStack
        // drops per-`mutate` callbacks once the observer is gone.
        // Everything left here only touches state that is
        // meaningless without this component.
        onSuccess: (response) => {
          handleInstallOutcome({
            outcome: response.outcome,
            indeterminateReason:
              response.outcome === "dispatch-indeterminate"
                ? response.reason
                : null,
            hostName,
            version,
            // `Date.now()` here, in the settle, is what "after the refusal"
            // means for the render-time clear above: a retained ok answer
            // has an OLDER `dataUpdatedAt` and cannot refute this discovery.
            onSticky: (reason) => {
              setInstallDiscovered({ reason, discoveredAt: Date.now() });
              // One immediate re-ask puts the CLI's absence INTO the check's
              // own answer, where the table-owned condition poll
              // (`host-method-policy-table.ts`) owns recovery from there —
              // and if the CLI is somehow already back, this same ask is the
              // fresh ok that clears the latch above.
              if (reason === "cli-unavailable") void checkQuery.refetch();
            },
            onTransient: setInstallFailure,
            onAccepted: () => setInstallFailure(null),
          });
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't start the update."),
      },
    );
  };

  // While the CURRENT ask is in error, the retained manifest is display
  // history, not an actionable catalog: TanStack keeps the previous data
  // beside `isError`, and deriving install affordances from it would offer
  // versions the failed check could not confirm - under a summary that says
  // the host could not be checked.
  const actionableManifest = checkQuery.isError ? null : manifest;
  // The best STRICTLY NEWER version this catalog offers, before the yanked and
  // platform-asset gates - what the sentence is about, where
  // `updatableVersion` below is what the button can act on.
  //
  // PRECEDENCE, not equality: a host running a hotfix or RC AHEAD of the
  // stable channel is not outdated, and offering Update now there submits a
  // target the CLI short-circuits as `installed-up-to-date` - an update that
  // announces itself and performs no work. Equal precedence (build-metadata
  // differences included) and incomparable pairs both count as up to date for
  // the SUMMARY - the picker stays the surface for deliberate cross-channel
  // moves.
  const targetVersion = newerTargetVersion({
    manifest,
    installedVersion,
    source: check.source,
  });
  // Read off the resolved target rather than `manifest.latest`, which for an
  // installed-RC catalog is the WRONG pointer: `latest` tracks the stable
  // channel, so a host on `2.0.0-rc.1` sees `1.9.0` there and would be told it
  // was up to date while `2.0.0` sat in the same list, offerable.
  const upToDate =
    manifest !== null && installedVersion !== null && targetVersion === null;
  // The one state "up to date" would misdescribe: an `installed-rc` follower
  // whose own line has run out, while the catalog still lists something newer
  // on ANOTHER line. Not moving is deliberate — a follower must not be pushed
  // to a line nobody put it on — but rendering that as "running the latest
  // version" is a false claim about the catalog the user is looking at, with
  // an enabled row for a newer version directly beneath it.
  const strandedOnLine = strandedLineTarget({
    upToDate,
    manifest,
    installedVersion,
    source: check.source,
  });
  // The summary action resolves through the SAME availability checks as the
  // picker rows: a latest with no usable asset for this host is advertised
  // nowhere rather than installable in one surface and unavailable in the
  // other.
  const updatableVersion = offerableLatestVersion({
    manifest: actionableManifest,
    installedVersion,
    platformKey: input.platformKey,
    source: check.source,
  });
  const installingVersion = installMutation.isPending
    ? installMutation.variables.version
    : null;

  return {
    degrade,
    summary: {
      hostName,
      description: describeCheckState({
        manifest,
        checking,
        failure: transientFailure,
        unreachable: checkQuery.isError,
        hostName,
        upToDate,
        offerable: updatableVersion !== null,
        // What the BUTTON will install, when it can install anything. The two
        // differ whenever the best candidate is unusable: with a yanked
        // `2.0.0` on the line the offer walks down to `2.0.0-rc.3`, and a
        // sentence still naming `2.0.0` would advertise a version Update now
        // does not install. Falls back to the bare target so the
        // "available, but can't install it" case still names what it means.
        targetVersion: updatableVersion ?? targetVersion,
        strandedOnLine,
        installedVersion,
      }),
      transientFailure,
      checking,
      // Offered only for a latest that is BOTH known and not already installed,
      // and never while the row is still reporting a failed attempt. "Update
      // now" is a promise that pressing it changes something.
      updatableVersion,
      installing: installingVersion !== null,
      busy: input.busy,
      onCheck: runCheck,
      onUpdateLatest: () => {
        if (updatableVersion !== null) install(updatableVersion);
      },
    },
    picker: {
      rows: visibleVersionRows({
        manifest: actionableManifest,
        installedVersion,
        platformKey: input.platformKey,
        showAll: showAllVersions,
      }),
      totalCount: manifest?.versions.length ?? 0,
      showAll: showAllVersions,
      onToggleShowAll: () => setShowAllVersions((previous) => !previous),
      // What the box SHOWS is what the catalog actually did, not what this
      // component last decided. Before any interaction the override is absent,
      // so the host's own resolved inclusion is the honest answer — on an RC
      // host that renders the box ticked, matching the RC rows beside it.
      // Falls back to unticked only until the first answer arrives.
      includePreReleases: resolveCheckboxState(
        includePreReleasesOverride,
        check.effectiveIncludePreReleases,
      ),
      // The first interaction turns the absent state into an explicit one, and
      // never returns to absent: the user has now expressed a filter, and
      // silently reverting to the derived default would make unticking on an
      // RC host appear to do nothing. Scope changes reset it — see above.
      //
      // Just moves the flag. It is part of the QUERY KEY, so changing it asks
      // the host a different question by itself — no explicit re-check, and no
      // risk of the two drifting apart the way an imperative re-ask could.
      onIncludePreReleasesChange: setIncludePreReleasesOverride,
      includePreReleasesExplanation: describeIncludePreReleasesSource(
        check.source,
        installedVersion,
      ),
      installingVersion,
      disabled: input.busy,
      onInstall: install,
      awaitingFirstCheck: actionableManifest === null,
      checking,
    },
  };
}

export interface HostOverviewUpdatesSummary {
  readonly hostName: string;
  readonly description: string;
  readonly transientFailure: CliShellFailure | null;
  readonly checking: boolean;
  readonly updatableVersion: string | null;
  readonly installing: boolean;
  readonly busy: boolean;
  readonly onCheck: () => void;
  readonly onUpdateLatest: () => void;
}

export interface HostOverviewUpdatesState {
  readonly degrade: OverviewDegradeReason | null;
  readonly summary: HostOverviewUpdatesSummary;
  readonly picker: VersionPickerProps;
}

/**
 * The manifest, projected to rows and sliced to the preview.
 *
 * Order is the manifest's own — the registry publishes newest first, and
 * re-sorting client-side would mean parsing versions this list has no business
 * having an opinion about (a staging build id is not semver, and the CLI's own
 * comparator treats non-numeric segments as zero).
 */
function visibleVersionRows(input: {
  /** `null` before the first check has answered — then there are no rows. */
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  readonly showAll: boolean;
}): readonly HostVersionRow[] {
  const { manifest } = input;
  if (manifest === null) return [];
  const entries = input.showAll
    ? manifest.versions
    : manifest.versions.slice(0, VERSION_LIST_PREVIEW);
  return entries.map((entry) => {
    const asset = platformAssetFor(entry.platforms, input.platformKey);
    const isInstalled = entry.version === input.installedVersion;
    return {
      version: entry.version,
      releasedAt: entry.releasedAt,
      yanked: entry.yanked,
      isLatest: entry.version === manifest.latest,
      isInstalled,
      unavailableReason:
        assetUnavailableReason(asset) ??
        (isInstalled
          ? null
          : supersededReason(input.installedVersion, entry.version)),
    };
  });
}

/**
 * The version the summary's Update now may offer, or `null`.
 *
 * Four gates, all of which the picker enforces per row and the summary must
 * therefore enforce for its one target: the manifest must be from a check the
 * host CONFIRMED (not error-retained data), the target must be strictly newer
 * than what is installed, its entry must not be YANKED (the row disables it and
 * the CLI's `resolveAsset` refuses it before download, so an offer here would
 * dispatch an install the host is guaranteed to reject), and the entry must
 * resolve a usable asset for this host's platform.
 *
 * WHICH version is the target depends on how the catalog was resolved, and
 * that is the whole reason provenance rides on the response. For an
 * `installed-rc` DEFAULT the answer is not `manifest.latest`: `latest` is
 * stable-CHANNEL metadata, so on a host running `2.0.0-rc.1` it can still read
 * `1.9.0` while `2.0.0` is published — offering `latest` there would offer a
 * DOWNGRADE, and the strictly-newer gate would then offer nothing at all.
 * Every other provenance keeps the plain `latest` behaviour, including an
 * explicit include: a user who asked for the broad catalog gets the broad
 * catalog's own pointer rather than a line restriction they did not request.
 */
function offerableLatestVersion(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): string | null {
  const { manifest } = input;
  if (manifest === null) return null;
  for (const candidate of targetCandidates({
    manifest,
    installedVersion: input.installedVersion,
    source: input.source,
  })) {
    if (
      input.installedVersion !== null &&
      !latestIsStrictlyNewer(input.installedVersion, candidate)
    ) {
      continue;
    }
    const entry = manifest.versions.find(
      (version) => version.version === candidate,
    );
    if (entry === undefined || entry.yanked) continue;
    const asset = platformAssetFor(entry.platforms, input.platformKey);
    if (assetUnavailableReason(asset) === null) return candidate;
  }
  return null;
}

/**
 * The best strictly-newer version in the catalog, ignoring installability.
 *
 * Separate from `offerableLatestVersion` because the summary says two
 * different things: whether an update EXISTS (this) and whether it can be
 * installed here (that). Collapsing them would make a yanked or
 * wrong-platform target read as "running the latest version", which is a
 * different — and false — claim.
 */
function newerTargetVersion(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): string | null {
  const { manifest, installedVersion } = input;
  if (manifest === null) return null;
  const candidates = targetCandidates({
    manifest,
    installedVersion,
    source: input.source,
  });
  if (installedVersion === null) return candidates[0] ?? null;
  return (
    candidates.find((candidate) =>
      latestIsStrictlyNewer(installedVersion, candidate),
    ) ?? null
  );
}

/**
 * The target versions to try, best first.
 *
 * For an `installed-rc` default this is the plan's same-line priority, and the
 * ORDER is the termination guarantee: matching stable `X.Y.Z` outranks every
 * later `X.Y.Z-rc.M`, so an RC that can reach its stable takes it and the next
 * launch derives `stable-only` with nothing to undo. Later RCs on the same line
 * follow, newest first, for the window before that stable exists.
 *
 * A LIST rather than one pick, because each candidate still has to clear the
 * yanked/asset gates above — "prefer stable IF USABLE, otherwise the highest
 * later RC" cannot be expressed by choosing before those run.
 *
 * Mirrors `resolveSameLineTarget` in desktop main's `host-stage-policy.ts`,
 * which makes the same choice for background staging. The duplication is
 * forced — that module is Electron-main-only and this one is browser-safe —
 * but both read the release-line vocabulary from the same shared helpers, so
 * only the ordering is restated, never what an RC or a line IS.
 */
function targetCandidates(input: {
  readonly manifest: HostAvailableManifest;
  readonly installedVersion: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): readonly string[] {
  const installed = input.installedVersion;
  if (input.source !== "installed-rc" || installed === null) {
    return [input.manifest.latest];
  }
  const versions = input.manifest.versions.map((entry) => entry.version);
  const matchingStable = versions.filter((version) =>
    isMatchingStableRelease(version, installed),
  );
  // EXCLUDING the matching stable, which also satisfies both predicates below
  // — it is on the line and strictly newer. Without this the stable is
  // returned twice, and `offerableLatestVersion` pays for a second yanked and
  // platform-asset probe on a candidate it already accepted or rejected.
  const laterOnLine = versions
    .filter(
      (version) =>
        !matchingStable.includes(version) &&
        isSameReleaseLine(installed, version) &&
        isStrictlyNewerHostVersion(version, installed),
    )
    .sort(compareNewestFirst);
  return [...matchingStable, ...laterOnLine];
}

/**
 * The newer version this host will not take on its own, or `null`.
 *
 * Gated on `installed-rc` PROVENANCE, not merely on there being something
 * newer. The copy it feeds says the host "follows its own release line", and
 * that is only true of a host whose catalog was derived from an installed
 * release candidate. A STABLE host with explicit inclusion is the case this
 * gate exists for: it is on the newest stable, `latest` names that stable, and
 * a newer RC row appears only because the user asked to see RCs — it follows
 * no line, and telling it otherwise would explain its state with a mechanism
 * that does not apply to it. Those RC rows stay manually installable either
 * way; only the sentence changes.
 *
 * Also gated on `upToDate`, which lives here rather than at the call site
 * where it was one more branch in an already dense hook.
 */
function strandedLineTarget(input: {
  readonly upToDate: boolean;
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): string | null {
  if (!input.upToDate || input.source !== "installed-rc") return null;
  return newestNewerVersion(input.manifest, input.installedVersion);
}

/**
 * What the checkbox SHOWS: the user's override once expressed, otherwise the
 * catalog's own resolved inclusion, otherwise unticked until the first answer.
 */
function resolveCheckboxState(
  override: boolean | undefined,
  effective: boolean | null,
): boolean {
  if (override !== undefined) return override;
  return effective ?? false;
}

/**
 * The newest version in the catalog that is strictly newer than what is
 * installed, ignoring release lines entirely — or `null` when there is none.
 *
 * Deliberately unrestricted, unlike `targetCandidates`. This does not decide
 * what to OFFER; it answers whether the summary may claim "running the latest
 * version". A follower with an exhausted line is not on the newest build the
 * catalog knows about, and saying so is what keeps the sentence honest while
 * the automatic policy stays unchanged.
 */
function newestNewerVersion(
  manifest: HostAvailableManifest | null,
  installedVersion: string | null,
): string | null {
  if (manifest === null || installedVersion === null) return null;
  const newer = manifest.versions
    .map((entry) => entry.version)
    .filter((version) => isStrictlyNewerHostVersion(version, installedVersion))
    .sort(compareNewestFirst);
  return newer[0] ?? null;
}

/**
 * Newest first, and a LAWFUL comparator: it returns 0 for pairs that are equal
 * or that cannot be compared at all.
 *
 * The obvious `isStrictlyNewer(a, b) ? -1 : 1` is not lawful — it answers `1`
 * in both directions for such a pair, violating antisymmetry. Registry
 * versions are unique valid SemVer so nothing misorders today, but a
 * comparator whose correctness rests on its input never containing a tie is
 * one duplicate away from an unstable sort.
 */
function compareNewestFirst(a: string, b: string): number {
  if (isStrictlyNewerHostVersion(a, b)) return -1;
  if (isStrictlyNewerHostVersion(b, a)) return 1;
  return 0;
}

/**
 * Whether `latest` is STRICTLY newer than the installed version - the only
 * state in which the summary offers Update now.
 */
function latestIsStrictlyNewer(
  installedVersion: string,
  latest: string,
): boolean {
  const comparison = compareHostVersions(installedVersion, latest);
  return comparison.comparable && comparison.ordering === "less";
}

/**
 * Why a row below the installed version cannot be installed.
 *
 * This mirrors the CLI's own short-circuit rather than inventing a policy:
 * `download-stage.ts` computes `installedAtOrAboveTarget` and returns
 * `installed-up-to-date` for a target at OR BELOW what is installed, then skips
 * the apply and writes no progress marker. The RPC has already answered
 * `accepted` by then, so an enabled button here would toast "Updating…" for a
 * host that will do nothing and report nothing — the list would be lying about
 * an action it cannot perform.
 *
 * Incomparable pairs are deliberately left installable. `compareHostVersions`
 * refuses anything non-semver, a staging build id is not semver, and the CLI
 * applies the same refusal — an incomparable target does NOT short-circuit
 * there, so it must not be blocked here.
 */
function supersededReason(
  installedVersion: string | null,
  rowVersion: string,
): string | null {
  if (installedVersion === null) return null;
  const comparison = compareHostVersions(installedVersion, rowVersion);
  if (!comparison.comparable || comparison.ordering === "less") return null;
  return `Already on v${installedVersion}`;
}

/**
 * Which platform's asset this row is about — the host's, never this computer's.
 *
 * A sole entry is USUALLY the host's own answer: the host's CLI projects
 * every entry to `currentHostPlatformKey()` before emitting it
 * (`host-available.ts`). But an OLDER CLI emits the whole map, and a version
 * released for a single platform gives that map exactly one key too — one
 * that can belong to another OS entirely. The two shapes are not
 * distinguishable from the entry alone, so a sole key is VALIDATED against
 * the registry's platform string rather than trusted outright; the
 * validation must still accept the emulated `win32-x64` answer a win32-arm64
 * host projects, which a key derived here would get wrong.
 *
 * More than one key means an OLDER CLI that emitted the whole map. Then the
 * registry's platform string is the only thing available to pick with, and a
 * miss is reported as "no asset" rather than guessed at.
 */
function platformAssetFor(
  platforms: HostAvailableManifest["versions"][number]["platforms"],
  platformKey: string | null,
): PlatformAsset | null {
  const keys = Object.keys(platforms);
  if (keys.length === 1) {
    return soleKeyBelongsToHost(keys[0], platformKey)
      ? (platforms[keys[0]] ?? null)
      : null;
  }
  if (platformKey === null) return null;
  if (platformKey in platforms) return platforms[platformKey] ?? null;
  // A registry row can carry an OS-only key ("darwin") while an older CLI's
  // un-projected manifest is architecture-qualified ("darwin-arm64"). A
  // UNIQUE prefix match is that OS's one asset and is taken; several
  // candidates stay a miss rather than a guess - reported as "no asset",
  // never resolved to the wrong architecture.
  const prefixed = keys.filter((key) => key.startsWith(`${platformKey}-`));
  if (prefixed.length === 1) return platforms[prefixed[0]] ?? null;
  return null;
}

/**
 * Whether a manifest entry's SOLE platform key can be this host's answer.
 *
 * Accepts the same shapes the multi-key path accepts — an exact match, or an
 * arch-qualified key under an OS-only registry string — plus the one mapping
 * the host CLI itself applies: `currentHostPlatformKey()` resolves
 * win32-arm64 to the emulated `win32-x64` build, so that pair is a genuine
 * projected answer, not a foreign asset. With no registry platform to check
 * against, the sole key is taken as-is — rejecting it would blank every row
 * for hosts whose registry record predates the platform field. Anything else
 * is a legacy single-platform release for some OTHER host, and refusing it
 * here mirrors the refusal the host CLI's own `resolveAsset` would produce
 * at install time.
 */
function soleKeyBelongsToHost(
  soleKey: string,
  platformKey: string | null,
): boolean {
  if (platformKey === null) return true;
  if (soleKey === platformKey) return true;
  if (soleKey.startsWith(`${platformKey}-`)) return true;
  return platformKey === "win32-arm64" && soleKey === "win32-x64";
}

type PlatformAsset =
  HostAvailableManifest["versions"][number]["platforms"][string];

function assetUnavailableReason(asset: PlatformAsset | null): string | null {
  if (asset === null) return "No asset for this platform.";
  if (asset.available) return null;
  const reason = asset.unavailableReason?.trim();
  return reason === undefined || reason.length === 0
    ? "Unavailable on this platform."
    : reason;
}

/**
 * Which refusals retire the REGION and which are just a bad attempt.
 *
 * `cli-unavailable` is structural — there is no Traycer CLI on that host to
 * shell, so no amount of retrying changes it. `externally-managed` is a
 * deliberate configuration (`TRAYCER_HOST_UPDATES=external`), and the cloud pin
 * is the supported control there. Both make every control in this region dead,
 * so both retire it.
 *
 * `cli-failed` / `invalid-output` are this attempt going wrong with the
 * mechanism intact. Retiring the region for those would take the retry away
 * from the person best placed to use it.
 */
/**
 * Whether a check answer refutes the install-discovered refusal.
 *
 * `host.update.check` shells the very CLI the install could not find, so an
 * ok answer NEWER than the discovery proves the CLI is back. The stamp
 * comparison is what keeps the ok answer TanStack retained from BEFORE the
 * install from counting as fresh evidence. `externally-managed` deliberately
 * never clears here: the check's outcome union has no externally-managed arm
 * (schemas.ts), so an ok check is what an externally-managed host answers
 * TOO — it says nothing about that refusal.
 */
function checkRefutesDiscoveredRefusal(input: {
  readonly discovered: {
    readonly reason: OverviewDegradeReason;
    readonly discoveredAt: number;
  } | null;
  readonly manifest: HostAvailableManifest | null;
  readonly checkDataUpdatedAt: number;
}): boolean {
  return (
    input.discovered !== null &&
    input.discovered.reason === "cli-unavailable" &&
    input.manifest !== null &&
    input.checkDataUpdatedAt > input.discovered.discoveredAt
  );
}

/** Precedence over the region's four retirement sources, first one wins. */
function resolveRegionDegrade(input: {
  readonly installDiscovered: OverviewDegradeReason | null;
  readonly checkSticky: OverviewDegradeReason | null;
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
}): OverviewDegradeReason | null {
  return (
    input.installDiscovered ??
    input.checkSticky ??
    input.checkDegrade ??
    input.installDegrade
  );
}

function stickyDegradeFor(
  outcome: CliShellFailure | "externally-managed",
): OverviewDegradeReason | null {
  if (outcome === "cli-unavailable") return "cli-unavailable";
  if (outcome === "externally-managed") return "externally-managed";
  return null;
}

function handleInstallOutcome(input: {
  readonly outcome:
    | "accepted"
    | "externally-managed"
    | "cli-unavailable"
    | "cli-failed"
    | "already-updating"
    | "dispatch-indeterminate";
  /**
   * The `dispatch-indeterminate` cause, when the host named one. `null` on
   * every other arm, and also when that arm declines to say.
   *
   * Carried rather than dropped because three different causes reach that one
   * outcome — an ACK timeout, the child exiting, and a bad or missing ACK — and
   * flattening them into a single opaque message is the diagnostic
   * substitution this epic has already paid for three times.
   */
  readonly indeterminateReason: string | null;
  readonly hostName: string;
  readonly version: string;
  readonly onSticky: (reason: OverviewDegradeReason) => void;
  readonly onTransient: (failure: CliShellFailure) => void;
  readonly onAccepted: () => void;
}): void {
  if (input.outcome === "accepted") {
    input.onAccepted();
    toast.success(`Updating ${input.hostName} to v${input.version}`);
    return;
  }
  if (input.outcome === "already-updating") {
    // Not a failure, and deliberately not sticky: the host refused because it
    // is BUSY doing the thing this button asks for. The page-wide lock makes
    // this rare from here, but it cannot be airtight — that lock reads
    // `host.status.updateProgress`, which the CLI does not write until
    // download and staging are already done, and it binds only this window.
    // This arm is what a second window, a direct CLI caller, or a click inside
    // that blind gap gets told.
    input.onAccepted();
    toast.info(`${input.hostName} is already installing an update.`);
    return;
  }
  if (input.outcome === "dispatch-indeterminate") {
    // NOT a success and NOT a failure — the host spawned a detached CLI and
    // cannot attribute a durable attempt to this call. An update may well be
    // running, so this must not read as "nothing happened"; equally it may not
    // read as "updating", because nothing here can name what would be updating.
    //
    // `onAccepted()` clears the transient CLI-failure state, which is correct:
    // the CLI did not fail to run. It does NOT arm the accepted latch — that
    // lives in `useHostUpdateInstall` and is deliberately reserved for
    // `accepted`, since a 60s lockout over an outcome nobody can attribute
    // would freeze the very controls a person would use to find out.
    //
    // The live answer comes from `host.status.updateOperation`, which is the
    // negotiated route for progress and is unaffected by this arm.
    input.onAccepted();
    toast.info(
      input.indeterminateReason === null
        ? `Couldn't confirm the update started on ${input.hostName}. Watching for progress.`
        : `Couldn't confirm the update started on ${input.hostName}: ${input.indeterminateReason}. Watching for progress.`,
    );
    return;
  }
  if (
    input.outcome === "externally-managed" ||
    input.outcome === "cli-unavailable"
  ) {
    // `stickyDegradeFor` owns the classification; this branch only exists so
    // the remaining arm narrows to a `CliShellFailure` for the transient path.
    const sticky = stickyDegradeFor(input.outcome);
    if (sticky !== null) input.onSticky(sticky);
    return;
  }
  input.onTransient(input.outcome);
}

function describeCheckState(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly checking: boolean;
  readonly failure: CliShellFailure | null;
  /** The RPC itself failed — a transport fault, not an answer from the host. */
  readonly unreachable: boolean;
  readonly hostName: string;
  readonly upToDate: boolean;
  /** `updatableVersion` resolved — the summary can actually OFFER the latest. */
  readonly offerable: boolean;
  /** The strictly-newer version this sentence is about, if there is one. */
  readonly targetVersion: string | null;
  /**
   * Set only when this host's own release line has no newer candidate but the
   * catalog does — the state "running the latest version" would misdescribe.
   */
  readonly strandedOnLine: string | null;
  readonly installedVersion: string | null;
}): string {
  // Ordered so a stale answer never outranks what is happening NOW: a refetch
  // keeps the previous manifest on screen, so "vX is available." would otherwise
  // sit there unchanged while a re-check ran, or failed.
  if (input.checking) return "Checking for updates…";
  if (input.failure !== null) {
    return describeCliShellFailure(input.failure, input.hostName);
  }
  if (input.unreachable) {
    // Deliberately NOT a toast, which is what the imperative check's `onError`
    // raised. This read now fires on its own, and an automatic request that
    // toasts on failure turns an unreachable host into a notification nobody
    // asked for, once per visit to this page.
    return `Couldn't ask ${input.hostName} which versions it can install.`;
  }
  // No answer yet and nothing wrong: the first load, which now starts by itself.
  if (input.manifest === null) return "Checking for updates…";
  if (input.upToDate) {
    // Honest about BOTH halves: the newer version exists, and this host will
    // not take it on its own. Naming the installed version names the line, and
    // pointing at the list is not decoration — those rows are enabled, and
    // they are the only way across.
    if (input.strandedOnLine !== null && input.installedVersion !== null) {
      return `v${input.strandedOnLine} is available, but ${input.installedVersion} follows its own release line and won't update to it automatically. Pick it below to move.`;
    }
    return "This host is running the latest version.";
  }
  // Nothing strictly newer to name — an unknown installed version leaves the
  // comparison undecidable, so the catalog is reported without a claim about
  // whether this host is behind it.
  const target = input.targetVersion;
  if (target === null) return "This host is running the latest version.";
  // A target this host cannot act on — yanked, or no asset for its platform.
  // Claiming plain availability here would put the sentence at odds with the
  // absent button; the version list carries the specific reason.
  if (!input.offerable) {
    return `v${target} is available, but ${input.hostName} can't install it.`;
  }
  return `v${target} is available.`;
}

/**
 * Why this catalog includes release candidates, when that is worth saying.
 *
 * Gated on `installed-rc` ALONE, and that single condition is also what
 * satisfies "omit the explanation for a negotiated v1.0 response" — no version
 * check needed. A v1.0 host cannot produce this value: its response carries no
 * provenance at all, and the v1.0→v1.1 bridge deliberately answers
 * `explicit-include` or `stable-default` and never `installed-rc`, precisely
 * because it must not assert a derivation the old peer never performed. So the
 * one provenance that unlocks copy here is the one only a v1.1 host can send.
 *
 * Nothing is said for the other three. `explicit-include` and
 * `explicit-exclude` restate the user's own click, and `stable-default` is the
 * unremarkable case — a line of prose under each would be noise that makes the
 * one meaningful explanation harder to notice.
 *
 * This is PROVENANCE, not a saved setting: the copy says the host is following
 * its current release-candidate line, and must never imply a stored
 * preference, because there is none to turn off.
 */
function describeIncludePreReleasesSource(
  source: HostIncludePreReleasesSource | null,
  installedVersion: string | null,
): string | null {
  if (source !== "installed-rc") return null;
  return installedVersion === null
    ? "This host is on a release candidate, so its own line is listed."
    : `This host is on ${installedVersion}, so its own release-candidate line is listed.`;
}

/**
 * The check's latest answer, split into the three things the page renders from
 * it: the manifest, a reason to retire the region, and a reason to retry.
 *
 * "Nothing asked yet" and an `ok` answer both mean "no failure", which is why
 * the two collapse here rather than at every use site.
 */
function readCheckResponse(response: HostUpdateCheckResponseV11 | null): {
  readonly manifest: HostAvailableManifest | null;
  readonly sticky: OverviewDegradeReason | null;
  readonly transient: CliShellFailure | null;
  /** The host's resolved inclusion, or `null` when it did not answer `ok`. */
  readonly effectiveIncludePreReleases: boolean | null;
  readonly source: HostIncludePreReleasesSource | null;
} {
  if (response === null) {
    return {
      manifest: null,
      sticky: null,
      transient: null,
      effectiveIncludePreReleases: null,
      source: null,
    };
  }
  if (response.outcome === "ok") {
    return {
      manifest: response.manifest,
      sticky: null,
      transient: null,
      effectiveIncludePreReleases: response.effectiveIncludePreReleases,
      source: response.includePreReleasesSource,
    };
  }
  // `stickyDegradeFor` owns the classification, and it is deliberately wider
  // than this response: `externally-managed` is an INSTALL outcome, which the
  // check schema does not carry. Naming it here as well was dead code the
  // compiler rejected — the shared classifier is what keeps the two paths
  // agreeing about which refusals are structural.
  const sticky = stickyDegradeFor(response.outcome);
  if (sticky !== null) {
    return {
      manifest: null,
      sticky,
      transient: null,
      effectiveIncludePreReleases: null,
      source: null,
    };
  }
  return {
    manifest: null,
    sticky: null,
    transient: response.outcome,
    effectiveIncludePreReleases: null,
    source: null,
  };
}
