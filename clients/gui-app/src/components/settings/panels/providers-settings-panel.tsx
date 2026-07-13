import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProviderList } from "@/components/providers/provider-list";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostClient } from "@/lib/host";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import { ProviderAuthBadge, ProviderAuthLine } from "./provider-auth-display";
import { TraycerSubscriptionSection } from "./traycer-subscription-section";
import { ProviderRateLimitForProvider } from "./provider-rate-limit-section";
import {
  AddProviderProfileDialog,
  type FailedProviderProfileAttempt,
} from "./add-provider-profile-dialog";
import { ProviderProfileScopedSection } from "./provider-profile-scoped-section";
import { defaultSelectedProfileId } from "@/components/providers/provider-profile-model";
import { ProviderApiKeySection } from "./provider-api-key-section";
import { TerminalAgentArgsSection } from "./terminal-agent-args-section";
import { ProviderEnvOverridesSection } from "./provider-env-overrides-section";
import { ProviderCliCandidatesSection } from "./provider-cli-candidates-section";

type ProviderId = ProviderCliState["providerId"];
type ProvidersListQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
>;

// The provider to select on mount: the deep-link focus target (mapped from its
// GUI harness id) when one was requested and is present,
// otherwise the first provider in the list.
function initialActiveProviderId(
  providers: readonly ProviderCliState[],
): ProviderId {
  const focusHarnessId = useProvidersFocusStore.getState().focusHarnessId;
  if (focusHarnessId !== null) {
    const match = providers.find(
      (p) => providerIdToGuiHarnessId(p.providerId) === focusHarnessId,
    );
    if (match !== undefined) return match.providerId;
  }
  return providers[0].providerId;
}

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  "claude-code": "Anthropic's Claude Code CLI.",
  codex: "OpenAI's Codex CLI.",
  opencode: "OpenCode CLI agent.",
  cursor:
    "Cursor agent - SDK-driven chats authenticated with your Cursor API key.",
  traycer: "Traycer's managed harness uses the selected OpenCode CLI binary.",
  openrouter:
    "OpenRouter - OpenAI-compatible gateway authenticated with your OpenRouter API key.",
  grok: "Grok agent - xAI's coding CLI via your SuperGrok / X subscription.",
  qwen: "Qwen Code CLI agent.",
  kiro: "Kiro agent - Kiro's coding CLI via login or KIRO_API_KEY.",
  droid:
    "Droid agent - Factory's coding CLI via your Factory account or API key.",
  kimi: "Kimi agent - MoonshotAI's coding CLI via your Kimi account.",
  copilot:
    "GitHub Copilot CLI agent via your active Copilot subscription or policy.",
  kilocode: "Kilo Code CLI agent via Kilo login or configured providers.",
  amp: "Amp agent - Ampcode's coding CLI via your Amp account or API key.",
  devin:
    "Devin agent - Cognition's coding CLI via Windsurf/Devin login or API key.",
  pi: "Pi agent - pi.dev coding agent via your configured model API key (BYOK).",
};

function hasPendingProviderProbe(
  providers: readonly ProviderCliState[],
): boolean {
  return providers.some(
    (provider) =>
      provider.authPending ||
      provider.candidates.some((candidate) => candidate.versionPending),
  );
}

function latestProviderCheckedAt(
  providers: readonly ProviderCliState[],
): number | null {
  return providers.reduce<number | null>((latest, provider) => {
    if (provider.checkedAt === null) return latest;
    if (latest === null) return provider.checkedAt;
    return Math.max(latest, provider.checkedAt);
  }, null);
}

function ProviderLastChecked({
  checkedAt,
  checking,
}: {
  readonly checkedAt: number | null;
  readonly checking: boolean;
}) {
  if (checking) {
    return (
      <span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
        <MutedAgentSpinner />
        Checking providers
      </span>
    );
  }
  if (checkedAt === null) return null;
  return <ProviderCheckedTimestamp checkedAt={checkedAt} />;
}

function ProviderCheckedTimestamp({
  checkedAt,
}: {
  readonly checkedAt: number;
}) {
  const relative = useRelativeTimestamp(checkedAt);
  return (
    <span className="text-ui-xs text-muted-foreground">
      Checked {relative.toLocaleLowerCase()}
    </span>
  );
}

export function ProvidersSettingsPanel() {
  const activeHostId = useReactiveActiveHostId();
  const hostsQuery = useHostDirectoryList();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? activeHostId;
  // Reach a non-active host through a transient client (the Worktrees
  // pattern) so picking one never rebinds the app-wide active host. Null when
  // the active host is selected - the inherited runtime context already
  // targets it, so no override client is built.
  const targetEntry = useMemo(() => {
    if (effectiveId === null || effectiveId === activeHostId) return null;
    return hosts.find((entry) => entry.hostId === effectiveId) ?? null;
  }, [hosts, effectiveId, activeHostId]);
  const selectedEntry = useMemo(() => {
    if (effectiveId === null) return null;
    return hosts.find((entry) => entry.hostId === effectiveId) ?? null;
  }, [hosts, effectiveId]);
  const isSelectedHostLocal = selectedEntry?.kind === "local";
  const transientClient = useHostClientFor(targetEntry);
  const realBinding = useHostBinding();
  // Scope the whole panel (list + refresh + every provider mutation) to the
  // selected host by re-providing the runtime client for this subtree; the
  // provider hooks all read `useHostClient()`, so none need a client prop.
  const scopedBinding = useMemo(() => {
    if (transientClient === null || realBinding === null) return null;
    return { ...realBinding, hostClient: transientClient };
  }, [transientClient, realBinding]);

  const hostPicker =
    hosts.length > 0 ? (
      <ProvidersHostSelect
        hosts={hosts}
        value={effectiveId}
        onChange={setSelectedId}
      />
    ) : null;

  const inner = (
    <ProvidersSettingsPanelInner
      hostPicker={hostPicker}
      hostId={effectiveId}
      isSelectedHostLocal={isSelectedHostLocal}
    />
  );
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

function ProvidersHostSelect(props: {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
}): ReactNode {
  return (
    <Select value={props.value ?? undefined} onValueChange={props.onChange}>
      <SelectTrigger
        size="sm"
        aria-label="Host"
        className="w-[min(40vw,12rem)]"
      >
        <SelectValue placeholder="Select a host" />
      </SelectTrigger>
      <SelectContent>
        {props.hosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {hostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function hostOptionLabel(host: HostDirectoryEntry): string {
  const label = host.label.length > 0 ? host.label : host.hostId;
  return host.status === "unavailable" ? `${label} (offline)` : label;
}

function ProvidersSettingsPanelInner({
  hostPicker,
  hostId,
  isSelectedHostLocal,
}: {
  readonly hostPicker: ReactNode;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}) {
  const query = useProvidersList({ enabled: true, subscribed: true });
  const providers = query.data?.providers ?? [];
  const checkingProviders =
    query.isFetching || hasPendingProviderProbe(providers);
  const checkedAt = latestProviderCheckedAt(providers);
  const refreshProviders = useRefreshProviders();
  return (
    <SettingsPanelShell
      title="Providers"
      description="Choose the CLI binary Traycer runs for each agent. Pick the bundled binary, one found on your PATH, or a custom install. Disable a provider to hide it from new chats."
      fillHeight
      bodyClassName="max-h-[min(85vh,52rem)]"
      headerAction={
        <div className="flex items-center gap-2">
          <ProviderLastChecked
            checkedAt={checkedAt}
            checking={checkingProviders}
          />
          <RefreshIconButton
            onRefresh={refreshProviders}
            label="Refresh providers"
            refreshing={checkingProviders}
          />
          {hostPicker}
        </div>
      }
    >
      <ProvidersPanelBody
        query={query}
        hostId={hostId}
        isSelectedHostLocal={isSelectedHostLocal}
      />
    </SettingsPanelShell>
  );
}

function ProvidersPanelBody({
  query,
  hostId,
  isSelectedHostLocal,
}: {
  readonly query: ProvidersListQuery;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}): ReactNode {
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 px-6 py-8 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading providers
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="px-6 py-8 text-ui-sm text-destructive">
        Couldn't load provider state. The host may need to be updated.
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't load provider state",
            message: null,
            code: query.error.code,
            source: "Providers",
          })}
          presentation="link"
          className="ml-1 h-auto p-0 text-current"
        />
      </div>
    );
  }
  if (query.data.providers.length === 0) {
    return (
      <div className="px-6 py-8 text-ui-sm text-muted-foreground">
        No providers reported by the host.
      </div>
    );
  }
  return (
    <ProvidersRailLayout
      providers={query.data.providers}
      hostId={hostId}
      isSelectedHostLocal={isSelectedHostLocal}
    />
  );
}

function ProvidersRailLayout({
  providers,
  hostId,
  isSelectedHostLocal,
}: {
  readonly providers: readonly ProviderCliState[];
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}) {
  const orderedProviders = useMemo(
    () => sortProviderStatesByProviderOrder(providers),
    [providers],
  );
  // A deep-link entry point (e.g. the model picker's "Add API key" CTA) can ask
  // the panel to open on a specific provider via the focus store. Read it once
  // for the initial selection, then clear it so a later manual open starts on
  // the first provider again.
  const [activeId, setActiveId] = useState<ProviderId>(() =>
    initialActiveProviderId(orderedProviders),
  );
  useEffect(() => {
    useProvidersFocusStore.getState().clearFocusHarnessId();
  }, []);
  const active =
    orderedProviders.find((p) => p.providerId === activeId) ??
    orderedProviders[0];

  return (
    // Fill the panel body (the shell stretches it to the settings scroll
    // container and caps it via `bodyClassName` max-height), so switching
    // providers never resizes the box and the detail pane - not the outer
    // overlay - owns the scroll. Height follows the viewport: on shorter
    // screens it shrinks to fit the modal instead of overflowing it.
    <div className="flex h-full">
      <nav
        aria-label="Providers"
        className="flex w-[clamp(10rem,22vw,14rem)] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-2"
      >
        <ProviderList
          ariaLabel="Providers"
          variant="settings"
          className="gap-1"
          rows={orderedProviders.map((state) => ({
            providerId: state.providerId,
            active: state.providerId === active.providerId,
            dimmed: false,
            enabled: state.enabled,
            badge: null,
            description: null,
            trailing: null,
            onSelect: setActiveId,
          }))}
        />
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        <ProviderDetail
          key={`${hostId}:${active.providerId}`}
          state={active}
          providers={orderedProviders}
          hostId={hostId}
          isSelectedHostLocal={isSelectedHostLocal}
        />
      </div>
    </div>
  );
}

// Gates the subscription card to the Traycer provider here (not via an inline
// ternary in ProviderDetail) so the credits query never fires while viewing
// another provider, and ProviderDetail's branch count stays put.
function TraycerSubscriptionForProvider({
  providerId,
}: {
  readonly providerId: ProviderId;
}): ReactNode {
  if (providerId !== "traycer") return null;
  return <TraycerSubscriptionSection />;
}

function ProviderEnableSwitch(props: {
  readonly id: string;
  readonly providerId: ProviderCliState["providerId"];
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly enabledProviderCount: number;
  readonly onSetEnabled: (
    providerId: ProviderCliState["providerId"],
    enabled: boolean,
  ) => void;
}) {
  const { id, providerId, enabled, isPending, onSetEnabled } = props;
  const disablingLast = enabled && props.enabledProviderCount <= 1;
  return (
    <Switch
      id={id}
      checked={enabled}
      onCheckedChange={(next) => {
        if (isPending || (!next && disablingLast)) return;
        onSetEnabled(providerId, next);
      }}
      disabled={isPending || disablingLast}
      title={
        disablingLast ? "At least one provider must stay enabled." : undefined
      }
    />
  );
}

function ProviderDetail({
  state,
  providers,
  hostId,
  isSelectedHostLocal,
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}) {
  const providerId = state.providerId;
  // Whichever host `useHostClient()` currently resolves to - the app-wide
  // default, or the Settings-selected host if `ProvidersSettingsPanel`
  // re-provided `HostRuntimeContext` for a non-default selection. Every
  // provider mutation in this subtree already reads `useHostClient()`
  // internally to the same effect; the add-profile dialog needs it as an
  // explicit prop since it's also reused by the picker's tab-scoped flow.
  const hostClient = useHostClient();
  const switchId = useId();
  const [addProfileOpen, setAddProfileOpen] = useState(false);
  const [failedProfileAttempt, setFailedProfileAttempt] =
    useState<FailedProviderProfileAttempt | null>(null);
  // Which profile the profile-scoped section is inspecting - local UI state,
  // lifted here (rather than owned by the section itself) so completing the
  // add-profile flow below can jump it straight to the new profile. Resets to
  // ambient/first on every provider switch for free: `ProvidersRailLayout`
  // keys `<ProviderDetail>` by `active.providerId`, remounting this component
  // (and this `useState`'s lazy initializer) whenever the active provider
  // changes.
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    () => defaultSelectedProfileId(state.profiles),
  );

  const setEnabled = useProvidersSetEnabled();
  const canAddProfile = providerCanStartProfileOauth(
    state,
    isSelectedHostLocal,
  );
  const enabledProviderCount = providers.filter(
    (provider) => provider.enabled,
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="font-medium text-foreground">
              {PROVIDER_DISPLAY_NAMES[providerId]}
            </div>
            {state.profiles.length === 0 ? (
              <ProviderAuthBadge state={state} />
            ) : null}
          </div>
          <p className="text-ui-sm text-muted-foreground">
            {PROVIDER_DESCRIPTIONS[providerId]}
          </p>
          {state.profiles.length === 0 ? (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
              <ProviderAuthLine state={state} />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-ui-sm">
          <label htmlFor={switchId} className="text-muted-foreground">
            {state.enabled ? "Enabled" : "Disabled"}
          </label>
          <ProviderEnableSwitch
            id={switchId}
            providerId={providerId}
            enabled={state.enabled}
            isPending={setEnabled.isPending}
            enabledProviderCount={enabledProviderCount}
            onSetEnabled={(id, enabled) =>
              // No profile management UI yet - this call never renames/removes
              // a profile.
              setEnabled.mutate({
                providerId: id,
                enabled,
                profileAction: null,
              })
            }
          />
        </div>
      </div>

      <TraycerSubscriptionForProvider providerId={providerId} />
      {state.profiles.length === 0 ? (
        <ProviderRateLimitForProvider
          providerId={providerId}
          profileId={null}
          usageUpdatedAt={null}
        />
      ) : null}
      <ProviderProfileScopedSection
        state={state}
        hostId={hostId}
        isSelectedHostLocal={isSelectedHostLocal}
        canAddProfile={canAddProfile}
        failedAttempt={failedProfileAttempt}
        onAddProfile={() => setAddProfileOpen(true)}
        onDismissFailedAttempt={() => setFailedProfileAttempt(null)}
        selectedProfileId={selectedProfileId}
        onSelectedProfileIdChange={setSelectedProfileId}
      />

      <div
        className={cn(
          "flex flex-col transition-opacity",
          state.enabled ? "" : "pointer-events-none opacity-50",
        )}
      >
        <ProviderApiKeySection state={state} />
        <ProviderCliCandidatesSection state={state} providers={providers} />
        <TerminalAgentArgsSection key={state.terminalAgentArgs} state={state} />
        <ProviderEnvOverridesSection
          providerId={providerId}
          overrides={state.envOverrides}
        />
      </div>
      {addProfileOpen ? (
        <AddProviderProfileDialog
          key={state.providerId}
          state={state}
          client={hostClient}
          open
          onOpenChange={setAddProfileOpen}
          onFailedAttempt={setFailedProfileAttempt}
          onProfileCreated={setSelectedProfileId}
        />
      ) : null}
    </div>
  );
}

function providerCanStartProfileOauth(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
): boolean {
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  return isSelectedHostLocal && oauthArgs !== null && oauthArgs.length > 0;
}
