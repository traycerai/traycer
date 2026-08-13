import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  HostOverviewNotice,
  HostOverviewActionButton,
} from "@/components/settings/panels/host-overview-status-card";
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
 * The IMMEDIATE half of a host's update story, over the host's own RPC.
 *
 * Its sibling — the account registry's auto-update policy and version pin — is
 * `HostRegistryUpdates`, and the two stay side by side in one card because a
 * person has one update question, not two. They are genuinely different
 * mechanisms though, and the copy keeps them apart: this one asks the host to
 * go and do it now; that one records what the host should be running and lets
 * it pick the instruction up on its next check-in.
 *
 * This region is the part that can vanish. A host without the methods, a host
 * with no CLI to shell, and a host whose updates are driven externally all
 * leave the cloud pin as the supported control — so this degrades to nothing
 * (plus one line saying why) rather than offering a button that cannot work.
 */
export function HostOverviewUpdatesRegion(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  /** `host.status`'s version — what the process says it is running right now. */
  readonly installedVersion: string | null;
  /** Tri-state `host.update.check` support; `null` is NOT a degrade. */
  readonly checkDegrade: OverviewDegradeReason | null;
  readonly installDegrade: OverviewDegradeReason | null;
  /** True while any other Overview mutation holds the page. */
  readonly busy: boolean;
}): ReactNode {
  const { client, hostName, installedVersion } = props;
  const [manifest, setManifest] = useState<HostAvailableManifest | null>(null);
  // Two different lifetimes, deliberately kept apart.
  //
  // `discoveredDegrade` is STICKY: `cli-unavailable` and `externally-managed`
  // are facts about how this host is set up, not about this attempt, and
  // neither is knowable before we try. Once either is seen the whole region
  // retires for this mounting and the cloud pin becomes the only update
  // control — which is what "degrade to the cloud-pin-only UI" has to mean.
  // Leaving Check-now behind would keep offering the one action we have just
  // been told can never lead anywhere.
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
          {latest !== null && !upToDate ? (
            <HostOverviewActionButton
              label={`Update to v${latest}`}
              hostName={hostName}
              variant="default"
              degrade={null}
              pending={installMutation.isPending}
              busy={props.busy}
              testId="host-overview-update-install"
              buttonRef={undefined}
              onClick={() => {
                installMutation.mutate(
                  { version: latest, force: false },
                  {
                    // MOUNTED UI state only. The `host.status` invalidation
                    // this used to do moved to `useHostUpdateInstall`'s
                    // hook-level `onSuccess`: an install outlives a Settings
                    // scope switch, which remounts this panel under its host
                    // key, and TanStack drops per-`mutate` callbacks once the
                    // observer is gone. Everything left here only touches
                    // state that is meaningless without this component.
                    onSuccess: (response) => {
                      handleInstallOutcome({
                        outcome: response.outcome,
                        hostName,
                        latest,
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
          ) : null}
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
    </div>
  );
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
  readonly latest: string;
  readonly onSticky: (reason: OverviewDegradeReason) => void;
  readonly onTransient: (failure: CliShellFailure) => void;
  readonly onAccepted: () => void;
}): void {
  if (input.outcome === "accepted") {
    input.onAccepted();
    toast.success(`Updating ${input.hostName} to v${input.latest}`);
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
    return "Ask this host to check for a newer version.";
  }
  if (input.upToDate) return "This host is running the latest version.";
  return `v${input.manifest.latest} is available.`;
}
