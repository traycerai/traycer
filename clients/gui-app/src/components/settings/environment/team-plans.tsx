import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  useConfigurationPlansQuery,
  useConfigurationPlanUnlinkPreview,
} from "@/hooks/environment/team/use-plans-query";
import { useConfigurationPlanUnlinkMutation } from "@/hooks/environment/team/use-plan-unlink-mutation";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import {
  providerIdToGuiHarnessId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  useConfigurationSource,
  useCanAdministerConfiguration,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";
import { PlansCard, type ConfigurationPlan } from "./plans-card";
import { ProviderRowDetails } from "@/components/settings/details/provider-row-details";
import { PlanUnlinkPreview } from "./plan-unlink-preview";
import { Button } from "@/components/ui/button";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { TeamReadFailed } from "./team-read-failed";

export function TeamPlans(props: {
  readonly providerId: ProviderId;
  readonly adminNames: readonly string[];
}): ReactNode {
  const source = useConfigurationSource();
  const name =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const canAdminister = useCanAdministerConfiguration();
  const personal = useConfigurationIsPersonal();
  const query = useConfigurationPlansQuery();
  const [target, setTarget] = useState<{
    readonly plan: ConfigurationPlan;
    readonly previewId: string;
  } | null>(null);
  const open = useProviderLinkDialogStore((state) => state.open);
  const plans =
    query.data?.plans.flatMap((plan) => {
      if (
        plan.harness !== providerIdToGuiHarnessId(props.providerId) ||
        plan.status === "empty"
      )
        return [];
      return [
        {
          id: plan.profileId,
          linkedBy: plan.linkedBy?.name ?? null,
          status: plan.status,
          providerLabel: providerDisplayName(props.providerId),
        },
      ];
    }) ?? [];
  if (query.isPending) return <MutedAgentSpinner />;
  if (query.isError)
    return (
      <TeamReadFailed
        message={
          personal
            ? "Couldn't read your plans."
            : `Couldn't read ${name}'s plans.`
        }
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <>
      <PlansCard
        renderDetails={(plan) => (
          <ProviderRowDetails
            kind="plan"
            itemKey={props.providerId}
            title={`${plan.providerLabel} plan`}
          />
        )}
        teamName={name}
        plans={plans}
        canAdminister={canAdminister}
        adminNames={props.adminNames}
        isPending={target !== null}
        onLink={() => {
          if (source.kind === "pool")
            open({
              providerId: props.providerId,
              profileId: null,
              environmentId: source.environmentId,
            });
        }}
        onPreviewUnlink={(plan) =>
          setTarget({ plan, previewId: crypto.randomUUID() })
        }
      />
      {target !== null && canAdminister ? (
        <TeamPlanUnlink
          key={target.previewId}
          plan={target.plan}
          previewId={target.previewId}
          teamName={name}
          onClose={() => setTarget(null)}
        />
      ) : null}
      <ProviderLinkDialog />
    </>
  );
}

function TeamPlanUnlink(props: {
  readonly plan: ConfigurationPlan;
  readonly previewId: string;
  readonly teamName: string;
  readonly onClose: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const preview = useConfigurationPlanUnlinkPreview(
    props.plan.id,
    props.previewId,
  );
  const unlink = useConfigurationPlanUnlinkMutation();
  if (preview.isPending || preview.isFetching)
    return (
      <div className="flex items-center gap-2">
        <MutedAgentSpinner />
        <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    );
  if (preview.isError)
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className="text-ui-sm text-muted-foreground">
          Couldn't preview unlinking this plan.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void preview.refetch()}
          >
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <>
      <PlanUnlinkPreview
        teamName={props.teamName}
        plan={props.plan}
        activeTurns={preview.data.activeTurns}
        activeHostName={
          preview.data.localHostId === null
            ? null
            : (scope.hosts.data?.hosts.find(
                (host) => host.hostId === preview.data.localHostId,
              )?.hostLabel ?? "the serving host")
        }
        remainingAccess={preview.data.keepsWorking}
        isPending={unlink.isPending}
        onClose={props.onClose}
        onConfirm={() => {
          if (source.kind !== "pool") return;
          unlink.mutate(
            { environmentId: source.environmentId, profileId: props.plan.id },
            {
              onSuccess: (result) => {
                if (result.outcome !== "forbidden") props.onClose();
              },
            },
          );
        }}
      />
      {unlink.data?.outcome === "forbidden" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Admins unlink plans.
        </p>
      ) : null}
    </>
  );
}
