import { useState, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import { Tabs, TabsList, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import {
  ORDERED_PROVIDERS,
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { useConfigurationProviderItemsQuery } from "@/hooks/environment/team/use-provider-items-query";
import { useConfigurationPlansQuery } from "@/hooks/environment/team/use-plans-query";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { useHostClient } from "@/lib/host";
import { configurationProfileValueSchema } from "@/hooks/environment/team/configuration-item-values";
import { ConfigurationOsPicker } from "./configuration-os-picker";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { TeamTextItems } from "./team-text-items";
import { TeamProfileItem, TeamPackItem } from "./team-provider-items";
import { EnvironmentProviderMcpTab } from "./environment-provider-mcp-tab";
import { TeamProviderLiveFacts } from "./team-provider-live-facts";
import { TeamPlans } from "./team-plans";
import { TeamProviderKeys } from "./team-provider-keys";
import { ProviderRowDetails } from "@/components/settings/details/provider-row-details";
import { useConfigurationAdminNames } from "@/hooks/environment/team/use-admin-names";
import { EnvironmentProviderSkillsTab } from "./environment-skills";
import { teamProviderStateWord } from "./team-provider-state-word";
import { ConfigurationReadFailed } from "./team-read-failed";
import { usePickedTeamLabel } from "./team-pick-label";
import {
  providerEnvSubtitle,
  providerEnvSubtitleUnknownScope,
  providerNativeConfigOnlyEnvSubtitle,
} from "@/components/settings/panels/provider-env-subtitle";
import {
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";

export function TeamProviders(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const source = useConfigurationSource();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const query = useConfigurationProviderItemsQuery();
  const read = useBoundedRead(query);
  const members = useConfigurationAdminNames();
  const scope = useTeamViewingHost();
  const catalog = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const plansQuery = useConfigurationPlansQuery();
  const secretsQuery = useEnvironmentSecretsQuery(useHostClient());
  const railWord = (provider: {
    readonly providerId: ProviderId;
    readonly harnessId: string;
  }): string | null =>
    personal
      ? providerState(items, provider.harnessId)
      : teamProviderStateWord({
          providerId: provider.providerId,
          harnessId: provider.harnessId,
          plans: plansQuery.data?.plans ?? null,
          secrets: secretsQuery.data?.secrets ?? null,
        });
  const [providerId, setProviderId] = useState<ProviderId>("claude-code");
  const [os, setOs] = useState<EnvironmentOs>("any");
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const items = query.data ?? [];
  const harness = providerIdToGuiHarnessId(providerId);
  const profiles = items.filter(
    (item) =>
      item.kind === "managed_profile" &&
      configurationProfileValueSchema.parse(item.value).harnessId === harness,
  );
  const savedPacks = items.filter((item) => item.kind === "pack_policy");
  const packId =
    catalog.data?.providers.find(
      (provider) => provider.providerId === providerId,
    )?.packId ?? null;
  const packs = savedPacks.filter(
    (item) => packId === null || item.key === packId,
  );
  const packIds = [
    ...new Set([
      ...packs.map((item) => item.key),
      ...(packId === null ? [] : [packId]),
    ]),
  ];
  const envSubtitleScope = providerEnvSubtitleScope(
    catalog.data?.providers,
    providerId,
  );
  return (
    <SettingsPanelShell
      title="Providers"
      description={
        personal
          ? "Sign-ins, keys and tools for each coding agent, on every computer and sandbox running Personal."
          : `Plans, keys and settings for each coding agent, on every host running ${teamName}.`
      }
      bodyClassName="flex flex-col gap-4 overflow-visible rounded-none border-none bg-transparent"
    >
      <ConfigurationWriteFeedback issue={issue} />
      {read.pending ? <MutedAgentSpinner /> : null}
      {read.failed ? (
        <ConfigurationReadFailed page="providers" onRetry={read.retry} />
      ) : null}
      {query.data === undefined ? null : (
        <>
          <TeamProviderKeys />
          <Select
            value={providerId}
            onValueChange={(value) => {
              const parsed = providerIdSchema.safeParse(value);
              if (parsed.success) setProviderId(parsed.data);
            }}
          >
            <SelectTrigger aria-label="Provider" className="max-w-sm lg:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDERED_PROVIDERS.map((provider) => {
                const word = railWord(provider);
                return (
                  <SelectItem
                    key={provider.providerId}
                    value={provider.providerId}
                  >
                    {providerDisplayName(provider.providerId)}
                    {word === null ? null : ` · ${word}`}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
            <nav
              aria-label="Providers"
              className="hidden flex-col gap-1 lg:flex"
            >
              {ORDERED_PROVIDERS.map((provider) => (
                <Button
                  key={provider.providerId}
                  type="button"
                  variant={
                    providerId === provider.providerId ? "secondary" : "ghost"
                  }
                  className="justify-between"
                  onClick={() => setProviderId(provider.providerId)}
                  aria-current={
                    providerId === provider.providerId ? "true" : undefined
                  }
                >
                  <span className="truncate">
                    {providerDisplayName(provider.providerId)}
                  </span>
                  <span className="text-ui-xs text-muted-foreground">
                    {railWord(provider)}
                  </span>
                </Button>
              ))}
            </nav>
            <Tabs defaultValue="plans" className="min-w-0 gap-3">
              <TabsList
                variant="line"
                className="h-auto w-full flex-wrap justify-start"
              >
                <TabsTrigger value="plans">Plans & limits</TabsTrigger>
                <TabsTrigger value="env">Env</TabsTrigger>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
                <TabsTrigger value="skills">Skills</TabsTrigger>
                {packIds.length > 0 ? (
                  <TabsTrigger value="pack">Pack version</TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="plans" className="flex flex-col gap-4">
                <TeamPlans
                  providerId={providerId}
                  adminNames={members.adminNames}
                />
                {profiles.map((item) => (
                  <TeamProfileItem
                    key={`${item.key}:${item.revision}`}
                    item={item}
                    onOutcome={(result) =>
                      setIssue(configurationWriteIssue(result))
                    }
                    details={
                      <ProviderRowDetails
                        kind={item.kind}
                        itemKey={item.key}
                        title={
                          configurationProfileValueSchema.parse(item.value).name
                        }
                      />
                    }
                  />
                ))}
                <TeamProviderLiveFacts providerId={providerId} />
              </TabsContent>
              <TabsContent value="env" className="flex flex-col gap-3">
                <p
                  className="text-ui-xs text-muted-foreground"
                  data-testid="team-provider-env-subtitle"
                >
                  {providerEnvSubtitleFor(envSubtitleScope)(
                    providerDisplayName(providerId),
                    personal
                      ? { kind: "personal" }
                      : { kind: "team", teamName },
                  )}
                </p>
                <ConfigurationOsPicker value={os} onChange={setOs} />
                <TeamTextItems
                  key={JSON.stringify([os, harness])}
                  items={items}
                  kind="env_override"
                  os={os}
                  providerId={harness}
                  onOutcome={(result) =>
                    setIssue(configurationWriteIssue(result))
                  }
                  renderDetails={(item) => (
                    <ProviderRowDetails
                      kind={item.kind}
                      itemKey={item.key}
                      title={item.key}
                    />
                  )}
                />
              </TabsContent>
              <TabsContent value="mcp">
                <EnvironmentProviderMcpTab providerId={providerId} />
              </TabsContent>
              <TabsContent value="skills">
                <EnvironmentProviderSkillsTab providerId={providerId} />
              </TabsContent>
              <TabsContent value="pack" className="flex flex-col gap-3">
                {packIds.map((id) => (
                  <TeamPackItem
                    key={`${id}:${packs.find((item) => item.key === id)?.revision ?? "new"}`}
                    packId={id}
                    item={packs.find((item) => item.key === id) ?? null}
                    onOutcome={(result) =>
                      setIssue(configurationWriteIssue(result))
                    }
                  />
                ))}
              </TabsContent>
            </Tabs>
          </div>
        </>
      )}
    </SettingsPanelShell>
  );
}

type EnvSubtitleScope = "config-only" | "normal" | "unknown";

/**
 * Whether the selected provider's Env override reaches its conversations,
 * per its row in the team's own `providers.list` catalog read - "unknown"
 * without a row to read (the catalog hasn't resolved, or there is no
 * reachable viewing host to read it from at all), never a guess either way.
 */
function providerEnvSubtitleScope(
  providers: readonly ProviderCliState[] | undefined,
  providerId: ProviderId,
): EnvSubtitleScope {
  const row = providers?.find((provider) => provider.providerId === providerId);
  if (row === undefined) return "unknown";
  return row.nativeCapabilities.envOverrideScope === "native-config-only"
    ? "config-only"
    : "normal";
}

/** `providerEnvSubtitle`, or one of its siblings for a confirmed
 *  native-config-only provider or an unconfirmed scope. */
function providerEnvSubtitleFor(
  scope: EnvSubtitleScope,
): typeof providerEnvSubtitle {
  switch (scope) {
    case "config-only":
      return providerNativeConfigOnlyEnvSubtitle;
    case "unknown":
      return providerEnvSubtitleUnknownScope;
    case "normal":
      return providerEnvSubtitle;
  }
}

function providerState(
  items: readonly ConfigurationItem[],
  harnessId: string,
): string {
  const count = items.filter((item) => {
    if (item.kind !== "managed_profile") return false;
    const profile = configurationProfileValueSchema.parse(item.value);
    return profile.harnessId === harnessId;
  }).length;
  return count === 0
    ? "No profiles"
    : `${count} ${count === 1 ? "profile" : "profiles"}`;
}
