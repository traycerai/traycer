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
  modelProviders: "Model Providers",
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
// the target supports it, else the first supported tab in
// {@link PROVIDER_TAB_ORDER} (account → usage → general → …).
function initialActiveTab(
  providers: readonly ProviderCliState[],
  providerId: ProviderId,
): ProviderTabKey {
  const state =
    providers.find((p) => p.providerId === providerId) ?? providers[0];
  const tabs = resolveSupportedTabs(providerTabInputs(state));
  // `focusTab` is a plain `string` in the store, so a deep link CAN name the
  // client-only `account` tab even though it is absent from the wire enum -
  // the match below is against the resolved tab list, not the schema. When no
  // focusTab is set (including the "Add API key" CTA that only sets
  // `focusHarnessId`), `tabs[0]` is the first supported tab — account when the
  // provider takes a key, usage when it has profiles/limits, otherwise the
  // next supported tab in display order.
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
  const scope = useHostScope();
  const setHostId = scope.setHostId;
  // A deep link that already knows which machine needs attention — the
  // composer's provider re-auth banner knows exactly whose profile expired —
  // hands its host to the SHARED scope rather than to a picker private to
  // this panel.
  //
  // Cleared HERE, at the point of use. It used to be cleared only inside the
  // provider rail, which is host-scoped and therefore never rendered when the
  // deep-linked host was unreachable — so the intent survived, and every later
  // visit to Providers yanked the scope back to a host the user had already
  // moved on from.
  //
  // READ LIVE from the store — never captured at mount, which is the part
  // each narrower fix got wrong in turn. Two constraints meet here:
  //
  //   - NOTHING BELOW MOUNTS until the switch has landed. The rail is a
  //     descendant, its mount effect consumes and clears the provider/profile
  //     half of the intent, and child passive effects run BEFORE the
  //     parent's — so children mounted for host A would consume the intent
  //     there (in the worst case starting a re-auth sign-in against A) one
  //     commit before the scope could move to B. The hold below removes that
  //     race rather than trying to outrun it.
  //   - The panel OUTLIVES its mount. The top-level keep-alive host retains
  //     this component while its tab is hidden, so a re-auth banner click
  //     that arms a new intent finds no fresh mount to capture it — a
  //     mount-time snapshot stayed stale, `pending` never rose, and the Sign
  //     in action appeared to do nothing. Deriving pending from the live
  //     subscription reacts to every newly armed intent, whenever it arms.
  //
  // Applying the intent clears `focusHostId`, this subscription re-renders,
  // and the hold releases — no setState inside the effect.
  const liveFocusHostId = useProvidersFocusStore((s) => s.focusHostId);
  const deepLinkPending = liveFocusHostId !== null;
  useEffect(() => {
    if (liveFocusHostId === null) return;
    setHostId(liveFocusHostId);
    useProvidersFocusStore.getState().clearFocusHostId();
  }, [liveFocusHostId, setHostId]);

  // Scope the whole panel (list + refresh + every provider mutation) to the
  // host this page is showing by re-providing the runtime client for this
  // subtree; the provider hooks all read `useHostClient()`, so none need a
  // client prop.
  //
  // Through the shared hook, not a copy of it. This panel used to inline the
  // rule — the same two guards, byte for byte — and that copy is why the
  // post-P4.2 `following` fix had to be made in two places to be true, which
  // is exactly how a rule ends up wrong in one of them. The hook states which
  // statuses re-provide and why.
  const scopedBinding = useScopedHostBinding(scope);

  // The hold that makes the deep link atomic: one frame of placeholder while
  // the effect above moves the scope. Children — including the rail that
  // consumes the rest of the intent — first mount already pointed at the
  // deep-linked host.
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
      // The blurb is desktop-only, and its absence is what puts the global
      // status control on the TITLE's line. The shell's header is a wrapping
      // row of [title + description] and [action]; the description's flex base
      // size is its max-content width, which on a phone exceeds the row on its
      // own, so the action wraps to a line of its own and spends a whole row of
      // the shortest viewport restating what the panel's contents already show.
      description={
        isMobile
          ? undefined
          : "Choose the CLI binary Traycer runs for each coding agent. Pick the bundled binary, one found on your PATH, or a custom install. Disable a provider to hide it when creating an agent."
      }
      // Desktop only, and this is the whole mobile scroll model. `fillHeight`
      // stretches the card to the settings scroll container and lets the ACTIVE
      // PANE own an internal scroll, which needs `min-h-0` at every level
      // between the two so each one may shrink past its content and hand the
      // overflow down. That chain assumes the card is reliably BOUNDED: its
      // levels have given up the automatic floor that would otherwise keep them
      // as tall as their contents, so they follow whatever height arrives from
      // above - including a height that arrives wrong.
      //
      // A phone has one scroll container already - the settings surface - so it
      // needs no second one. Without `fillHeight` the card is sized by its
      // contents, the panes below keep `min-height: auto`, and the surface
      // scrolls the lot. That drops the bounded-ancestor contract entirely
      // rather than relying on every level above holding up its end of it.
      fillHeight={!isMobile}
      // No host readout here — the sidebar states the scoped host one row
      // above and repeating it was the same fact printed twice.
      //
      // The global status DOES belong here: it reports a max over every
      // provider and refreshes all of them, and inside the card it sat beside
      // the selected provider's Enabled toggle and read as that provider's own.
      //
      // It renders only on a USABLE scope, which is the whole safety argument.
      // `headerAction` is a sibling of the gate, so it is not gated - and the
      // old bug was mounting these hooks here unconditionally: on `connecting`,
      // `unreachable` or `vanished` there is no client, `useHostClient()` falls
      // back to the ambient one, and Refresh re-probed and rewrote THAT host's
      // provider list while the page named another.
      //
      // `isHostScopeUsable` is the repo's own name for this - "what may be
      // MOUNTED", as its own comment puts it - and it is the same rule the
      // body's controls already mount under, so the header cannot be safe by a
      // different standard than the thing below it.
      //
      // The two usable states are correct for DIFFERENT reasons: `ready`
      // re-provides its own client through `HostRuntimeContext`, which wraps
      // this entire shell INCLUDING the header, while `following` needs no
      // override precisely because the ambient client already IS the scoped
      // host's. Gating on `ready` alone would hide the control in the ordinary
      // no-explicit-pick case.
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

/**
 * "All providers · Checked …" plus Refresh, for the panel heading row.
 *
 * Named for its SCOPE because that is what was unclear: `checkedAt` is a max
 * over every provider and Refresh re-probes all of them, which read as
 * per-provider when it sat at the card's top-right.
 *
 * Mounted only on a USABLE scope - see `headerAction` above. Its hooks resolve
 * `useHostClient()`, so on `connecting` / `unreachable` / `vanished` they would
 * resolve the ambient host instead of the one the page names.
 */
function ProvidersGlobalStatus(): ReactNode {
  // SUBSCRIBED, like the body's instance. `subscribed: false` was avoiding a
  // duplicate that does not exist - two observers of one key share a fetch -
  // while buying a real defect: an unsubscribed observer renders the cache at
  // mount and then ignores it, so a refresh would update the rows below and
  // leave this row's "Checked …" and its spinner frozen on the old answer.
  // That is precisely the state this control exists to report.
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

/**
 * Everything that talks to the scoped host, mounted only once the gate has
 * proven there is a client behind the name.
 */
function ProvidersScopedContent({
  hostId,
  isSelectedHostLocal,
}: {
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}): ReactNode {
  const query = useProvidersList({ enabled: true, subscribed: true });
  return (
    // `h-full` / `min-h-0` from `md` up only. They are the two halves of the
    // inner-scroll model: `h-full` hands the card's height down, and `min-h-0`
    // lets the levels below shrink past their content so the pane can scroll
    // instead of the page. Both only mean anything against a bounded card, and
    // together they make this subtree follow the height it is given rather than
    // its own contents. Below `md` there is no such card, so neither is claimed
    // and the content sizes itself.
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
    // A PRE-SEND transport failure says nothing about the RPC or the host's
    // version - the request was never put on the wire. On a remote host this
    // is routinely just the session's first dial still in flight, and the
    // ready boundary refetches this query the moment the session is up, so
    // describe the connection instead of blaming the host.
    //
    // Deliberately the `RetryableTransportError` subclass and not its
    // `HostTransportFailureError` base: an AMBIGUOUS post-send drop (the
    // socket died after the request frame went out) keeps the base class
    // precisely because nothing may assume it will resolve itself. Nothing
    // refetches it either - `useHostQuery` pins `retry: false`, and a healthy
    // independent stream connection need not emit any recovery event - so
    // showing it as "connecting" would park the panel on a spinner that never
    // resolves and offers no way to report the fault.
    //
    // REMOTE only, for exactly the same reason. A spinner is a promise that
    // something will refetch, and only the remote path can keep it: the
    // messenger holds a remote binding for the selected host whose ready
    // boundary invalidates this query (`subscribeRemoteAvailability` ->
    // `onRemoteAvailabilityRecovered`). A local host has no such binding, and
    // by the time this error arrives the retry wrapper has already spent its
    // whole budget - its final attempt rethrows unchanged, so "retryable" here
    // describes what the class of failure WAS, not that anything is still
    // retrying. The only thing that could refetch a local host is a durable
    // stream tab that happens to be bound to it, which Settings cannot assume
    // exists. So local falls through to the actionable card, which at worst
    // shows a recoverable fault with a way out and is replaced the moment a
    // recovery invalidation does land.
    //
    // A remote host that dialed and then went TERMINAL - an incompatible
    // handshake, a plan restriction, a rejected credential, the reconnect cap -
    // owes no boundary either, and would strand this spinner just as badly.
    // That case never PERSISTS here, enforced at two layers. New requests:
    // `RemoteSession.sendUnary` rejects a closed session as a non-retryable
    // `HostTransportFailureError` - and, since it now AWAITS a session that is
    // merely dialing, a retryable error reaching this branch means a whole
    // attach attempt failed with another already armed on backoff. Either way
    // the class keeps meaning "still dialing" here. The query that already
    // CACHED a retryable error from racing the dial:
    // `RuntimeHostMessenger` records the terminal verdict, fires one
    // host-scope invalidation, and rejects the resulting refetch with the
    // verdict instead of transparently redialing - without that, the refetch
    // would race a FRESH dial, cache "retryable" again, and spin forever.
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
  // Same provider id as `activeId` above, deliberately: the default tab is now
  // provider-dependent (account → usage → …), so deriving it from the rail's
  // first provider lands the deep link on the wrong tab. The "Add API key" CTA
  // sets `focusHarnessId` with no `focusTab`; with a first provider defaulting
  // to `usage`, a focused provider that also supports `usage` would keep
  // "Profiles & Limits" instead of opening its own first tab, "Account" — the
  // one field the CTA exists to reach. When the deep link is not consumed (no
  // focus, or a different host) `initialFocus.harnessId` is already null, so
  // this stays the rail's first provider.
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
    // From `md` up, fill the panel body (the shell stretches it to the settings
    // scroll container), so switching providers never resizes the box and the
    // detail pane - not the outer overlay - owns the scroll. Height follows the
    // viewport: on shorter screens it shrinks to fit the modal instead of
    // overflowing it. Below `md` the card is content-sized and the settings
    // surface scrolls, so there is no height to fill and none is claimed.
    // Below md the rail column collapses into a full-width provider select
    // stacked above the detail pane. The select lists `orderedProviders`, not
    // the rail's filtered `visibleProviders` - the rail's search/filter is a
    // pointer affordance that goes with it, so it must never narrow what a
    // phone can reach.
    <div className="flex flex-col md:h-full md:min-h-0 md:flex-row">
      <div className="shrink-0 border-b border-border/60 p-2 md:hidden">
        <ProvidersMobileSelect
          providers={orderedProviders}
          activeId={active.providerId}
          onSelect={onSelectProvider}
        />
      </div>
      {/* The search row is a pinned SIBLING of the scroll box rather than the
          first child of a scrolling column - the same shape the tab rail uses
          below, and for the same reason: scrolling the list must never carry
          the control that filters it out of reach. */}
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
      {/* From `md` up the detail COLUMN does not scroll - the active tab's body
          does (see `ProviderDetail`), so the provider header and section rail
          stay pinned. Horizontal padding lives here rather than on each row so
          the rail's `border-b` keeps exactly the width it had when this element
          owned the scroll; the tab body cancels it with `-mx-5 px-5` to put its
          scrollbar on the pane edge instead of 5 units inside it. */}
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
        {/* The same `HarnessIcon` the desktop rail draws through
            `ProviderList`, so the two presentations of the provider list mark a
            provider the same way. `SelectItem` wraps its children in Radix's
            `ItemText`, which portals the SELECTED item into the trigger - so
            the icon rides the closed state too, from this one place. */}
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

/**
 * The provider's enable/disable control: one switch, and the label that names
 * its state.
 *
 * A three-way Auto/On/Off control briefly lived here, where "Auto" derived
 * enablement from whether the host had detected an account. It is gone, and
 * the reason is worth keeping: nobody could tell what Auto meant from looking
 * at it, and a provider it enabled could silently switch itself off a few
 * seconds later when a background probe finally answered - the row a user had
 * just clicked would disappear from the picker and reappear somewhere else.
 * Enablement is a choice, so it is a switch, and it stays where it is put.
 */
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
  // Whichever host `useHostClient()` currently resolves to - the app-wide
  // default, or the Settings-selected host if `ProvidersSettingsPanel`
  // re-provided `HostRuntimeContext` for a non-default selection. Every
  // provider mutation in this subtree already reads `useHostClient()`
  // internally to the same effect; the add-profile dialog needs it as an
  // explicit prop since it's also reused by the picker's tab-scoped flow.
  const hostClient = useHostClient();
  const switchId = useId();
  // Layout question ("is the window narrow?"), so the viewport signal - the
  // rail is a pointer affordance, and a narrow desktop window wants the phone
  // presentation for the same reason a phone does.
  const isMobile = useIsMobileViewport();
  // The API-key draft outlives the `account` tab body that renders it. Radix
  // keeps every pane's div in the DOM but unmounts an inactive pane's BODY,
  // so holding this inside the section
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
  // Whether the detail pane below the header is inert - the Account and
  // Profiles controls included.
  //
  // Keyed on the effective `enabled` flag, which is now the only thing it could
  // be keyed on. Not because `false` has a single cause - boot seeding leaves
  // plenty of providers off that nobody ever touched - but because every cause
  // is now a STICKY row: seeded once, or set by the user's toggle, and never
  // re-derived. So the pane is inert precisely when the provider is off, and
  // turning it on is the one gesture that revives it.
  //
  // Under the retired tri-state that did not hold: an auto-undetected provider
  // read disabled from a verdict that could flip under the user without anyone
  // choosing anything, which is why this gate used to read the sticky mode
  // instead of the effective flag.
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
    // Three rows: provider header, section rail, section body. From `md` up
    // only the last one scrolls, and `min-h-0` repeats down every level to
    // allow it: a flex item's default `min-height: auto` refuses to shrink
    // below its content, which would push the overflow back up to the column
    // and un-pin the two rows above.
    //
    // Below `md` that default is the SAFETY, not the obstacle - it is what
    // guarantees each level is at least as tall as its content, so the body
    // renders whole and the settings surface scrolls it. Hence `md:` on every
    // `min-h-0` from here down: a phone has no bounded card to distribute, and
    // a subtree that has given up its own floor can only be as right as the
    // height handed to it. Keeping the floor makes that moot.
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
            if (next === undefined) return;
            onActiveTabChange(next);
          }}
          // `gap-0`, with the rail-to-body spacing moved INSIDE the scroll box
          // as `pt-4`. With a gap here the scroll box would start 4 units below
          // the rail's rule, so content vanished in mid-air above itself; owned
          // by the body, the clip edge and the rule are the same line.
          className="flex flex-1 flex-col gap-0 md:min-h-0"
        >
          {/* Two presentations of ONE selection, off the same `tabs` list and
              the same labels. The pointer-width rail is the line bar; below
              `md` it is a dropdown, because the bar's `flex-wrap` is what a
              phone gets - two ragged rows of the pane's fourth chrome row.

              The branch is presentation only. The desktop arm's triggers write
              the `Tabs` value directly; the phone arm cannot (a select item is
              not a tab trigger) and calls `onActiveTabChange` instead, which is
              the same prop this component's `onValueChange` above calls. Either
              way `Tabs` stays controlled from one place, so the bodies below
              and the one-mounted-pane invariant are untouched by the swap. */}
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
            /* Line (underline) tabs, not the filled default. Seven unrelated
               panes is NAVIGATION, and a filled track reads as a segmented
               control - which is for re-presenting one dataset, and tops out
               around four options. The old bar also cancelled the primitive's
               `w-fit` with `w-full` while keeping content-width triggers, so
               the filled slab spanned the pane and every unused pixel piled up
               on the right as dead space. Full width is kept here for the
               BORDER (a rail spanning the pane), while the track itself is
               transparent, so there is nothing left to look empty. */
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

          {/* From `md` up, the scroll owner. Radix keeps every pane's div in
              the DOM but hides all except the active one and mounts only its
              body, so there is exactly one live scroll box at a time and
              switching sections starts it at the top - which is what you want
              when the panes are unrelated. Pinning the rail this way (a sibling
              row outside the scroll box) rather than with `position: sticky` is
              what avoids the background problem: nothing ever passes UNDER the
              rail, so it needs no opaque fill over the pane's translucent
              `bg-card/40`.

              Below `md` it owns no scroll and claims no height. A phone already
              scrolls the settings surface, and a pane that scrolls inside a
              page that also scrolls is two gestures competing for one flick -
              so the body simply grows and the surface carries it. The rail
              scrolls away with the content instead of staying pinned, which is
              the cost of that, and the reason the rail is one row tall. */}
          {tabs.map((tab) => (
            <TabsContent
              key={tab}
              value={tab}
              // Radix names a pane after the TRIGGER that selects it
              // (`aria-labelledby={triggerId}`), which on a phone names an
              // element that does not exist - the dropdown replaces the whole
              // `TabsList`, triggers included. So the phone arm labels the pane
              // by its section instead, and drops the reference that would
              // otherwise dangle. Caller props spread AFTER Radix's own in
              // `Tabs.Content`, so both keys land.
              //
              // Spread CONDITIONALLY, because on the desktop arm the trigger is
              // real and Radix's wiring is the better one.
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
          <div
            className={cn(
              "flex flex-col gap-3 transition-opacity duration-150",
              detailPaneInert && "pointer-events-none opacity-50",
            )}
            {...(detailPaneInert ? { inert: true } : {})}
          >
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
          // An old host omits the key entirely; `?? true` matches the schema's
          // own `.catch(true)` - assume resolved, show no notice - so a host
          // that cannot report this never accuses a provider of a missing
          // binary it knows nothing about.
          cliBinaryResolved={state.cliBinaryResolved ?? true}
        />
      );
    }
    case "modelProviders": {
      const modelProviders = state.nativeCapabilities.modelProviders;
      if (modelProviders === null) {
        // Unreachable through the tab bar - `supportedTabsFor` only returns a
        // tab the host advertised, and a host that advertises this one fills
        // the capability block. Kept because the switch is the only place that
        // narrows the nullable block, and a `!` here would be the escape the
        // repo's type rules exist to prevent.
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
          // The catalog needs a managed server, so a pack that is still
          // downloading reads as "the server would not start". The provider row
          // is what tells the tab to render that as a WAIT rather than a
          // failure - see `ModelProvidersBody`.
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
