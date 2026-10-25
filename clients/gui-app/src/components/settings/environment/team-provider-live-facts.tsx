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
          <>
            <NextRunBinaryLine state={state} hostName={hostName} />
            <TeamPlanLimits
              providerId={props.providerId}
              state={state}
              linkedProfileIds={linkedProfileIds}
              teamName={name}
            />
          </>
        )}
      </TeamViewingHostBinding>
    </section>
  );
}

/** `Studio uses: <path> · <version>.`, when the host reports its next binary. */
function NextRunBinaryLine(props: {
  readonly state: ProviderCliState;
  readonly hostName: string;
}): ReactNode {
  const binary = props.state.nextRunBinary;
  if (binary === undefined || binary === null) return null;
  return (
    <p className="text-ui-xs text-muted-foreground">
      {props.hostName} uses: {binary.path ?? "Included agent"}
      {binary.version === null ? "" : ` · ${binary.version}`}.
    </p>
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
