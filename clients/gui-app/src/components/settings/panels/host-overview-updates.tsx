import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import {
  HostVersionRows,
  type HostVersionRow,
} from "@/components/settings/panels/host-version-rows";
import { VERSION_LIST_PREVIEW } from "@/components/settings/panels/host-settings-panel-model";
import {
  describeCliShellFailure,
  describeOverviewDegrade,
  type CliShellFailure,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  useHostUpdateCheck,
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
 * The check remains a mutation, not a query, for the reason `host.doctor` is:
 * it spawns a process on the host and reaches the registry, so it happens when
 * someone asks and not because a settings pane mounted.
 *
 * This region is the part that can vanish. A host without the methods, a host
 * with no CLI to shell, and a host whose updates are driven externally leave
 * the auto-update policy as the only supported control — so this degrades to
 * nothing (plus one line saying why) rather than offering a button that cannot
 * work.
 */
export function HostOverviewUpdatesRegion(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  /** `host.status`'s version — what the process says it is running right now. */
  readonly installedVersion: string | null;
  /** Tri-state `host.update.check` support; `null` is NOT a degrade. */
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  /**
   * The scoped host's registry platform key (`linux-x64`), used only as the
   * FALLBACK asset lookup — see `platformAssetFor`.
   */
  readonly platformKey: string | null;
  /** True while any other Overview mutation holds the page. */
  readonly busy: boolean;
}): ReactNode {
  const { client, hostName, installedVersion } = props;
  const [manifest, setManifest] = useState<HostAvailableManifest | null>(null);
  const [showAllVersions, setShowAllVersions] = useState(false);
  // Two different lifetimes, deliberately kept apart.
  //
  // `discoveredDegrade` is STICKY: `cli-unavailable` and `externally-managed`
  // are facts about how this host is set up, not about this attempt, and
  // neither is knowable before we try. Once either is seen the whole region
  // retires for this mounting and says so, because for an externally-managed
  // host there is no fallback control left to point at: it skips the update
  // reconciler outright, so neither this list nor the auto-update switch
  // reaches it. Leaving Check-now behind would keep offering the one action we
  // have just been told can never lead anywhere.
  const [discoveredDegrade, setDiscoveredDegrade] =
    useState<OverviewDegradeReason | null>(null);
  // `transientFailure` is NOT sticky: `cli-failed` and `invalid-output` say
  // this attempt went wrong, not that the mechanism is unavailable, so the
  // controls stay and the message clears on the next try.
  const [transientFailure, setTransientFailure] =
    useState<CliShellFailure | null>(null);

  const checkMutation = useHostUpdateCheck(client);
  const installMutation = useHostUpdateInstall(client);

  // Any one of the three retires the region. `installDegrade` counts even
  // though checking would still work: learning about a version this host can
  // never install is not a capability, it is a tease.
  const regionDegrade =
    discoveredDegrade ?? props.checkDegrade ?? props.installDegrade;
  if (regionDegrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-updates-degraded">
        {describeOverviewDegrade(regionDegrade, hostName)}
      </HostOverviewNotice>
    );
  }

  const latest = manifest?.latest ?? null;
  const upToDate =
    latest !== null && installedVersion !== null && latest === installedVersion;

  return (
    <div
      className="flex flex-col border-t border-border/40"
      data-testid="host-overview-updates"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-ui-sm">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {describeCheckState({
            manifest,
            checking: checkMutation.isPending,
            failure: transientFailure,
            hostName,
            upToDate,
          })}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={checkMutation.isPending || props.busy}
            data-testid="host-overview-update-check"
            onClick={() => {
              checkMutation.mutate(undefined, {
                onSuccess: (response) => {
                  if (response.outcome === "ok") {
                    setManifest(response.manifest);
                    setTransientFailure(null);
                    return;
                  }
                  setManifest(null);
                  // A check that comes back `cli-unavailable` retires the whole
                  // region, not just this attempt: there is no CLI on that host
                  // to check WITH, so neither button can ever work.
                  const sticky = stickyDegradeFor(response.outcome);
                  if (sticky !== null) {
                    setDiscoveredDegrade(sticky);
                    return;
                  }
                  setTransientFailure(response.outcome);
                },
                onError: (error) =>
                  toastFromHostError(error, "Couldn't check for updates."),
              });
            }}
          >
            {checkMutation.isPending ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Check now
          </Button>
        </div>
      </div>
      {transientFailure === null ? null : (
        <HostOverviewNotice testId="host-overview-update-attempt-failed">
          {describeCliShellFailure(transientFailure, hostName)}
        </HostOverviewNotice>
      )}
      {manifest === null ? null : (
        <div
          className="flex flex-col gap-2 border-t border-border/40 px-5 py-3"
          data-testid="host-overview-version-picker"
        >
          <HostVersionRows
            rows={visibleVersionRows({
              manifest,
              installedVersion,
              platformKey: props.platformKey,
              showAll: showAllVersions,
            })}
            totalCount={manifest.versions.length}
            showAll={showAllVersions}
            onToggleShowAll={() => setShowAllVersions((previous) => !previous)}
            installingVersion={
              installMutation.isPending
                ? installMutation.variables.version
                : null
            }
            disabled={props.busy}
            onInstall={(version) => {
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
                      onSticky: setDiscoveredDegrade,
                      onTransient: setTransientFailure,
                      onAccepted: () => setTransientFailure(null),
                    });
                  },
                  onError: (error) =>
                    toastFromHostError(error, "Couldn't start the update."),
                },
              );
            }}
          />
        </div>
      )}
    </div>
  );
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
  readonly manifest: HostAvailableManifest;
  readonly installedVersion: string | null;
  readonly platformKey: string | null;
  readonly showAll: boolean;
}): readonly HostVersionRow[] {
  const { manifest } = input;
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
 * A SOLE entry is authoritative and is taken as-is: the host's CLI projects
 * every entry to `currentHostPlatformKey()` before emitting it
 * (`host-available.ts`), so the one key present IS the host's own answer, and
 * second-guessing it with a key derived here would get win32-arm64 wrong — that
 * host resolves to the emulated `win32-x64` build, which the registry row does
 * not know.
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
  if (keys.length === 1) return platforms[keys[0]] ?? null;
  if (platformKey === null) return null;
  return platforms[platformKey] ?? null;
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
function stickyDegradeFor(
  outcome: CliShellFailure | "externally-managed",
): OverviewDegradeReason | null {
  if (outcome === "cli-unavailable") return "cli-unavailable";
  if (outcome === "externally-managed") return "externally-managed";
  return null;
}

function handleInstallOutcome(input: {
  readonly outcome:
    "accepted" | "externally-managed" | "cli-unavailable" | "cli-failed";
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
  readonly hostName: string;
  readonly upToDate: boolean;
}): string {
  if (input.checking) return "Checking for updates…";
  if (input.failure !== null) {
    return describeCliShellFailure(input.failure, input.hostName);
  }
  if (input.manifest === null) {
    return "Ask this host which versions it can install.";
  }
  if (input.upToDate) return "This host is running the latest version.";
  return `v${input.manifest.latest} is available.`;
}
