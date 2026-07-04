import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Gauge, Settings } from "lucide-react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
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
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useConfiguredRateLimitProviders,
  type ConfiguredRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useIsRateLimitQueueDraining } from "@/hooks/rate-limits/use-is-rate-limit-queue-draining";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  formatUnavailableReason,
  resolvePopoverProviderRateLimitState,
  type PopoverProviderRateLimitState,
} from "@/lib/provider-rate-limit-content";
import type { HostRpcRegistry } from "@/lib/host";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import { queryKeys } from "@/lib/query-keys";
import {
  rateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
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
      aria-label="Rate limits"
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
  const authQuery = useAuthUser();
  const storedAccountContext = useAccountContextStore((s) => s.accountContext);
  const traycerEligible = useMemo(() => {
    const user = authQuery.data ?? null;
    const teams = user?.teamSubscriptions ?? [];
    const teamIds = new Set(teams.map((team) => team.team.id));
    const resolved = resolveAccountContext(storedAccountContext, teamIds);
    const subscription = selectSubscription(user, resolved, teams);
    return subscription !== null && isTraycerEligible(subscription);
  }, [authQuery.data, storedAccountContext]);

  const railTabs = useMemo(
    () => orderRailTabs(providers, traycerEligible),
    [providers, traycerEligible],
  );
  const [activeTab, setActiveTab] = useState<RateLimitTab>("overview");

  // Zero-state only when there is genuinely nothing to show: no host-RPC
  // providers AND no eligible Traycer tab.
  if (providers.length === 0 && !traycerEligible) {
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
    <TraycerRateLimitBlock variant="popover-detail" />
  ) : (
    <RateLimitProviderBlock providerId={tab} variant="popover-detail" />
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
  activeTab,
  onSelect,
  onClose,
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
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
        aria-label="Rate limit providers"
        aria-orientation="vertical"
        className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto"
      >
        <RailTab
          label="Overview"
          selected={activeTab === "overview"}
          onSelect={() => onSelect("overview")}
          icon={<Gauge className="size-4" />}
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          className="my-0.5 h-px w-5 bg-border"
        />
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
      <RateLimitRefreshAllButton providers={providers} />
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
 * *between* consecutive blocks (`index > 0`). Not capped at 3 (unlike the header
 * glyph) - it's a scroll, not a summary.
 */
function RateLimitOverview({
  railTabs,
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      {railTabs.map((tab, index) => (
        <div key={railTabProviderId(tab)} className="flex flex-col gap-4">
          {index > 0 ? <div aria-hidden className="h-px bg-border/70" /> : null}
          {tab.kind === "traycer" ? (
            <TraycerRateLimitBlock variant="popover-overview" />
          ) : (
            <RateLimitProviderBlock
              providerId={tab.providerId}
              variant="popover-overview"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The rail's icon-only "Refresh all" (Core Flows): ephemeralProcess providers
 * refresh one at a time through the shared serial queue (`force: true`), while
 * httpFetch providers refresh concurrently alongside via a direct query
 * invalidation - a plain GET has no subprocess cost to serialize. `refreshing`
 * is wired to the queue's draining state so the icon spins and the button stays
 * disabled until the round finishes, so it can't be re-triggered mid-round.
 */
function RateLimitRefreshAllButton({
  providers,
}: {
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
}): ReactNode {
  const draining = useIsRateLimitQueueDraining();
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();

  // Fire-and-forget, not awaited: httpFetch providers refresh concurrently via a
  // direct invalidation while ephemeralProcess providers queue through the
  // shared serial lane. Returns an already-resolved promise so `RefreshIconButton`
  // gets its `() => Promise<void>` contract without gating the spinner on the
  // fetches themselves - the queue's `draining` state (below) owns that.
  const refreshAll = (): Promise<void> => {
    providers
      .filter((provider) => provider.lane === "httpFetch")
      .forEach((provider) => {
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
    return Promise.resolve();
  };

  return (
    <RefreshIconButton
      onRefresh={refreshAll}
      label="Refresh all"
      refreshing={draining}
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
 * One provider's block - a header (name + "Updated Xm ago" + per-provider
 * refresh) over its state-driven body. Shared by the single-provider tab
 * (`variant="popover-detail"`, full detail) and each Overview entry
 * (`variant="popover-overview"`, condensed), so both render an identical header
 * over a variant-scoped body.
 */
function RateLimitProviderBlock({
  providerId,
  variant,
}: {
  readonly providerId: RateLimitProviderId;
  readonly variant: PopoverBlockVariant;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId);
  const lane = rateLimitFetchLane(providerId);
  const queryState: ProviderRateLimitQueryState = {
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    providerRateLimits: query.data?.providerRateLimits,
  };
  const state = resolvePopoverProviderRateLimitState(queryState);

  // ephemeralProcess: a manual refresh must go through the serial queue
  // (`force: true`) so it can't spawn a subprocess overlapping a scheduled tick.
  // httpFetch: refetch the query directly - no subprocess to bound.
  const refresh = async (): Promise<void> => {
    if (lane === "ephemeralProcess") {
      await enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
      });
      return;
    }
    await query.refetch();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">
          {providerDisplayName(providerId)}
        </span>
        <div className="flex items-center gap-1.5">
          <RateLimitUpdatedLabel
            state={state}
            updatedAt={query.dataUpdatedAt}
          />
          {/* Overview has its own "Refresh all" on the rail (item 2 feedback:
              a per-provider icon there was redundant); only the single-provider
              detail tab keeps this one. */}
          {variant === "popover-detail" ? (
            <RefreshIconButton
              onRefresh={refresh}
              label={`Refresh ${providerDisplayName(providerId)}`}
              refreshing={query.isFetching}
            />
          ) : null}
        </div>
      </div>
      <RateLimitProviderBody
        state={state}
        onRetry={refresh}
        variant={variant}
      />
    </div>
  );
}

/**
 * "Updated Xm ago", only once a reading actually exists - and "· refresh
 * failed" appended when a last-known-good reading is being shown after a failed
 * poll (Core Flows degraded state).
 */
function RateLimitUpdatedLabel({
  state,
  updatedAt,
}: {
  readonly state: PopoverProviderRateLimitState;
  readonly updatedAt: number;
}): ReactNode {
  if (state.kind !== "ready" || updatedAt === 0) return null;
  return <UpdatedAgoText updatedAt={updatedAt} degraded={state.degraded} />;
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
  onRetry,
  variant,
}: {
  readonly state: PopoverProviderRateLimitState;
  readonly onRetry: () => Promise<void>;
  readonly variant: PopoverBlockVariant;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage
          message="Couldn't load rate limits right now."
          onRetry={onRetry}
        />
      );
    case "unavailable":
      return (
        <RateLimitErrorMessage
          message={`Rate limits unavailable — ${formatUnavailableReason(state.reason)}`}
          onRetry={onRetry}
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
 * blocks (name + "Updated Xm ago" + refresh); the detail variant adds the same
 * Personal/Team picker the Settings card uses, so switching accounts here
 * updates the global selection (and therefore Overview, the Settings card, and
 * what a Traycer run bills). Both variants render through the shared
 * `TraycerSubscriptionView`.
 */
function TraycerRateLimitBlock({
  variant,
}: {
  readonly variant: PopoverBlockVariant;
}): ReactNode {
  const query = useAuthUser();
  const storedAccountContext = useAccountContextStore((s) => s.accountContext);
  const setAccountContext = useAccountContextStore((s) => s.setAccountContext);
  const queryClient = useQueryClient();
  const hostId = useReactiveActiveHostId();

  const user = query.data ?? null;
  const teams = user?.teamSubscriptions ?? [];
  const teamIds = new Set(teams.map((team) => team.team.id));
  const resolved = resolveAccountContext(storedAccountContext, teamIds);
  const subscription = selectSubscription(user, resolved, teams);
  const state = resolveTraycerSubscriptionState({
    isPending: query.isPending,
    isError: query.isError,
    subscription,
  });

  const overview = variant === "popover-overview";
  const rateLimitBased =
    subscription !== null &&
    !isCreditBasedPricing(subscription.subscriptionStatus);

  // Refetch the subscription, and - only for rate-limit-based plans, whose
  // aperture bar is live host data - invalidate that exact query so the mounted
  // `RateLimitView` refetches it too. `exact: true` targets only the aperture
  // `{ accountContext }` key, never the providers' `{ accountContext, providerId }`
  // pulls (which a Traycer refresh can't have changed).
  const refresh = async (): Promise<void> => {
    await query.refetch();
    if (rateLimitBased) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext: storedAccountContext,
        }),
        exact: true,
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">
          {providerDisplayName("traycer")}
        </span>
        <div className="flex items-center gap-1.5">
          {state.kind === "ready" && query.dataUpdatedAt !== 0 ? (
            <UpdatedAgoText
              updatedAt={query.dataUpdatedAt}
              degraded={state.degraded}
            />
          ) : null}
          {/* Overview has its own "Refresh all" on the rail (item 2 feedback);
              only the single-provider detail tab keeps this one. */}
          {!overview ? (
            <RefreshIconButton
              onRefresh={refresh}
              label={`Refresh ${providerDisplayName("traycer")}`}
              refreshing={query.isFetching}
            />
          ) : null}
        </div>
      </div>
      {/* Detail tab only: the account picker, matching the Settings card. Renders
          nothing when the user has no teams. Overview just reflects the global
          selection with no controls, like every other Overview block. */}
      {!overview ? (
        <TraycerAccountSelect
          teams={teams}
          value={accountContextValue(resolved)}
          onValueChange={(value) =>
            setAccountContext(parseAccountContextValue(value))
          }
        />
      ) : null}
      <TraycerRateLimitBody state={state} onRetry={refresh} />
    </div>
  );
}

function TraycerRateLimitBody({
  state,
  onRetry,
}: {
  readonly state: TraycerSubscriptionState;
  readonly onRetry: () => Promise<void>;
}): ReactNode {
  switch (state.kind) {
    case "cold":
      return <RateLimitDetailSkeleton />;
    case "error":
      return (
        <RateLimitErrorMessage
          message="Couldn't load your Traycer subscription right now."
          onRetry={onRetry}
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
          <TraycerSubscriptionView subscription={state.subscription} />
        </div>
      );
  }
}

function RateLimitErrorMessage({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => Promise<void>;
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-ui-xs text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => {
          void onRetry();
        }}
        className="rounded text-ui-xs font-medium text-primary outline-none transition-colors hover:text-primary/80 hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Retry
      </button>
    </div>
  );
}

/**
 * Cold load (first open this session, no data yet): skeleton bars previewing
 * the eventual window layout, not a spinner replacing the panel (Core Flows -
 * a deliberate difference from the Settings card's spinner).
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
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
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
