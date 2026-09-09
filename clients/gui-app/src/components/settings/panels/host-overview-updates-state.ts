import { useEffect, useState } from "react";
import type { HostStatusStoreFormats } from "@traycer/protocol/host/status/index";
import {
  hostStoreFormatRestriction,
  hostStoreFormatRestrictionFromRpc,
  type HostStoreFormatRestriction,
  describeHostStoreFloorRpcRefusal,
} from "./host-overview-store-formats";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  baseDispatchAckReason,
  dispatchAckReasonClosedStaleAttempt,
} from "@traycer/protocol/config/host-update-ack-reason";
import {
  compareHostVersions,
  isValidHostVersion,
  isStrictlyNewerHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import {
  HOST_CLIENT_FLOOR_REASON_PREFIX,
  isHostClientFloorRefusedAsset,
} from "@traycer-clients/shared/host-version/client-floor-reason";
import {
  isMatchingStableRelease,
  isSameReleaseLine,
} from "@traycer-clients/shared/host-version/release-line";
import type {
  HostAvailableManifest,
  HostIncludePreReleasesSource,
  HostUpdateCheckResponseV12,
  HostUpdateInstallResponseV13,
  HostUpdateStoreFloorRefusal,
} from "@traycer/protocol/host/maintenance/index";
import type { StoredCliInstallManifest } from "@traycer/protocol/config/installation-records";
import type { DesktopAppUpdateSnapshot } from "@/lib/windows/types";
import {
  describeCliFloorRemedy,
  type CliFloorRemedy,
} from "@/components/settings/panels/host-overview-cli-floor-remedy";
import type { VersionPickerProps } from "@/components/settings/panels/host-overview-advanced";
import type { HostVersionRow } from "@/components/settings/panels/host-version-rows";
import { VERSION_LIST_PREVIEW } from "@/components/settings/panels/host-settings-panel-model";
import {
  describeCliShellFailure,
  type CliShellFailure,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  useHostUpdateActivate,
  useHostUpdateCheckQuery,
  useHostUpdateContinue,
  useHostUpdateInstall,
  type BoundDispatchResponse,
} from "@/components/settings/panels/host-overview-rpc";
import {
  useHostNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import type { FleetUpdateAttemptPosition } from "@/lib/host/fleet-update/fleet-update-view";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * How often the catalog is re-asked while a CLI-floor remedy is on screen. A
 * fixed cadence, not a backoff: the thing being waited on is a person running
 * the copied command, and the remedy's copy promises the page notices.
 */
export const CLI_FLOOR_RECHECK_MS = 30_000;

/**
 * The version the catalog is compared against: the install record's under
 * activation debt, the process's otherwise. Kept out of the hook body so the
 * hook stays under the complexity ceiling.
 */
function comparisonBaseline(
  activationDebt: { readonly installedVersion: string } | null,
  runningVersion: string | null,
): string | null {
  if (activationDebt !== null) return activationDebt.installedVersion;
  return runningVersion;
}

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
  /** What the PROCESS reports about itself (`host.status.hostVersion`). */
  readonly runningVersion: string | null;
  readonly storeFormats: HostStatusStoreFormats | null;
  /**
   * The install record is ahead of the running host (`legacy-update-facts.ts`).
   * When set, every catalog comparison below is against the INSTALLED version,
   * not the running one: the bytes on disk are what the next restart serves,
   * so "is there something newer" is a question about them. Comparing
   * against the running version would re-offer the version that is already
   * installed as "Update now", and pressing it would find nothing to do.
   */
  readonly activationDebt: {
    readonly installedVersion: string;
    /**
     * Whether the record read this debt came from is live
     * (`canonicalReadIsLive` over the installation leg). A retained read
     * still sets the comparison baseline - the bytes on disk do not change
     * because a poll failed, and dropping the baseline would re-offer the
     * installed version as "available" - but the sentence says so, and the
     * page withholds the Restart until the read is live again.
     */
    readonly live: boolean;
  } | null;
  readonly platformKey: string | null;
  readonly cliManifest: StoredCliInstallManifest | null;
  readonly isLocalMachine: boolean;
  readonly desktopUpdate: DesktopAppUpdateSnapshot | null;
  readonly stagedVersion: string | null;
  /** Whether this host is worth asking at all — the page owns that gate. */
  readonly enabled: boolean;
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  readonly busy: boolean;
  /**
   * The dispatching panel mount's token (D8), threaded to all three update
   * dispatches so an `accepted` answer can be attributed to the mount that
   * asked for it. See `host-overview-rpc.ts`'s `settleUpdateDispatch`.
   */
  readonly incarnation: string;
}): HostOverviewUpdatesState {
  const { client, hostName } = input;
  // The version the catalog is compared against. Under activation debt that
  // is the install record's, not the process's - see `activationDebt`.
  const installedVersion = comparisonBaseline(
    input.activationDebt,
    input.runningVersion,
  );
  const installVersion = useHostNegotiatedMethodVersion(
    client,
    "host.update.install",
  );
  const supportsDowngrade = versionSupportsDowngrade(installVersion);
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
  const [forceRefusal, setForceRefusal] = useState<ForceUpdateRefusal | null>(
    null,
  );

  const checkQuery = useHostUpdateCheckQuery({
    client,
    enabled: input.enabled && input.checkDegrade === null,
    includePreReleases: includePreReleasesOverride,
  });
  const installMutation = useHostUpdateInstall(client, input.incarnation);
  const bound = useBoundUpdateDispatches({
    client,
    hostId: input.hostId,
    hostName,
    incarnation: input.incarnation,
    beforeDispatch: () => setForceRefusal(null),
    onAccepted: () => setInstallFailure(null),
  });

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
    storeFloor.clear();
    setForceRefusal(null);
    void checkQuery.refetch();
  };

  const install = (
    version: string,
    force: boolean,
    acceptStoreFormatLoss: boolean,
    // The caller's own settle hook, for UI that opened a confirmation over
    // this dispatch and has to close it whatever the answer was. MOUNTED
    // state only, like the callbacks beside it.
    onSettled: (() => void) | null,
  ): void => {
    setForceRefusal(null);
    if (!storeFloor.prepareInstall(version, acceptStoreFormatLoss)) {
      onSettled?.();
      return;
    }
    installMutation.mutate(
      { version, force, acceptStoreFormatLoss },
      {
        onSettled: () => onSettled?.(),
        // MOUNTED UI state only. The `host.status` invalidation this
        // used to do moved to `useHostUpdateInstall`'s hook-level
        // `onSuccess`: an install outlives a Settings scope switch,
        // which remounts this panel under its host key, and TanStack
        // drops per-`mutate` callbacks once the observer is gone.
        // Everything left here only touches state that is
        // meaningless without this component.
        onSuccess: (response) => {
          if (storeFloor.recordRefusal(response)) {
            setInstallFailure(null);
            return;
          }
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
  // A repaired refusal must not return when a later check loses its catalog.
  // Retire it on a newer successful answer, using the same guarded render
  // adjustment as installDiscovered; hiding the text alone keeps stale state.
  retireForceRefusalIfRefuted({
    refusal: forceRefusal,
    manifest: actionableManifest,
    checkDataUpdatedAt: checkQuery.dataUpdatedAt,
    checkSucceeded: checkQuery.isSuccess,
    checkIsPlaceholderData: checkQuery.isPlaceholderData,
    platformKey: input.platformKey,
    hostName,
    retire: () => setForceRefusal(null),
  });
  const storeFloor = useHostInstallStoreFloor({
    hostId: input.hostId,
    installSupportsStoreFloor: versionSupportsStoreFloor(installVersion),
    hostName,
    runningVersion: input.runningVersion,
    storeFormats: input.storeFormats,
    manifest: actionableManifest,
    fallbackFailure: describeUpdateFailure({
      refusal: forceRefusal,
      manifest: actionableManifest,
      platformKey: input.platformKey,
      failure: transientFailure,
      hostName,
    }),
  });
  const { failureDescription } = storeFloor;
  // The best STRICTLY NEWER version this catalog offers, before the yanked and
  // platform-asset gates - what the sentence is about, where
  // `updatableVersion` below is what the button can act on.
  //
  // PRECEDENCE, not equality: a host running a hotfix or RC AHEAD of the
  // stable channel is not outdated. Only the picker may request a deliberate
  // downgrade; the summary must never offer one as an update. Equal precedence (build-metadata
  // differences included) and incomparable pairs both count as up to date for
  // the SUMMARY - the picker stays the surface for deliberate cross-channel
  // moves.
  const targetVersion = newerTargetVersion({
    manifest,
    installedVersion,
    source: check.source,
  });
  const summaryCandidate = selectSummaryCandidate({
    manifest: actionableManifest,
    installedVersion,
    platformKey: input.platformKey,
    source: check.source,
  });
  const { cliFloor, stagedEntryOfferable, remedy } = deriveCliFloorAndForceGate(
    {
      manifest: actionableManifest,
      summaryCandidate,
      stagedVersion: input.stagedVersion,
      platformKey: input.platformKey,
      cliManifest: input.cliManifest,
      isLocalMachine: input.isLocalMachine,
      desktopUpdate: input.desktopUpdate,
      hostName,
    },
  );
  // THE CLI-FLOOR RECHECK. While the remedy is on screen, re-ask the catalog
  // every `CLI_FLOOR_RECHECK_MS` so a repaired CLI reveals Update now without
  // a click - the remedy's own copy promises exactly that. Keyed on the
  // REMEDY, not on the response: which floored catalog row the remedy names
  // is the summary walk's answer (the matching stable and the later RCs on
  // the installed line, strictly newer than what runs), and that walk needs
  // the installed version, which the check's response does not carry. A
  // classifier over the response alone - the table-owned condition lane this
  // replaced - kept a 30 s cadence on ANY floored row of an `installed-rc`
  // catalog, a release on another line included, with no remedy on screen to
  // end it. Invalidating the shared key rather than holding a private query
  // is the choice `useActiveUpdatePollAccelerator` makes, for the same
  // reason: one key, one answer, every observer of it refreshed alike.
  // Non-cancelling for the reason recorded there too - a round trip slower
  // than the cadence is coalesced, never aborted by the next tick. The
  // query's own scheduling stays table-owned; this only marks it stale.
  //
  // "On screen" is literal: a RETIRED region (`degrade` non-null - an
  // externally-managed host discovered at install, an unsupported install
  // method) renders a notice in place of the remedy, and two of those
  // retirements leave the check query enabled, so a floor read before the
  // retirement would otherwise keep re-asking a host with nothing on screen
  // to end it - the defect this recheck exists to avoid, relocated.
  //
  // Two more things end it: a floor no upgrade can clear (`repairable`
  // false - the remedy is help only, and re-asking cannot change the
  // answer), and the page's own gate (`enabled`) - the region renders under
  // it, and a timer ticking against a disabled query is a live timer for
  // nothing.
  const queryClient = useQueryClient();
  const recheckFloor = floorRecheckArmed({
    enabled: input.enabled,
    degrade,
    cliFloor,
  });
  const { hostId } = input;
  useEffect(() => {
    if (!recheckFloor || hostId === null) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries(
        { queryKey: hostQueryKeys.methodScope(hostId, "host.update.check") },
        { cancelRefetch: false },
      );
    }, CLI_FLOOR_RECHECK_MS);
    return () => clearInterval(timer);
  }, [recheckFloor, hostId, queryClient]);
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
  const updatableVersion = storeFloor.offerableVersion(
    offerableLatestVersion(summaryCandidate),
  );
  const installingVersion = installMutation.isPending
    ? installMutation.variables.version
    : null;
  // ONE in-flight update dispatch per page, whatever its intent. The three
  // mutations share a mutation key so any `useIsMutating` reader sees them
  // alike, and this is the same fact read from the page's own observers: the
  // controls a dispatch greys out must be greyed by an activation and a
  // continuation too, or the page would offer a second dispatch beside one it
  // is already waiting on.
  const dispatching = installingVersion !== null || bound.pending;
  const versionRows = visibleVersionRows({
    manifest: actionableManifest,
    installedVersion,
    platformKey: input.platformKey,
    showAll: showAllVersions,
    supportsDowngrade,
    storeRestrictionForVersion: storeFloor.restrictionForVersion,
  });
  return {
    degrade,
    cliFloor,
    cliFloorForVersion: (version) =>
      readCliFloorForVersion(actionableManifest, input.platformKey, version),
    stagedEntryOfferable: storeFloor.stagedEntryOfferable(
      stagedEntryOfferable,
      input.stagedVersion,
    ),
    stagedStoreFormatConfirmation: storeFloor.stagedStoreFormatConfirmation(
      input.stagedVersion,
    ),
    activate: bound.activate,
    continueAttempt: bound.continueAttempt,
    // The staged-wait force: the SAME dispatch as a row's Install, with
    // `force: true` and whatever loss consent its confirmation collected, so
    // the accepted latch, the invalidations, the outcome toasts and the
    // store-floor gate are the ones every other install on this page gets.
    // The confirmation that precedes it is the panel's (the ellipsis on
    // "Force update…" is a promise); this is only the dispatch.
    installForce: (version, acceptStoreFormatLoss, onSettled) => {
      // Re-read the exact version named by the confirmation. A catalog poll
      // can withdraw it or project a refusal after the offer was opened.
      const refusal = describeForceUpdateRefusal({
        manifest: actionableManifest,
        version,
        platformKey: input.platformKey,
        hostName,
      });
      if (refusal !== null) {
        setForceRefusal({
          version,
          text: refusal,
          checkDataUpdatedAt: checkQuery.dataUpdatedAt,
        });
        // No mutation means no mutation settle callback. Close synchronously
        // here or the confirmation would be stranded over the inline notice.
        onSettled();
        return;
      }
      install(version, true, acceptStoreFormatLoss, onSettled);
    },
    summary: {
      hostName,
      description: describeCheckState({
        manifest,
        checking,
        failure: failureDescription,
        unreachable: checkQuery.isError,
        hostName,
        upToDate,
        activationDebt: input.activationDebt,
        remedy,
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
      failureDescription,
      remedy,
      checking,
      // Offered only for a latest that is BOTH known and not already installed,
      // and never while the row is still reporting a failed attempt. "Update
      // now" is a promise that pressing it changes something.
      updatableVersion,
      installing: dispatching,
      busy: input.busy,
      onCheck: runCheck,
      onUpdateLatest: () => {
        if (updatableVersion !== null) {
          install(updatableVersion, false, false, null);
        }
      },
    },
    picker: {
      rows: versionRows,
      storeFloorNotice: storeFloor.showNotice(versionRows),
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
      onInstall: (version, acceptStoreFormatLoss) =>
        install(version, false, acceptStoreFormatLoss, null),
      awaitingFirstCheck: actionableManifest === null,
      checking,
    },
  };
}

interface RetainedHostInstallRefusal {
  readonly hostId: string | null;
  readonly hostVersion: string | null;
  readonly message: string;
  readonly storeFloor: HostUpdateStoreFloorRefusal | null;
}

interface HostInstallStoreFloor {
  readonly failureDescription: string | null;
  readonly clear: () => void;
  readonly restrictionForVersion: (
    version: string,
  ) => HostStoreFormatRestriction | null;
  readonly offerableVersion: (version: string | null) => string | null;
  readonly stagedEntryOfferable: (
    offerable: boolean,
    version: string | null,
  ) => boolean;
  /** The staged version's Install-anyway confirmation, or `null`. */
  readonly stagedStoreFormatConfirmation: (
    version: string | null,
  ) => string | null;
  readonly showNotice: (rows: readonly HostVersionRow[]) => boolean;
  readonly prepareInstall: (
    version: string,
    acceptStoreFormatLoss: boolean,
  ) => boolean;
  readonly recordRefusal: (response: HostUpdateInstallResponseV13) => boolean;
}

/**
 * The version offers and the dispatch gate share one view of store evidence.
 * A catalog refresh cannot refute a fresh RPC refusal, so that evidence stays
 * local to this panel until Check or a new dispatch. Consent is only an input
 * to prepareInstall; it is never retained or inherited by another dispatch.
 */
function useHostInstallStoreFloor(input: {
  readonly hostId: string | null;
  readonly hostName: string;
  readonly runningVersion: string | null;
  readonly storeFormats: HostStatusStoreFormats | null;
  readonly manifest: HostAvailableManifest | null;
  readonly fallbackFailure: string | null;
  /** Whether the negotiated install method carries the store-format floor. */
  readonly installSupportsStoreFloor: boolean;
}): HostInstallStoreFloor {
  const [retained, setRetained] = useState<RetainedHostInstallRefusal | null>(
    null,
  );
  const activeRefusal =
    retained !== null &&
    retained.hostId === input.hostId &&
    retained.hostVersion === input.runningVersion
      ? retained
      : null;
  const storeFloorForVersion = (
    version: string,
  ): HostUpdateStoreFloorRefusal | null => {
    const storeFloor = activeRefusal?.storeFloor ?? null;
    return storeFloor?.targetVersion === version ? storeFloor : null;
  };
  const restrictionForVersion = (
    version: string,
  ): HostStoreFormatRestriction | null => {
    const restriction = hostStoreFormatRestriction({
      version,
      publishedFormats:
        input.manifest?.versions.find((entry) => entry.version === version)
          ?.storeFormats ?? null,
      runningVersion: input.runningVersion,
      storeFormats: input.storeFormats,
      installSupportsStoreFloor: input.installSupportsStoreFloor,
    });
    // Neither of these may be displaced by retained RPC evidence. `pending` is
    // transient; `unsupported` says this peer cannot honour consent at all, so
    // a refusal it once sent cannot turn the row back into an offer.
    if (
      restriction?.kind === "pending" ||
      restriction?.kind === "floor-unsupported"
    ) {
      return restriction;
    }
    const storeFloor = storeFloorForVersion(version);
    if (storeFloor !== null) {
      return hostStoreFormatRestrictionFromRpc(storeFloor);
    }
    return restriction;
  };
  return {
    failureDescription: activeRefusal?.message ?? input.fallbackFailure,
    clear: () => setRetained(null),
    restrictionForVersion,
    offerableVersion: (version) => {
      if (version === null || restrictionForVersion(version) !== null) {
        return null;
      }
      return version;
    },
    // A staged version's Force update is offered under the same rule as a
    // row's Install: an unrestricted target, or one whose restriction carries
    // a confirmation - "Install anyway" for a blocked, unknown or failed
    // survey. The dialog that precedes the force then names that loss beside
    // the sessions it ends, and dispatches with the consent the person gave
    // there (`installForce`). Withheld, exactly as the row is, for a
    // restriction with no confirmation: a pending survey, or a peer that
    // cannot honour consent.
    //
    // This is the RECORD-derived staged wait - the park `legacyPark`
    // projects with no attempt id, which `installForce` resumes through
    // `host.update.install {force}`, the one dispatch that carries
    // `acceptStoreFormatLoss`. A park that is a bound ATTEMPT resumes through
    // `host.update.continue`, whose request carries no consent on the wire
    // and whose dialog names no loss; a downgrade parked that way still
    // finishes through a fresh Install anyway once the host is idle. Carrying
    // consent on `continue` is a protocol change, recorded as a follow-up.
    stagedEntryOfferable: (offerable, version) => {
      if (!offerable || version === null) return false;
      const restriction = restrictionForVersion(version);
      return restriction === null || restriction.confirmation !== null;
    },
    stagedStoreFormatConfirmation: (version) =>
      version === null
        ? null
        : (restrictionForVersion(version)?.confirmation ?? null),
    // The notice explains the Install-anyway affordance, so it follows the
    // rows that actually carry one rather than re-deriving the two conditions
    // that used to imply it. A failed survey no longer implies one by itself:
    // a target stamping at or above this build's format clears from formats
    // alone, and a notice about consent nothing is asking for reads as a
    // warning the page cannot act on. This also picks up the unknown-target
    // row, which offers Install anyway and which the old pair missed.
    showNotice: (rows) =>
      rows.some((row) => row.storeFormatConfirmation !== null),
    prepareInstall: (version, acceptStoreFormatLoss) => {
      // A dialog can outlive a status poll. Re-read the row's evidence; force
      // authorizes ending busy work and never implies losing chat access.
      const restriction = restrictionForVersion(version);
      if (
        restriction !== null &&
        // `unsupported` sits beside `pending` for the same reason it does in
        // `restrictionForVersion`, and it is the more important half: consent
        // must not unlock a peer that cannot HONOUR consent. A dialog that
        // outlived a status poll could otherwise arrive here with
        // `acceptStoreFormatLoss` true and dispatch the very install this
        // restriction exists to withhold.
        (!acceptStoreFormatLoss ||
          restriction.kind === "pending" ||
          restriction.kind === "floor-unsupported")
      ) {
        setRetained({
          hostId: input.hostId,
          hostVersion: input.runningVersion,
          message: restriction.detail ?? restriction.reason,
          // Local rejection obtains no fresher evidence. Preserve the typed
          // answer so a cached safe catalog cannot erase Install anyway.
          storeFloor: storeFloorForVersion(version),
        });
        return false;
      }
      setRetained(null);
      return true;
    },
    recordRefusal: (response) => {
      if (response.outcome !== "cli-failed") return false;
      const message = describeInstallRefusal(
        response.reason,
        response.storeFloor,
        input.hostName,
      );
      if (message === null) return false;
      setRetained({
        hostId: input.hostId,
        hostVersion: input.runningVersion,
        message,
        storeFloor: response.storeFloor,
      });
      return true;
    },
  };
}

/**
 * What a `cli-failed` install refusal tells the reader, or `null` when the
 * arm said nothing this page can improve on.
 *
 * The two named arms are refusals with their own remedy. The last one is the
 * open half of the vocabulary, and it is deliberately ADDITIVE rather than a
 * replacement: this page keeps its own sentence and attaches what it was told,
 * the same shape the bound dispatches use for a reason they do not recognise.
 * A reason is not guaranteed to be copy - the host mints short codes, while
 * the local-CLI fallback lane forwards the CLI's own sentence, which for a
 * store-format refusal is the ONLY evidence that reaches this page - so
 * presenting one as the whole message would sooner or later put a bare code
 * where a sentence belongs.
 */
function describeInstallRefusal(
  reason: string | null,
  storeFloor: HostUpdateStoreFloorRefusal | null,
  hostName: string,
): string | null {
  if (storeFloor !== null) return describeHostStoreFloorRpcRefusal(storeFloor);
  if (reason === "cli-too-old") {
    return "This device's Traycer CLI is too old to start the update. Update the CLI, then try again.";
  }
  if (reason === null) return null;
  return `${describeCliShellFailure("cli-failed", hostName)} (${reason})`;
}

/**
 * The two BOUND dispatches, and whether either is in flight.
 *
 * Split out of {@link useHostOverviewUpdates} because it is a self-contained
 * question — does this host advertise the methods, and what happens when one
 * answers — and the hook it came from is already at its complexity ceiling.
 *
 * Both go through the SAME machinery an install goes through: the accepted
 * latch, the read invalidations and the settle classification live in
 * `useHostUpdateActivate` / `useHostUpdateContinue`, which share them with
 * `useHostUpdateInstall` and share its mutation key.
 *
 * What they deliberately do NOT go through is `describeForceUpdateRefusal`.
 * That gate exists to stop this page offering to place bytes it has just been
 * told cannot be placed here — a withdrawn release, an unresolvable asset, a
 * CLI floor — and neither of these places bytes on that basis: `activate`
 * places none at all, and `continue` resumes bytes the attempt was authorized
 * to fetch when it was created (a downgrade park re-downloads the same version
 * it was created for). Running the catalog gate over them would refuse a
 * parked update because the catalog has since moved, which is exactly the
 * state a park needs to be resumable out of.
 *
 * `null` means the host does not advertise that method.
 * `useHostSupportsMethod` fails closed on a manifest it has not seen, so the
 * page keeps its legacy routes until a handshake positively proves the method
 * present — never dispatching something the transport would refuse.
 */
function useBoundUpdateDispatches(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly incarnation: string;
  /** Clears the page's stale Force refusal, as an install's dispatch does. */
  readonly beforeDispatch: () => void;
  /** Clears the transient CLI-failure notice on any answer that ran. */
  readonly onAccepted: () => void;
}): {
  readonly activate: ((variables: BoundDispatchInput) => void) | null;
  readonly continueAttempt: ((variables: BoundDispatchInput) => void) | null;
  readonly pending: boolean;
} {
  // Each gated on ITS OWN method: they are two authorizations, and a host can
  // advertise one without the other.
  const supportsActivate = useHostSupportsMethod(
    input.hostId,
    "host.update.activate",
  );
  const supportsContinue = useHostSupportsMethod(
    input.hostId,
    "host.update.continue",
  );
  const activateMutation = useHostUpdateActivate(
    input.client,
    input.incarnation,
  );
  const continueMutation = useHostUpdateContinue(
    input.client,
    input.incarnation,
  );
  // BOTH mutations arrive here — `continueMutation` is passed to a parameter
  // spelled `typeof activateMutation`, which type-checks only because the two
  // responses coincide. `typeof activateMutation | typeof continueMutation`
  // says it properly and is rejected by
  // `typescript(no-duplicate-type-constituents)` for the same reason the union
  // in `host-overview-rpc.ts` is, so what guarantees this stays sound is that
  // module's `BoundDispatchResponsesAgree` assertion, not this annotation.
  // Worth stating here because this site names no response type at all: no
  // search for `BoundDispatchResponse` reaches it.
  const dispatch = (
    mutation: typeof activateMutation,
    variables: BoundDispatchInput,
  ): void => {
    input.beforeDispatch();
    mutation.mutate(
      {
        attemptId: variables.attemptId,
        force: variables.force,
        expected: variables.expected,
      },
      {
        onSettled: () => variables.onSettled(),
        onSuccess: (response) => {
          handleBoundDispatchOutcome({
            response,
            hostName: input.hostName,
            targetVersion: variables.targetVersion,
            onAccepted: input.onAccepted,
          });
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't start the update."),
      },
    );
  };
  return {
    activate: supportsActivate
      ? (variables) => dispatch(activateMutation, variables)
      : null,
    continueAttempt: supportsContinue
      ? (variables) => dispatch(continueMutation, variables)
      : null,
    pending: activateMutation.isPending || continueMutation.isPending,
  };
}

export interface HostOverviewUpdatesSummary {
  readonly hostName: string;
  readonly description: string;
  readonly failureDescription: string | null;
  readonly remedy: CliFloorRemedy | null;
  readonly checking: boolean;
  readonly updatableVersion: string | null;
  readonly installing: boolean;
  readonly busy: boolean;
  readonly onCheck: () => void;
  readonly onUpdateLatest: () => void;
}

/**
 * What a bound dispatch needs from its caller: which attempt, whether the user
 * consented to push past live work, what to say it is updating to, and how to
 * close the confirmation that asked.
 *
 * `targetVersion` is for COPY only and is deliberately not sent: the operation
 * comes from the record's own continuation, and a version on the wire would be
 * a second copy of a fact the record owns — one a stale UI could get wrong.
 *
 * ## Why `expected` is not that second copy
 *
 * That argument stands, and it does not reach this field. A version is a fact
 * about the world, and a stale one makes the host do the WRONG THING. A
 * position is a cursor into the record's own history whose only use is to be
 * compared for equality, and a stale one produces a REFUSAL. They fail in
 * opposite directions, which is why one is withheld here and the other is sent.
 *
 * `null` means this view named no attempt position, and it is sent as an ABSENT
 * key rather than a synthesised one. Absence is the legacy signal — a client
 * that predates the field cannot send it, and a `@1.0` peer parses with a
 * schema where it does not exist — so "the caller did not say" has to stay
 * distinguishable from "the caller says any position will do". Filling in a
 * position this page did not observe would be an affirmative claim from a
 * client that observed nothing, which is the one thing this field must never be.
 */
export interface BoundDispatchInput {
  readonly attemptId: string;
  readonly force: boolean;
  /**
   * Which position of {@link BoundDispatchInput.attemptId} the user was shown.
   * Sent, unlike `targetVersion` — see the note above.
   */
  readonly expected: FleetUpdateAttemptPosition | null;
  /** The attempt's target, when the view named one. Toast copy only. */
  readonly targetVersion: string | null;
  readonly onSettled: () => void;
}

export interface HostOverviewUpdatesState {
  readonly degrade: OverviewDegradeReason | null;
  readonly summary: HostOverviewUpdatesSummary;
  readonly picker: VersionPickerProps;
  /**
   * The SUMMARY WALK's floor — the one the remedy row and the recheck are
   * about, on the version this region would offer to install.
   *
   * Deliberately NOT an answer about any other version. The staged release is
   * not part of the walk (it was chosen earlier, by a catalog that may since
   * have moved), and neither is a parked attempt's target: a manifest can
   * carry a floored rc.4 above a perfectly installable rc.3, and this field
   * says nothing about rc.3. A consumer asking "is THIS version floored" wants
   * {@link HostOverviewUpdatesState.cliFloorForVersion}.
   */
  readonly cliFloor: CliFloor | null;
  /**
   * The catalog's CLI floor for one named version, or `null` when that version
   * installs on this host's tools — the per-version question {@link cliFloor}
   * cannot answer.
   *
   * Same `readCliFloor` the summary walk uses, so the two cannot disagree
   * about a version they both look at; `null` for a version the manifest does
   * not list, and for a null version (a park that named no target). It reads
   * ONLY the floor, deliberately not `describeForceUpdateRefusal`: that also
   * refuses a withdrawn or unresolvable entry, and a caller choosing CLI-floor
   * COPY off it would say "update your command-line tools" about a release
   * that was yanked.
   */
  readonly cliFloorForVersion: (version: string | null) => CliFloor | null;
  readonly stagedEntryOfferable: boolean;
  /**
   * The store-format loss the staged version's Force update has to name and
   * collect consent for - the same confirmation its picker row would show
   * behind Install anyway - or `null` when the stage carries no such
   * restriction. Read at offer time by the panel, so the dialog describes the
   * loss the person is consenting to.
   */
  readonly stagedStoreFormatConfirmation: string | null;
  /**
   * `host.update.install {version, force: true}` — the staged-wait force.
   * `acceptStoreFormatLoss` is the consent the confirmation collected when it
   * named a store-format loss (`stagedStoreFormatConfirmation`); the dispatch
   * gate re-reads the row's evidence and still refuses a peer that cannot
   * honour it. `onSettled` runs once the request answers or fails, so the
   * confirmation that dispatched it can close on the answer rather than on a
   * guess.
   */
  readonly installForce: (
    version: string,
    acceptStoreFormatLoss: boolean,
    onSettled: () => void,
  ) => void;
  /**
   * `host.update.activate {attemptId, force}` — restart into an attempt's
   * already-placed bytes. `null` when this host does not advertise the method,
   * which is how the page keeps the legacy `host.restart` route for a host that
   * predates the cutover rather than dispatching something it cannot serve.
   */
  readonly activate: ((input: BoundDispatchInput) => void) | null;
  /**
   * `host.update.continue {attemptId, force}` — resume a parked attempt.
   * `null` on a host without the method, exactly as `activate`.
   */
  readonly continueAttempt: ((input: BoundDispatchInput) => void) | null;
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
  readonly supportsDowngrade: boolean;
  readonly storeRestrictionForVersion: (
    version: string,
  ) => HostStoreFormatRestriction | null;
}): readonly HostVersionRow[] {
  const { manifest } = input;
  if (manifest === null) return [];
  const entries = input.showAll
    ? manifest.versions
    : manifest.versions.slice(0, VERSION_LIST_PREVIEW);
  return entries.map((entry) => {
    const asset = platformAssetFor(entry.platforms, input.platformKey);
    const isInstalled = entry.version === input.installedVersion;
    // Platform and version refusals retain priority. A store warning must not
    // obscure an asset that cannot be installed on this device at all.
    const existingReason =
      assetUnavailableReason(asset) ??
      versionUnavailableReason(
        input.installedVersion,
        entry.version,
        input.supportsDowngrade,
      );
    // A yanked entry is blocked by the row itself, and no store restriction is
    // computed for one: "install anyway" past a store floor is a choice about
    // chat access, and it is not on offer for a release that was withdrawn.
    const restriction =
      existingReason === null && !entry.yanked
        ? input.storeRestrictionForVersion(entry.version)
        : null;
    return {
      version: entry.version,
      releasedAt: entry.releasedAt,
      yanked: entry.yanked,
      isLatest: entry.version === manifest.latest,
      isInstalled,
      unavailableReason: existingReason ?? restriction?.reason ?? null,
      unavailableDetail: restriction?.detail ?? null,
      newerData: restriction?.kind === "blocked",
      storeFormatConfirmation: restriction?.confirmation ?? null,
    };
  });
}

/**
 * The version the summary's Update now may offer, or `null`.
 *
 * The summary additionally requires a strictly newer target; the picker also
 * permits explicit downgrades. Both require a manifest from a check the
 * host CONFIRMED (not error-retained data), a non-yanked entry, and a usable
 * asset for this host's platform. The CLI also refuses yanked releases before
 * downloading.
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
function offerableLatestVersion(
  candidate: SummaryUpdateCandidate | null,
): string | null {
  if (candidate === null || candidate.cliFloor !== null) return null;
  return candidate.version;
}

interface SummaryUpdateCandidate {
  readonly version: string;
  readonly cliFloor: CliFloor | null;
}

/**
 * One ordered walk owns both the update and its CLI remedy. An unusable
 * stable may leave an RC as the first repairable target; a floored stable
 * must instead keep its priority over an already-installable lower RC.
 * Yanked entries never become usable after a CLI repair, so skip them here.
 */
function selectSummaryCandidate(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): SummaryUpdateCandidate | null {
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
    if (assetUnavailableReason(asset) === null) {
      return { version: candidate, cliFloor: null };
    }
    const cliFloor = readCliFloor(entry, input.platformKey);
    if (cliFloor !== null) return { version: candidate, cliFloor };
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
  // returned twice, and `selectSummaryCandidate` pays for a second yanked and
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

function versionSupportsDowngrade(version: NegotiatedMethodVersion): boolean {
  if (version === null || version === false) return false;
  return version.major > 1 || (version.major === 1 && version.minor >= 2);
}

/**
 * Whether the negotiated `host.update.install` carries the store-format floor.
 *
 * `@1.3`, where `versionSupportsDowngrade` is `@1.2` - one minor apart, and
 * the gap is a real fleet state rather than a theoretical one. A host in it
 * advertises downgrades and has nothing behind them: no pre-dispatch survey,
 * no typed refusal, and the framework projects `acceptStoreFormatLoss` away
 * before the request lands. Fails CLOSED on an unnegotiated method for the
 * same reason its sibling does - an unknown peer is not a floor-capable one.
 */
function versionSupportsStoreFloor(version: NegotiatedMethodVersion): boolean {
  if (version === null || version === false) return false;
  return version.major > 1 || (version.major === 1 && version.minor >= 3);
}

/** Only a host advertising downgrade support can honor an older target. */
function versionUnavailableReason(
  installedVersion: string | null,
  rowVersion: string,
  supportsDowngrade: boolean,
): string | null {
  if (installedVersion === null || installedVersion === rowVersion) return null;
  const comparison = compareHostVersions(installedVersion, rowVersion);
  if (!comparison.comparable) return null;
  if (comparison.ordering === "equal") {
    // Comparable-equal but a different string: another BUILD of the installed
    // release (`1.2.0+build.2` beside an installed `1.2.0+build.1`). The
    // comparator is build-metadata-blind and reserved for ordering; the
    // artifact's identity is the string, and this host is NOT on the row's
    // version. The CLI installs such a target only as an explicit sideways
    // move (`--allow-downgrade`), which `host.update.install` passes only on a
    // host that knows the sideways rule - and this page cannot tell which
    // host it has - so the row stays disabled and says how to get the build.
    return `Another build of v${installedVersion} is installed. To install v${rowVersion} over it, run: traycer host update --version ${rowVersion} --allow-downgrade`;
  }
  if (comparison.ordering === "greater" && !supportsDowngrade) {
    return "Update this host to a release that supports downgrades from Settings.";
  }
  return null;
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

interface CliFloor {
  readonly requiredCliVersion: string | null;
  /**
   * Whether upgrading the CLI can clear this floor: the version it names is
   * one (`isValidHostVersion`), or none is named at all (an older payload
   * whose authored reason still says the CLI is too old). A floor naming
   * something that is not a version came from the pre-repair projector,
   * which put the repairable prefix on an unreadable floor too; no upgrade
   * clears it, so the remedy is help only and the recheck does not run.
   */
  readonly repairable: boolean;
}

interface ForceUpdateRefusal {
  readonly version: string;
  readonly text: string;
  readonly checkDataUpdatedAt: number;
}

function deriveCliFloorAndForceGate(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly summaryCandidate: SummaryUpdateCandidate | null;
  readonly stagedVersion: string | null;
  readonly platformKey: string | null;
  readonly cliManifest: StoredCliInstallManifest | null;
  readonly isLocalMachine: boolean;
  readonly desktopUpdate: DesktopAppUpdateSnapshot | null;
  readonly hostName: string;
}): {
  readonly cliFloor: CliFloor | null;
  readonly stagedEntryOfferable: boolean;
  readonly remedy: CliFloorRemedy | null;
} {
  // The staged release is not part of the summary walk (it was chosen
  // earlier, by a catalog that may since have withdrawn it); its gates live
  // in `describeForceUpdateRefusal`, which the Force offer and the Force
  // dispatch both read. A withdrawn stage has no floor to remedy - no CLI
  // version installs a yanked release - so the refusal names the withdrawal
  // rather than a CLI requirement.
  const cliFloor = input.summaryCandidate?.cliFloor ?? null;
  return {
    cliFloor,
    // ONE predicate for "may Force be offered" and "may Force dispatch": the
    // same refusal the dispatch revalidates at confirmation. A stage the
    // catalog has dropped or withdrawn is not offered - the CLI would purge
    // the stage (`discardIneligibleStagedVersion`) and then refuse the
    // version, so the offer could only ever destroy the parked stage. See
    // `describeForceUpdateRefusal` for why an unavailable asset is NOT in
    // that set.
    stagedEntryOfferable:
      input.stagedVersion !== null &&
      describeForceUpdateRefusal({
        manifest: input.manifest,
        version: input.stagedVersion,
        platformKey: input.platformKey,
        hostName: input.hostName,
      }) === null,
    remedy:
      cliFloor === null
        ? null
        : describeCliFloorRemedy({
            isLocalMachine: input.isLocalMachine,
            platform: input.platformKey,
            cliSource: input.cliManifest?.source ?? null,
            cliBinaryPath: input.cliManifest?.binaryPath ?? null,
            cliVersion: input.cliManifest?.version ?? null,
            requiredCliVersion: cliFloor.requiredCliVersion,
            desktopUpdate: input.desktopUpdate,
            hostName: input.hostName,
          }),
  };
}

/**
 * The floor for ONE named version, looked up in the same actionable manifest
 * the summary walk reads.
 *
 * The walk's own candidate is chosen by an ordered scan; this is the direct
 * question, for a caller that already knows which version it means — a parked
 * attempt's target, say, which the walk may never visit because something
 * newer sits above it.
 */
function readCliFloorForVersion(
  manifest: HostAvailableManifest | null,
  platformKey: string | null,
  version: string | null,
): CliFloor | null {
  if (version === null) return null;
  return readCliFloor(
    manifest?.versions.find((entry) => entry.version === version),
    platformKey,
  );
}

function readCliFloor(
  entry: HostAvailableManifest["versions"][number] | undefined,
  platformKey: string | null,
): CliFloor | null {
  if (entry === undefined) return null;
  const asset = platformAssetFor(entry.platforms, platformKey);
  if (!isHostClientFloorRefusedAsset(asset)) return null;
  // The version decorates the verdict; it never decides it. Older payloads
  // can omit the field while the authored refusal still names the requirement.
  const reasonVersion = asset?.unavailableReason
    ?.slice(HOST_CLIENT_FLOOR_REASON_PREFIX.length)
    .match(/^(\S+) or newer\b/)?.[1];
  const requiredCliVersion = entry.requiredCliVersion ?? reasonVersion ?? null;
  return {
    requiredCliVersion,
    repairable:
      requiredCliVersion === null || isValidHostVersion(requiredCliVersion),
  };
}

function describeForceUpdateRefusal(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly version: string;
  readonly platformKey: string | null;
  readonly hostName: string;
}): string | null {
  const entry = input.manifest?.versions.find(
    (candidate) => candidate.version === input.version,
  );
  // The gates that matter for the one version Force names - a version whose
  // bytes are ALREADY staged, downloaded and verified. That is narrower than
  // the summary walk's: the CLI's stage reconcile purges a stage only when
  // the catalog no longer lists the version or has yanked it
  // (`discardIneligibleStagedVersion`), and an already-staged target
  // short-circuits before any asset is resolved again, so a platform build
  // the catalog has since marked unavailable still installs from the stage.
  // Refusing that would strand a downloaded update behind a control that
  // vanished. What does refuse: an entry the catalog dropped or withdrew
  // (the confirmation could only destroy the stage); an asset this page
  // cannot RESOLVE (nothing about the floor can be read - a deliberate
  // narrowing for a host whose record carries no platform against a
  // multi-platform entry; the CLI's own `host update --force` still works
  // there); and a CLI floor. The floor is a PRODUCT gate, not a CLI one:
  // the CLI would install the staged bytes, and the resulting host would
  // then refuse the client that installed it, which is not a state this
  // page offers to enter. The staged version is normally also the best
  // target, whose floor renders the remedy card.
  if (entry === undefined) {
    // An absent entry, failed check, or incomplete refusal cannot name a
    // floor.
    return `Traycer couldn't verify that v${input.version} can be installed on ${input.hostName}. Select Check now and try again.`;
  }
  if (entry.yanked) {
    return `v${input.version} has been withdrawn and can't be installed on ${input.hostName}. Select Check now for the current catalog.`;
  }
  if (platformAssetFor(entry.platforms, input.platformKey) === null) {
    // No asset RESOLVED - an unknown platform key against a multi-platform
    // entry, or a key the entry does not carry. Not proof the release is
    // unavailable here, only that this page cannot read a floor for it.
    return `Traycer couldn't verify that v${input.version} can be installed on ${input.hostName}. Select Check now and try again.`;
  }
  // The catalog ENTRY's own floor, read apart from the asset's authored
  // reason: staged bytes install whatever the asset's availability says
  // (the CLI's already-staged short-circuit resolves no asset and applies no
  // floor), so a floor that is not a version - one this page cannot
  // establish compatibility for, the same rule the projector applies when
  // it reads the manifest - is refused here whether or not the asset
  // carries the repairable prefix. A READABLE floor is left to the asset's
  // verdict below: `available` is the executing CLI's own comparison
  // against its own version, and the stored CLI manifest is no substitute
  // for it in either direction (the stored copy can be newer than the
  // executing one - see the remedy's older-copy sentence - or stale behind
  // an upgrade the record has not re-read yet).
  const declaredFloor = entry.requiredCliVersion;
  if (declaredFloor !== null && !isValidHostVersion(declaredFloor)) {
    return `Traycer couldn't verify the command-line tools version v${input.version} needs on ${input.hostName}: its catalog entry declares a requirement this page cannot read.`;
  }
  const floor = readCliFloor(entry, input.platformKey);
  if (floor !== null) {
    return floor.repairable && floor.requiredCliVersion !== null
      ? `v${input.version} needs Traycer CLI ${floor.requiredCliVersion} or newer on ${input.hostName}. Update the command-line tools first.`
      : `Traycer couldn't verify that v${input.version} can be installed on ${input.hostName}. Select Check now and try again.`;
  }
  return null;
}

interface ForceRefusalEvidence {
  readonly refusal: ForceUpdateRefusal | null;
  readonly manifest: HostAvailableManifest | null;
  readonly checkDataUpdatedAt: number;
  readonly checkSucceeded: boolean;
  readonly checkIsPlaceholderData: boolean;
  readonly platformKey: string | null;
  readonly hostName: string;
}

/**
 * The guarded render adjustment for a Force refusal: one decision, one
 * action, stated beside its predicate rather than inline in the hook.
 * `retire` is the state setter; calling it conditionally during render is
 * the same pattern the `installDiscovered` adjustment uses.
 */
function retireForceRefusalIfRefuted(
  input: ForceRefusalEvidence & { readonly retire: () => void },
): void {
  if (checkRefutesForceRefusal(input)) input.retire();
}

function checkRefutesForceRefusal(input: ForceRefusalEvidence): boolean {
  // A retained or placeholder catalog cannot prove a subsequent repair.
  // The exact refused version must be cleared by a newer successful answer.
  return (
    input.refusal !== null &&
    input.checkSucceeded &&
    !input.checkIsPlaceholderData &&
    input.manifest !== null &&
    input.checkDataUpdatedAt > input.refusal.checkDataUpdatedAt &&
    describeForceUpdateRefusal({
      manifest: input.manifest,
      version: input.refusal.version,
      platformKey: input.platformKey,
      hostName: input.hostName,
    }) === null
  );
}

function describeUpdateFailure(input: {
  readonly refusal: ForceUpdateRefusal | null;
  readonly manifest: HostAvailableManifest | null;
  readonly platformKey: string | null;
  readonly failure: CliShellFailure | null;
  readonly hostName: string;
}): string | null {
  // A successful poll can repair the exact version refused at confirmation.
  // Derive visibility from the current catalog so both failure surfaces clear
  // with that answer, without waiting for another click to reset local state.
  if (
    input.refusal !== null &&
    describeForceUpdateRefusal({
      manifest: input.manifest,
      version: input.refusal.version,
      platformKey: input.platformKey,
      hostName: input.hostName,
    }) !== null
  ) {
    return input.refusal.text;
  }
  return input.failure === null
    ? null
    : describeCliShellFailure(input.failure, input.hostName);
}

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
/**
 * Whether the mounted CLI-floor recheck runs: a REPAIRABLE floor is on
 * screen (the remedy names a command an upgrade can satisfy), in a region
 * that is neither retired nor disabled. See the comment at its caller for
 * why each of the three ends it.
 */
function floorRecheckArmed(input: {
  readonly enabled: boolean;
  readonly degrade: OverviewDegradeReason | null;
  readonly cliFloor: CliFloor | null;
}): boolean {
  return (
    input.enabled &&
    input.degrade === null &&
    input.cliFloor !== null &&
    input.cliFloor.repairable
  );
}

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
      describeIndeterminateDispatch(input.indeterminateReason, input.hostName),
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

/**
 * The copy this page owns for the CLI floor a bound dispatch can hit.
 *
 * The host maps a spawned CLI that rejected `--intent` (an old parser exits
 * before any command body runs) — and its own diagnostic version preflight — to
 * `cli-failed {reason: "cli-too-old"}`. That is the one refusal with a concrete
 * remedy, and it is worth its own sentence rather than the generic
 * "couldn't complete the request": nothing on the HOST is wrong, and no amount
 * of retrying this button changes anything until the CLI is updated.
 */
const CLI_TOO_OLD_MESSAGE =
  "This computer's Traycer CLI is too old to resume the update. Update the CLI, then try again.";

/**
 * What a `dispatch-indeterminate` reason means to a person (D18).
 *
 * The host names a reason from a closed grammar, and three of those reasons are
 * not really "we could not confirm" at all — they are definite answers about
 * work that did not need doing, which read as a shrug if they go through the
 * generic sentence. The rest keep today's wording WITH the reason attached:
 * several distinct causes reach this one outcome, and flattening them into one
 * opaque message is the diagnostic substitution this epic has already paid for
 * more than once.
 */
function describeIndeterminateDispatch(
  reason: string | null,
  hostName: string,
): string {
  // Q26. A decline that ALSO closed a stranded attempt carries
  // `<base>-stale-attempt-closed`, and every comparison below is on the BASE.
  // Comparing the raw string dropped every such decline into the generic
  // sentence — "Couldn't confirm the update started on host-a:
  // nothing-to-do-stale-attempt-closed" over a host that is simply up to date.
  //
  // Stripping is the protocol's job, not this module's: the suffix has exactly
  // one spelling in the repository (`STALE_ATTEMPT_CLOSED_SUFFIX`), the CLI's
  // generator imports the same constant, and a local copy of either the literal
  // or the strip is how a build and a strip drift apart.
  const base = reason === null ? null : baseDispatchAckReason(reason);
  // An INSTALL-path reason, and only that: the bound verbs never mint it. So it
  // sits outside the known bound-dispatch vocabulary by design, and its absence
  // from that tuple is not a coverage gap. This function serves both call sites,
  // which is why the arm lives here rather than beside the bound ones.
  if (base === "nothing-to-do") {
    return withStaleClosure(`${hostName} is already up to date.`, reason);
  }
  // No closure clause on either recovery arm. The lead sentence is already
  // about a record being concluded, so appending "a stranded update record was
  // also closed" narrates one event as two — the boundary the ruling drew.
  //
  // These two reasons ARE reachable here, including through a bound verb —
  // `selectBoundResume`'s non-parked arm reaches `interruptedResume` under
  // `reselect`. What they cannot arrive as is SUFFIXED, and the reason is that
  // their producer returns DIRECTLY rather than routing through the decline
  // path that appends the suffix.
  //
  // Explicitly NOT "they ride the `terminalized` outcome kind and the suffix
  // rides `released`". That was the mechanism first recorded here and it is
  // false: under `reselect` — which is what `runHostUpdate` passes — the
  // recovery returns `released` too, the same kind the close path produces. The
  // conclusion survived the correction; the reason did not, and a wrong reason
  // on a right entry is the worse defect, because it reads as verified and the
  // next person extends it.
  //
  // The clause rule is a rule about the GRAMMAR, which permits the suffix on
  // any base, so it holds however the producers move.
  if (base === "recovered-complete") return "The last update already finished.";
  // The record's own failure arrives on the next `host.status` frame and the
  // operation card states it; this only says which run it is about.
  if (base === "recovered-failed") return "The last update failed.";
  // The attempt is PRESENT and is the one named — what moved is its position.
  // Deliberately not folded into `refused-attempt-gone`: that one says "there is
  // nothing here to act on", this one says "what is here is not what you were
  // shown", and the only correct response is to look again.
  //
  // The sentence carries the whole instruction because there is no dialog left
  // to carry it: the confirmation closes on the answer, whatever the answer is.
  // Reopening it automatically would be worse than saying nothing — it would
  // put a fresh confirmation on screen populated from a record the user has not
  // read, which is the same consent defect one turn later and is exactly what
  // sending `expected` exists to prevent.
  if (base === "refused-attempt-moved") {
    return withStaleClosure(
      `The update moved on while you were deciding, so ${hostName} did not act on it. Re-read the confirmation and confirm again.`,
      reason,
    );
  }
  if (
    base === "refused-attempt-gone" ||
    // No producer mints this literal — a moved install record on a park is
    // written `failed {install-changed}` and arrives as the record's own
    // failure. Kept as a defensive arm rather than deleted: it is a value the
    // generated `refused-<code>` grammar can still express, and a sentence that
    // misdescribes it is worse than one that does not.
    base === "refused-install-changed"
  ) {
    return withStaleClosure(
      "The host changed while the update was being prepared. Try again.",
      reason,
    );
  }
  // NOT the sentence above, though it shipped sharing it. This reason has two
  // producers that mean different things: the host mints it when the attempt
  // record cannot be decoded, and the CLI mints it for consent failures — a
  // park with no claim, a target that is not an upgrade, a downgrade with
  // neither `allowDowngrade` nor strict-upgrade set. "The host changed" is true
  // of the first and false of all three of the second, so it told most of this
  // reason's arrivals something that had not happened. The wording has to be
  // true of every producer, which means naming the check that failed rather
  // than a cause it does not know.
  if (base === "refused-unverifiable") {
    return withStaleClosure(
      `${hostName} could not verify this request against the update record, so nothing was started.`,
      reason,
    );
  }
  // The DIAGNOSTIC arm echoes what the host actually sent, suffix included, and
  // adds no clause: this sentence exists to be pasted into a support thread, so
  // stripping here would hide a fact from the one place that reports the raw
  // vocabulary, and appending a clause would say the same thing twice.
  return reason === null
    ? `Couldn't confirm the update started on ${hostName}. Watching for progress.`
    : `Couldn't confirm the update started on ${hostName}: ${reason}. Watching for progress.`;
}

/**
 * The lead sentence, plus one clause when this decline also closed a stranded
 * attempt.
 *
 * Worth saying at all because the closure is USER-VISIBLE: the stranded record
 * was what the Overview card had been reporting, and the dispatch ends it. A
 * card that changes with no explanation is worse than one short sentence, which
 * is why this is not the layered narration the page otherwise deletes — it is
 * the dispatch's own outcome, not a second remedy for one blocker.
 *
 * Says only what the suffix knows. It records THAT a stranded attempt was
 * closed and never HOW it settled — the same 21 characters ride a record that
 * ended `complete` and one that ended `failed` — so this must not imply either
 * (see the note in `host-update-ack-reason.ts`, which rules out a
 * "concludes-as-done" predicate for exactly this reason). "Cleaned up" is
 * outcome-free on purpose; the record's own state arrives on the next
 * `host.status` frame and the operation card states it.
 */
function withStaleClosure(sentence: string, reason: string | null): string {
  if (reason === null || !dispatchAckReasonClosedStaleAttempt(reason)) {
    return sentence;
  }
  return `${sentence} An interrupted update record was also cleaned up.`;
}

/**
 * The bound methods' four outcomes, which are the install's minus the two
 * structural refusals and plus a REASONED `cli-failed`.
 *
 * Neither `externally-managed` nor `cli-unavailable` can arrive here — the
 * bound response schema has no arm for either — which is why this does not
 * touch the sticky region-degrade state at all. A bound dispatch cannot retire
 * the updates region, and pretending it could would take the version list away
 * on an answer that never said the mechanism was gone.
 */
function handleBoundDispatchOutcome(input: {
  readonly response: BoundDispatchResponse;
  readonly hostName: string;
  readonly targetVersion: string | null;
  readonly onAccepted: () => void;
}): void {
  const { hostName } = input;
  if (input.response.outcome === "accepted") {
    input.onAccepted();
    // The same sentence an install's acceptance produces, deliberately: from
    // the user's side this IS the update continuing, and a second vocabulary
    // for "the host took the job" would read as a different thing happening.
    toast.success(
      input.targetVersion === null
        ? `Updating ${hostName}`
        : `Updating ${hostName} to v${input.targetVersion}`,
    );
    return;
  }
  if (input.response.outcome === "already-updating") {
    input.onAccepted();
    toast.info(`${hostName} is already installing an update.`);
    return;
  }
  if (input.response.outcome === "dispatch-indeterminate") {
    input.onAccepted();
    toast.info(describeIndeterminateDispatch(input.response.reason, hostName));
    return;
  }
  // `cli-failed`, whose `reason` is non-nullable on this schema — the whole
  // point of not reusing the install's response, whose `cli-failed` arm has
  // nowhere to put one.
  const reason = input.response.reason;
  if (reason === "cli-too-old") {
    toast.error(CLI_TOO_OLD_MESSAGE);
    return;
  }
  toast.error(`${describeCliShellFailure("cli-failed", hostName)} (${reason})`);
}

function describeCheckState(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly checking: boolean;
  readonly failure: string | null;
  /** The RPC itself failed — a transport fault, not an answer from the host. */
  readonly unreachable: boolean;
  readonly hostName: string;
  readonly upToDate: boolean;
  /** The install record is ahead of the running host; see the hook's input. */
  readonly activationDebt: {
    readonly installedVersion: string;
    readonly live: boolean;
  } | null;
  readonly remedy: CliFloorRemedy | null;
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
  if (input.failure !== null) {
    return input.failure;
  }
  // Debt outranks everything the CATALOG can say, including "checking": it is
  // a fact about this host's own disk, true whether or not the registry
  // answers, and the sentence names the one action that resolves it. Only a
  // failed install attempt sits above it - that is the answer to something
  // the person just pressed. When the catalog additionally offers something
  // newer than the INSTALLED version, Update now stays beside this sentence
  // (see the hook's `installedVersion`); the button speaks for itself.
  if (input.activationDebt !== null) {
    // Qualified when the record read behind it is not live: the debt was
    // read, and still sets the baseline, but the page is not vouching for it
    // right now (and withholds the Restart until it can).
    return input.activationDebt.live
      ? `v${input.activationDebt.installedVersion} is installed — restart host to finish.`
      : `v${input.activationDebt.installedVersion} is installed (last known) — restart host to finish.`;
  }
  // Like debt, the remedy stays useful during the next check. The hook drops
  // it when that check fails or returns a catalog that clears the refusal.
  if (input.remedy !== null) return input.remedy.sentence;
  if (input.checking) return "Checking for updates…";
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
function readCheckResponse(response: HostUpdateCheckResponseV12 | null): {
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
