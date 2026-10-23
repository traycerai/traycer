import { useState, type ReactNode } from "react";
import type {
  ProviderId,
  ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providerDisplayName } from "@/lib/provider-ordering";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { TeamContentNeedsHost } from "./team-content-needs-host";

export function TeamSkillsPage(): ReactNode {
  return (
    <SettingsPanelShell
      title="Skills"
      description="Instructions for a kind of task, available to agents running this team."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <TeamSkills providerId={null} />
    </SettingsPanelShell>
  );
}

export function TeamSkills(props: {
  readonly providerId: ProviderId | null;
}): ReactNode {
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const name =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const query = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ProviderId>("claude-code");
  const providers =
    query.data?.providers.filter(
      (provider) =>
        provider.nativeCapabilities.skills?.actionScopes.list.includes(
          "global",
        ) === true,
    ) ?? [];
  const state = skillProviderFor(providers, picked, props.providerId);
  const noHost = (
    <TeamContentNeedsHost
      content="skills"
      teamName={name}
      onPickHost={() => setPicking(true)}
    />
  );
  return (
    <section className="flex flex-col gap-3">
      <TeamViewingHostPicker
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
        }}
      />
      <TeamViewingHostBinding unavailable={noHost}>
        {query.isPending ? <MutedAgentSpinner /> : null}
        {query.isError ? (
          <p role="status" className="text-ui-sm text-muted-foreground">
            Couldn't read these skills.
          </p>
        ) : null}
        {props.providerId === null && providers.length > 0 ? (
          <Select
            value={state?.providerId ?? ""}
            onValueChange={(value) => {
              const parsed = providerIdSchema.safeParse(value);
              if (parsed.success) setPicked(parsed.data);
            }}
          >
            <SelectTrigger
              aria-label="Provider for skills"
              className="max-w-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem
                  key={provider.providerId}
                  value={provider.providerId}
                >
                  {providerDisplayName(provider.providerId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {state === undefined ? null : (
          <ProviderSkillsTab
            key={`${scope.viewingHost?.hostId}:${state.providerId}`}
            state={state}
          />
        )}
      </TeamViewingHostBinding>
    </section>
  );
}

/** The page can pick another capable provider; a provider tab cannot. */
function skillProviderFor(
  providers: readonly ProviderCliState[],
  picked: ProviderId,
  providerId: ProviderId | null,
): ProviderCliState | undefined {
  return (
    providers.find(
      (provider) => provider.providerId === (providerId ?? picked),
    ) ?? (providerId === null ? providers.at(0) : undefined)
  );
}
