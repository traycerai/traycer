import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { ProviderId as HarnessIconId } from "@/components/home/data/landing-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetSelection } from "@/hooks/providers/use-providers-set-selection-mutation";
import { useProvidersAddCustomPath } from "@/hooks/providers/use-providers-add-custom-path-mutation";
import { useProvidersRemoveCustomPath } from "@/hooks/providers/use-providers-remove-custom-path-mutation";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { useProvidersSetApiKey } from "@/hooks/providers/use-providers-set-api-key-mutation";
import { useProvidersClearApiKey } from "@/hooks/providers/use-providers-clear-api-key-mutation";
import { useProvidersSetTerminalAgentArgs } from "@/hooks/providers/use-providers-set-terminal-agent-args-mutation";
import { useProvidersDetectVersion } from "@/hooks/providers/use-providers-detect-version-query";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { ProviderAuthBadge, ProviderAuthLine } from "./provider-auth-display";
import { EnvOverrideEditor } from "./env-override-editor";
import { TraycerSubscriptionSection } from "./traycer-subscription-section";

type ProviderId = ProviderCliState["providerId"];
type ProvidersListQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
>;

// The provider to select on mount: the deep-link focus target (mapped from its
// GUI harness id via `HARNESS_ICON_ID`) when one was requested and is present,
// otherwise the first provider in the list.
function initialActiveProviderId(
  providers: readonly ProviderCliState[],
): ProviderId {
  const focusHarnessId = useProvidersFocusStore.getState().focusHarnessId;
  if (focusHarnessId !== null) {
    const match = providers.find(
      (p) => HARNESS_ICON_ID[p.providerId] === focusHarnessId,
    );
    if (match !== undefined) return match.providerId;
  }
  return providers[0].providerId;
}

// Where a key-authenticated provider's API keys are created. Rendered as a
// "Create an API key" link in the key section so users don't have to hunt for
// the provider's dashboard.
const API_KEY_DASHBOARD_URL: Partial<Record<ProviderId, string>> = {
  cursor: "https://cursor.com/dashboard/api?section=user-keys#user-api-keys",
  droid: "https://app.factory.ai/settings/api-keys",
};

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  "claude-code": "Anthropic's Claude Code CLI.",
  codex: "OpenAI's Codex CLI.",
  opencode: "OpenCode CLI agent.",
  cursor:
    "Cursor agent - SDK-driven chats authenticated with your Cursor API key.",
  traycer: "Traycer's managed harness uses the selected OpenCode CLI binary.",
  grok: "Grok agent - xAI's coding CLI via your SuperGrok / X subscription.",
  kiro: "Kiro agent - Kiro's coding CLI via login or KIRO_API_KEY.",
  droid:
    "Droid agent - Factory's coding CLI via your Factory account or API key.",
  kimi: "Kimi agent - MoonshotAI's coding CLI via your Kimi account.",
  copilot:
    "GitHub Copilot CLI agent via your active Copilot subscription or policy.",
  kilocode: "Kilo Code CLI agent via Kilo login or configured providers.",
};

const TERMINAL_AGENT_ARGS_PLACEHOLDER: Record<
  Extract<ProviderId, "claude-code" | "codex" | "opencode">,
  string
> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  opencode: "--model anthropic/claude-opus-4-8",
};

function terminalAgentArgsPlaceholder(providerId: ProviderId): string {
  switch (providerId) {
    case "claude-code":
      return TERMINAL_AGENT_ARGS_PLACEHOLDER["claude-code"];
    case "codex":
      return TERMINAL_AGENT_ARGS_PLACEHOLDER.codex;
    case "opencode":
      return TERMINAL_AGENT_ARGS_PLACEHOLDER.opencode;
    case "cursor":
    case "traycer":
    case "grok":
    case "kiro":
    case "copilot":
    case "droid":
    case "kimi":
    case "kilocode":
      return "CLI arguments (optional)";
  }
}

const HARNESS_ICON_ID: Record<ProviderId, HarnessIconId> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  traycer: "traycer",
  grok: "grok",
  kiro: "kiro",
  droid: "droid",
  kimi: "kimi",
  copilot: "copilot",
  kilocode: "kilocode",
};

// Grid keeps the columns aligned across header + rows; `minmax(0,1fr)` on
// the Path column guarantees it shrinks/truncates instead of pushing the
// table past the panel width.
const TABLE_GRID =
  "grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(5.5rem,auto)_2.25rem] items-center";

interface ProviderCandidateConfig {
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
}

function candidateConfigForProvider(
  state: ProviderCliState,
  providers: readonly ProviderCliState[],
): ProviderCandidateConfig {
  if (state.providerId !== "traycer" || state.candidates.length > 0) {
    return { selected: state.selected, candidates: state.candidates };
  }

  const opencode = providers.find(
    (provider) => provider.providerId === "opencode",
  );
  return {
    selected: state.selected,
    candidates: opencode?.candidates ?? state.candidates,
  };
}

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

  const inner = <ProvidersSettingsPanelInner hostPicker={hostPicker} />;
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
}: {
  readonly hostPicker: ReactNode;
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
      <ProvidersPanelBody query={query} />
    </SettingsPanelShell>
  );
}

function ProvidersPanelBody({
  query,
}: {
  readonly query: ProvidersListQuery;
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
  return <ProvidersRailLayout providers={query.data.providers} />;
}

function ProvidersRailLayout({
  providers,
}: {
  readonly providers: readonly ProviderCliState[];
}) {
  // A deep-link entry point (e.g. the model picker's "Add API key" CTA) can ask
  // the panel to open on a specific provider via the focus store. Read it once
  // for the initial selection, then clear it so a later manual open starts on
  // the first provider again.
  const [activeId, setActiveId] = useState<ProviderId>(() =>
    initialActiveProviderId(providers),
  );
  useEffect(() => {
    useProvidersFocusStore.getState().clearFocusHarnessId();
  }, []);
  const active =
    providers.find((p) => p.providerId === activeId) ?? providers[0];

  return (
    // Fill the panel body (the shell stretches it to the settings scroll
    // container and caps it via `bodyClassName` max-height), so switching
    // providers never resizes the box and the detail pane - not the outer
    // overlay - owns the scroll. Height follows the viewport: on shorter
    // screens it shrinks to fit the modal instead of overflowing it.
    <div className="flex h-full">
      <nav className="flex w-[clamp(10rem,22vw,14rem)] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-2">
        {providers.map((state) => {
          const selected = state.providerId === active.providerId;
          return (
            <button
              key={state.providerId}
              type="button"
              data-active={selected}
              onClick={() => setActiveId(state.providerId)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ui-sm transition-colors",
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
              )}
            >
              <HarnessIcon harnessId={HARNESS_ICON_ID[state.providerId]} />
              <span className="flex-1 truncate">
                {PROVIDER_DISPLAY_NAMES[state.providerId]}
              </span>
              {state.enabled ? null : (
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              )}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        <ProviderDetail
          key={active.providerId}
          state={active}
          providers={providers}
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
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
}) {
  const providerId = state.providerId;
  // Cursor's chat runs through the `@cursor/sdk` (no CLI binary) and its
  // terminal-agent surface is hidden for now, so there's no CLI path to pick -
  // hide the candidates table and show only the API-key section. Traycer shares
  // the OpenCode binary path set: its table shows the OpenCode candidates (or
  // Traycer's own when present) while selection / custom-path mutations target
  // the Traycer provider id.
  const cliConfig = candidateConfigForProvider(state, providers);
  const showCliCandidates = providerId !== "cursor";
  const radioName = useId();
  const switchId = useId();
  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const focusDraftInput = useCallback((node: HTMLInputElement | null): void => {
    node?.focus();
  }, []);

  const setSelection = useProvidersSetSelection();
  const addCustom = useProvidersAddCustomPath();
  const removeCustom = useProvidersRemoveCustomPath();
  const setEnabled = useProvidersSetEnabled();
  const enabledProviderCount = providers.filter(
    (provider) => provider.enabled,
  ).length;
  // Debounce so we don't spawn a `<bin> --version` probe on every keystroke.
  const debouncedPath = useDebouncedValue(draftPath.trim(), 250);
  const probe = useProvidersDetectVersion({
    candidatePath: debouncedPath,
    enabled: adding && debouncedPath.length > 0,
  });

  const onSelect = (selection: ProviderSelection): void => {
    if (setSelection.isPending) return;
    setSelection.mutate({ providerId, selection });
  };

  const onSaveCustom = (): void => {
    const trimmed = draftPath.trim();
    if (trimmed.length === 0 || addCustom.isPending) return;
    addCustom.mutate(
      { providerId, path: trimmed },
      {
        onSuccess: () => {
          setAdding(false);
          setDraftPath("");
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="font-medium text-foreground">
              {PROVIDER_DISPLAY_NAMES[providerId]}
            </div>
            <ProviderAuthBadge state={state} />
          </div>
          <p className="text-ui-sm text-muted-foreground">
            {PROVIDER_DESCRIPTIONS[providerId]}
          </p>
          <ProviderAuthLine state={state} />
          {!state.enabled && state.disabledBy !== null ? (
            <p className="mt-0.5 text-ui-xs text-muted-foreground/80">
              Disabled by {state.disabledBy.handle ?? state.disabledBy.userId}
            </p>
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
              setEnabled.mutate({ providerId: id, enabled })
            }
          />
        </div>
      </div>

      <TraycerSubscriptionForProvider providerId={providerId} />

      <div
        className={cn(
          "flex flex-col transition-opacity",
          state.enabled ? "" : "pointer-events-none opacity-50",
        )}
      >
        <ApiKeySection state={state} />
        {showCliCandidates ? (
          <>
            <div className="overflow-hidden rounded-lg border border-border/60">
              <div
                className={cn(
                  TABLE_GRID,
                  "border-b border-border/40 bg-muted/30 text-ui-xs font-medium text-muted-foreground",
                )}
              >
                <span className="py-2" />
                <span className="min-w-0 p-2">Path</span>
                <span className="p-2">Version</span>
                <span className="py-2" />
              </div>
              {cliConfig.candidates.map((candidate) => (
                <CandidateRow
                  key={candidateKey(candidate)}
                  candidate={candidate}
                  radioName={radioName}
                  selected={isSelected(cliConfig.selected, candidate)}
                  busy={setSelection.isPending || removeCustom.isPending}
                  onSelect={onSelect}
                  onRemove={(path) => removeCustom.mutate({ providerId, path })}
                />
              ))}
              {adding ? (
                <div className="flex flex-col gap-2 border-t border-border/40 bg-muted/10 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      ref={focusDraftInput}
                      className="w-full font-mono text-ui-sm"
                      placeholder="/absolute/path/to/binary"
                      value={draftPath}
                      onChange={(e) => setDraftPath(e.target.value)}
                      disabled={addCustom.isPending}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveCustom();
                        if (e.key === "Escape") {
                          setAdding(false);
                          setDraftPath("");
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={onSaveCustom}
                      disabled={
                        addCustom.isPending || draftPath.trim().length === 0
                      }
                    >
                      {addCustom.isPending ? <MutedAgentSpinner /> : null}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAdding(false);
                        setDraftPath("");
                      }}
                      disabled={addCustom.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                  <ProbeLine
                    probing={probe.isFetching}
                    executable={probe.data?.executable ?? null}
                    version={probe.data?.version ?? null}
                  />
                </div>
              ) : null}
            </div>

            {adding ? null : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <Plus className="size-4" /> Add custom path
              </button>
            )}
          </>
        ) : null}
        <TerminalAgentArgsSection key={state.terminalAgentArgs} state={state} />
        <ProviderEnvOverridesSection
          providerId={providerId}
          overrides={state.envOverrides}
        />
      </div>
    </div>
  );
}

function ProviderEnvOverridesSection({
  providerId,
  overrides,
}: {
  readonly providerId: ProviderId;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
}) {
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];
  const setOverride = useProvidersSetEnvOverride();
  const deleteOverride = useProvidersDeleteEnvOverride();
  const disabled = setOverride.isPending || deleteOverride.isPending;

  // A rename is set-new → delete-old so a failed delete leaves a harmless
  // duplicate rather than a lost value.
  const onCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    setOverride.mutate(
      { providerId, key: newKey, value },
      {
        onSuccess: () => {
          if (oldKey.length > 0 && oldKey !== newKey) {
            deleteOverride.mutate({ providerId, key: oldKey });
          }
        },
      },
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            Environment variables
          </div>
          <p className="text-ui-xs text-muted-foreground">
            Applied when Traycer spawns the {providerName} harness. Use Unset to
            drop a variable inherited from your shell.
          </p>
        </div>
        {disabled ? <MutedAgentSpinner /> : null}
      </div>
      <EnvOverrideEditor
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No environment variables for ${providerName}.`}
        onCommit={onCommit}
        onDelete={(key) => deleteOverride.mutate({ providerId, key })}
      />
    </div>
  );
}

// Example variable name shown as the add-row placeholder, per provider, so the
// hint matches the harness being configured (illustrative only).
function envNamePlaceholder(providerId: ProviderId): string {
  switch (providerId) {
    case "claude-code":
      return "ANTHROPIC_API_KEY";
    case "codex":
      return "OPENAI_API_KEY";
    case "opencode":
    case "traycer":
      return "ANTHROPIC_API_KEY";
    case "cursor":
      return "CURSOR_API_KEY";
    case "grok":
      return "XAI_API_KEY";
    case "kiro":
      return "KIRO_API_KEY";
    case "droid":
      return "FACTORY_API_KEY";
    case "kimi":
      return "KIMI_API_KEY";
    case "copilot":
      return "COPILOT_GITHUB_TOKEN";
    case "kilocode":
      return "KILO_API_KEY";
  }
}

// Extra CLI args appended when launching this provider as a terminal agent.
// Rendered only for providers whose harness advertises the `tui` surface
// (Claude Code / Codex / OpenCode - not GUI-only providers like Cursor); the
// host launch path reads this saved value, and the launch picker pre-fills
// it for a per-launch override.
function TerminalAgentArgsSection({
  state,
}: {
  readonly state: ProviderCliState;
}) {
  const providerId = state.providerId;
  const inputId = useId();
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const setArgs = useProvidersSetTerminalAgentArgs();
  const saved = state.terminalAgentArgs;
  const [draft, setDraft] = useState(saved);

  const harnessId = HARNESS_ICON_ID[providerId];
  const supportsTerminalAgent =
    harnessesQuery.data?.harnesses.some(
      (harness) => harness.id === harnessId && harness.modes.includes("tui"),
    ) ?? false;
  if (!supportsTerminalAgent) return null;

  const commit = (): void => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    // Skip only when nothing changed. Firing while a previous save is still
    // in-flight is intentional - guarding on `isPending` here would silently
    // drop the latest edit.
    if (next === saved) return;
    setArgs.mutate({ providerId, terminalAgentArgs: next });
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <label
        htmlFor={inputId}
        className="text-ui-sm font-medium text-foreground"
      >
        Terminal agent arguments
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          className="w-full font-mono text-ui-sm"
          placeholder={terminalAgentArgsPlaceholder(providerId)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {setArgs.isPending ? <MutedAgentSpinner /> : null}
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Appended to the CLI when launching a{" "}
        {PROVIDER_DISPLAY_NAMES[providerId]} terminal agent. Pre-fills the
        launch picker, where you can override it per launch.
      </p>
    </div>
  );
}

function apiKeyStatusLabel(apiKey: ProviderCliState["apiKey"]): string {
  if (!apiKey.configured) return "Not set";
  return apiKey.source === "stored" ? "Key set" : "From environment";
}

// API-key-authenticated providers (Cursor) render a key field in addition to
// the binary picker. The raw key never leaves the host; `state.apiKey` only
// reports whether one is configured and where it came from.
function ApiKeySection({ state }: { readonly state: ProviderCliState }) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const setApiKey = useProvidersSetApiKey();
  const clearApiKey = useProvidersClearApiKey();
  const runnerHost = useRunnerHost();

  if (!state.apiKey.supported) return null;

  const providerId = state.providerId;
  const dashboardUrl = API_KEY_DASHBOARD_URL[providerId];
  const onSave = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || setApiKey.isPending) return;
    setApiKey.mutate(
      { providerId, apiKey: trimmed },
      { onSuccess: () => setDraft("") },
    );
  };

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-ui-sm font-medium text-foreground"
        >
          API key
        </label>
        <span className="text-ui-xs text-muted-foreground">
          {apiKeyStatusLabel(state.apiKey)}
        </span>
      </div>
      {dashboardUrl === undefined ? null : (
        <button
          type="button"
          onClick={() => {
            void runnerHost.openExternalLink(dashboardUrl);
          }}
          className="inline-flex w-fit items-center gap-1.5 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
        >
          Create an API key
          <ExternalLink className="size-3" />
        </button>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          className="w-full font-mono text-ui-sm"
          placeholder={
            state.apiKey.source === "stored"
              ? "Replace stored key…"
              : `Paste your ${PROVIDER_DISPLAY_NAMES[providerId]} API key`
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={setApiKey.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onSave}
          disabled={setApiKey.isPending || draft.trim().length === 0}
        >
          {setApiKey.isPending ? <MutedAgentSpinner /> : null}
          Save
        </Button>
        {state.apiKey.source === "stored" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!clearApiKey.isPending) clearApiKey.mutate({ providerId });
            }}
            disabled={clearApiKey.isPending}
          >
            {clearApiKey.isPending ? <MutedAgentSpinner /> : null}
            Clear
          </Button>
        ) : null}
      </div>
      <p className="text-ui-xs text-muted-foreground">
        {state.apiKey.source === "env"
          ? `Using ${envNamePlaceholder(providerId)} from your shell environment. Save a key here to override it.`
          : `Stored encrypted on this device. Falls back to ${envNamePlaceholder(providerId)} from your shell when unset.`}
      </p>
    </div>
  );
}

function CandidateRow({
  candidate,
  radioName,
  selected,
  busy,
  onSelect,
  onRemove,
}: {
  readonly candidate: ProviderCliCandidate;
  readonly radioName: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (selection: ProviderSelection) => void;
  readonly onRemove: (path: string) => void;
}): ReactNode {
  const isBundled = candidate.kind === "bundled";
  const isCustom = candidate.kind === "custom";
  const pathLabel = isBundled ? "Bundled" : candidate.path;
  // A resolved-but-missing binary (custom path the user typed that no longer
  // exists, or a bundled binary not installed). We keep the row and dim it so
  // the user sees the entry is retained but unavailable.
  const unavailable = !candidate.available && !candidate.versionPending;
  return (
    <div
      className={cn(
        TABLE_GRID,
        "border-b border-border/40 last:border-b-0 hover:bg-muted/20",
        unavailable ? "opacity-60" : "",
      )}
    >
      <span className="flex items-center justify-center py-2.5">
        <input
          type="radio"
          aria-label={
            isBundled ? "Select bundled binary" : `Select ${candidate.path}`
          }
          name={radioName}
          checked={selected}
          disabled={busy}
          onChange={() => onSelect(selectionFor(candidate))}
          className="size-3.5 cursor-pointer accent-primary"
        />
      </span>
      {isBundled ? (
        <span className="min-w-0 truncate p-2.5 text-ui-sm text-foreground">
          {pathLabel}
        </span>
      ) : (
        <FilePathTooltip content={candidate.path} side="bottom">
          <StartTruncatedText className="min-w-0 p-2.5 font-mono text-ui-sm text-foreground">
            {candidate.path}
          </StartTruncatedText>
        </FilePathTooltip>
      )}
      <span
        className={cn(
          "flex items-center gap-1.5 truncate p-2.5 text-ui-sm",
          unavailable ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {candidate.versionPending ? (
          <>
            <MutedAgentSpinner />
            <span className="text-ui-xs">checking…</span>
          </>
        ) : (
          versionLabel(candidate)
        )}
      </span>
      <span className="flex items-center justify-center py-2.5">
        {isCustom ? (
          <button
            type="button"
            aria-label="Remove custom path"
            disabled={busy}
            onClick={() => onRemove(candidate.path)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function versionLabel(candidate: ProviderCliCandidate): string {
  if (candidate.version !== null) return `v${candidate.version}`;
  if (candidate.kind === "bundled" && !candidate.available) {
    return "Not installed";
  }
  if (!candidate.available) return "Not found";
  return "-";
}

function candidateKey(candidate: ProviderCliCandidate): string {
  return candidate.kind === "custom"
    ? `custom:${candidate.path}`
    : candidate.kind;
}

function selectionFor(candidate: ProviderCliCandidate): ProviderSelection {
  if (candidate.kind === "custom") {
    return { kind: "custom", path: candidate.path };
  }
  return { kind: candidate.kind };
}

function isSelected(
  selected: ProviderSelection,
  candidate: ProviderCliCandidate,
): boolean {
  if (selected.kind !== candidate.kind) return false;
  if (selected.kind === "custom" && candidate.kind === "custom") {
    return selected.path === candidate.path;
  }
  return true;
}

function ProbeLine({
  probing,
  executable,
  version,
}: {
  readonly probing: boolean;
  readonly executable: boolean | null;
  readonly version: string | null;
}): ReactNode {
  if (probing) {
    return (
      <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <MutedAgentSpinner /> Checking
      </div>
    );
  }
  if (executable === null) return null;
  if (!executable) {
    return <div className="text-ui-xs text-destructive">Not executable.</div>;
  }
  return (
    <div className="text-ui-xs text-muted-foreground">
      {version === null
        ? "Detected (no version reported)"
        : `Detected v${version}`}
    </div>
  );
}
