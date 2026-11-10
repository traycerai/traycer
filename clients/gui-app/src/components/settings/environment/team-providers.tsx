import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  EnvironmentOs,
  EnvironmentSecret,
} from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentConfigurationItemWriteResponse,
  EnvironmentPlan,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsMasterSelect } from "@/components/settings/settings-master-detail";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
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
import { useConfigurationProviderItemsQuery } from "@/hooks/environment/team/use-provider-items-query";
import { useConfigurationPlansQuery } from "@/hooks/environment/team/use-plans-query";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { useHostClient } from "@/lib/host";
import { configurationProfileValueSchema } from "@/hooks/environment/team/configuration-item-values";
import { cn } from "@/lib/utils";
import { ConfigurationOsPicker } from "./configuration-os-picker";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { TeamTextItems } from "./team-text-items";
import {
  useConfigurationItemWrites,
  type ConfigurationItemWrites,
} from "./configuration-item-writes";
import { TeamPackItem } from "./team-provider-items";
import { EnvironmentProviderMcpTab } from "./environment-provider-mcp-tab";
import { TeamProviderLiveFacts } from "./team-provider-live-facts";
import { ConfigurationProfiles } from "./team-configuration-profiles";
import { TeamPlans } from "./team-plans";
import { ProviderRowDetails } from "@/components/settings/details/provider-row-details";
import { useConfigurationAdminNames } from "@/hooks/environment/team/use-admin-names";
import { EnvironmentProviderSkillsTab } from "./environment-skills";
import {
  cloudProviderStanding,
  teamProviderStateWord,
  type CloudProviderStanding,
} from "./team-provider-state-word";
import { ConfigurationReadFailed } from "./team-read-failed";
import { usePickedTeamLabel } from "./team-pick-label";
import { PROVIDER_ENV_TAB_SUBTITLE } from "@/components/settings/panels/provider-env-subtitle";
import {
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";

function providersPageDescription(personal: boolean, teamName: string): string {
  return personal
    ? "Sign-ins, keys and tools for each coding agent, on every computer and sandbox running Personal."
    : `Sign-ins, keys and tools for each coding agent, on every host running ${teamName}.`;
}

type RailClass = "configured" | "unconfigured" | "unknown";

interface ProviderRailRow {
  readonly providerId: ProviderId;
  readonly harnessId: string;
  readonly railClass: RailClass;
  readonly subtitle: string | null;
}

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
  const items = query.data ?? [];
  const [providerId, setProviderId] = useState<ProviderId>("claude-code");
  const [os, setOs] = useState<EnvironmentOs>("any");
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const writes = useConfigurationItemWrites(query, (result) =>
    setIssue(configurationWriteIssue(result)),
  );
  const [userPicked, setUserPicked] = useState(false);
  const [seenRailKey, setSeenRailKey] = useState<string | null>(null);
  const rows = providerRailRows({
    items: query.data,
    plans: plansQuery.data?.plans ?? null,
    secrets: secretsQuery.data?.secrets ?? null,
  });
  const railKey = rows
    .map((row) => `${row.providerId}:${row.railClass}`)
    .join("|");
  // Latch the first configured provider once the reads settle, during render
  // rather than an effect: the selection is derived from those reads, and a
  // later explicit pick stays put.
  const adjustment = providerRailAdjustment({
    picked: userPicked,
    ready: query.data !== undefined,
    seenRailKey,
    railKey,
    rows,
    providerId,
  });
  if (adjustment !== null) {
    setSeenRailKey(adjustment.railKey);
    if (adjustment.providerId !== providerId) {
      setProviderId(adjustment.providerId);
    }
  }
  const selectProvider = (next: ProviderId): void => {
    setUserPicked(true);
    setProviderId(next);
  };
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
  return (
    <TeamProvidersView
      personal={personal}
      teamName={teamName}
      providerId={providerId}
      os={os}
      onOsChange={setOs}
      issue={issue}
      readPending={read.pending}
      readFailed={read.failed}
      onRetry={read.retry}
      ready={query.data !== undefined}
      rows={rows}
      onSelect={selectProvider}
      profiles={profiles}
      adminNames={members.adminNames}
      packIds={packIds}
      packs={packs}
      items={items}
      writes={writes}
      harness={harness}
      onOutcome={(result) => setIssue(configurationWriteIssue(result))}
    />
  );
}

function TeamProvidersView(props: {
  readonly personal: boolean;
  readonly teamName: string;
  readonly providerId: ProviderId;
  readonly os: EnvironmentOs;
  readonly onOsChange: (os: EnvironmentOs) => void;
  readonly issue: ConfigurationWriteIssue;
  readonly readPending: boolean;
  readonly readFailed: boolean;
  readonly onRetry: () => void;
  readonly ready: boolean;
  readonly rows: readonly ProviderRailRow[];
  readonly onSelect: (providerId: ProviderId) => void;
  readonly profiles: readonly ConfigurationItem[];
  readonly adminNames: readonly string[];
  readonly packIds: readonly string[];
  readonly packs: readonly ConfigurationItem[];
  readonly items: readonly ConfigurationItem[];
  readonly writes: ConfigurationItemWrites;
  readonly harness: string;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const {
    personal,
    teamName,
    providerId,
    os,
    onOsChange,
    issue,
    readPending,
    readFailed,
    onRetry,
    ready,
    rows,
    onSelect,
    profiles,
    adminNames,
    packIds,
    packs,
    items,
    writes,
    harness,
    onOutcome,
  } = props;
  return (
    <SettingsPanelShell
      title="Providers"
      description={providersPageDescription(personal, teamName)}
      bodyClassName="flex flex-col gap-4 overflow-visible rounded-none border-none bg-transparent"
    >
      <ConfigurationWriteFeedback issue={issue} />
      {readPending ? <MutedAgentSpinner /> : null}
      {readFailed ? (
        <ConfigurationReadFailed page="providers" onRetry={onRetry} />
      ) : null}
      {ready ? (
        <>
          <div className="lg:hidden">
            <SettingsMasterSelect
              label="Provider"
              value={providerId}
              options={rows.map((row) => ({
                value: row.providerId,
                label: providerDisplayName(row.providerId),
                icon: <HarnessIcon harnessId={row.harnessId} />,
                trailing: null,
              }))}
              onSelect={onSelect}
            />
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
            <nav
              aria-label="Providers"
              className="hidden min-w-0 flex-col gap-1 lg:flex"
            >
              {rows.map((row) => (
                <ProviderRailButton
                  key={row.providerId}
                  row={row}
                  selected={providerId === row.providerId}
                  onSelect={onSelect}
                />
              ))}
            </nav>
            <Tabs
              key={providerId}
              defaultValue="plans"
              className="min-w-0 gap-3"
            >
              <TabsList
                variant="line"
                className="h-auto w-full max-w-full flex-wrap justify-start"
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
                <TeamPlans providerId={providerId} adminNames={adminNames} />
                <ConfigurationProfiles
                  providerLabel={providerDisplayName(providerId)}
                  profiles={profiles}
                  onOutcome={onOutcome}
                />
                <TeamProviderLiveFacts providerId={providerId} />
              </TabsContent>
              <TabsContent value="env" className="flex flex-col gap-3">
                <p
                  className="text-ui-xs text-muted-foreground"
                  data-testid="team-provider-env-subtitle"
                >
                  {PROVIDER_ENV_TAB_SUBTITLE}
                </p>
                <ConfigurationOsPicker value={os} onChange={onOsChange} />
                <TeamTextItems
                  items={items}
                  kind="env_override"
                  os={os}
                  providerId={harness}
                  writes={writes}
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
                    onOutcome={onOutcome}
                  />
                ))}
              </TabsContent>
            </Tabs>
          </div>
        </>
      ) : null}
    </SettingsPanelShell>
  );
}

function ProviderRailButton(props: {
  readonly row: ProviderRailRow;
  readonly selected: boolean;
  readonly onSelect: (providerId: ProviderId) => void;
}): ReactNode {
  const name = providerDisplayName(props.row.providerId);
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      onClick={() => props.onSelect(props.row.providerId)}
      className={railButtonClass(props.selected)}
    >
      <span className="min-w-0 whitespace-normal break-words">{name}</span>
      {props.row.subtitle === null ? null : (
        <span className="min-w-0 whitespace-normal break-words text-ui-xs text-muted-foreground">
          {props.row.subtitle}
        </span>
      )}
    </button>
  );
}

function railButtonClass(selected: boolean): string {
  return cn(
    "flex h-auto w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-ui-sm whitespace-normal break-words transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
    selected
      ? "bg-accent text-accent-foreground"
      : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
  );
}

/**
 * While the user has not picked a provider, follow the first configured one
 * once each classification is known. Returns null when nothing should move.
 */
function providerRailAdjustment(input: {
  readonly picked: boolean;
  readonly ready: boolean;
  readonly seenRailKey: string | null;
  readonly railKey: string;
  readonly rows: readonly ProviderRailRow[];
  readonly providerId: ProviderId;
}): { readonly railKey: string; readonly providerId: ProviderId } | null {
  if (input.picked || !input.ready || input.seenRailKey === input.railKey) {
    return null;
  }
  const current = input.rows.find((row) => row.providerId === input.providerId);
  const firstConfigured = input.rows.find(
    (row) => row.railClass === "configured",
  );
  if (
    current !== undefined &&
    current.railClass === "unconfigured" &&
    firstConfigured !== undefined
  ) {
    return { railKey: input.railKey, providerId: firstConfigured.providerId };
  }
  return { railKey: input.railKey, providerId: input.providerId };
}

function providerRailRows(input: {
  readonly items: readonly ConfigurationItem[] | undefined;
  readonly plans: readonly EnvironmentPlan[] | null;
  readonly secrets: readonly EnvironmentSecret[] | null;
}): readonly ProviderRailRow[] {
  return ORDERED_PROVIDERS.map((provider) => {
    const count =
      input.items === undefined
        ? null
        : managedProfileCount(input.items, provider.harnessId);
    const word = teamProviderStateWord({
      providerId: provider.providerId,
      harnessId: provider.harnessId,
      plans: input.plans,
      secrets: input.secrets,
    });
    return {
      providerId: provider.providerId,
      harnessId: provider.harnessId,
      railClass: providerRailClass(
        cloudProviderStanding({
          providerId: provider.providerId,
          harnessId: provider.harnessId,
          profileCount: count,
          plans: input.plans,
          secrets: input.secrets,
        }),
      ),
      subtitle: word === "key" ? "key" : null,
    };
  });
}

function providerRailClass(standing: CloudProviderStanding): RailClass {
  switch (standing) {
    case "configured":
      return "configured";
    case "absent":
      return "unconfigured";
    case "unknown":
      return "unknown";
  }
}

function managedProfileCount(
  items: readonly ConfigurationItem[],
  harnessId: string,
): number {
  return items.filter((item) => {
    if (item.kind !== "managed_profile") return false;
    const profile = configurationProfileValueSchema.parse(item.value);
    return profile.harnessId === harnessId;
  }).length;
}
