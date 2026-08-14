import { useState } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type {
  HostAvailableManifest,
  HostUpdateCheckResponse,
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
  const [includePreReleases, setIncludePreReleases] = useState(false);
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
    includePreReleases,
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

  const latest = manifest?.latest ?? null;
  // While the CURRENT ask is in error, the retained manifest is display
  // history, not an actionable catalog: TanStack keeps the previous data
  // beside `isError`, and deriving install affordances from it would offer
  // versions the failed check could not confirm - under a summary that says
  // the host could not be checked.
  const actionableManifest = checkQuery.isError ? null : manifest;
  // PRECEDENCE, not equality: a host running a hotfix or RC AHEAD of the
  // stable channel is not outdated, and offering Update now there submits a
  // target the CLI short-circuits as `installed-up-to-date` - an update that
  // announces itself and performs no work. `latest` must be STRICTLY newer to
  // offer anything; equal precedence (build-metadata differences included)
  // and incomparable pairs both count as up to date for the SUMMARY - the
  // picker below stays the surface for deliberate cross-channel moves.
  const upToDate =
    latest !== null &&
    installedVersion !== null &&
    !latestIsStrictlyNewer(installedVersion, latest);
  // The summary action resolves through the SAME availability checks as the
  // picker rows: a latest with no usable asset for this host is advertised
  // nowhere rather than installable in one surface and unavailable in the
  // other.
  const updatableVersion = offerableLatestVersion({
    manifest: actionableManifest,
    installedVersion,
    platformKey: input.platformKey,
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
      includePreReleases,
      // Just moves the flag. It is part of the QUERY KEY, so changing it asks
      // the host a different question by itself — no explicit re-check, and no
      // risk of the two drifting apart the way an imperative re-ask could.
      onIncludePreReleasesChange: setIncludePreReleases,
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
 * host CONFIRMED (not error-retained data), `latest` must be strictly newer
 * than what is installed, the latest entry must not be YANKED (the row
 * disables it and the CLI's `resolveAsset` refuses it before download, so an
 * offer here would dispatch an install the host is guaranteed to reject), and
 * the entry must resolve a usable asset for this host's platform.
 */
function offerableLatestVersion(input: {
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
}): string | null {
  const { manifest } = input;
  if (manifest === null) return null;
  const latest = manifest.latest;
  if (
    input.installedVersion !== null &&
    !latestIsStrictlyNewer(input.installedVersion, latest)
  ) {
    return null;
  }
  const entry = manifest.versions.find(
    (candidate) => candidate.version === latest,
  );
  if (entry === undefined) return null;
  if (entry.yanked) return null;
  const asset = platformAssetFor(entry.platforms, input.platformKey);
  return assetUnavailableReason(asset) === null ? latest : null;
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
    | "already-updating";
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
  if (input.upToDate) return "This host is running the latest version.";
  // A latest this host cannot act on — yanked, or no asset for its platform.
  // Claiming plain availability here would put the sentence at odds with the
  // absent button; the version list carries the specific reason.
  if (!input.offerable) {
    return `v${input.manifest.latest} is available, but ${input.hostName} can't install it.`;
  }
  return `v${input.manifest.latest} is available.`;
}

/**
 * The check's latest answer, split into the three things the page renders from
 * it: the manifest, a reason to retire the region, and a reason to retry.
 *
 * "Nothing asked yet" and an `ok` answer both mean "no failure", which is why
 * the two collapse here rather than at every use site.
 */
function readCheckResponse(response: HostUpdateCheckResponse | null): {
  readonly manifest: HostAvailableManifest | null;
  readonly sticky: OverviewDegradeReason | null;
  readonly transient: CliShellFailure | null;
} {
  if (response === null) {
    return { manifest: null, sticky: null, transient: null };
  }
  if (response.outcome === "ok") {
    return { manifest: response.manifest, sticky: null, transient: null };
  }
  // `stickyDegradeFor` owns the classification, and it is deliberately wider
  // than this response: `externally-managed` is an INSTALL outcome, which the
  // check schema does not carry. Naming it here as well was dead code the
  // compiler rejected — the shared classifier is what keeps the two paths
  // agreeing about which refusals are structural.
  const sticky = stickyDegradeFor(response.outcome);
  if (sticky !== null) return { manifest: null, sticky, transient: null };
  return { manifest: null, sticky: null, transient: response.outcome };
}
