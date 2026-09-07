import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProviderList } from "@/components/providers/provider-list";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  useProviderProfileEnablementPending,
  useProvidersSetProfileEnabledForClient,
} from "@/hooks/providers/use-providers-set-profile-enabled-mutation";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import { useHostClient } from "@/lib/host";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import { ProviderAuthBadge, ProviderAuthLine } from "./provider-auth-display";
import { TraycerSubscriptionSection } from "./traycer-subscription-section";
import { ProviderRateLimitForProvider } from "./provider-rate-limit-section";
import { ProviderMcpTab } from "./provider-mcp-tab";
import { ProviderModelProvidersTab } from "./provider-model-providers-tab";
import { ProviderPluginsTab } from "./provider-plugins-tab";
import { ProviderSkillsTab } from "./provider-skills-tab";
import { resolveRateLimitFetchEligibility } from "@/lib/rate-limit-providers";
import {
  AddProviderProfileDialog,
  type FailedProviderProfileAttempt,
} from "./add-provider-profile-dialog";
import { ProviderProfileScopedSection } from "./provider-profile-scoped-section";
import {
  defaultSelectedProfileId,
  profileCommitId,
} from "@/components/providers/provider-profile-model";
import { providerPackPreparingForProvider } from "@/components/providers/provider-pack-readiness";
import {
  providerCanStartProfileOauth,
  providerSignInUnavailableHint,
} from "@/components/providers/provider-signin-availability";
import { ProviderApiKeySection } from "./provider-api-key-section";
import { ProviderRailControls } from "./provider-rail-controls";
import {
  DEFAULT_PROVIDER_RAIL_VIEW,
  filterProviderRail,
  type ProviderRailView,
} from "./provider-rail-filter";
import { TerminalAgentArgsSection } from "./terminal-agent-args-section";
import { ProviderEnvOverridesSection } from "./provider-env-overrides-section";
import { ProviderSectionSelect } from "./provider-section-select";
import { ProviderCliCandidatesSection } from "./provider-cli-candidates-section";
import {
  providerTabInputs,
  providerTabLabel,
  supportedTabsFor as resolveSupportedTabs,
  type ProviderTabKey,
} from "./provider-settings-tabs";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
type ProviderId = ProviderCliState["providerId"];
type ProviderProfile = ProviderCliState["profiles"][number];
type ProvidersListQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
>;

// An id this side renames that an older client cannot parse fails the enum and drops that entire object,
// silently taking MCP/Plugins/Skills with it.
const PROVIDER_TAB_LABELS: Record<ProviderTabKey, string> = {
  general: "CLI & Args",
  account: "Account",
  usage: "Profiles & Limits",
  env: "Env",
  mcp: "MCP",
  plugins: "Plugins",
  skills: "Skills",
  modelProviders: "Model Providers",
};

// The provider to select on mount: the deep-link focus target (mapped from its GUI harness id) when one was
// requested and is present, otherwise the first provider in the list.
function initialActiveProviderId(
  providers: readonly ProviderCliState[],
  focusHarnessId: GuiHarnessId | null,
): ProviderId {
  if (focusHarnessId !== null) {
    const match = providers.find(
      (p) => providerIdToGuiHarnessId(p.providerId) === focusHarnessId,
    );
    if (match !== undefined) return match.providerId;
  }
  return providers[0].providerId;
}

// Initial tab for the deep-linked (or first) provider: honor `focusTab` when the target supports it, else the
// first supported tab in PROVIDER_TAB_ORDER (account → usage → general → …).
function initialActiveTab(
  providers: readonly ProviderCliState[],
  providerId: ProviderId,
): ProviderTabKey {
  const state =
    providers.find((p) => p.providerId === providerId) ?? providers[0];
  const tabs = resolveSupportedTabs(providerTabInputs(state));
  // `focusTab` is a plain `string` in the store, so a deep link can name the client-only `account` tab even
  // though it is absent from the wire enum - the match below is against the resolved tab list, not the schema.
  const focusTab = useProvidersFocusStore.getState().focusTab;
  if (focusTab !== null) {
    const match = tabs.find((tab) => tab === focusTab);
    if (match !== undefined) return match;
  }
  return tabs[0] ?? "general";
}

// When switching providers, keep the current tab if the new provider supports
// it; otherwise fall back to that provider's first tab.
function resolveTabForProvider(
  state: ProviderCliState,
  preferred: ProviderTabKey,
): ProviderTabKey {
  const tabs = resolveSupportedTabs(providerTabInputs(state));
  if (tabs.includes(preferred)) return preferred;
  return tabs[0] ?? "general";
}

function initialSelectedProfileId(
  profiles: readonly ProviderProfile[],
  focusProfileId: string | null,
): string | null {
  if (focusProfileId !== null) {
    const focused = profiles.find(
      (profile) => profile.profileId === focusProfileId,
    );
    if (focused !== undefined) return profileCommitId(focused);
  }
  return defaultSelectedProfileId(profiles);
}

// NOTE: the per-tab "has content" dot that used to render here is gone on

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  "claude-code": "Anthropic's Claude Code CLI.",
  codex: "OpenAI's Codex CLI.",
  opencode: "OpenCode CLI agent.",
  cursor:
    "Cursor coding agent - SDK-driven agents authenticated with your Cursor API key.",
  traycer: "Traycer's managed harness uses the selected OpenCode CLI binary.",
  openrouter:
    "OpenRouter - OpenAI-compatible gateway authenticated with your OpenRouter API key.",
  huggingface:
    "Hugging Face - OpenAI-compatible router authenticated with your Hugging Face token.",
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
  hermes: "Hermes Agent - Nous Research's coding CLI via your Hermes account.",
  omp: "Oh My Pi - can1357's coding CLI via your linked provider subscriptions.",
  reasonix:
    "Reasonix - a coding CLI you point at your own model provider; keys live in Reasonix's own store, set up from its terminal wizard.",
};

function hasPendingProviderProbe(
  providers: readonly ProviderCliState[],
): boolean {
  return providers.some(
    (provider) =>
      // A disabled provider's probes are irrelevant (the host clears these flags for disabled providers at the wire
      // boundary).
      provider.enabled &&
      (provider.authPending ||
        provider.availabilityPending ||
        provider.candidates.some((candidate) => candidate.versionPending)),
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
  const scope = useHostScope();
  const setHostId = scope.setHostId;
  // The top-level keep-alive host retains this component while its tab is hidden, so a re-auth banner click that
  // arms a new intent finds no fresh mount to capture it - a mount-time snapshot stayed stale.
  const liveFocusHostId = useProvidersFocusStore((s) => s.focusHostId);
  const deepLinkPending = liveFocusHostId !== null;
  useEffect(() => {
    if (liveFocusHostId === null) return;
    setHostId(liveFocusHostId);
    useProvidersFocusStore.getState().clearFocusHostId();
  }, [liveFocusHostId, setHostId]);

  // Through the shared hook, not a copy of it.
  const scopedBinding = useScopedHostBinding(scope);

  // The hold that makes the deep link atomic: one frame of placeholder while the effect above moves the scope.
  if (deepLinkPending) {
    return (
      <div
        className="flex-1"
        data-testid="providers-deep-link-pending"
        aria-hidden
      />
    );
  }

  const inner = (
    <ProvidersSettingsPanelInner
      scope={scope}
      hostId={scope.hostId}
      isSelectedHostLocal={scope.host?.isLocalMachine ?? false}
    />
  );
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

function ProvidersSettingsPanelInner({
  scope,
  hostId,
  isSelectedHostLocal,
}: {
  readonly scope: HostScope;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}) {
  const isMobile = useIsMobileViewport();
  return (
    <SettingsPanelShell
      title="Providers"
      // The shell's header is a wrapping row of [title + description] and [action].
      description={
        isMobile
          ? undefined
          : "Choose the CLI binary Traycer runs for each coding agent. Pick the bundled binary, one found on your PATH, or a custom install. Disable a provider to hide it when creating an agent."
      }
      // That chain assumes the card is reliably bounded: its levels have given up the automatic floor that would
      // otherwise keep them as tall as their contents, so they follow whatever height arrives from above.
      fillHeight={!isMobile}
      // `isHostScopeUsable` is the repo's own name for this - "what may be mounted", as its own comment puts it -
      // and it is the same rule the body's controls already mount under.
      headerAction={
        isHostScopeUsable(scope.status) ? <ProvidersGlobalStatus /> : undefined
      }
    >
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        <ProvidersScopedContent
          hostId={hostId}
          isSelectedHostLocal={isSelectedHostLocal}
        />
      </HostScopeGate>
    </SettingsPanelShell>
  );
}

/** Its hooks resolve `useHostClient`, so on `connecting` / `unreachable` / `vanished` they would resolve the
 * ambient host instead of the one the page names. */
function ProvidersGlobalStatus(): ReactNode {
  // `subscribed: false` was avoiding a duplicate that does not exist - two observers of one key share a fetch.
  const query = useProvidersList({ enabled: true, subscribed: true });
  const providers = query.data?.providers ?? [];
  const checking = query.isFetching || hasPendingProviderProbe(providers);
  const refreshProviders = useRefreshProviders();
  return (
    <div
      className="flex items-center gap-2"
      data-testid="providers-global-status"
    >
      <span className="text-ui-xs font-medium text-muted-foreground">
        All providers
      </span>
      <ProviderLastChecked
        checkedAt={latestProviderCheckedAt(providers)}
        checking={checking}
      />
      <RefreshIconButton
        onRefresh={refreshProviders}
        label="Refresh all providers"
        refreshing={checking}
      />
    </div>
  );
}

/** Everything that talks to the scoped host, mounted only once the gate has proven there is a client behind the
 * name. */
function ProvidersScopedContent({
  hostId,
  isSelectedHostLocal,
}: {
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}): ReactNode {
  const query = useProvidersList({ enabled: true, subscribed: true });
  return (
    // Below `md` there is no such card, so neither is claimed and the content sizes itself.
    <div className="flex flex-col md:h-full md:min-h-0">
      <div className="flex-1 md:min-h-0">
        <ProvidersPanelBody
          query={query}
          hostId={hostId}
          isSelectedHostLocal={isSelectedHostLocal}
        />
      </div>
    </div>
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
    // The query that already cached a retryable error from racing the dial.
    if (
      query.error instanceof RetryableTransportError &&
      !isSelectedHostLocal
    ) {
      return (
        <div className="flex items-center gap-2 px-6 py-8 text-ui-sm text-muted-foreground">
          <MutedAgentSpinner />
          Connecting to the remote host…
        </div>
      );
    }
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
  const [initialFocus, setInitialFocus] = useState(() => {
    const focus = useProvidersFocusStore.getState();
    // The intent is consumed only by the rail of the host it NAMES. A profile
    // deep link whose target is unreachable or plan-gated never mounts a rail
    // there, so the harness / profile / sign-in halves stay armed; without
    // this check the next reachable host the user picked consumed them and
    // could start an automatic sign-in on that machine whenever the same
    // profile id existed. `null` target = "no host in particular".
    if (
      focus.focusTargetHostId !== null &&
      focus.focusTargetHostId !== hostId
    ) {
      return { harnessId: null, profileId: null, startSignIn: false };
    }
    return {
      harnessId: focus.focusHarnessId,
      profileId: focus.focusProfileId,
      startSignIn: focus.startSignIn,
    };
  });
  // A deep-link entry point (e.g. the model picker's "Add API key" CTA) can ask
  // the panel to open on a specific provider (and optional tab) via the focus
  // store. Read both once for the initial selection, then clear so a later
  // manual open starts on the first provider / first tab again.
  const [activeId, setActiveId] = useState<ProviderId>(() =>
    initialActiveProviderId(orderedProviders, initialFocus.harnessId),
  );
  // Derive the default tab from the same provider as `activeId`; the Add API key CTA sets focusHarnessId with no focusTab and must open Account, not the rail's first provider's tab.
  const [activeTab, setActiveTab] = useState<ProviderTabKey>(() =>
    initialActiveTab(
      orderedProviders,
      initialActiveProviderId(orderedProviders, initialFocus.harnessId),
    ),
  );
  useEffect(() => {
    const store = useProvidersFocusStore.getState();
    store.clearFocusHarnessId();
    store.clearFocusTab();
  }, []);
  const active =
    orderedProviders.find((p) => p.providerId === activeId) ??
    orderedProviders[0];
  const resolvedTab = resolveTabForProvider(active, activeTab);

  // The rail's own view state. Resolved against `orderedProviders` for the ROWS
  // only - `active` above is deliberately unaffected, so narrowing the rail
  // never yanks the detail pane onto a different provider mid-keystroke. The
  // cost is that a filter can hide the selected row; that reads as "the rail is
  // showing a subset", where re-selecting on every keystroke would silently
  // discard whatever you were in the middle of doing on the right.
  const [railView, setRailView] = useState<ProviderRailView>(
    DEFAULT_PROVIDER_RAIL_VIEW,
  );
  const visibleProviders = useMemo(
    () => filterProviderRail(orderedProviders, railView),
    [orderedProviders, railView],
  );

  const onSelectProvider = (providerId: ProviderId): void => {
    setInitialFocus({ harnessId: null, profileId: null, startSignIn: false });
    setActiveId(providerId);
    const next =
      orderedProviders.find((p) => p.providerId === providerId) ??
      orderedProviders[0];
    setActiveTab(resolveTabForProvider(next, activeTab));
  };

  return (
    // The select lists `orderedProviders`, not the rail's filtered `visibleProviders` - the rail's search/filter
    // is a pointer affordance that goes with it, so it must never narrow what a phone can reach.
    <div className="flex flex-col md:h-full md:min-h-0 md:flex-row">
      <div className="shrink-0 border-b border-border/60 p-2 md:hidden">
        <ProvidersMobileSelect
          providers={orderedProviders}
          activeId={active.providerId}
          onSelect={onSelectProvider}
        />
      </div>
      {/* The search row is a pinned sibling of the scroll box rather than the first child of a scrolling column. */}
      <nav
        aria-label="Providers"
        className="hidden w-[clamp(10rem,22vw,14rem)] shrink-0 flex-col border-r border-border/60 md:flex"
      >
        <ProviderRailControls
          view={railView}
          onViewChange={setRailView}
          resultCount={visibleProviders.length}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
          {visibleProviders.length === 0 ? (
            <p className="px-2.5 py-2 text-ui-xs text-muted-foreground">
              No providers match.
            </p>
          ) : (
            <ProviderList
              ariaLabel="Providers"
              variant="settings"
              className="gap-1"
              rows={visibleProviders.map((state) => ({
                providerId: state.providerId,
                active: state.providerId === active.providerId,
                dimmed: false,
                enabled: state.enabled,
                badge: null,
                description: null,
                trailing: null,
                onSelect: onSelectProvider,
              }))}
            />
          )}
        </div>
      </nav>
      {/* Horizontal padding lives here rather than on each row so the rail's `border-b` keeps exactly the width it
         had when this element owned the scroll. */}
      <div className="flex min-w-0 flex-1 flex-col px-5 pt-5 md:min-h-0">
        <ProviderDetail
          key={`${hostId}:${active.providerId}`}
          state={active}
          providers={orderedProviders}
          activeTab={resolvedTab}
          onActiveTabChange={setActiveTab}
          hostId={hostId}
          isSelectedHostLocal={isSelectedHostLocal}
          initialProfileId={initialFocus.profileId}
          initialSignIn={initialFocus.startSignIn}
        />
      </div>
    </div>
  );
}

function ProvidersMobileSelect(props: {
  readonly providers: readonly ProviderCliState[];
  readonly activeId: ProviderId;
  readonly onSelect: (providerId: ProviderId) => void;
}): ReactNode {
  return (
    <Select
      value={props.activeId}
      onValueChange={(value) => {
        // Resolve through the provider list instead of asserting the select's
        // string value back into the ProviderId union.
        const match = props.providers.find((p) => p.providerId === value);
        if (match !== undefined) props.onSelect(match.providerId);
      }}
    >
      <SelectTrigger aria-label="Provider" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* The same `HarnessIcon` the desktop rail draws through `ProviderList`, so the two presentations of the
           provider list mark a provider the same way. */}
        {props.providers.map((provider) => (
          <SelectItem key={provider.providerId} value={provider.providerId}>
            <span className="flex min-w-0 items-center gap-2">
              <HarnessIcon
                harnessId={providerIdToGuiHarnessId(provider.providerId)}
              />
              <span className="min-w-0 truncate">
                {PROVIDER_DISPLAY_NAMES[provider.providerId]}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Gates the subscription card to the Traycer provider here (not via an inline ternary in ProviderDetail) so
// the credits query never fires while viewing another provider, and ProviderDetail's branch count stays put.
function TraycerSubscriptionForProvider({
  providerId,
}: {
  readonly providerId: ProviderId;
}): ReactNode {
  if (providerId !== "traycer") return null;
  return <TraycerSubscriptionSection />;
}

const ENABLEMENT_FLOOR_HINT = "At least one provider must stay enabled.";

function providerEnablementDisabledReason(input: {
  readonly enabled: boolean;
  readonly enabledProviderCount: number;
  readonly profileEnablementAvailable: boolean;
  readonly enabledProfileCount: number;
}): string | null {
  if (input.enabled && input.enabledProviderCount <= 1) {
    return ENABLEMENT_FLOOR_HINT;
  }
  if (
    !input.enabled &&
    input.profileEnablementAvailable &&
    input.enabledProfileCount === 0
  ) {
    return "Enable a profile before enabling this provider.";
  }
  return null;
}

function ProviderEnableSwitch(props: {
  readonly id: string;
  readonly providerId: ProviderCliState["providerId"];
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly enabledProviderCount: number;
  readonly profileEnablementAvailable: boolean;
  readonly enabledProfileCount: number;
  readonly profileEnablementPending: boolean;
  readonly onSetEnabled: (
    providerId: ProviderCliState["providerId"],
    enabled: boolean,
  ) => void;
}) {
  const { id, providerId, enabled, isPending, onSetEnabled } = props;
  const disabledReason = providerEnablementDisabledReason(props);
  return (
    <TooltipWrapper
      label={disabledReason}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* Guard span: the Switch stays focusable with aria-disabled when a
          profile is guarded, while pending state disables pointer events. */}
      <span className="inline-flex">
        <Switch
          id={id}
          checked={enabled}
          aria-disabled={disabledReason !== null || undefined}
          onCheckedChange={(next) => {
            if (
              isPending ||
              props.profileEnablementPending ||
              disabledReason !== null
            ) {
              return;
            }
            onSetEnabled(providerId, next);
          }}
          disabled={isPending || props.profileEnablementPending}
        />
      </span>
    </TooltipWrapper>
  );
}

/** It is gone, and the reason is worth keeping. */
function ProviderEnablementControl(props: {
  readonly id: string;
  readonly providerId: ProviderCliState["providerId"];
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly enabledProviderCount: number;
  readonly profileEnablementAvailable: boolean;
  readonly enabledProfileCount: number;
  readonly profileEnablementPending: boolean;
  readonly onSetEnabled: (
    providerId: ProviderCliState["providerId"],
    enabled: boolean,
  ) => void;
}) {
  const { id, providerId, enabled, isPending } = props;
  return (
    <div className="flex shrink-0 items-center gap-2 text-ui-sm">
      <label htmlFor={id} className="text-muted-foreground">
        {enabled ? "Enabled" : "Disabled"}
      </label>
      <ProviderEnableSwitch
        id={id}
        providerId={providerId}
        enabled={enabled}
        isPending={isPending}
        enabledProviderCount={props.enabledProviderCount}
        profileEnablementAvailable={props.profileEnablementAvailable}
        enabledProfileCount={props.enabledProfileCount}
        profileEnablementPending={props.profileEnablementPending}
        onSetEnabled={props.onSetEnabled}
      />
    </div>
  );
}

function ProviderDetail({
  state,
  providers,
  activeTab,
  onActiveTabChange,
  hostId,
  isSelectedHostLocal,
  initialProfileId,
  initialSignIn,
}: {
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
  readonly activeTab: ProviderTabKey;
  readonly onActiveTabChange: (tab: ProviderTabKey) => void;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly initialProfileId: string | null;
  readonly initialSignIn: boolean;
}) {
  const providerId = state.providerId;
  // Whichever host `useHostClient` currently resolves to - the app-wide default, or the Settings-selected host
  // if `ProvidersSettingsPanel` re-provided `HostRuntimeContext` for a non-default selection.
  const hostClient = useHostClient();
  const switchId = useId();
  // Layout question ("is the window narrow?"), so the viewport signal - the rail is a pointer affordance, and a
  // narrow desktop window wants the phone presentation for the same reason a phone does.
  const isMobile = useIsMobileViewport();
  // Held here for the same reason `selectedProfileId` is below: `ProvidersRailLayout` keys `<ProviderDetail>` by
  // provider, so a provider switch still discards the draft.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [addProfileOpen, setAddProfileOpen] = useState(false);
  const [failedProfileAttempt, setFailedProfileAttempt] =
    useState<FailedProviderProfileAttempt | null>(null);
  // Which profile the profile-scoped section is inspecting - local UI state, lifted here (rather than owned by
  // the section itself) so completing the add-profile flow below can jump it straight to the new profile.
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    () => initialSelectedProfileId(state.profiles, initialProfileId),
  );
  const setEnabled = useProvidersSetEnabled();
  const setProfileEnabled = useProvidersSetProfileEnabledForClient(
    hostClient,
    providerId,
  );
  const profileEnablementPending = useProviderProfileEnablementPending(
    hostClient,
    providerId,
  );
  const hasManagedProfiles = state.profiles.some(
    (profile) => profile.kind === "managed",
  );
  const supportsProfileEnablement = useHostSupportsMethod(
    hostId,
    "providers.setProfileEnabled",
  );
  const supportsProfileStatusRefresh = useHostSupportsMethod(
    hostId,
    "providers.refreshProfileStatus",
  );
  const profileEnablementAvailable =
    hasManagedProfiles && supportsProfileEnablement;
  const profileStatusRefreshAvailable =
    hasManagedProfiles && supportsProfileStatusRefresh;
  const anyProfileEnablementPending = state.profiles.some((profile) =>
    profileEnablementPending(profileCommitId(profile)),
  );
  // Not because `false` has a single cause - boot seeding leaves plenty of providers off that nobody ever
  // touched.
  const detailPaneInert = !state.enabled;
  const canAddProfile = providerCanStartProfileOauth(
    state,
    isSelectedHostLocal,
  );
  const shouldStartInReauth =
    initialSignIn &&
    initialProfileId !== null &&
    selectedProfileId === initialProfileId &&
    canAddProfile;
  const enabledProviderCount = providers.filter(
    (provider) => provider.enabled,
  ).length;
  const tabs = resolveSupportedTabs(providerTabInputs(state));
  // Bundled once here (rather than threaded as eight separate props) since only the "usage" ("Profiles &
  // Limits") tab body needs the profile- management surface - the other tabs never see it.
  const profileTab: ProviderProfileTabProps = {
    hostId,
    isSelectedHostLocal,
    canAddProfile,
    startInReauth: shouldStartInReauth,
    failedAttempt: failedProfileAttempt,
    onAddProfile: () => setAddProfileOpen(true),
    onDismissFailedAttempt: () => setFailedProfileAttempt(null),
    selectedProfileId,
    onSelectedProfileIdChange: setSelectedProfileId,
    profileEnablementAvailable,
    profileStatusRefreshAvailable,
    profileEnablementPending,
    onSetProfileEnabled: (profileId, enabled) =>
      setProfileEnabled.mutate({
        providerId,
        profileId: profileId ?? "ambient",
        enabled,
      }),
  };

  return (
    // Below `md` that default is the safety, not the obstacle - it is what guarantees each level is at least as
    // tall as its content, so the body renders whole and the settings surface scrolls it.
    <div className="flex flex-1 flex-col gap-4 md:min-h-0">
      <div className="flex shrink-0 items-start justify-between gap-4">
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
        <ProviderEnablementControl
          id={switchId}
          providerId={providerId}
          enabled={state.enabled}
          isPending={setEnabled.isPending}
          enabledProviderCount={enabledProviderCount}
          profileEnablementAvailable={profileEnablementAvailable}
          enabledProfileCount={
            state.profiles.filter((profile) => profile.enabled).length
          }
          profileEnablementPending={anyProfileEnablementPending}
          onSetEnabled={(id, enabled) =>
            // Plain enable/disable - never a native mutation or profile
            // rename/remove/recolor/drift-ack.
            setEnabled.mutate({
              providerId: id,
              enabled,
              profileAction: null,
            })
          }
        />
      </div>
      <div className="flex flex-1 flex-col md:min-h-0">
        {/* That matters more now that the rail is pinned: anything parked here would occupy fixed height at the top of
           the pane forever, not just until you scrolled past it. */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const next = tabs.find((tab) => tab === value);
            if (next === undefined) return;
            onActiveTabChange(next);
          }}
          // With a gap here the scroll box would start 4 units below the rail's rule, so content vanished in mid-air
          // above itself; owned by the body, the clip edge and the rule are the same line.
          className="flex flex-1 flex-col gap-0 md:min-h-0"
        >
          {/* The desktop arm's triggers write the `Tabs` value directly. */}
          {isMobile ? (
            <ProviderSectionSelect
              tabs={tabs}
              activeTab={activeTab}
              onSelect={onActiveTabChange}
              labelFor={(tab) =>
                providerTabLabel(tab, PROVIDER_TAB_LABELS, state.providerId)
              }
            />
          ) : (
            /* Line (underline) tabs, not the filled default. */
            <TabsList
              variant="line"
              className="h-auto w-full max-w-full shrink-0 flex-wrap justify-start rounded-none border-b border-border/60 px-0 pb-1.5"
            >
              {tabs.map((tab) => (
                <TabsTrigger key={tab} value={tab} className="flex-none px-3">
                  {providerTabLabel(tab, PROVIDER_TAB_LABELS, state.providerId)}
                </TabsTrigger>
              ))}
            </TabsList>
          )}

          {/* Radix keeps every pane's div in the DOM but hides all except the active one and mounts only its body, so
             there is exactly one live scroll box at a time and switching sections starts it at the top. */}
          {tabs.map((tab) => (
            <TabsContent
              key={tab}
              value={tab}
              // So the phone arm labels the pane by its section instead, and drops the reference that would otherwise
              // dangle.
              {...(isMobile
                ? {
                    "aria-labelledby": undefined,
                    "aria-label": providerTabLabel(
                      tab,
                      PROVIDER_TAB_LABELS,
                      state.providerId,
                    ),
                  }
                : {})}
              className={cn(
                "-mx-5 mt-0 px-5 pt-4 pb-5 transition-opacity duration-150 md:min-h-0 md:overflow-y-auto",
                detailPaneInert &&
                  tab !== "usage" &&
                  "pointer-events-none opacity-50",
              )}
              {...(detailPaneInert && tab !== "usage" ? { inert: true } : {})}
            >
              <ProviderTabBody
                tab={tab}
                state={state}
                providers={providers}
                hostId={hostId}
                detailPaneInert={detailPaneInert}
                profileTab={profileTab}
                apiKeyDraft={apiKeyDraft}
                onApiKeyDraftChange={setApiKeyDraft}
                onActiveTabChange={onActiveTabChange}
              />
            </TabsContent>
          ))}
        </Tabs>
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

// Bundled into one object rather than eight individual props on `ProviderTabBody`, since the other tabs
// (general/account/env/mcp/plugins/skills) are provider-level and never touch it.
interface ProviderProfileTabProps {
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly canAddProfile: boolean;
  readonly startInReauth: boolean;
  readonly failedAttempt: FailedProviderProfileAttempt | null;
  readonly onAddProfile: () => void;
  readonly onDismissFailedAttempt: () => void;
  readonly selectedProfileId: string | null;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
  readonly profileEnablementAvailable: boolean;
  readonly profileStatusRefreshAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
}

function ProviderTabBody({
  tab,
  state,
  providers,
  hostId,
  detailPaneInert,
  profileTab,
  apiKeyDraft,
  onApiKeyDraftChange,
  onActiveTabChange,
}: {
  readonly tab: ProviderTabKey;
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
  readonly hostId: string | null;
  readonly detailPaneInert: boolean;
  readonly profileTab: ProviderProfileTabProps;
  readonly apiKeyDraft: string;
  readonly onApiKeyDraftChange: (draft: string) => void;
  readonly onActiveTabChange: (tab: ProviderTabKey) => void;
}): ReactNode {
  switch (tab) {
    case "general":
      return (
        <div className="flex flex-col gap-3">
          <ProviderCliCandidatesSection
            state={state}
            providers={providers}
            hostId={hostId}
          />
          <TerminalAgentArgsSection
            key={state.terminalAgentArgs}
            state={state}
          />
        </div>
      );
    case "env":
      return (
        <ProviderEnvOverridesSection
          providerId={state.providerId}
          overrides={state.envOverrides}
          envOverrideScope={state.nativeCapabilities.envOverrideScope}
        />
      );
    // The key IS the account for these providers, so it owns a tab rather than floating above the tab bar as its
    // own pre-tab region.
    case "account":
      return (
        <ProviderApiKeySection
          state={state}
          draft={apiKeyDraft}
          onDraftChange={onApiKeyDraftChange}
        />
      );
    case "usage":
      return (
        <div className="flex flex-col gap-3">
          <ProviderProfileScopedSection
            state={state}
            {...profileTab}
            signInUnavailableHint={providerSignInUnavailableHint(
              state,
              profileTab.isSelectedHostLocal,
            )}
          />
          <div
            className={cn(
              "flex flex-col gap-3 transition-opacity duration-150",
              detailPaneInert && "pointer-events-none opacity-50",
            )}
            {...(detailPaneInert ? { inert: true } : {})}
          >
            <TraycerSubscriptionForProvider providerId={state.providerId} />
            {/* With profiles on this same tab its per-profile limits are already rendered above, scoped to the selected
               profile. */}
            {state.profiles.length === 0 ? (
              <ProviderRateLimitForProvider
                providerId={state.providerId}
                profileId={null}
                usageUpdatedAt={null}
                fetchEligible={resolveRateLimitFetchEligibility(state).ambient}
                onOpenModelProviders={() => onActiveTabChange("modelProviders")}
              />
            ) : null}
          </div>
        </div>
      );
    case "mcp": {
      const mcp = state.nativeCapabilities.mcp;
      if (mcp === null) {
        return (
          <ProviderTabPlaceholder
            title="MCP servers"
            description="This provider does not support MCP servers."
          />
        );
      }
      return (
        <ProviderMcpTab
          providerId={state.providerId}
          capabilities={mcp}
          providerLabel={PROVIDER_DISPLAY_NAMES[state.providerId]}
          // true` matches the schema's own `.catch(true)` - assume resolved, show no notice - so a host that cannot
          // report this never accuses a provider of a missing binary it knows nothing about.
          cliBinaryResolved={state.cliBinaryResolved ?? true}
        />
      );
    }
    case "modelProviders": {
      const modelProviders = state.nativeCapabilities.modelProviders;
      if (modelProviders === null) {
        // Kept because the switch is the only place that narrows the nullable block, and a `!` here would be the
        // escape the repo's type rules exist to prevent.
        return (
          <ProviderTabPlaceholder
            title="Model providers"
            description="This provider does not support upstream model provider sign-in."
          />
        );
      }
      return (
        <ProviderModelProvidersTab
          providerId={state.providerId}
          providerLabel={PROVIDER_DISPLAY_NAMES[state.providerId]}
          capabilities={modelProviders}
          // The provider row is what tells the tab to render that as a wait rather than a failure - see
          // `ModelProvidersBody`.
          packPreparing={providerPackPreparingForProvider(state)}
        />
      );
    }
    case "plugins":
      return <ProviderPluginsTab state={state} />;
    case "skills":
      return <ProviderSkillsTab state={state} />;
  }
}

function ProviderTabPlaceholder({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
      <div className="text-ui-sm font-medium text-foreground">{title}</div>
      <p className="text-ui-xs text-muted-foreground">{description}</p>
    </div>
  );
}
