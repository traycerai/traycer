import { useState, type ReactNode } from "react";
import { z } from "zod";
import { MoreHorizontal, Plus } from "lucide-react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  EnvironmentOs,
  EnvironmentSecret,
} from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentConfigurationItemWriteResponse,
  EnvironmentPlan,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
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
import { TeamPlans } from "./team-plans";
import { TeamProviderKeys } from "./team-provider-keys";
import { ProviderRowDetails } from "@/components/settings/details/provider-row-details";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import { useProviderRowDetailsSubject } from "@/components/settings/details/use-provider-row-details-subject";
import { useConfigurationAdminNames } from "@/hooks/environment/team/use-admin-names";
import { EnvironmentProviderSkillsTab } from "./environment-skills";
import {
  cloudProviderStanding,
  type CloudProviderStanding,
} from "./team-provider-state-word";
import { ConfigurationReadFailed } from "./team-read-failed";
import { usePickedTeamLabel } from "./team-pick-label";
import {
  providerEnvSubtitle,
  providerEnvSubtitleUnknownScope,
  providerNativeConfigOnlyEnvSubtitle,
} from "@/components/settings/panels/provider-env-subtitle";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";

const PROVIDERS_PAGE_DESCRIPTION =
  "Sign-ins, keys and tools for each coding agent.";

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
  const [addProviderOpen, setAddProviderOpen] = useState(false);
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
  const primary = rows.filter((row) => row.railClass !== "unconfigured");
  const unconfigured = rows.filter((row) => row.railClass === "unconfigured");
  const selectedFolded =
    unconfigured.find((row) => row.providerId === providerId) ?? null;
  const behindAdd = unconfigured.filter((row) => row.providerId !== providerId);
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
  const envSubtitleScope = providerEnvSubtitleScope(
    catalog.data?.providers,
    providerId,
  );
  return (
    <TeamProvidersView
      personal={personal}
      teamName={teamName}
      providerId={providerId}
      addProviderOpen={addProviderOpen}
      onToggleAdd={() => setAddProviderOpen((open) => !open)}
      os={os}
      onOsChange={setOs}
      issue={issue}
      readPending={read.pending}
      readFailed={read.failed}
      onRetry={read.retry}
      ready={query.data !== undefined}
      primary={primary}
      selectedFolded={selectedFolded}
      behindAdd={behindAdd}
      onSelect={selectProvider}
      profiles={profiles}
      adminNames={members.adminNames}
      packIds={packIds}
      packs={packs}
      items={items}
      writes={writes}
      harness={harness}
      envSubtitleScope={envSubtitleScope}
      onOutcome={(result) => setIssue(configurationWriteIssue(result))}
    />
  );
}

function TeamProvidersView(props: {
  readonly personal: boolean;
  readonly teamName: string;
  readonly providerId: ProviderId;
  readonly addProviderOpen: boolean;
  readonly onToggleAdd: () => void;
  readonly os: EnvironmentOs;
  readonly onOsChange: (os: EnvironmentOs) => void;
  readonly issue: ConfigurationWriteIssue;
  readonly readPending: boolean;
  readonly readFailed: boolean;
  readonly onRetry: () => void;
  readonly ready: boolean;
  readonly primary: readonly ProviderRailRow[];
  readonly selectedFolded: ProviderRailRow | null;
  readonly behindAdd: readonly ProviderRailRow[];
  readonly onSelect: (providerId: ProviderId) => void;
  readonly profiles: readonly ConfigurationItem[];
  readonly adminNames: readonly string[];
  readonly packIds: readonly string[];
  readonly packs: readonly ConfigurationItem[];
  readonly items: readonly ConfigurationItem[];
  readonly writes: ConfigurationItemWrites;
  readonly harness: string;
  readonly envSubtitleScope: EnvSubtitleScope;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const {
    personal,
    teamName,
    providerId,
    addProviderOpen,
    onToggleAdd,
    os,
    onOsChange,
    issue,
    readPending,
    readFailed,
    onRetry,
    ready,
    primary,
    selectedFolded,
    behindAdd,
    onSelect,
    profiles,
    adminNames,
    packIds,
    packs,
    items,
    writes,
    harness,
    envSubtitleScope,
    onOutcome,
  } = props;
  return (
    <SettingsPanelShell
      title="Providers"
      description={PROVIDERS_PAGE_DESCRIPTION}
      headerAction={<OpenSecretsLink />}
      bodyClassName="flex flex-col gap-4 overflow-visible rounded-none border-none bg-transparent"
    >
      <ConfigurationWriteFeedback issue={issue} />
      {readPending ? <MutedAgentSpinner /> : null}
      {readFailed ? (
        <ConfigurationReadFailed page="providers" onRetry={onRetry} />
      ) : null}
      {ready ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
          <nav
            aria-label="Configured providers"
            className="flex min-w-0 flex-col gap-1"
          >
            {primary.map((row) => (
              <ProviderRailButton
                key={row.providerId}
                row={row}
                selected={providerId === row.providerId}
                onSelect={onSelect}
              />
            ))}
            {selectedFolded === null ? null : (
              <ProviderRailButton
                row={selectedFolded}
                selected
                onSelect={onSelect}
              />
            )}
            {behindAdd.length === 0 ? null : (
              <button
                type="button"
                aria-expanded={addProviderOpen}
                className={railButtonClass(false)}
                onClick={onToggleAdd}
              >
                <span className="flex min-w-0 items-start gap-1.5">
                  <Plus className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-normal break-words">
                    Add provider
                  </span>
                </span>
              </button>
            )}
            {addProviderOpen
              ? behindAdd.map((row) => (
                  <ProviderRailButton
                    key={row.providerId}
                    row={row}
                    selected={false}
                    onSelect={onSelect}
                  />
                ))
              : null}
          </nav>
          <Tabs defaultValue="plans" className="min-w-0 gap-3">
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
              <TeamProviderKeys providerId={providerId} />
              <TeamPlans providerId={providerId} adminNames={adminNames} />
              {profiles.length === 0 ? null : (
                <section className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-ui-sm font-medium">Profiles</h2>
                  <ul className="divide-y divide-border/60 overflow-visible rounded-lg border border-border/60">
                    {profiles.map((item) => (
                      <ConfigurationProfileRow
                        key={`${item.key}:${item.revision}`}
                        item={item}
                        onOutcome={onOutcome}
                      />
                    ))}
                  </ul>
                </section>
              )}
              <TeamProviderLiveFacts providerId={providerId} />
            </TabsContent>
            <TabsContent value="env" className="flex flex-col gap-3">
              <p
                className="text-ui-xs text-muted-foreground"
                data-testid="team-provider-env-subtitle"
              >
                {providerEnvSubtitleFor(envSubtitleScope)(
                  providerDisplayName(providerId),
                  personal ? { kind: "personal" } : { kind: "team", teamName },
                )}
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
      ) : null}
    </SettingsPanelShell>
  );
}

function OpenSecretsLink(): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto min-w-0 max-w-full shrink whitespace-normal"
      onClick={() => {
        navigateToSettingsSection("secrets");
      }}
    >
      Open Secrets
    </Button>
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
 * A saved profile: its name, the account it names, and Off when it is not
 * in use. Details and the use switch sit in More. There is no standing or
 * presence to show yet; those arrive with the profile stream.
 */
function ConfigurationProfileRow(props: {
  readonly item: ConfigurationItem;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put } = useConfigurationItemMutations();
  const profile = configurationProfileValueSchema.parse(props.item.value);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsSubject = useProviderRowDetailsSubject(
    props.item.kind,
    props.item.key,
  );
  const setEnabled = (enabled: boolean): void => {
    if (source.kind !== "pool") return;
    put.mutate(
      {
        environmentId: source.environmentId,
        kind: "managed_profile",
        key: props.item.key,
        os: null,
        value: {
          ...z.record(z.string(), z.json()).parse(props.item.value),
          enabled,
        },
        revision: props.item.revision,
      },
      { onSuccess: props.onOutcome },
    );
  };
  return (
    <li className="flex min-w-0 items-start justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="min-w-0 whitespace-normal break-words text-ui-sm font-medium">
          {profile.name}
        </p>
        {profile.accountIdentity === null ? null : (
          <p className="min-w-0 whitespace-normal break-words text-ui-xs text-muted-foreground">
            {profile.accountIdentity}
          </p>
        )}
        {profile.enabled ? null : (
          <p className="text-ui-xs text-muted-foreground">Off</p>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`More for ${profile.name}`}
            className="shrink-0"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {detailsSubject === null ? null : (
            <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
              Details
            </DropdownMenuItem>
          )}
          {canEdit ? (
            <DropdownMenuCheckboxItem
              aria-label={`Use ${profile.name}`}
              checked={profile.enabled}
              disabled={put.isPending}
              onCheckedChange={setEnabled}
            >
              Use
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuLabel>
              {profile.enabled ? "On" : "Off"}
            </DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsDetailsDialog
        subject={detailsSubject}
        title={profile.name}
        controls={null}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        initialTab="status"
      />
    </li>
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
      subtitle: count === null ? null : profileCountLabel(count),
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

function profileCountLabel(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 profile" : `${count} profiles`;
}
