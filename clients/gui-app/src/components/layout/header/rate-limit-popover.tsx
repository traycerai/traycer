import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Gauge, Settings } from "lucide-react";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  type AccountContext,
} from "@traycer/protocol/common/schemas";
import { Badge } from "@/components/ui/badge";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import {
  ProviderRateLimitDetail,
  type ProviderRateLimitQueryState,
} from "@/components/settings/panels/provider-rate-limit-views";
import { resolveCodexResetCreditAction } from "@/components/settings/panels/codex-reset-credit-availability";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import {
  useHostQueries,
  useHostQueriesWithResponseMap,
} from "@/hooks/host/use-host-queries";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import type { RateLimitUnavailableReason } from "@traycer/protocol/host";
import type { TraycerTeamSubscription } from "@traycer/protocol/auth";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  useVisibleRateLimitProviders,
  type ConfiguredRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
import {
  resolveRateLimitProfileId,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  enqueueRateLimitFetch,
  enqueueRateLimitFetchBatch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  formatUnavailableReason,
  resolvePopoverProviderRateLimitState,
  resolveProviderPlanLabel,
  type PopoverProviderRateLimitState,
} from "@/lib/provider-rate-limit-content";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import { queryKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import { useRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import {
  resolveAccountContext,
  useAccountContextStore,
} from "@/stores/auth/account-context-store";
import {
  accountContextValue,
  isCreditBasedPricing,
  isTraycerEligible,
  resolveTraycerSubscriptionState,
  selectSubscription,
  subscriptionPlanLabel,
  type TraycerSubscription,
  type TraycerSubscriptionState,
} from "@/lib/auth/traycer-subscription-content";
import { TraycerSubscriptionView } from "@/components/settings/panels/traycer-subscription-views";
import {
  useRateLimitPopoverStore,
  type RateLimitPopoverTab,
} from "@/stores/rate-limits/rate-limit-popover-store";
import { cn } from "@/lib/utils";

/**
 * A rail/Overview entry, in draw order: either a host-RPC provider or the
 * synthetic Traycer entry. `railTabProviderId` maps each to a `ProviderId` so a
 * single `sortProviderStatesByProviderOrder` positions Traycer at its
 * `PROVIDER_ID_ORDER` slot among the providers.
 */
type RailTabDescriptor =
  | { readonly kind: "provider"; readonly providerId: RateLimitProviderId }
  | { readonly kind: "traycer" };

const PERSONAL_ACCOUNT_CONTEXT: AccountContext = { type: "PERSONAL" };

function railTabProviderId(tab: RailTabDescriptor): ProviderId {
  return tab.kind === "traycer" ? "traycer" : tab.providerId;
}

function useTraycerSubscription() {
  const query = useAuthUser();
  const storedAccountContext = useAccountContextStore((s) => s.accountContext);
  const user = query.data ?? null;
  const teams = user?.teamSubscriptions ?? [];
  const teamIds = new Set(teams.map((team) => team.team.id));
  const resolvedAccountContext = resolveAccountContext(
    storedAccountContext,
    teamIds,
  );
  const personalSubscription = user?.userSubscription ?? null;
  const subscription = selectSubscription(user, resolvedAccountContext, teams);
  const accountSubscriptions = [
    {
      accountContext: PERSONAL_ACCOUNT_CONTEXT,
      subscription: personalSubscription,
    },
    ...teams.map((team) => ({
      accountContext: { type: "TEAM" as const, teamId: team.team.id },
      subscription: team,
    })),
  ];
  const eligible = accountSubscriptions.some(
    (account) =>
      account.subscription !== null && isTraycerEligible(account.subscription),
  );
  const rateLimitAccountContexts = accountSubscriptions
    .filter(
      (account) =>
        account.subscription !== null &&
        !isCreditBasedPricing(account.subscription.subscriptionStatus),
    )
    .map((account) => account.accountContext);
  return {
    query,
    resolvedAccountContext,
    teams,
    personalSubscription,
    subscription,
    eligible,
    rateLimitAccountContexts,
  };
}

function orderRailTabs(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  includeTraycer: boolean,
): ReadonlyArray<RailTabDescriptor> {
  const descriptors: RailTabDescriptor[] = providers.map((provider) => ({
    kind: "provider",
    providerId: provider.providerId,
  }));
  if (includeTraycer) descriptors.push({ kind: "traycer" });
  return sortProviderStatesByProviderOrder(
    descriptors.map((descriptor) => ({
      providerId: railTabProviderId(descriptor),
      descriptor,
    })),
  ).map((entry) => entry.descriptor);
}

function configuredProviderProfiles(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  providerId: RateLimitProviderId,
): ReadonlyArray<ProviderProfile> {
  const provider = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  return provider === undefined ? [] : provider.profiles;
}

function refreshTargetsForProvider(
  provider: ConfiguredRateLimitProvider,
): ReadonlyArray<string | null> {
  if (provider.profiles.length === 0) return [null];
  return provider.profiles
    .filter(profileLoggedInForUsage)
    .map(rateLimitProfileId);
}

function profileLoggedInForUsage(profile: ProviderProfile): boolean {
  return (
    profile.auth.status === "authenticated" ||
    profile.auth.status === "configured"
  );
}

function rateLimitProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * The header rate-limit popover content: a left rail (Overview + one tab per
 * connected provider) and a detail pane, mirroring the composer's model-picker
 * shell (Core Flows: "same interaction family as the composer's model picker").
 * The whole body is a child of `PopoverContent`, so Radix only mounts it - and
 * runs its queries - while the popover is open. The selected tab is persisted
 * separately so reopening restores the provider the user last inspected.
 */
export function RateLimitPopover({
  onClose,
  profileSelection,
}: {
  readonly onClose: () => void;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  return (
    <PopoverContent
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={12}
      role="dialog"
      aria-label="Usage limits"
      className="w-[min(92vw,30rem)] gap-0 overflow-hidden rounded-xl p-0"
      // Radix auto-focuses the first focusable child on open. Here that's the
      // Overview rail tab, whose `TooltipWrapper` opens the tooltip on focus
      // (keyboard a11y) - so it would pop open the instant the popover mounts
      // and never receive a mouseleave/blur to close it. This popover has no
      // field to type into (unlike the composer's model picker, whose first
      // focusable is its search input, so it wants and keeps the auto-focus), so
      // opting out of the initial focus is harmless and stops the stuck tooltip.
      onOpenAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          (target.closest('[data-testid="confirm-destructive-dialog"]') !==
            null ||
            target.closest('[data-slot="dialog-overlay"]') !== null)
        ) {
          event.preventDefault();
        }
      }}
    >
      <RateLimitPopoverBody
        onClose={onClose}
        profileSelection={profileSelection}
      />
    </PopoverContent>
  );
}

function RateLimitPopoverBody({
  onClose,
  profileSelection,
}: {
  readonly onClose: () => void;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  const displayProviders = useVisibleRateLimitProviders();
  // Rail order matches the app's standard provider order everywhere else.
  const providers = useMemo(
    () => sortProviderStatesByProviderOrder(displayProviders),
    [displayProviders],
  );

  // Traycer is a GUI-only rail entry (AuthService subscription, not a host RPC),
  // gated on the *selected* account being paid or credit-bundled. Recomputed
  // reactively from the auth query + account-context store, so the tab appears /
  // disappears live as either changes - not snapshotted at popover-open time.
  const traycerSubscription = useTraycerSubscription();

  const railTabs = useMemo(
    () => orderRailTabs(providers, traycerSubscription.eligible),
    [providers, traycerSubscription.eligible],
  );
  const activeTab = useRateLimitPopoverStore((state) => state.activeTab);
  const setActiveTab = useRateLimitPopoverStore((state) => state.setActiveTab);

  // Zero-state only when there is genuinely nothing to show: no host-RPC
  // providers AND no eligible Traycer tab.
  if (providers.length === 0 && !traycerSubscription.eligible) {
    return <RateLimitZeroState onClose={onClose} />;
  }

  // A credential removed (or Traycer becoming ineligible) mid-session can drop
  // the active tab from the rail; fall back to Overview rather than rendering a
  // tab that no longer exists.
  const validTabs = new Set<RateLimitPopoverTab>([
    "overview",
    ...railTabs.map((tab) =>
      tab.kind === "traycer" ? "traycer" : tab.providerId,
    ),
  ]);
  const resolvedTab: RateLimitPopoverTab = validTabs.has(activeTab)
    ? activeTab
    : "overview";

  // A *fixed target* height (not content-sized), plus an explicit
  // `minmax(0,1fr)` grid row, is what makes the popover a stable box across
  // tabs and lets its panes scroll. The target is at least half the viewport in
  // normal header placement, while Radix's available-height guard keeps it
  // inside short windows. `minmax(0,1fr)` pins the row to the used container
  // height regardless of content, and both columns stretch into it with their
  // own `min-h-0` + `overflow-y-auto`, so each scrolls internally.
  return (
    <div className="grid h-[max(50vh,22rem)] max-h-[var(--radix-popover-content-available-height)] grid-cols-[3rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden">
      <RateLimitRail
        railTabs={railTabs}
        providers={providers}
        traycerRefreshTarget={{
          enabled: traycerSubscription.eligible,
          rateLimitAccountContexts:
            traycerSubscription.rateLimitAccountContexts,
          isFetching: traycerSubscription.query.isFetching,
          refetch: traycerSubscription.query.refetch,
        }}
        activeTab={resolvedTab}
        onSelect={setActiveTab}
        onClose={onClose}
      />
      <div className="min-h-0 min-w-0 overflow-y-auto p-3">
        {resolvedTab === "overview" ? (
          <RateLimitOverview
            railTabs={railTabs}
            providers={providers}
            profileSelection={profileSelection}
          />
        ) : (
          <RateLimitDetailPane
            tab={resolvedTab}
            providers={providers}
            profileSelection={profileSelection}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The single-tab detail pane: the synthetic Traycer block, or a host-RPC
 * provider block. Split out so `RateLimitPopoverBody` picks Overview-vs-detail
 * with one ternary instead of a nested one.
 */
function RateLimitDetailPane({
  tab,
  providers,
  profileSelection,
}: {
  readonly tab: Exclude<RateLimitPopoverTab, "overview">;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  return tab === "traycer" ? (
    <TraycerRateLimitBlock variant="popover-detail" onReady={null} />
  ) : (
    <RateLimitProviderBlock
      providerId={tab}
      profiles={configuredProviderProfiles(providers, tab)}
      variant="popover-detail"
      onReady={null}
      profileSelection={profileSelection}
    />
  );
}

/**
 * The left rail: an Overview tab, one tab per connected provider, then a
 * "Refresh all" and a "Provider settings" icon pinned to the bottom - the same
 * structural shell as the composer model picker's `ProviderRail` (scrollable
 * `role="tablist"` as a `flex-1` sibling, action icons after it). The two
 * bottom icons are deliberately siblings of the tablist, not tabs inside it, so
 * only real tab elements live under `role="tablist"` for correct screen-reader
 * nav.
 */
function RateLimitRail({
  railTabs,
  providers,
  traycerRefreshTarget,
  activeTab,
  onSelect,
  onClose,
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly traycerRefreshTarget: TraycerRefreshTarget;
  readonly activeTab: RateLimitPopoverTab;
  readonly onSelect: (tab: RateLimitPopoverTab) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const openProviderSettings = (): void => {
    onClose();
    openSettings({ section: "providers", resetToGeneral: false });
  };
  return (
    <div className="flex min-h-0 flex-col items-center border-r bg-muted/20 p-1.5">
      <div
        role="tablist"
        aria-label="Usage limit providers"
        aria-orientation="vertical"
        className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto"
      >
        <RailTab
          label="Overview"
          selected={activeTab === "overview"}
          onSelect={() => onSelect("overview")}
          icon={<Gauge className="size-4" />}
        />
        <div aria-hidden className="my-0.5 h-px w-5 bg-border" />
        {railTabs.map((tab) =>
          tab.kind === "traycer" ? (
            <RailTab
              key="traycer"
              label={providerDisplayName("traycer")}
              selected={activeTab === "traycer"}
              onSelect={() => onSelect("traycer")}
              icon={
                <HarnessIcon harnessId={providerIdToGuiHarnessId("traycer")} />
              }
            />
          ) : (
            <RailTab
              key={tab.providerId}
              label={providerDisplayName(tab.providerId)}
              selected={activeTab === tab.providerId}
              onSelect={() => onSelect(tab.providerId)}
              icon={
                <HarnessIcon
                  harnessId={providerIdToGuiHarnessId(tab.providerId)}
                />
              }
            />
          ),
        )}
      </div>
      <RateLimitRefreshAllButton
        providers={providers}
        traycerRefreshTarget={traycerRefreshTarget}
      />
      <button
        type="button"
        aria-label="Provider settings"
        title="Provider settings"
        onClick={openProviderSettings}
        className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Settings className="size-4" />
      </button>
    </div>
  );
}

function RailTab({
  label,
  selected,
  onSelect,
  icon,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly icon: ReactNode;
}): ReactNode {
  return (
    <TooltipWrapper label={label} side="right" sideOffset={6} align={undefined}>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={label}
        title={label}
        onClick={onSelect}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
          selected && "bg-accent text-foreground",
        )}
      >
        {icon}
      </button>
    </TooltipWrapper>
  );
}

/**
 * The Overview tab: every rail entry's *condensed* block
 * (`variant="popover-overview"`), in rail order, each separated by a divider.
 * For host-RPC providers that's their 5h/Weekly windows plus credit/balance
 * figures; for the Traycer entry it's the tier badge + credit/rate-limit
 * breakdown. Per-model breakdowns, spend controls, badges, plan labels, and the
 * Traycer account picker are single-provider-tab detail, not shown here. The
 * "Refresh all" and settings controls live on the rail (shared across every
 * tab), so this pane is pure content - no header row, and dividers only
 * *between* consecutive blocks. Not capped at 3 (unlike the header glyph) -
 * it's a scroll, not a summary.
 *
 * Every tab's block stays mounted the whole time (so its query keeps running
 * regardless of what's visible), but a tab that hasn't reported readiness yet
 * (`onReady`, fired once its own state moves past `cold`) is hidden rather
 * than painted as its own blank/loading section - it's revealed in place once
 * its data arrives, so the list grows one provider at a time instead of every
 * slot appearing empty up front. While nothing has reported ready yet, a
 * single centered "Fetching usage limits" indicator stands in for the whole
 * list (feedback: "just a modal centered fetching usage limits instead of
 * empty provider sections").
 */
function RateLimitOverview({
  railTabs,
  providers,
  profileSelection,
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  const [readyKeys, setReadyKeys] = useState<ReadonlySet<string>>(new Set());
  const markReady = useCallback((key: string) => {
    setReadyKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const anyReady = readyKeys.size > 0;
  const readyOrder = railTabs
    .filter((tab) => readyKeys.has(railTabProviderId(tab)))
    .map(railTabProviderId);

  return (
    <div className="flex min-h-full flex-col gap-4">
      {!anyReady ? <RateLimitOverviewLoading /> : null}
      {railTabs.map((tab) => {
        const key = railTabProviderId(tab);
        const isReady = readyKeys.has(key);
        const showDivider = isReady && readyOrder.indexOf(key) > 0;
        const onReady = () => markReady(key);
        return (
          <div
            key={key}
            className={cn("flex flex-col gap-4", !isReady && "hidden")}
          >
            {showDivider ? (
              <div aria-hidden className="h-px bg-border/70" />
            ) : null}
            {tab.kind === "traycer" ? (
              <TraycerRateLimitBlock
                variant="popover-overview"
                onReady={onReady}
              />
            ) : (
              <RateLimitProviderBlock
                providerId={tab.providerId}
                profiles={configuredProviderProfiles(providers, tab.providerId)}
                variant="popover-overview"
                onReady={onReady}
                profileSelection={profileSelection}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Overview's combined "nothing has arrived yet" state - a single centered
 * indicator standing in for every provider's still-blank section, rather than
 * painting N blank/loading sections at once. `flex-1` on a `min-h-full`
 * column centers it within the popover's full pane height rather than
 * collapsing to the height of the (hidden, zero-height) sibling blocks.
 */
function RateLimitOverviewLoading(): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 py-10 text-ui-sm text-muted-foreground">
      <MutedAgentSpinner />
      Fetching usage limits
    </div>
  );
}

interface TraycerRefreshTarget {
  readonly enabled: boolean;
  readonly rateLimitAccountContexts: ReadonlyArray<AccountContext>;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

function useTraycerRateLimitUsageState(
  accountContexts: ReadonlyArray<AccountContext>,
): {
  readonly isFetching: boolean;
  readonly updatedAtByAccount: ReadonlyMap<string, number>;
} {
  const client = useHostClient();
  const queries = useHostQueries<HostRpcRegistry, "host.getRateLimitUsage">({
    client,
    requests: accountContexts.map((accountContext) => ({
      method: "host.getRateLimitUsage",
      params: { accountContext, profileId: null },
    })),
    cacheKeyIdentity: undefined,
    // Observe the exact shared query states without initiating a second fetch;
    // each rendered RateLimitView remains the enabled owner of its account pull.
    options: { enabled: false },
  });
  return {
    isFetching: queries.some((query) => query.isFetching),
    updatedAtByAccount: new Map(
      accountContexts.map((accountContext, index) => [
        accountContextValue(accountContext),
        queries[index]?.dataUpdatedAt ?? 0,
      ]),
    ),
  };
}

/**
 * The rail's icon-only "Refresh all" (Core Flows): ephemeralProcess providers
 * refresh as one queued batch whose profile pulls run concurrently
 * (`force: true`), while httpFetch providers refresh concurrently alongside via
 * a direct query invalidation - a plain GET has no subprocess cost to serialize.
 * The synthetic Traycer entry refreshes here too: it refetches the AuthService
 * subscription query, and rate-limit based plans additionally invalidate the
 * unscoped aperture `host.getRateLimitUsage` query that backs the live artifact
 * bar.
 * `refreshing` combines all lanes' real query state - the queue's draining flag
 * for ephemeralProcess (which stays true until every profile in the batch has
 * settled, even after one provider's own `isFetching` clears), each configured
 * httpFetch provider's own
 * `isFetching` (read via `useHostQueries` against the exact same query keys the
 * invalidation below targets), plus Traycer's auth/aperture fetch state - so
 * the icon spins for the whole round regardless of which lane(s) are actually
 * configured, not just when an ephemeralProcess provider happens to be in the
 * mix.
 */
function RateLimitRefreshAllButton({
  providers,
  traycerRefreshTarget,
}: {
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly traycerRefreshTarget: TraycerRefreshTarget;
}): ReactNode {
  const draining = useIsRateLimitQueueDraining();
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const traycerRateLimitUsageState = useTraycerRateLimitUsageState(
    traycerRefreshTarget.rateLimitAccountContexts,
  );
  const httpFetchProviders = providers.filter(
    (provider) => provider.lane === "httpFetch",
  );
  const httpFetchRequests = httpFetchProviders.flatMap((provider) =>
    refreshTargetsForProvider(provider).map((profileId) => ({
      providerId: provider.providerId,
      profileId,
    })),
  );
  const ephemeralProcessRequests = providers
    .filter((provider) => provider.lane === "ephemeralProcess")
    .flatMap((provider) =>
      refreshTargetsForProvider(provider).map((profileId) => ({
        providerId: provider.providerId,
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId,
      })),
    );
  // Every httpFetch provider resolves to the exact same lane options (the
  // `isHttpFetch` branch in `providerRateLimitQueryOptions` doesn't vary by
  // provider id) - reusing the first one's is safe without the "verify every
  // request shares one lane" check `useHeaderRateLimitBars` needs (that hook's
  // provider list isn't pre-filtered to a single lane the way `httpFetchProviders`
  // is here). Passing this through (rather than `null`) matters:
  // `RateLimitProviderBlock`'s own query for these same providers sets
  // `retry: false`, and TanStack keys retry/staleTime/refetchOnMount per query
  // key - an unset `options` here would silently inherit the global
  // QueryClient's defaults (one retry) for this same key instead.
  const httpFetchOptions =
    httpFetchProviders.length === 0
      ? null
      : providerRateLimitQueryOptions(httpFetchProviders[0].providerId, null)
          .options;
  const httpFetchQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: httpFetchRequests.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        target.providerId,
        target.profileId,
      );
      return { method, params };
    }),
    options: httpFetchOptions,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const traycerRefreshing =
    traycerRefreshTarget.enabled &&
    (traycerRefreshTarget.isFetching || traycerRateLimitUsageState.isFetching);
  const refreshing =
    draining ||
    httpFetchQueries.some((query) => query.isFetching) ||
    traycerRefreshing;

  // Fire-and-forget, not awaited: httpFetch providers refresh concurrently via a
  // direct invalidation, ephemeralProcess profiles fan out inside one queued
  // batch, and Traycer refetches its subscription/usage queries. Returns
  // an already-resolved promise so `RefreshIconButton` gets its
  // `() => Promise<void>` contract without gating the spinner on the fetches
  // themselves - `refreshing` (above) owns that.
  const refreshAll = (): Promise<void> => {
    httpFetchRequests.forEach(({ providerId, profileId }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId,
          profileId,
        }),
      });
    });
    void enqueueRateLimitFetchBatch(ephemeralProcessRequests, { force: true });
    if (traycerRefreshTarget.enabled) {
      void traycerRefreshTarget.refetch();
      traycerRefreshTarget.rateLimitAccountContexts.forEach(
        (accountContext) => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.hostTraycerRateLimitUsage(
              hostId,
              accountContext,
            ),
            exact: true,
          });
        },
      );
    }
    return Promise.resolve();
  };

  return (
    <RefreshIconButton
      onRefresh={refreshAll}
      label="Refresh all"
      refreshing={refreshing}
      className="mt-1"
    />
  );
}

/**
 * The two popover surfaces a provider's block renders on: the single-provider
 * tab (full detail) and the Overview tab (condensed). Both draw windows the
 * same way; they differ only in how much detail is shown.
 */
type PopoverBlockVariant = "popover-detail" | "popover-overview";

/**
 * One provider's block. Providers with profile metadata always render the
 * same profile-card layout, whether they have one profile or many; older hosts
 * that do not report profiles fall back to the provider-wide reading. Shared by the
 * single-provider tab (`variant="popover-detail"`, full detail) and each
 * Overview entry (`variant="popover-overview"`, condensed). The plan/tier
 * chip (`resolveProviderPlanLabel`) is single-provider-tab only, same scoping
 * Overview already applies to every other detail field; the rest of the
 * header renders identically across both variants.
 *
 * `onReady` fires once (and again on every later state change, harmlessly -
 * the callback is expected to be idempotent) `state.kind` moves past `cold`,
 * so `RateLimitOverview` can reveal this block in place instead of painting
 * it as a blank/loading section from mount. `null` on the single-provider
 * detail tab, which always renders regardless of state.
 */
function RateLimitProviderBlock({
  providerId,
  profiles,
  variant,
  onReady,
  profileSelection,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  if (profiles.length > 0) {
    return (
      <ProfileRateLimitProviderBlock
        providerId={providerId}
        profiles={profiles}
        variant={variant}
        onReady={onReady}
        profileSelection={profileSelection}
      />
    );
  }

  return (
    <SingleProfileRateLimitProviderBlock
      providerId={providerId}
      variant={variant}
      onReady={onReady}
    />
  );
}

function SingleProfileRateLimitProviderBlock({
  providerId,
  variant,
  onReady,
}: {
  readonly providerId: RateLimitProviderId;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId, null);
  // Single source of truth for this provider's refresh action + spinner state
  // (fresh-on-open, queue routing, and the ephemeralProcess `draining` fold-in),
  // shared verbatim with the Settings card so they can't drift apart.
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId: null,
    usageUpdatedAt: null,
    isFetching: query.isFetching,
    refetch: query.refetch,
  });
  const queryState: ProviderRateLimitQueryState = {
    isPending: query.isPending,
    isFetching: isRefreshing,
    isError: query.isError,
    envelope: query.data,
  };
  const state = resolvePopoverProviderRateLimitState(queryState);
  const updatedAt =
    state.kind === "ready"
      ? (query.data?.lastGoodAt ?? query.dataUpdatedAt)
      : query.dataUpdatedAt;
  useEffect(() => {
    if (state.kind !== "cold" && onReady !== null) onReady();
  }, [state.kind, onReady]);

  // Chip next to the name, single-provider tab only (Overview stays
  // condensed - same scoping the plan/tier line used before it moved into
  // this header). `null` for a provider that doesn't report a plan/tier
  // (`resolveProviderPlanLabel`), so no chip renders for e.g. OpenRouter.
  const planLabel =
    variant === "popover-detail" && state.kind === "ready"
      ? resolveProviderPlanLabel(state.data)
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Overview stacks every provider's block in one scrollable list with
              no rail-tab context alongside it, so the name alone doesn't say
              which provider this is; the single-provider detail tab already has
              that context from its selected rail icon. */}
          {variant === "popover-overview" ? (
            <HarnessIcon harnessId={providerIdToGuiHarnessId(providerId)} />
          ) : null}
          <span className="text-ui-sm font-medium text-foreground">
            {providerDisplayName(providerId)}
          </span>
          {planLabel !== null ? (
            <Badge variant="secondary" className="font-normal">
              {planLabel}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <UsageLimitUpdatedLabel
            ready={state.kind === "ready"}
            updatedAt={updatedAt}
            refreshing={isRefreshing}
            degraded={state.kind === "ready" && state.degraded}
            degradedReason={
              state.kind === "ready" ? state.degradedReason : null
            }
          />
          {/* Overview has its own "Refresh all" on the rail (item 2 feedback:
              a per-provider icon there was redundant); only the single-provider
              detail tab keeps this one. */}
          {variant === "popover-detail" ? (
            <RefreshIconButton
              onRefresh={refresh}
              label={`Refresh ${providerDisplayName(providerId)}`}
              // `isRefreshing` (from useProviderRateLimitRefresh) already folds
              // in the ephemeralProcess `draining` flag, so this button stays
              // disabled for a "Refresh all" round's full duration, not just
              // this provider's own fetch.
              refreshing={isRefreshing}
            />
          ) : null}
        </div>
      </div>
      <RateLimitProviderBody state={state} variant={variant} profileId={null} />
    </div>
  );
}

function ProfileRateLimitProviderBlock({
  providerId,
  profiles,
  variant,
  onReady,
  profileSelection,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  const draining = useIsRateLimitQueueDraining();
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const activeProfileId = resolveRateLimitProfileId(
    profileSelection,
    providerId,
    profiles,
  );
  const rows = profiles.filter(profileLoggedInForUsage);
  const targets = rows.map((profile) => ({
    profile,
    profileId: rateLimitProfileId(profile),
  }));
  const queryOptions = providerRateLimitQueryOptions(providerId, null).options;
  const queries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    requests: targets.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        providerId,
        target.profileId,
      );
      return { method, params };
    }),
    cacheKeyIdentity: undefined,
    options: queryOptions,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const lane = rateLimitFetchLane(providerId);
  const isRefreshing =
    lane === "ephemeralProcess"
      ? draining
      : queries.some((query) => query.isFetching);

  const refresh = (): Promise<void> => {
    if (lane === "ephemeralProcess") {
      targets.forEach((target) => {
        void enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
          force: true,
          profileId: target.profileId,
        });
      });
      return Promise.resolve();
    }
    targets.forEach((target) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId,
          profileId: target.profileId,
        }),
        exact: true,
      });
    });
    return Promise.resolve();
  };

  useEffect(() => {
    if (onReady !== null) onReady();
  }, [onReady]);

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <ProviderGroupHeader
          providerId={providerId}
          variant={variant}
          refresh={refresh}
          isRefreshing={isRefreshing}
        />
        <RateLimitErrorMessage
          message="No logged-in profiles."
          reportContext={null}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ProviderGroupHeader
        providerId={providerId}
        variant={variant}
        refresh={refresh}
        isRefreshing={isRefreshing}
      />
      <div className="flex flex-col gap-2">
        {targets.map((target, index) => {
          return (
            <RateLimitProviderProfileRow
              key={target.profile.profileId}
              providerId={providerId}
              profile={target.profile}
              profileId={target.profileId}
              active={activeProfileId === target.profileId}
              variant={variant}
              query={queries[index]}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProviderGroupHeader({
  providerId,
  variant,
  refresh,
  isRefreshing,
}: {
  readonly providerId: RateLimitProviderId;
  readonly variant: PopoverBlockVariant;
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {variant === "popover-overview" ? (
          <HarnessIcon harnessId={providerIdToGuiHarnessId(providerId)} />
        ) : null}
        <span className="text-ui-sm font-medium text-foreground">
          {providerDisplayName(providerId)}
        </span>
      </div>
      {variant === "popover-detail" ? (
        <RefreshIconButton
          onRefresh={refresh}
          label={`Refresh ${providerDisplayName(providerId)}`}
          refreshing={isRefreshing}
        />
      ) : null}
    </div>
  );
}

function RateLimitProviderProfileRow({
  providerId,
  profile,
  profileId,
  active,
  variant,
  query,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profile: ProviderProfile;
  readonly profileId: string | null;
  readonly active: boolean;
  readonly variant: PopoverBlockVariant;
  readonly query: {
    readonly isPending: boolean;
    readonly isFetching: boolean;
    readonly isError: boolean;
    readonly data: ProviderRateLimitEnvelope | undefined;
  };
}): ReactNode {
  useRefreshProviderRateLimitsOnMount(
    providerId,
    profileId,
    profile.usageUpdatedAt,
  );
  const queryState: ProviderRateLimitQueryState = {
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    envelope: query.data,
  };
  const state = resolvePopoverProviderRateLimitState(queryState);
  const dataPlanLabel =
    state.kind === "ready" ? resolveProviderPlanLabel(state.data) : null;
  const profilePlanLabel =
    profile.identity?.tier !== null && profile.identity?.tier !== undefined
      ? profile.identity.tier
      : null;
  const planLabel =
    profilePlanLabel !== null && profilePlanLabel.length > 0
      ? profilePlanLabel
      : dataPlanLabel;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-2",
        active && "border-primary/60 bg-primary/5",
      )}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <AccentDot
              profileId={profile.profileId}
              accentColor={profile.accentColor}
              label={null}
              variant="inline"
              size="default"
              className={undefined}
            />
            <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
              {profileDisplayLabel(profile)}
            </span>
            {planLabel !== null ? (
              <Badge variant="secondary" className="font-normal">
                {planLabel}
              </Badge>
            ) : null}
            {active ? (
              <Badge variant="outline" className="font-normal">
                Active
              </Badge>
            ) : null}
          </div>
          <ProfileUsageUpdatedLabel
            updatedAt={profile.usageUpdatedAt}
            refreshing={query.isFetching}
          />
        </div>
      </div>
      <RateLimitProviderBody
        state={state}
        variant={variant}
        profileId={profileId}
      />
    </div>
  );
}

function ProfileUsageUpdatedLabel({
  updatedAt,
  refreshing,
}: {
  readonly updatedAt: number | null;
  readonly refreshing: boolean;
}): ReactNode {
  const now = useSampledNow();
  const ago = useRelativeTimestamp(updatedAt ?? 0);
  if (refreshing) return <RefreshingText />;
  if (updatedAt === null) {
    return <span className="text-ui-xs text-muted-foreground">stale</span>;
  }
  if (now - updatedAt >= PROVIDER_RATE_LIMITS_STALE_TIME_MS) {
    return <span className="text-ui-xs text-muted-foreground">stale</span>;
  }
  return <span className="text-ui-xs text-muted-foreground">{ago}</span>;
}

/**
 * "Updated Xm ago", only once a reading actually exists - and a trailing
 * degraded note appended when a last-known-good reading is being shown after
 * a failed poll (Core Flows degraded state): the specific transient reason's
 * plain-language copy (e.g. "couldn't fetch usage - will retry") when the
 * envelope itself is why (`degradedReason` non-null), or the generic
 * "· refresh failed" when the degrade is only a thrown query-level exception
 * with no specific reason to report.
 */
function UsageLimitUpdatedLabel({
  ready,
  updatedAt,
  refreshing,
  degraded,
  degradedReason,
}: {
  readonly ready: boolean;
  readonly updatedAt: number;
  readonly refreshing: boolean;
  readonly degraded: boolean;
  readonly degradedReason: RateLimitUnavailableReason | null;
}): ReactNode {
  if (!ready) return null;
  if (refreshing) return <RefreshingText />;
  if (updatedAt === 0) return null;
  return (
    <UpdatedAgoText
      updatedAt={updatedAt}
      degraded={degraded}
      degradedReason={degradedReason}
    />
  );
}

function RefreshingText(): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1 text-ui-xs text-muted-foreground">
      <span className="working-text-shimmer text-ui-xs">Refreshing</span>
      <RefreshingWorkingDots />
    </span>
  );
}

function RefreshingWorkingDots(): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="working-dots text-current"
      data-testid="usage-limit-refreshing-dots"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

function UpdatedAgoText({
  updatedAt,
  degraded,
  degradedReason,
}: {
  readonly updatedAt: number;
  readonly degraded: boolean;
  readonly degradedReason: RateLimitUnavailableReason | null;
}): ReactNode {
  const ago = useRelativeTimestamp(updatedAt);
  if (!degraded) {
    return (
      <span className="text-ui-xs text-muted-foreground">Updated {ago}</span>
    );
  }
  const note =
    degradedReason !== null
      ? formatUnavailableReason(degradedReason)
      : "refresh failed";
  return (
    <span className="text-ui-xs text-muted-foreground">
      {`Updated ${ago} · ${note}`}
    </span>
  );
}

function RateLimitProviderBody({
  state,
  variant,
  profileId,
}: {
  readonly state: PopoverProviderRateLimitState;
  readonly variant: PopoverBlockVariant;
  readonly profileId: string | null;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage
          message="Couldn't load usage limits right now."
          reportContext={createReportIssueContext({
            title: "Couldn't load usage limits",
            message: null,
            code: null,
            source: "Usage limits",
          })}
        />
      );
    case "unavailable":
      return (
        <RateLimitErrorMessage
          message={`Usage limits unavailable - ${formatUnavailableReason(state.reason)}`}
          reportContext={createReportIssueContext({
            title: "Usage limits unavailable",
            message: null,
            code: null,
            source: "Usage limits",
          })}
        />
      );
    case "ready":
      // Degraded (stale, latest poll failed): dim the reading in place rather
      // than replacing it with an error (Core Flows).
      return (
        <div className={cn(state.degraded && "opacity-60")}>
          <ProviderRateLimitDetail
            data={state.data}
            variant={variant}
            codexResetAction={resolveCodexResetCreditAction(
              state.data.provider,
              profileId,
              variant === "popover-detail",
            )}
          />
        </div>
      );
  }
}

/**
 * The synthetic "Traycer" block - the GUI-sourced analogue of
 * `RateLimitProviderBlock`. Its data is the signed-in user's subscription
 * (`useAuthUser`) for the globally-selected account (`useAccountContextStore`),
 * NOT a `host.getRateLimitUsage` provider pull. Header mirrors the provider
 * blocks (name + plan/tier chip + "Updated Xm ago" + refresh) - the chip
 * (`subscriptionPlanLabel`) reflects whichever account is currently selected
 * and is shown on each account card in the single-provider tab. The detail
 * variant and Overview both render Personal/Team cards like the Codex and
 * Claude profile cards; selecting a card updates the global account selection
 * (and therefore Overview, the Settings card, and what a Traycer run bills).
 * Both variants render through the shared `TraycerSubscriptionView`. `onReady` mirrors
 * `RateLimitProviderBlock`'s own - fires once `state.kind` moves past `cold`,
 * `null` on the single-provider detail tab.
 */
function TraycerRateLimitBlock({
  variant,
  onReady,
}: {
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
}): ReactNode {
  const traycerSubscription = useTraycerSubscription();
  const setAccountContext = useAccountContextStore((s) => s.setAccountContext);
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();
  const state = resolveTraycerSubscriptionState({
    isPending: traycerSubscription.query.isPending,
    isError: traycerSubscription.query.isError,
    subscription: traycerSubscription.subscription,
  });
  useEffect(() => {
    if (state.kind !== "cold" && onReady !== null) onReady();
  }, [state.kind, onReady]);

  const overview = variant === "popover-overview";
  const rateLimitUsageState = useTraycerRateLimitUsageState(
    traycerSubscription.rateLimitAccountContexts,
  );
  const isRefreshing =
    traycerSubscription.query.isFetching || rateLimitUsageState.isFetching;
  // Refetch the subscription and every rendered rate-limit account. Exact
  // invalidation targets only aperture `{ accountContext }` keys, never provider
  // `{ accountContext, providerId }` pulls.
  const refresh = async (): Promise<void> => {
    const result = await traycerSubscription.query.refetch();
    traycerSubscription.rateLimitAccountContexts.forEach((accountContext) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostTraycerRateLimitUsage(hostId, accountContext),
        exact: true,
      });
    });
    // Observational only: the UI awaits exactly what it always did (the
    // primary refetch; invalidations stay fire-and-forget background work).
    if (result.status === "success") {
      Analytics.getInstance().track(AnalyticsEvent.SubscriptionRefreshed, {
        source: "direct_ui",
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {overview ? (
            <HarnessIcon harnessId={providerIdToGuiHarnessId("traycer")} />
          ) : null}
          <span className="text-ui-sm font-medium text-foreground">
            {providerDisplayName("traycer")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Overview has its own "Refresh all" on the rail (item 2 feedback);
              only the single-provider detail tab keeps this one. */}
          {!overview ? (
            <RefreshIconButton
              onRefresh={refresh}
              label={`Refresh ${providerDisplayName("traycer")}`}
              refreshing={isRefreshing}
            />
          ) : null}
        </div>
      </div>
      <TraycerAccountCards
        state={state}
        teams={traycerSubscription.teams}
        personalSubscription={traycerSubscription.personalSubscription}
        activeAccountContext={traycerSubscription.resolvedAccountContext}
        updatedAt={traycerSubscription.query.dataUpdatedAt}
        rateLimitUpdatedAtByAccount={rateLimitUsageState.updatedAtByAccount}
        refreshing={isRefreshing}
        onSelect={setAccountContext}
      />
    </div>
  );
}

function TraycerAccountCards({
  state,
  teams,
  personalSubscription,
  activeAccountContext,
  updatedAt,
  rateLimitUpdatedAtByAccount,
  refreshing,
  onSelect,
}: {
  readonly state: TraycerSubscriptionState;
  readonly teams: readonly TraycerTeamSubscription[];
  readonly personalSubscription: TraycerSubscription | null;
  readonly activeAccountContext: AccountContext;
  readonly updatedAt: number;
  readonly rateLimitUpdatedAtByAccount: ReadonlyMap<string, number>;
  readonly refreshing: boolean;
  readonly onSelect: (accountContext: AccountContext) => void;
}): ReactNode {
  if (state.kind !== "ready") {
    return (
      <TraycerRateLimitBody
        state={state}
        accountContext={activeAccountContext}
      />
    );
  }

  const accounts = [
    {
      key: accountContextValue(PERSONAL_ACCOUNT_CONTEXT),
      label: "Personal",
      accountContext: PERSONAL_ACCOUNT_CONTEXT,
      subscription: personalSubscription,
    },
    ...teams.map((team) => ({
      key: accountContextValue({ type: "TEAM", teamId: team.team.id }),
      label: team.team.slug,
      accountContext: { type: "TEAM" as const, teamId: team.team.id },
      subscription: team,
    })),
  ];
  return (
    <div className="flex flex-col gap-2">
      {accounts.map((account) => {
        if (account.subscription === null) return null;
        const active =
          accountContextValue(activeAccountContext) === account.key;
        return (
          <button
            key={account.key}
            type="button"
            onClick={() => onSelect(account.accountContext)}
            aria-current={active ? "true" : undefined}
            aria-label={`Use ${account.label} account`}
            className={cn(
              "flex w-full flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-2 text-left transition-colors hover:border-border hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              active && "border-primary/60 bg-primary/5",
            )}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <AccentDot
                  profileId={account.key}
                  accentColor={null}
                  label={null}
                  variant="inline"
                  size="default"
                  className={undefined}
                />
                <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
                  {account.label}
                </span>
                <Badge variant="secondary" className="font-normal">
                  {subscriptionPlanLabel(
                    account.subscription.subscriptionStatus,
                  )}
                </Badge>
                {active ? (
                  <Badge variant="outline" className="font-normal">
                    Active
                  </Badge>
                ) : null}
              </div>
              <ProfileUsageUpdatedLabel
                updatedAt={
                  rateLimitUpdatedAtByAccount.get(account.key) ?? updatedAt
                }
                refreshing={refreshing}
              />
            </div>
            <TraycerSubscriptionView
              subscription={account.subscription}
              accountContext={account.accountContext}
            />
          </button>
        );
      })}
    </div>
  );
}

function TraycerRateLimitBody({
  state,
  accountContext,
}: {
  readonly state: TraycerSubscriptionState;
  readonly accountContext: AccountContext;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage
          message="Couldn't load your Traycer subscription right now."
          reportContext={createReportIssueContext({
            title: "Couldn't load your Traycer subscription",
            message: null,
            code: null,
            source: "Subscription",
          })}
        />
      );
    case "empty":
      return (
        <p className="text-ui-xs text-muted-foreground">
          No subscription found for this account.
        </p>
      );
    case "ready":
      return (
        <div className={cn(state.degraded && "opacity-60")}>
          <TraycerSubscriptionView
            subscription={state.subscription}
            accountContext={accountContext}
          />
        </div>
      );
  }
}

// No inline retry action here - the block's own header refresh icon (detail
// tab) or the rail's "Refresh all" (Overview) already covers it, so a second
// retry control right below the message would just be a redundant control
// for the same action.
function RateLimitErrorMessage({
  message,
  reportContext,
}: {
  readonly message: string;
  readonly reportContext: ReportIssueContext | null;
}): ReactNode {
  if (reportContext === null) {
    return <p className="text-ui-xs text-muted-foreground">{message}</p>;
  }
  return (
    <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
      <span>{message}</span>
      <ReportIssueAction
        context={reportContext}
        presentation="link"
        className="h-auto p-0 text-current"
      />
    </div>
  );
}

/**
 * Cold load (first open this session, no data yet): skeleton bars previewing
 * the eventual window layout, not a spinner replacing the panel (Core Flows -
 * a deliberate difference from the Settings card's spinner).
 *
 * Each block overrides `Skeleton`'s default `bg-muted` fill with
 * `bg-foreground/15`, same reasoning as `MeterRow`'s track: several dark
 * theme presets set `--muted` equal to `--popover`, so a plain `bg-muted`
 * skeleton can end up the same color as the popover background and read as
 * an empty section instead of a loading one. An opacity overlay on
 * `--foreground` contrasts against any background without needing a border.
 */
function RateLimitDetailSkeleton(): ReactNode {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="rate-limit-detail-skeleton"
    >
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-16 bg-foreground/15" />
            <Skeleton className="h-3 w-10 bg-foreground/15" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full bg-foreground/15" />
        </div>
      ))}
    </div>
  );
}

/**
 * Zero-provider state (Core Flows): no rail, no tabs - a single CTA linking to
 * Settings › Providers, since there's nothing yet to switch between.
 */
function RateLimitZeroState({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const openProviderSettings = (): void => {
    onClose();
    openSettings({ section: "providers", resetToGeneral: false });
  };
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <p className="text-ui-sm text-muted-foreground">
        Connect Claude Code or Codex to see usage here.
      </p>
      <button
        type="button"
        onClick={openProviderSettings}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-ui-xs font-medium text-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Open provider settings
      </button>
    </div>
  );
}
