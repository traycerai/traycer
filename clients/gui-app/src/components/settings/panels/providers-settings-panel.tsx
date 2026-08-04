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
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { settingsHostOptionLabel } from "./settings-host-labels";
import { ProviderMcpTab } from "./provider-mcp-tab";
import { ProviderPluginsTab } from "./provider-plugins-tab";
import { ProviderSkillsTab } from "./provider-skills-tab";
import { resolveRateLimitFetchEligibility } from "@/lib/rate-limit-providers";
import {
  AddProviderProfileDialog,
  type FailedProviderProfileAttempt,
} from "./add-provider-profile-dialog";
import { ProviderProfileScopedSection } from "./provider-profile-scoped-section";
import { defaultSelectedProfileId } from "@/components/providers/provider-profile-model";
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
import { ProviderCliCandidatesSection } from "./provider-cli-candidates-section";
import {
  providerTabInputs,
  supportedTabsFor as resolveSupportedTabs,
  type ProviderTabKey,
} from "./provider-settings-tabs";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
type ProviderId = ProviderCliState["providerId"];
type ProvidersListQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
>;

// Wire ids (`providerSettingsTabSchema`) are NOT display strings: they ride
// `supportedTabs`, which a released client decodes through a single
// `.catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES)` on the whole
// `nativeCapabilities` object. An id this side renames that an older client
// cannot parse fails the enum and drops that ENTIRE object, silently taking
// MCP/Plugins/Skills with it. So every rename lands here, on the label, and
// never on the id - `general` shows as "CLI & Args" and `usage` as
// "Profiles & Limits". "General" said nothing about what the tab holds; each
// label now names its own content.
const PROVIDER_TAB_LABELS: Record<ProviderTabKey, string> = {
  general: "CLI & Args",
  account: "Account",
  usage: "Profiles & Limits",
  env: "Env",
  mcp: "MCP",
  plugins: "Plugins",
  skills: "Skills",
};

// The provider to select on mount: the deep-link focus target (mapped from its
// GUI harness id) when one was requested and is present,
// otherwise the first provider in the list.
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

// Initial tab for the deep-linked (or first) provider: honor `focusTab` when
// the target advertises it, else the first supported tab.
function initialActiveTab(
  providers: readonly ProviderCliState[],
  providerId: ProviderId,
): ProviderTabKey {
  const state =
    providers.find((p) => p.providerId === providerId) ?? providers[0];
  const tabs = resolveSupportedTabs(providerTabInputs(state));
  // `focusTab` is a plain `string` in the store, so a deep link CAN name the
  // client-only `account` tab even though it is absent from the wire enum -
  // the match below is against the resolved tab list, not the schema. No
  // caller sets it today; the "Add API key" CTA passes only `focusHarnessId`
  // and therefore lands on `tabs[0]`, which is `general` for every provider
  // that has one. That predates the Account/Usage split (the key field sat on
  // `usage`, also not first) and is a CTA-side change, not one this pane can
  // make on its own.
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

// NOTE: the per-tab "has content" dot that used to render here is gone on
// purpose, not by oversight. It claimed "this tab holds something" but could
// not tell the truth about it: `general` lit up for every CLI-backed provider
// (candidates are never empty) INCLUDING cursor/amp, whose tab rendered
// nothing; `usage` lit up unconditionally for every rate-limit-capable
// provider whether or not anything was configured; and mcp/plugins/skills -
// the only three tabs that hold user-installed content - were hardcoded to
// never light up, so the tabs with real content were the ones that looked
// empty. It also drew in `bg-primary`, reading as "needs attention" for what
// was at best "is configured", using the same 1.5-unit dot the provider rail
// already spends on "provider disabled".
//
// If a per-tab signal comes back, split the two meanings and keep them split:
// a muted COUNT on mcp/plugins/skills once their list query is cached, and a
// warning-toned dot reserved for genuine attention (expired auth, config
// parse failure). Never one glyph for both.

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  "claude-code": "Anthropic's Claude Code CLI.",
  codex: "OpenAI's Codex CLI.",
  opencode: "OpenCode CLI agent.",
  cursor:
    "Cursor coding agent - SDK-driven agents authenticated with your Cursor API key.",
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
  hermes: "Hermes Agent - Nous Research's coding CLI via your Hermes account.",
  omp: "Oh My Pi - can1357's coding CLI via your linked provider subscriptions.",
};

function hasPendingProviderProbe(
  providers: readonly ProviderCliState[],
): boolean {
  return providers.some(
    (provider) =>
      // A disabled provider's probes are irrelevant (the host clears these
      // flags for disabled providers at the wire boundary); don't render a
      // stuck "checking…" for one, and stay correct against an older host that
      // still surfaces the flags.
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
  const activeHostId = useReactiveActiveHostId();
  const hostsQuery = useHostDirectoryList();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => useProvidersFocusStore.getState().focusHostId,
  );
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
            {settingsHostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
      description="Choose the CLI binary Traycer runs for each coding agent. Pick the bundled binary, one found on your PATH, or a custom install. Disable a provider to hide it when creating an agent."
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
  const [initialFocus, setInitialFocus] = useState(() => {
    const focus = useProvidersFocusStore.getState();
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
  const [activeTab, setActiveTab] = useState<ProviderTabKey>(() =>
    initialActiveTab(
      orderedProviders,
      initialActiveProviderId(orderedProviders, null),
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
    // Fill the panel body (the shell stretches it to the settings scroll
    // container and caps it via `bodyClassName` max-height), so switching
    // providers never resizes the box and the detail pane - not the outer
    // overlay - owns the scroll. Height follows the viewport: on shorter
    // screens it shrinks to fit the modal instead of overflowing it.
    <div className="flex h-full min-h-0">
      {/* The search row is a pinned SIBLING of the scroll box rather than the
          first child of a scrolling column - the same shape the tab rail uses
          below, and for the same reason: scrolling the list must never carry
          the control that filters it out of reach. */}
      <nav
        aria-label="Providers"
        className="flex w-[clamp(10rem,22vw,14rem)] shrink-0 flex-col border-r border-border/60"
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
      {/* The detail COLUMN no longer scrolls - the active tab's body does (see
          `ProviderDetail`), so the provider header and tab rail stay pinned.
          Horizontal padding lives here rather than on each row so the rail's
          `border-b` keeps exactly the width it had when this element owned the
          scroll; the tab body cancels it with `-mx-5 px-5` to put its scrollbar
          on the pane edge instead of 5 units inside it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 pt-5">
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
    <TooltipWrapper
      label={disablingLast ? "At least one provider must stay enabled." : null}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* Guard span: the Switch is `disabled` in exactly the state this
          explains, and a disabled control emits no pointer events. */}
      <span className="inline-flex">
        <Switch
          id={id}
          checked={enabled}
          onCheckedChange={(next) => {
            if (isPending || (!next && disablingLast)) return;
            onSetEnabled(providerId, next);
          }}
          disabled={isPending || disablingLast}
        />
      </span>
    </TooltipWrapper>
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
  // Whichever host `useHostClient()` currently resolves to - the app-wide
  // default, or the Settings-selected host if `ProvidersSettingsPanel`
  // re-provided `HostRuntimeContext` for a non-default selection. Every
  // provider mutation in this subtree already reads `useHostClient()`
  // internally to the same effect; the add-profile dialog needs it as an
  // explicit prop since it's also reused by the picker's tab-scoped flow.
  const hostClient = useHostClient();
  const switchId = useId();
  // The API-key draft outlives the `account` tab body that renders it. Radix
  // unmounts an inactive `TabsContent`, so holding this inside the section
  // would blank a pasted key on any tab switch. Held HERE for the same reason
  // `selectedProfileId` is below: `ProvidersRailLayout` keys `<ProviderDetail>`
  // by provider, so a provider switch still discards the draft - a key typed
  // for one provider must never appear in another's field.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
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
    () =>
      state.profiles.some((profile) => profile.profileId === initialProfileId)
        ? initialProfileId
        : defaultSelectedProfileId(state.profiles),
  );
  const setEnabled = useProvidersSetEnabled();
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
  // Bundled once here (rather than threaded as eight separate props) since
  // only the "usage" ("Profiles & Limits") tab body needs the profile-
  // management surface - the other tabs never see it.
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
  };

  return (
    // Three rows: provider header, tab rail, tab body - and only the last one
    // scrolls. `min-h-0` repeats down every level because a flex item's default
    // `min-height: auto` refuses to shrink below its content, which would push
    // the overflow back up to the column and un-pin the two rows above.
    <div className="flex min-h-0 flex-1 flex-col gap-4">
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
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-opacity",
          state.enabled ? "" : "pointer-events-none opacity-50",
        )}
        {...(!state.enabled ? { inert: true } : {})}
      >
        {/* Nothing renders between the provider header and the tab rail. The
            API-key card used to sit here, above the bar, so a provider's only
            real setting appeared outside the tabs that were supposed to hold
            its settings; it is now the whole body of the `account` tab. That
            matters more now that the rail is PINNED: anything parked here would
            occupy fixed height at the top of the pane forever, not just until
            you scrolled past it. */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const next = tabs.find((tab) => tab === value);
            if (next !== undefined) onActiveTabChange(next);
          }}
          // `gap-0`, with the rail-to-body spacing moved INSIDE the scroll box
          // as `pt-4`. With a gap here the scroll box would start 4 units below
          // the rail's rule, so content vanished in mid-air above itself; owned
          // by the body, the clip edge and the rule are the same line.
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {/* Line (underline) tabs, not the filled default. Seven unrelated
              panes is NAVIGATION, and a filled track reads as a segmented
              control - which is for re-presenting one dataset, and tops out
              around four options. The old bar also cancelled the primitive's
              `w-fit` with `w-full` while keeping content-width triggers, so
              the filled slab spanned the pane and every unused pixel piled up
              on the right as dead space. Full width is kept here for the
              BORDER (a rail spanning the pane), while the track itself is
              transparent, so there is nothing left to look empty. */}
          <TabsList
            variant="line"
            className="h-auto w-full max-w-full shrink-0 flex-wrap justify-start rounded-none border-b border-border/60 px-0 pb-1.5"
          >
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab} className="flex-none px-3">
                {PROVIDER_TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* The scroll owner. Radix mounts only the ACTIVE content, so there
              is exactly one scroll box at a time and switching tabs starts it
              at the top - which is what you want when the panes are unrelated.
              Pinning the rail this way (a sibling row outside the scroll box)
              rather than with `position: sticky` is what avoids the background
              problem: nothing ever passes UNDER the rail, so it needs no opaque
              fill over the pane's translucent `bg-card/40`. */}
          {tabs.map((tab) => (
            <TabsContent
              key={tab}
              value={tab}
              className="-mx-5 mt-0 min-h-0 overflow-y-auto px-5 pt-4 pb-5"
            >
              <ProviderTabBody
                tab={tab}
                state={state}
                providers={providers}
                profileTab={profileTab}
                apiKeyDraft={apiKeyDraft}
                onApiKeyDraftChange={setApiKeyDraft}
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

// Profile-management surface handed to the "usage" ("Profiles & Limits") tab
// body - the only tab that renders `ProviderProfileScopedSection` (add/rename/
// remove/recolor, switch active profile). Profiles and limits stay on ONE tab
// because the section already owns the SELECTED PROFILE's limits; splitting
// those two meant a provider's limits were reported in two places at once. The
// API key is a different question (how the provider authenticates at all) and
// moved to its own `account` tab. Bundled into one object rather than eight
// individual props on `ProviderTabBody`, since the other tabs
// (general/account/env/mcp/plugins/skills) are provider-level and never touch
// it.
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
}

function ProviderTabBody({
  tab,
  state,
  providers,
  profileTab,
  apiKeyDraft,
  onApiKeyDraftChange,
}: {
  readonly tab: ProviderTabKey;
  readonly state: ProviderCliState;
  readonly providers: readonly ProviderCliState[];
  readonly profileTab: ProviderProfileTabProps;
  readonly apiKeyDraft: string;
  readonly onApiKeyDraftChange: (draft: string) => void;
}): ReactNode {
  switch (tab) {
    case "general":
      return (
        <div className="flex flex-col gap-3">
          <ProviderCliCandidatesSection state={state} providers={providers} />
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
        />
      );
    // The key IS the account for these providers, so it owns a tab rather than
    // floating above the tab bar as its own pre-tab region. `supportedTabsFor`
    // shows this tab exactly when `apiKey.supported`, so the section's own
    // `if (!supported) return null` guard is unreachable from here - kept
    // there because the section is not otherwise gated at its call site.
    //
    // The draft is threaded in because this body is UNMOUNTED whenever another
    // tab is active (Radix `TabsContent`), which the section used to survive by
    // sitting outside the tab bar entirely.
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
          <TraycerSubscriptionForProvider providerId={state.providerId} />
          {/* The unscoped card is the ZERO-profile shape, which is what
              `ProviderProfileScopedSection` documents it as. With profiles on
              this same tab its per-profile limits are already rendered above,
              scoped to the selected profile - mounting this too would show two
              near-identical limits blocks and leave the ambient one looking
              authoritative when the selected profile is what actually runs. */}
          {state.profiles.length === 0 ? (
            <ProviderRateLimitForProvider
              providerId={state.providerId}
              profileId={null}
              usageUpdatedAt={null}
              fetchEligible={resolveRateLimitFetchEligibility(state).ambient}
            />
          ) : null}
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
