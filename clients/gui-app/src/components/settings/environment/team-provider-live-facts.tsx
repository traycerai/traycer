import { useState, type ReactNode } from "react";
import type { EnvironmentPlan } from "@traycer/protocol/host/environment/configuration-contracts";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useConfigurationPlansQuery } from "@/hooks/environment/team/use-plans-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { ProviderRateLimitForProvider } from "@/components/settings/panels/provider-rate-limit-section";
import {
  isRateLimitProfileFetchEligible,
  resolveRateLimitFetchEligibility,
} from "@/lib/rate-limit-providers";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamReadFailed } from "./team-read-failed";
import { TeamContentNeedsHost } from "./team-content-needs-host";

export function TeamProviderLiveFacts(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const scope = useTeamViewingHost();
  const source = useConfigurationSource();
  const name =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const query = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const linkedProfileIds = linkedPlanProfileIds(
    useConfigurationPlansQuery().data?.plans ?? [],
    props.providerId,
  );
  const [picking, setPicking] = useState(false);
  const state = query.data?.providers.find(
    (provider) => provider.providerId === props.providerId,
  );
  const hostName = scope.viewingHost?.hostLabel ?? "This host";
  const noHost = (
    <TeamContentNeedsHost
      content="rate-limits"
      teamName={name}
      onPickHost={() => setPicking(true)}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-ui-sm font-medium">Rate limits</h3>
          <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
        </div>
        <TeamViewingHostBinding unavailable={noHost}>
          {query.isError ? (
            <TeamReadFailed
              message="Couldn't read this host's providers."
              onRetry={() => void query.refetch()}
            />
          ) : null}
          {state === undefined ? null : (
            <TeamPlanLimits
              providerId={props.providerId}
              state={state}
              linkedProfileIds={linkedProfileIds}
              teamName={name}
            />
          )}
        </TeamViewingHostBinding>
      </section>
      {/* Same host gate as the card, so a missing viewing host does not
          describe a binary this page cannot read. */}
      <TeamViewingHostBinding unavailable={null}>
        {state === undefined ? null : (
          <NextRunBinaryDetails state={state} hostName={hostName} />
        )}
      </TeamViewingHostBinding>
    </div>
  );
}

/**
 * Path and version of the binary the viewing host will run, outside the
 * usage card. Omitted when the host has not reported one. A null path is the
 * included agent; a null version is left off rather than printed.
 */
function NextRunBinaryDetails(props: {
  readonly state: ProviderCliState;
  readonly hostName: string;
}): ReactNode {
  const binary = props.state.nextRunBinary;
  if (binary === undefined || binary === null) return null;
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-ui-sm font-medium">
        Details
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-1 text-ui-xs text-muted-foreground">
        <p className="min-w-0 whitespace-normal break-words">
          Executable: {binary.path ?? "Included agent"}
        </p>
        {binary.version === null ? null : (
          <p className="min-w-0 whitespace-normal break-words">
            Version: {binary.version}
          </p>
        )}
        <p className="min-w-0 whitespace-normal break-words">
          as reported by {props.hostName}
        </p>
      </div>
    </details>
  );
}

/** The profiles of the team's linked plans for this provider. */
function linkedPlanProfileIds(
  plans: readonly EnvironmentPlan[],
  providerId: ProviderId,
): readonly string[] {
  return plans
    .filter(
      (plan) =>
        plan.harness === providerIdToGuiHarnessId(providerId) &&
        plan.status === "linked",
    )
    .map((plan) => plan.profileId);
}

/**
 * The limits of the team's linked plans as this host signs them in: each
 * linked plan is a managed profile on the host, read with that profile's own
 * eligibility. The host's ambient login is never a team plan's source.
 *
 * A linked plan with no profile of its id here draws nothing: a copy the host
 * received through profile sync has a local id of its own, and
 * `providers.list` names only that one, so nothing can be said about the
 * plan from here.
 */
function TeamPlanLimits(props: {
  readonly providerId: ProviderId;
  readonly state: ProviderCliState;
  readonly linkedProfileIds: readonly string[];
  readonly teamName: string;
}): ReactNode {
  const eligibility = resolveRateLimitFetchEligibility(props.state);
  const profiles = props.state.profiles.filter(
    (profile) =>
      profile.kind === "managed" &&
      props.linkedProfileIds.includes(profile.profileId),
  );
  if (props.linkedProfileIds.length === 0)
    return (
      <p role="status" className="text-ui-sm text-muted-foreground">
        Link a plan to {props.teamName} to see its rate limits.
      </p>
    );
  return profiles.map((profile) => (
    <ProviderRateLimitForProvider
      key={profile.profileId}
      providerId={props.providerId}
      profileId={profile.profileId}
      usageUpdatedAt={profile.usageUpdatedAt}
      fetchEligible={isRateLimitProfileFetchEligible(eligibility, profile)}
    />
  ));
}
