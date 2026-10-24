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
import { Button } from "@/components/ui/button";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";

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
    <p role="status" className="text-ui-sm text-muted-foreground">
      Rate limits need a host running {name}.{" "}
      <Button
        type="button"
        size="sm"
        variant="link"
        onClick={() => setPicking(true)}
      >
        Pick one.
      </Button>
    </p>
  );
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium">
          Rate limits
          {scope.viewingHost === null
            ? ""
            : ` · read through ${scope.viewingHost.hostLabel ?? scope.viewingHost.hostId}`}
        </h3>
        <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      </div>
      <TeamViewingHostBinding unavailable={noHost}>
        {query.isError ? (
          <p role="status" className="text-ui-sm text-muted-foreground">
            Couldn't read this host's providers.
          </p>
        ) : null}
        {state === undefined ? null : (
          <>
            <NextRunBinaryLine state={state} hostName={hostName} />
            <TeamPlanLimits
              providerId={props.providerId}
              state={state}
              linkedProfileIds={linkedProfileIds}
              teamName={name}
              hostName={hostName}
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
 * eligibility. The host's ambient login is never a team plan's source; a host
 * without the plan's profile says so instead.
 */
function TeamPlanLimits(props: {
  readonly providerId: ProviderId;
  readonly state: ProviderCliState;
  readonly linkedProfileIds: readonly string[];
  readonly teamName: string;
  readonly hostName: string;
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
  if (profiles.length === 0)
    return (
      <p role="status" className="text-ui-sm text-muted-foreground">
        {props.hostName} hasn't signed in {props.teamName}'s plan yet.
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
