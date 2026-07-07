import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
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
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  ProviderRateLimitDetail,
  type ProviderRateLimitQueryState,
} from "@/components/settings/panels/provider-rate-limit-views";
import { useHostProviderRateLimitsQuery } from "@/hooks/host/use-host-provider-rate-limits-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useConfiguredRateLimitProviders,
  type ConfiguredRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";
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
import { type RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import {
  resolveAccountContext,
  useAccountContextStore,
} from "@/stores/auth/account-context-store";
import {
  accountContextValue,
  isCreditBasedPricing,
  isTraycerEligible,
  parseAccountContextValue,
  resolveTraycerSubscriptionState,
  selectSubscription,
  subscriptionPlanLabel,
  type TraycerSubscriptionState,
} from "@/lib/auth/traycer-subscription-content";
import {
  TraycerAccountSelect,
  TraycerSubscriptionView,
} from "@/components/settings/panels/traycer-subscription-views";
import { cn } from "@/lib/utils";

/**
 * The Overview tab (always pinned first), one tab per connected host-RPC
 * provider, and - when the account is eligible - the GUI-sourced "traycer" tab.
 * `"traycer"` is a synthetic entry: it is NOT a `RateLimitProviderId` and does
 * not flow through `useConfiguredRateLimitProviders()`.
 */
type RateLimitTab = "overview" | RateLimitProviderId | "traycer";

/**
 * A rail/Overview entry, in draw order: either a host-RPC provider or the
 * synthetic Traycer entry. `railTabProviderId` maps each to a `ProviderId` so a
 * single `sortProviderStatesByProviderOrder` positions Traycer at its
 * `PROVIDER_ID_ORDER` slot among the providers.
 */
type RailTabDescriptor =
  | { readonly kind: "provider"; readonly providerId: RateLimitProviderId }
  | { readonly kind: "traycer" };

function railTabProviderId(tab: RailTabDescriptor): ProviderId {
  return tab.kind === "traycer" ? "traycer" : tab.providerId;
}

function traycerRateLimitUsageQueryKey(
  hostId: string | null,
  accountContext: AccountContext,
) {
  return queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
    hostId,
    "host.getRateLimitUsage",
    { accountContext },
  );
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
  const subscription = selectSubscription(user, resolvedAccountContext, teams);
  const eligible = subscription !== null && isTraycerEligible(subscription);
  const rateLimitBased =
    subscription !== null &&
    !isCreditBasedPricing(subscription.subscriptionStatus);
  return {
    query,
    storedAccountContext,
    resolvedAccountContext,
    teams,
    subscription,
    eligible,
    rateLimitBased,
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

/**
 * The header rate-limit popover content: a left rail (Overview + one tab per
 * connected provider) and a detail pane, mirroring the composer's model-picker
 * shell (Core Flows: "same interaction family as the composer's model picker").
 * The whole body is a child of `PopoverContent`, so Radix only mounts it - and
 * runs its queries and tab state - while the popover is open; `activeTab`
 * therefore resets to Overview on every open (Core Flows: "Landing tab is
 * always Overview").
 */
export function RateLimitPopover({
  onClose,
}: {
  readonly onClose: () => void;
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
    >
      <RateLimitPopoverBody onClose={onClose} />
    </PopoverContent>
  );
}

function RateLimitPopoverBody({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const configured = useConfiguredRateLimitProviders();
  // Rail order matches the app's standard provider order everywhere else.
  const providers = useMemo(
    () => sortProviderStatesByProviderOrder(configured),
    [configured],
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
  const [activeTab, setActiveTab] = useState<RateLimitTab>("overview");

  // Zero-state only when there is genuinely nothing to show: no host-RPC
  // providers AND no eligible Traycer tab.
  if (providers.length === 0 && !traycerSubscription.eligible) {
    return <RateLimitZeroState onClose={onClose} />;
  }

  // A credential removed (or Traycer becoming ineligible) mid-session can drop
  // the active tab from the rail; fall back to Overview rather than rendering a
  // tab that no longer exists.
  const validTabs = new Set<RateLimitTab>([
    "overview",
    ...railTabs.map((tab) =>
      tab.kind === "traycer" ? "traycer" : tab.providerId,
    ),
  ]);
  const resolvedTab: RateLimitTab = validTabs.has(activeTab)
    ? activeTab
    : "overview";

  // A *fixed* height (not `max-h`), plus an explicit `minmax(0,1fr)` grid row,
  // is what makes the popover a stable box across tabs and lets its panes
  // scroll: a `max-h` on a single-`auto`-row grid lets the row size to content,
  // so the detail pane grew unbounded (tall content clipped, no scrollbar) and
  // the whole popover resized per tab. `minmax(0,1fr)` pins the row to the
  // container height regardless of content, and both columns stretch into it
  // with their own `min-h-0` + `overflow-y-auto`, so each scrolls internally.
  return (
    <div className="grid h-[min(58vh,22rem)] grid-cols-[3rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden">
      <RateLimitRail
        railTabs={railTabs}
        providers={providers}
        traycerRefreshTarget={{
          enabled: traycerSubscription.eligible,
          accountContext: traycerSubscription.storedAccountContext,
          rateLimitBased: traycerSubscription.rateLimitBased,
          isFetching: traycerSubscription.query.isFetching,
          refetch: traycerSubscription.query.refetch,
        }}
        activeTab={resolvedTab}
        onSelect={setActiveTab}
        onClose={onClose}
      />
      <div className="min-h-0 min-w-0 overflow-y-auto p-3">
        {resolvedTab === "overview" ? (
          <RateLimitOverview railTabs={railTabs} />
        ) : (
          <RateLimitDetailPane tab={resolvedTab} />
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
}: {
  readonly tab: Exclude<RateLimitTab, "overview">;
}): ReactNode {
  return tab === "traycer" ? (
    <TraycerRateLimitBlock variant="popover-detail" onReady={null} />
  ) : (
    <RateLimitProviderBlock
      providerId={tab}
      variant="popover-detail"
      onReady={null}
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
  readonly activeTab: RateLimitTab;
  readonly onSelect: (tab: RateLimitTab) => void;
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
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
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
                variant="popover-overview"
                onReady={onReady}
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
  readonly accountContext: AccountContext;
  readonly rateLimitBased: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

/**
 * The rail's icon-only "Refresh all" (Core Flows): ephemeralProcess providers
 * refresh one at a time through the shared serial queue (`force: true`), while
 * httpFetch providers refresh concurrently alongside via a direct query
 * invalidation - a plain GET has no subprocess cost to serialize. The synthetic
 * Traycer entry refreshes here too: it refetches the AuthService subscription
 * query, and rate-limit based plans additionally invalidate the unscoped
 * aperture `host.getRateLimitUsage` query that backs the live artifact bar.
 * `refreshing` combines all lanes' real query state - the queue's draining flag
 * for ephemeralProcess (which stays true a beat longer than any single
 * provider's `isFetching`, covering the "still waiting behind an earlier
 * provider in the queue" gap), each configured httpFetch provider's own
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
  const traycerRateLimitUsageFetching =
    useIsFetching({
      queryKey: traycerRateLimitUsageQueryKey(
        hostId,
        traycerRefreshTarget.accountContext,
      ),
      exact: true,
    }) > 0;
  const httpFetchProviders = providers.filter(
    (provider) => provider.lane === "httpFetch",
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
      : providerRateLimitQueryOptions(httpFetchProviders[0].providerId).options;
  const httpFetchQueries = useHostQueries<
    HostRpcRegistry,
    "host.getRateLimitUsage"
  >({
    client,
    requests: httpFetchProviders.map((provider) => {
      const { method, params } = providerRateLimitQueryOptions(
        provider.providerId,
      );
      return { method, params };
    }),
    options: httpFetchOptions,
  });
  const traycerRefreshing =
    traycerRefreshTarget.enabled &&
    (traycerRefreshTarget.isFetching ||
      (traycerRefreshTarget.rateLimitBased && traycerRateLimitUsageFetching));
  const refreshing =
    draining ||
    httpFetchQueries.some((query) => query.isFetching) ||
    traycerRefreshing;

  // Fire-and-forget, not awaited: httpFetch providers refresh concurrently via a
  // direct invalidation, ephemeralProcess providers queue through the shared
  // serial lane, and Traycer refetches its subscription/usage queries. Returns
  // an already-resolved promise so `RefreshIconButton` gets its
  // `() => Promise<void>` contract without gating the spinner on the fetches
  // themselves - `refreshing` (above) owns that.
  const refreshAll = (): Promise<void> => {
    httpFetchProviders.forEach((provider) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId: provider.providerId,
        }),
      });
    });
    providers
      .filter((provider) => provider.lane === "ephemeralProcess")
      .forEach((provider) => {
        void enqueueRateLimitFetch(
          provider.providerId,
          DEFAULT_ACCOUNT_CONTEXT,
          { force: true },
        );
      });
    if (traycerRefreshTarget.enabled) {
      void traycerRefreshTarget.refetch();
      if (traycerRefreshTarget.rateLimitBased) {
        void queryClient.invalidateQueries({
          queryKey: traycerRateLimitUsageQueryKey(
            hostId,
            traycerRefreshTarget.accountContext,
          ),
          exact: true,
        });
      }
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
 * One provider's block - a header (name + plan/tier chip + "Updated Xm ago" +
 * per-provider refresh) over its state-driven body. Shared by the
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
  variant,
  onReady,
}: {
  readonly providerId: RateLimitProviderId;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId);
  // Single source of truth for this provider's refresh action + spinner state
  // (fresh-on-open, queue routing, and the ephemeralProcess `draining` fold-in),
  // shared verbatim with the Settings card so they can't drift apart.
  const { refresh, isRefreshing } = useProviderRateLimitRefresh(
    providerId,
    query.isFetching,
    query.refetch,
  );
  const queryState: ProviderRateLimitQueryState = {
    isPending: query.isPending,
    isFetching: isRefreshing,
    isError: query.isError,
    providerRateLimits: query.data?.providerRateLimits,
  };
  const state = resolvePopoverProviderRateLimitState(queryState);
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
            updatedAt={query.dataUpdatedAt}
            refreshing={isRefreshing}
            degraded={state.kind === "ready" && state.degraded}
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
              // this provider's own slice of it.
              refreshing={isRefreshing}
            />
          ) : null}
        </div>
      </div>
      <RateLimitProviderBody state={state} variant={variant} />
    </div>
  );
}

/**
 * "Updated Xm ago", only once a reading actually exists - and "· refresh
 * failed" appended when a last-known-good reading is being shown after a failed
 * poll (Core Flows degraded state).
 */
function UsageLimitUpdatedLabel({
  ready,
  updatedAt,
  refreshing,
  degraded,
}: {
  readonly ready: boolean;
  readonly updatedAt: number;
  readonly refreshing: boolean;
  readonly degraded: boolean;
}): ReactNode {
  if (!ready) return null;
  if (refreshing) return <RefreshingText />;
  if (updatedAt === 0) return null;
  return <UpdatedAgoText updatedAt={updatedAt} degraded={degraded} />;
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
}: {
  readonly updatedAt: number;
  readonly degraded: boolean;
}): ReactNode {
  const ago = useRelativeTimestamp(updatedAt);
  return (
    <span className="text-ui-xs text-muted-foreground">
      {degraded ? `Updated ${ago} · refresh failed` : `Updated ${ago}`}
    </span>
  );
}

function RateLimitProviderBody({
  state,
  variant,
}: {
  readonly state: PopoverProviderRateLimitState;
  readonly variant: PopoverBlockVariant;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage message="Couldn't load usage limits right now." />
      );
    case "unavailable":
      return (
        <RateLimitErrorMessage
          message={`Usage limits unavailable — ${formatUnavailableReason(state.reason)}`}
        />
      );
    case "ready":
      // Degraded (stale, latest poll failed): dim the reading in place rather
      // than replacing it with an error (Core Flows).
      return (
        <div className={cn(state.degraded && "opacity-60")}>
          <ProviderRateLimitDetail data={state.data} variant={variant} />
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
 * and is single-provider-tab only, same scoping
 * `RateLimitProviderBlock` applies to its own plan chip; the detail variant
 * adds the same Personal/Team picker the Settings card uses, so switching
 * accounts here updates the global selection (and therefore Overview, the
 * Settings card, and what a Traycer run bills). Both variants render through
 * the shared `TraycerSubscriptionView`. `onReady` mirrors
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
  const rateLimitUsageFetching =
    useIsFetching({
      queryKey: traycerRateLimitUsageQueryKey(
        hostId,
        traycerSubscription.storedAccountContext,
      ),
      exact: true,
    }) > 0;
  const isRefreshing =
    traycerSubscription.query.isFetching ||
    (traycerSubscription.rateLimitBased && rateLimitUsageFetching);
  // Chip next to the name, single-provider tab only - same scoping
  // `resolveProviderPlanLabel` uses for the host-RPC providers' plan chip.
  // Reflects whichever account (personal/team) is currently selected, since
  // `subscription` is already resolved against that selection.
  const planLabel =
    !overview && traycerSubscription.subscription !== null
      ? subscriptionPlanLabel(
          traycerSubscription.subscription.subscriptionStatus,
        )
      : null;

  // Refetch the subscription, and - only for rate-limit-based plans, whose
  // aperture bar is live host data - invalidate that exact query so the mounted
  // `RateLimitView` refetches it too. `exact: true` targets only the aperture
  // `{ accountContext }` key, never the providers' `{ accountContext, providerId }`
  // pulls (which a Traycer refresh can't have changed).
  const refresh = async (): Promise<void> => {
    await traycerSubscription.query.refetch();
    if (traycerSubscription.rateLimitBased) {
      void queryClient.invalidateQueries({
        queryKey: traycerRateLimitUsageQueryKey(
          hostId,
          traycerSubscription.storedAccountContext,
        ),
        exact: true,
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
          {planLabel !== null ? (
            <Badge variant="secondary" className="font-normal">
              {planLabel}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <UsageLimitUpdatedLabel
            ready={state.kind === "ready"}
            updatedAt={traycerSubscription.query.dataUpdatedAt}
            refreshing={isRefreshing}
            degraded={state.kind === "ready" && state.degraded}
          />
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
      {/* Detail tab only: the account picker, matching the Settings card. Renders
          nothing when the user has no teams. Overview just reflects the global
          selection with no controls, like every other Overview block. */}
      {!overview ? (
        <TraycerAccountSelect
          teams={traycerSubscription.teams}
          value={accountContextValue(
            traycerSubscription.resolvedAccountContext,
          )}
          onValueChange={(value) =>
            setAccountContext(parseAccountContextValue(value))
          }
        />
      ) : null}
      <TraycerRateLimitBody state={state} />
    </div>
  );
}

function TraycerRateLimitBody({
  state,
}: {
  readonly state: TraycerSubscriptionState;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage message="Couldn't load your Traycer subscription right now." />
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
          <TraycerSubscriptionView subscription={state.subscription} />
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
}: {
  readonly message: string;
}): ReactNode {
  return <p className="text-ui-xs text-muted-foreground">{message}</p>;
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
