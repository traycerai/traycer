import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { ProviderRateLimitForProvider } from "@/components/settings/panels/provider-rate-limit-section";
import { resolveRateLimitFetchEligibility } from "@/lib/rate-limit-providers";
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
  const [picking, setPicking] = useState(false);
  const state = query.data?.providers.find(
    (provider) => provider.providerId === props.providerId,
  );
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
        {state?.nextRunBinary === undefined ||
        state.nextRunBinary === null ? null : (
          <p className="text-ui-xs text-muted-foreground">
            {scope.viewingHost?.hostLabel ?? "This host"} uses:{" "}
            {state.nextRunBinary.path ?? "Included agent"}
            {state.nextRunBinary.version === null
              ? ""
              : ` · ${state.nextRunBinary.version}`}
            .
          </p>
        )}
        {state === undefined ? null : (
          <ProviderRateLimitForProvider
            providerId={props.providerId}
            profileId={null}
            usageUpdatedAt={null}
            fetchEligible={resolveRateLimitFetchEligibility(state).ambient}
          />
        )}
      </TeamViewingHostBinding>
    </section>
  );
}
