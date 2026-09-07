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
import {
  useHostNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";

/** Check now is a forced refetch, which is the one thing that ignores `staleTime`. */
export function useHostOverviewUpdates(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  readonly hostId: string | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  /** Whether this host is worth asking at all - the page owns that gate. */
  readonly enabled: boolean;
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  readonly busy: boolean;
}): HostOverviewUpdatesState {
  const { client, hostName, installedVersion } = input;
  const installVersion = useHostNegotiatedMethodVersion(
    client,
    "host.update.install",
  );
  const supportsDowngrade = versionSupportsDowngrade(installVersion);
  const [showAllVersions, setShowAllVersions] = useState(false);
  // `undefined` until the user touches the checkbox: the default is the host's own derivation, not a value this
  // component picked.
  const [includePreReleasesOverride, setIncludePreReleasesOverride] = useState<
    boolean | undefined
  >(undefined);
  // Settings can swap the scoped host under a subtree `HostScopeGate` keeps mounted, and a filter carried across
  // that swap would silently apply one machine's decision to another.
  const [overrideHostId, setOverrideHostId] = useState(input.hostId);
  if (overrideHostId !== input.hostId) {
    setOverrideHostId(input.hostId);
    setIncludePreReleasesOverride(undefined);
  }
  // The `discoveredAt` stamp is what lets a check answer that arrived after the refusal clear it below; the ok
  // answer TanStack retained from before the install must not count as fresh evidence.
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

  // A query re-asks on its own schedule, so state that only ever latched a failure would outlive the condition
  // that produced it: a host that gains a Traycer CLI would keep a retired region until the page was remounted.
  const check = readCheckResponse(checkQuery.data ?? null);
  const manifest = check.manifest;
  // A check that succeeded after the refusal was discovered refutes `cli-unavailable` - installing the CLI and
  // restarting the host must not leave the region retired until the user leaves the scope and returns.
  if (
    checkRefutesDiscoveredRefusal({
      discovered: installDiscovered,
      manifest: check.manifest,
      checkDataUpdatedAt: checkQuery.dataUpdatedAt,
    })
  ) {
    setInstallDiscovered(null);
  }
  // `installDegrade` counts even though checking would still work: learning about a version this host can never
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
        // Everything left here only touches state that is meaningless without this component.
        onSuccess: (response) => {
          handleInstallOutcome({
            outcome: response.outcome,
            indeterminateReason:
              response.outcome === "dispatch-indeterminate"
                ? response.reason
                : null,
            hostName,
            version,
            // `Date.now` here, in the settle, is what "after the refusal" means for the render-time clear above: a
            // retained ok answer has an older `dataUpdatedAt` and cannot refute this discovery.
            onSticky: (reason) => {
              setInstallDiscovered({ reason, discoveredAt: Date.now() });
              // One immediate re-ask puts the CLI's absence into the check's own answer, where the table-owned condition
              // poll (`host-method-policy-table.ts`) owns recovery from there.
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

  // While the current ask is in error, the retained manifest is display history, not an actionable catalog.
  const actionableManifest = checkQuery.isError ? null : manifest;
  // Only the picker may request a deliberate downgrade; the summary must never offer one as an update.
  const targetVersion = newerTargetVersion({
    manifest,
    installedVersion,
    source: check.source,
  });
  // Read off the resolved target rather than `manifest.latest`, which for an installed-RC catalog is the wrong
  // pointer.
  const upToDate =
    manifest !== null && installedVersion !== null && targetVersion === null;
  // The one state "up to date" would misdescribe: an `installed-rc` follower whose own line has run out, while
  // the catalog still lists something newer on another line.
  const strandedOnLine = strandedLineTarget({
    upToDate,
    manifest,
    installedVersion,
    source: check.source,
  });
  // The summary action resolves through the same availability checks as the picker rows.
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
        // The two differ whenever the best candidate is unusable.
        targetVersion: updatableVersion ?? targetVersion,
        strandedOnLine,
        installedVersion,
      }),
      transientFailure,
      checking,
      // Offered only for a latest that is both known and not already installed, and never while the row is still
      // reporting a failed attempt.
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
        supportsDowngrade,
      }),
      totalCount: manifest?.versions.length ?? 0,
      showAll: showAllVersions,
      onToggleShowAll: () => setShowAllVersions((previous) => !previous),
      // Before any interaction the override is absent, so the host's own resolved inclusion is the honest answer -
      // on an RC host that renders the box ticked, matching the RC rows beside it.
      includePreReleases: resolveCheckboxState(
        includePreReleasesOverride,
        check.effectiveIncludePreReleases,
      ),
      // The first interaction turns the absent state into an explicit one, and never returns to absent.
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

/** Order is the manifest's own - the registry publishes newest first, and re-sorting client-side would mean
 * parsing versions this list has no business having an opinion about (a staging build id is not semver. */
function visibleVersionRows(input: {
  /** `null` before the first check has answered - then there are no rows. */
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  readonly showAll: boolean;
  readonly supportsDowngrade: boolean;
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
        versionUnavailableReason(
          input.installedVersion,
          entry.version,
          input.supportsDowngrade,
        ),
    };
  });
}

/** Every other provenance keeps the plain `latest` behaviour, including an explicit include. */
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

/** Collapsing them would make a yanked or wrong-platform target read as "running the latest version", which is
 * a different - and false - claim. */
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

/** A list rather than one pick, because each candidate still has to clear the yanked/asset gates above -
 * "prefer stable IF usable, otherwise the highest later RC" cannot be expressed by choosing before those run. */
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
  // Without this the stable is returned twice, and `offerableLatestVersion` pays for a second yanked and
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

/** A stable host with explicit inclusion is the case this gate exists for: it is on the newest stable, `latest`
 * names that stable, and a newer RC row appears only because the user asked to see RCs. */
function strandedLineTarget(input: {
  readonly upToDate: boolean;
  readonly manifest: HostAvailableManifest | null;
  readonly installedVersion: string | null;
  readonly source: HostIncludePreReleasesSource | null;
}): string | null {
  if (!input.upToDate || input.source !== "installed-rc") return null;
  return newestNewerVersion(input.manifest, input.installedVersion);
}

/** What the checkbox shows: the user's override once expressed, otherwise the catalog's own resolved inclusion,
 * otherwise unticked until the first answer. */
function resolveCheckboxState(
  override: boolean | undefined,
  effective: boolean | null,
): boolean {
  if (override !== undefined) return override;
  return effective ?? false;
}

/** This does not decide what to offer; it answers whether the summary may claim "running the latest version". */
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

/** Newest first, and a lawful comparator: it returns 0 for pairs that are equal or that cannot be compared at
 * all. */
function compareNewestFirst(a: string, b: string): number {
  if (isStrictlyNewerHostVersion(a, b)) return -1;
  if (isStrictlyNewerHostVersion(b, a)) return 1;
  return 0;
}

/** Whether `latest` is strictly newer than the installed version - the only state in which the summary offers
 * Update now. */
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

/** Only a host advertising downgrade support can honor an older target. */
function versionUnavailableReason(
  installedVersion: string | null,
  rowVersion: string,
  supportsDowngrade: boolean,
): string | null {
  if (installedVersion === null || installedVersion === rowVersion) return null;
  const comparison = compareHostVersions(installedVersion, rowVersion);
  if (!comparison.comparable) return null;
  if (comparison.ordering === "equal") return `Already on v${installedVersion}`;
  if (comparison.ordering === "greater" && !supportsDowngrade) {
    return "Update this host to a release that supports downgrades from Settings.";
  }
  return null;
}

/** The two shapes are not distinguishable from the entry alone, so a sole key is validated against the
 * registry's platform string rather than trusted outright. */
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
  // A unique prefix match is that OS's one asset and is taken; several candidates stay a miss rather than a
  // guess - reported as "no asset", never resolved to the wrong architecture.
  const prefixed = keys.filter((key) => key.startsWith(`${platformKey}-`));
  if (prefixed.length === 1) return platforms[prefixed[0]] ?? null;
  return null;
}

/** Anything else is a legacy single-platform release for some other host, and refusing it here mirrors the
 * refusal the host CLI's own `resolveAsset` would produce at install time. */
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

/** Retiring the region for those would take the retry away from the person best placed to use it. */
/** `externally-managed` deliberately never clears here: the check's outcome union has no externally-managed arm
 * (schemas.ts), so an ok check is what an externally-managed host answers too. */
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
  /** Carried rather than dropped because three different causes reach that one outcome - an ack timeout, the
   * child exiting, and a bad or missing ack. */
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
    // The page-wide lock makes this rare from here, but it cannot be airtight.
    input.onAccepted();
    toast.info(`${input.hostName} is already installing an update.`);
    return;
  }
  if (input.outcome === "dispatch-indeterminate") {
    // An update may well be running, so this must not read as "nothing happened"; equally it may not read as
    // "updating", because nothing here can name what would be updating.
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
  /** The RPC itself failed - a transport fault, not an answer from the host. */
  readonly unreachable: boolean;
  readonly hostName: string;
  readonly upToDate: boolean;
  readonly offerable: boolean;
  readonly targetVersion: string | null;
  /** Set only when this host's own release line has no newer candidate but the catalog does - the state "running
   * the latest version" would misdescribe. */
  readonly strandedOnLine: string | null;
  readonly installedVersion: string | null;
}): string {
  // Ordered so a stale answer never outranks what is happening now: a refetch keeps the previous manifest on
  // screen, so "vX is available." would otherwise sit there unchanged while a re-check ran, or failed.
  if (input.checking) return "Checking for updates…";
  if (input.failure !== null) {
    return describeCliShellFailure(input.failure, input.hostName);
  }
  if (input.unreachable) {
    // Deliberately not a toast, which is what the imperative check's `onError` raised.
    return `Couldn't ask ${input.hostName} which versions it can install.`;
  }
  // No answer yet and nothing wrong: the first load, which now starts by itself.
  if (input.manifest === null) return "Checking for updates…";
  if (input.upToDate) {
    // Naming the installed version names the line, and pointing at the list is not decoration - those rows are
    // enabled, and they are the only way across.
    if (input.strandedOnLine !== null && input.installedVersion !== null) {
      return `v${input.strandedOnLine} is available, but ${input.installedVersion} follows its own release line and won't update to it automatically. Pick it below to move.`;
    }
    return "This host is running the latest version.";
  }
  // Nothing strictly newer to name - an unknown installed version leaves the comparison undecidable, so the
  // catalog is reported without a claim about whether this host is behind it.
  const target = input.targetVersion;
  if (target === null) return "This host is running the latest version.";
  // A target this host cannot act on - yanked, or no asset for its platform. Claiming plain availability here
  // would put the sentence at odds with the absent button; the version list carries the specific reason.
  if (!input.offerable) {
    return `v${target} is available, but ${input.hostName} can't install it.`;
  }
  return `v${target} is available.`;
}

/** A v1.0 host cannot produce this value: its response carries no provenance at all, and the v1.0→v1.1 bridge
 * deliberately answers `explicit-include` or `stable-default` and never `installed-rc`. */
function describeIncludePreReleasesSource(
  source: HostIncludePreReleasesSource | null,
  installedVersion: string | null,
): string | null {
  if (source !== "installed-rc") return null;
  return installedVersion === null
    ? "This host is on a release candidate, so its own line is listed."
    : `This host is on ${installedVersion}, so its own release-candidate line is listed.`;
}

/** "Nothing asked yet" and an `ok` answer both mean "no failure", which is why the two collapse here rather
 * than at every use site. */
function readCheckResponse(response: HostUpdateCheckResponseV11 | null): {
  readonly manifest: HostAvailableManifest | null;
  readonly sticky: OverviewDegradeReason | null;
  readonly transient: CliShellFailure | null;
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
  // `stickyDegradeFor` owns the classification, and it is deliberately wider than this response:
  // `externally-managed` is an install outcome, which the check schema does not carry.
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
