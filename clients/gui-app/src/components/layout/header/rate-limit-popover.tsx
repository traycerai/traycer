import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
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
import { OpenModelProvidersButton } from "@/components/settings/panels/opencode-go-actions";
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
import { enqueueRateLimitFetchBatchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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
  isRateLimitProfileFetchEligible,
  rateLimitFetchLane,
  type RateLimitFetchEligibility,
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
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { cn } from "@/lib/utils";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";

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
const NO_RATE_LIMIT_FETCH_ELIGIBILITY: RateLimitFetchEligibility = {
  ambient: false,
  managedProfiles: false,
};

const POPOVER_SURFACE_CLASS_NAME =
  "relative w-[min(92vw,30rem)] min-w-[min(92vw,20rem,var(--radix-popover-content-available-width))] max-w-[var(--radix-popover-content-available-width)] max-h-[var(--radix-popover-content-available-height)] overflow-hidden";

type RateLimitPopoverResizeDirection =
  "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface RateLimitPopoverPositionLock {
  readonly wrapperElement: HTMLElement;
  offsetXPx: number;
  offsetYPx: number;
  readonly setOffset: (xPx: number, yPx: number) => void;
  readonly restore: () => void;
}

interface RateLimitPopoverViewportBounds {
  readonly rightPx: number;
  readonly bottomPx: number;
}

interface RateLimitPopoverResizeDrag {
  readonly pointerId: number;
  readonly direction: RateLimitPopoverResizeDirection;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startLeftPx: number;
  readonly startTopPx: number;
  readonly startRightPx: number;
  readonly startBottomPx: number;
  readonly startWidthPx: number;
  readonly startHeightPx: number;
  readonly viewportRightPx: number;
  readonly viewportBottomPx: number;
  readonly positionLock: RateLimitPopoverPositionLock;
  readonly restorePositionOnCancel: boolean;
  readonly startPositionOffsetXPx: number;
  readonly startPositionOffsetYPx: number;
  readonly previousInlineWidth: string;
  readonly previousInlineHeight: string;
  latestWidthPx: number;
  latestHeightPx: number;
  moved: boolean;
}

const RATE_LIMIT_POPOVER_RESIZE_DIRECTIONS = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
] as const;

function isRateLimitPopoverResizeDirection(
  value: string | undefined,
): value is RateLimitPopoverResizeDirection {
  return RATE_LIMIT_POPOVER_RESIZE_DIRECTIONS.some(
    (direction) => direction === value,
  );
}

const RATE_LIMIT_POPOVER_RESIZE_HANDLE_CLASS_NAMES = {
  n: "absolute inset-x-3 top-0 z-20 h-2 cursor-n-resize touch-none",
  ne: "absolute top-0 right-0 z-30 size-3 cursor-ne-resize touch-none",
  e: "absolute inset-y-3 right-0 z-20 w-2 cursor-e-resize touch-none",
  se: "absolute right-0 bottom-0 z-30 size-3 cursor-se-resize touch-none",
  s: "absolute inset-x-3 bottom-0 z-20 h-2 cursor-s-resize touch-none",
  sw: "absolute bottom-0 left-0 z-30 size-3 cursor-sw-resize touch-none",
  w: "absolute inset-y-3 left-0 z-20 w-2 cursor-w-resize touch-none",
  nw: "absolute top-0 left-0 z-30 size-3 cursor-nw-resize touch-none",
} satisfies Record<RateLimitPopoverResizeDirection, string>;

const RATE_LIMIT_POPOVER_COLLISION_PADDING_PX = 12;

// Radix owns the floating wrapper's transform and rewrites it whenever content
// size changes. Lock that transform for the rest of this popover opening so a
// resize can move the exact active edge without Radix re-anchoring underneath
// the pointer. The observer only restores one expected transform; it never
// derives another offset from the moved element, avoiding a feedback loop.
function createRateLimitPopoverPositionLock(
  wrapperElement: HTMLElement,
): RateLimitPopoverPositionLock {
  const originalTransform = wrapperElement.style.transform;
  const originalTransformPriority =
    wrapperElement.style.getPropertyPriority("transform");
  let expectedTransform = originalTransform;
  let restored = false;
  const applyExpectedTransform = (): void => {
    if (restored) return;
    if (
      wrapperElement.style.transform === expectedTransform &&
      wrapperElement.style.getPropertyPriority("transform") === "important"
    ) {
      return;
    }
    wrapperElement.style.setProperty(
      "transform",
      expectedTransform,
      "important",
    );
  };
  const observer = new MutationObserver(applyExpectedTransform);
  const positionLock: RateLimitPopoverPositionLock = {
    wrapperElement,
    offsetXPx: 0,
    offsetYPx: 0,
    setOffset: (xPx, yPx) => {
      positionLock.offsetXPx = xPx;
      positionLock.offsetYPx = yPx;
      const offsetTransform = `translate(${xPx}px, ${yPx}px)`;
      expectedTransform =
        originalTransform === "" || originalTransform === "none"
          ? offsetTransform
          : `${originalTransform} ${offsetTransform}`;
      applyExpectedTransform();
    },
    restore: () => {
      if (restored) return;
      restored = true;
      observer.disconnect();
      if (originalTransform === "") {
        wrapperElement.style.removeProperty("transform");
        return;
      }
      wrapperElement.style.setProperty(
        "transform",
        originalTransform,
        originalTransformPriority,
      );
    },
  };
  observer.observe(wrapperElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  applyExpectedTransform();
  return positionLock;
}

function rateLimitPopoverViewportBounds(
  surface: HTMLDivElement,
  rect: DOMRect,
): RateLimitPopoverViewportBounds {
  const ownerDocument = surface.ownerDocument;
  const win = ownerDocument.defaultView;
  const viewportWidth =
    ownerDocument.documentElement.clientWidth || win?.innerWidth || rect.right;
  const viewportHeight =
    ownerDocument.documentElement.clientHeight ||
    win?.innerHeight ||
    rect.bottom;
  return {
    rightPx: viewportWidth - RATE_LIMIT_POPOVER_COLLISION_PADDING_PX,
    bottomPx: viewportHeight - RATE_LIMIT_POPOVER_COLLISION_PADDING_PX,
  };
}

type RateLimitPopoverSurfaceVariant = "content" | "empty";

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

function providerFetchEligibility(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
  providerId: RateLimitProviderId,
): RateLimitFetchEligibility {
  return (
    providers.find((candidate) => candidate.providerId === providerId)
      ?.fetchEligibility ?? NO_RATE_LIMIT_FETCH_ELIGIBILITY
  );
}

function refreshTargetsForProvider(
  provider: ConfiguredRateLimitProvider,
): ReadonlyArray<string | null> {
  if (provider.profiles.length === 0) {
    return provider.fetchEligibility.ambient ? [null] : [];
  }
  return provider.profiles
    .filter((profile) =>
      isRateLimitProfileFetchEligible(provider.fetchEligibility, profile),
    )
    .map(rateLimitProfileId);
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
  scope,
  hasExplicitPick,
}: {
  readonly onClose: () => void;
  readonly profileSelection: RateLimitProfileSelection;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  return (
    <PopoverContent
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={RATE_LIMIT_POPOVER_COLLISION_PADDING_PX}
      role="dialog"
      aria-label="Usage limits"
      className="w-fit max-w-[var(--radix-popover-content-available-width)] max-h-[var(--radix-popover-content-available-height)] gap-0 overflow-hidden rounded-xl p-0"
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
            target.closest('[data-slot="dialog-overlay"]') !== null ||
            // The host switcher's own list is a nested Radix popover, so it
            // portals OUTSIDE this content and every click in it reads as an
            // interaction outside. Without this, opening the picker closed the
            // surface the picker exists to scope, and no host could ever be
            // chosen. Shared with every other container that embeds it.
            isHostSwitcherListInteraction(target))
        ) {
          event.preventDefault();
        }
      }}
    >
      <RateLimitPopoverBody
        onClose={onClose}
        profileSelection={profileSelection}
        scope={scope}
        hasExplicitPick={hasExplicitPick}
      />
    </PopoverContent>
  );
}

/**
 * Viewport-bounded resize surface with OS-style hit areas on every edge and
 * corner. Drag frames mutate inline dimensions directly, while pointer release
 * commits the final measured size once so subsequent opens restore it.
 */
function RateLimitPopoverResizeSurface({
  variant,
  children,
}: {
  readonly variant: RateLimitPopoverSurfaceVariant;
  readonly children: ReactNode;
}): ReactNode {
  const size = useRateLimitPopoverStore((state) => state.size);
  const setSize = useRateLimitPopoverStore((state) => state.setSize);
  const dragRef = useRef<RateLimitPopoverResizeDrag | null>(null);
  const positionLockRef = useRef<RateLimitPopoverPositionLock | null>(null);
  useEffect(
    () => () => {
      positionLockRef.current?.restore();
    },
    [],
  );

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragRef.current !== null) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const direction = target.dataset.resizeDirection;
    if (!isRateLimitPopoverResizeDirection(direction)) return;

    const surface = event.currentTarget;
    const positionWrapper = surface.closest<HTMLElement>(
      "[data-radix-popper-content-wrapper]",
    );
    if (positionWrapper === null) return;
    const rect = surface.getBoundingClientRect();
    const { width, height } = rect;
    if (width <= 0 || height <= 0) return;
    const viewportBounds = rateLimitPopoverViewportBounds(surface, rect);
    event.preventDefault();
    event.stopPropagation();
    surface.setPointerCapture(event.pointerId);
    const existingPositionLock = positionLockRef.current;
    const restorePositionOnCancel =
      existingPositionLock === null ||
      existingPositionLock.wrapperElement !== positionWrapper;
    if (
      existingPositionLock !== null &&
      existingPositionLock.wrapperElement !== positionWrapper
    ) {
      existingPositionLock.restore();
    }
    const positionLock = restorePositionOnCancel
      ? createRateLimitPopoverPositionLock(positionWrapper)
      : existingPositionLock;
    positionLockRef.current = positionLock;
    const drag: RateLimitPopoverResizeDrag = {
      pointerId: event.pointerId,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeftPx: rect.left,
      startTopPx: rect.top,
      startRightPx: rect.right,
      startBottomPx: rect.bottom,
      startWidthPx: width,
      startHeightPx: height,
      viewportRightPx: viewportBounds.rightPx,
      viewportBottomPx: viewportBounds.bottomPx,
      positionLock,
      restorePositionOnCancel,
      startPositionOffsetXPx: positionLock.offsetXPx,
      startPositionOffsetYPx: positionLock.offsetYPx,
      previousInlineWidth: surface.style.width,
      previousInlineHeight: surface.style.height,
      latestWidthPx: width,
      latestHeightPx: height,
      moved: false,
    };
    dragRef.current = drag;
    // Freeze both axes at their computed dimensions before the first drag frame;
    // otherwise a content reflow can change the untouched axis mid-drag.
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
  };

  const resizeDuringDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    const resizeFromLeft = drag.direction.includes("w");
    const resizeFromRight = drag.direction.includes("e");
    const resizeFromTop = drag.direction.includes("n");
    const resizeFromBottom = drag.direction.includes("s");
    let widthDelta = 0;
    if (resizeFromLeft) widthDelta = -deltaX;
    else if (resizeFromRight) widthDelta = deltaX;
    let heightDelta = 0;
    if (resizeFromTop) heightDelta = -deltaY;
    else if (resizeFromBottom) heightDelta = deltaY;
    let maxWidthPx = drag.startWidthPx;
    if (resizeFromLeft) {
      maxWidthPx = drag.startRightPx - RATE_LIMIT_POPOVER_COLLISION_PADDING_PX;
    } else if (resizeFromRight) {
      maxWidthPx = drag.viewportRightPx - drag.startLeftPx;
    }
    let maxHeightPx = drag.startHeightPx;
    if (resizeFromTop) {
      maxHeightPx =
        drag.startBottomPx - RATE_LIMIT_POPOVER_COLLISION_PADDING_PX;
    } else if (resizeFromBottom) {
      maxHeightPx = drag.viewportBottomPx - drag.startTopPx;
    }
    drag.latestWidthPx = Math.min(
      Math.max(1, maxWidthPx),
      Math.max(1, drag.startWidthPx + widthDelta),
    );
    drag.latestHeightPx = Math.min(
      Math.max(1, maxHeightPx),
      Math.max(1, drag.startHeightPx + heightDelta),
    );
    event.currentTarget.style.width = `${drag.latestWidthPx}px`;
    event.currentTarget.style.height = `${drag.latestHeightPx}px`;
    const measured = event.currentTarget.getBoundingClientRect();
    drag.moved =
      measured.width !== drag.startWidthPx ||
      measured.height !== drag.startHeightPx;
    const offsetDeltaXPx = resizeFromLeft
      ? drag.startWidthPx - measured.width
      : 0;
    const offsetDeltaYPx = resizeFromTop
      ? drag.startHeightPx - measured.height
      : 0;
    drag.positionLock.setOffset(
      drag.startPositionOffsetXPx + offsetDeltaXPx,
      drag.startPositionOffsetYPx + offsetDeltaYPx,
    );
  };

  const finishResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const surface = event.currentTarget;
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    if (!commit || !drag.moved) {
      surface.style.width = drag.previousInlineWidth;
      surface.style.height = drag.previousInlineHeight;
      if (drag.restorePositionOnCancel) {
        drag.positionLock.restore();
        if (positionLockRef.current === drag.positionLock) {
          positionLockRef.current = null;
        }
      } else {
        drag.positionLock.setOffset(
          drag.startPositionOffsetXPx,
          drag.startPositionOffsetYPx,
        );
      }
      return;
    }

    const measured = surface.getBoundingClientRect();
    const widthPx = measured.width > 0 ? measured.width : drag.latestWidthPx;
    const heightPx =
      measured.height > 0 ? measured.height : drag.latestHeightPx;
    surface.style.width = `${widthPx}px`;
    surface.style.height = `${heightPx}px`;
    setSize({ widthPx, heightPx });
  };

  return (
    <div
      data-testid="rate-limit-popover-resize-surface"
      className={cn(
        POPOVER_SURFACE_CLASS_NAME,
        variant === "content"
          ? "flex h-[max(50vh,22rem)] min-h-[min(35vh,16rem,var(--radix-popover-content-available-height))] flex-col"
          : "flex min-h-[min(20vh,8rem,var(--radix-popover-content-available-height))] flex-col items-start gap-3 p-4",
      )}
      style={
        size === null
          ? undefined
          : { width: size.widthPx, height: size.heightPx }
      }
      onPointerDown={startResize}
      onPointerMove={resizeDuringDrag}
      onPointerUp={(event) => finishResize(event, true)}
      onPointerCancel={(event) => finishResize(event, false)}
      onLostPointerCapture={(event) => finishResize(event, false)}
    >
      {children}
      {RATE_LIMIT_POPOVER_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          aria-hidden="true"
          data-resize-direction={direction}
          data-testid={`rate-limit-popover-resize-${direction}`}
          className={RATE_LIMIT_POPOVER_RESIZE_HANDLE_CLASS_NAMES[direction]}
        />
      ))}
    </div>
  );
}

function RateLimitPopoverBody({
  onClose,
  profileSelection,
  scope,
  hasExplicitPick,
}: {
  readonly onClose: () => void;
  readonly profileSelection: RateLimitProfileSelection;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  // The picker earns its row once there is a choice to make. One host means
  // one possible answer, and a control whose only outcome is the state you are
  // already in is chrome. The `vanished` exception is not a choice but a way
  // OUT: a pick that no longer resolves must never leave someone stranded on a
  // notice with the only control that could clear it hidden.
  const showHostPicker =
    scope.hosts.length > 1 || scope.vanishedHostId !== null;
  const header = showHostPicker ? (
    <RateLimitHostPickerRow scope={scope} onClose={onClose} />
  ) : null;

  // Everything below reads through this subtree's host binding, and a PICK
  // that is not `ready` did not produce one - so the providers, the rail and
  // every block would silently describe the AMBIENT host under the name this
  // header just printed. Say what happened instead.
  //
  // Gated on there being a pick at all, because without one the ambient host
  // is not a substitution for anything: it is the host this surface has always
  // reported, an `unreachable` blip on it is what the envelope's last-good
  // retention exists to survive, and swapping that for a notice would take
  // working usage away from every single-host user.
  if (hasExplicitPick && !isHostScopeUsable(scope.status)) {
    return (
      <RateLimitPopoverResizeSurface variant="content">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-stretch gap-3 overflow-y-auto p-3">
          <RateLimitHostUnavailableNotice scope={scope} />
          {/* The ACCOUNT-scoped half survives the host being down: Traycer
              Inference usage comes through the AuthService with no host
              binding involved, so only the host-RPC provider panes go with
              the route. Hiding this too both took working data away and had
              the notice claim more than is true. */}
          <UnscopedTraycerUsage />
        </div>
      </RateLimitPopoverResizeSurface>
    );
  }

  return (
    <RateLimitPopoverScopedBody
      onClose={onClose}
      profileSelection={profileSelection}
      header={header}
      displayedHostId={scope.hostId}
    />
  );
}

/**
 * The rail + detail body, mounted only once the surface is bound to the host
 * it names. Split from `RateLimitPopoverBody` so the provider queries below
 * are not mounted at all under an unusable scope - a hook that runs anyway and
 * has its output hidden still fires against the ambient host and caches the
 * answer under its key (`isHostScopeUsable`).
 */
function RateLimitPopoverScopedBody({
  onClose,
  profileSelection,
  header,
  displayedHostId,
}: {
  readonly onClose: () => void;
  readonly profileSelection: RateLimitProfileSelection;
  readonly header: ReactNode;
  /** The host this popover is SHOWING - pinned or followed - for deep links. */
  readonly displayedHostId: string | null;
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
  const { openSettings } = useSystemTabModalActions();
  const openOpenCodeModelProviders = useCallback((): void => {
    onClose();
    const focus = useProvidersFocusStore.getState();
    focus.setFocusHarnessId("opencode");
    focus.setFocusTab("modelProviders");
    carryViewedHostIntoSettingsScope(displayedHostId);
    openSettings({ section: "providers", resetToGeneral: false });
  }, [displayedHostId, onClose, openSettings]);

  // Zero-state only when there is genuinely nothing to show: no host-RPC
  // providers AND no eligible Traycer tab.
  if (providers.length === 0 && !traycerSubscription.eligible) {
    // The zero state keeps its own compact surface when nothing scopes it. With
    // a host picker present the row has to stay reachable, or picking the one
    // host with no providers configured would remove the only way to pick a
    // different one.
    if (header === null) {
      return (
        <RateLimitPopoverResizeSurface variant="empty">
          <RateLimitZeroState
            onClose={onClose}
            displayedHostId={displayedHostId}
          />
        </RateLimitPopoverResizeSurface>
      );
    }
    return (
      <RateLimitPopoverResizeSurface variant="content">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto p-4">
          <RateLimitZeroState
            onClose={onClose}
            displayedHostId={displayedHostId}
          />
        </div>
      </RateLimitPopoverResizeSurface>
    );
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

  // The default target height keeps the popover stable across tabs. The resize
  // surface applies the remembered user size within fluid viewport bounds.
  // `minmax(0,1fr)` pins the row to that height, and both columns keep their
  // own `min-h-0` + `overflow-y-auto` scrolling.
  return (
    <RateLimitPopoverResizeSurface variant="content">
      {header}
      {/* The rail/detail grid, now a row of the surface's flex column rather
          than the surface itself, so the host picker can head both panes.
          `minmax(0,1fr)` still pins this row to the surface's height and both
          columns keep their own `min-h-0` + `overflow-y-auto` scrolling. */}
      <div
        data-testid="rate-limit-popover-panes"
        className="grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
      >
        <RateLimitRail
          displayedHostId={displayedHostId}
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
              openOpenCodeModelProviders={openOpenCodeModelProviders}
            />
          ) : (
            <RateLimitDetailPane
              tab={resolvedTab}
              providers={providers}
              profileSelection={profileSelection}
              openOpenCodeModelProviders={openOpenCodeModelProviders}
            />
          )}
        </div>
      </div>
    </RateLimitPopoverResizeSurface>
  );
}

/**
 * The host row above the rail: which machine's usage the whole surface is
 * reporting. It heads the rail + detail grid rather than sitting inside either
 * one, because it scopes BOTH - a picker in the detail pane would read as
 * scoping only the provider whose tab happens to be open, and the 3rem rail
 * has no room to say a host's name at all.
 *
 * `HostSwitcher` is Settings' picker, reused rather than re-skinned. The two
 * surfaces answer different questions (administer vs. watch) but the rows
 * answer the same one - which machine is this, can I reach it, which one is
 * active - and a second picker over one concept is how two vocabularies for it
 * start.
 */
function RateLimitHostPickerRow({
  scope,
  onClose,
}: {
  readonly scope: HostScope;
  readonly onClose: () => void;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  // The registry list this picker renders is served by a NON-polling observer;
  // the Settings sidebar is normally the surface that opts the window into the
  // liveness poll. When this popover is the only host-list surface mounted, a
  // row would otherwise keep an Online dot from the last registry DTO until
  // something else happened to refetch - so this picker carries the same
  // opt-in for exactly as long as it is on screen.
  useRegisteredHostsPollLiveness();
  return (
    // Full-bleed on purpose: the strip's own edges ARE the card's, so the
    // picker's list can drop from it at exactly the card's width. Padding here
    // would inset the trigger, and with it the list anchored to the trigger,
    // leaving a few pixels of card showing down both sides of the open list —
    // the nested-panel look this row is meant to avoid.
    <div
      className="flex shrink-0 items-center border-b"
      data-testid="rate-limit-host-picker-row"
    >
      <HostSwitcher
        hosts={scope.hosts}
        selected={scope.host}
        activeHostId={scope.activeHostId}
        onSelect={scope.setHostId}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        // Managing hosts — adding, renaming, updating, removing — is Settings'
        // job, with its own dialogs and failure states; this popover reports
        // usage. So the list ends in the same gear the model picker offers for
        // provider settings: one link to where that work already lives, rather
        // than a second copy of one verb from it.
        action={{
          kind: "manage-hosts",
          onSelect: () => {
            onClose();
            // The displayed host travels with the jump - one rule, one
            // implementation, shared with the provider CTAs.
            carryViewedHostIntoSettingsScope(scope.hostId);
            openSettings({ section: "host", resetToGeneral: false });
          },
        }}
        surface="panel-header"
        intent="view"
        disabled={false}
        isLoading={scope.isLoading}
        listsFailed={scope.listsFailed}
        onRetryLists={scope.retryLists}
      />
    </div>
  );
}

/**
 * Why this surface is showing nothing rather than showing the active host's
 * numbers under another host's name. Each branch names the remedy it has,
 * because the three states differ in exactly that: `vanished` needs the pick
 * dropped, `unreachable` needs the machine back, `connecting` needs a moment.
 */
function RateLimitHostUnavailableNotice({
  scope,
}: {
  readonly scope: HostScope;
}): ReactNode {
  if (scope.status === "connecting") {
    return (
      <span
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="rate-limit-host-connecting"
      >
        <MutedAgentSpinner />
        Finding {scope.hostLabel}…
      </span>
    );
  }
  return (
    <div
      role="status"
      className="flex max-w-[40ch] flex-col items-center gap-2 text-center"
      data-testid="rate-limit-host-unavailable"
    >
      <p className="text-ui-sm font-medium text-foreground">
        {scope.status === "vanished"
          ? `${scope.hostLabel} is no longer connected`
          : `Can't reach ${scope.hostLabel}`}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        {scope.status === "vanished"
          ? "It was removed or signed out, so its usage limits can't be read."
          : "Provider usage limits are read from the host itself, so they're unavailable while it's offline."}
      </p>
      <button
        type="button"
        onClick={scope.returnToActive}
        className="rounded-md px-1 py-0.5 text-ui-sm text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="rate-limit-host-return-to-active"
      >
        Show the active host
      </button>
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
  openOpenCodeModelProviders,
}: {
  readonly tab: Exclude<RateLimitPopoverTab, "overview">;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
  readonly openOpenCodeModelProviders: () => void;
}): ReactNode {
  return tab === "traycer" ? (
    <TraycerRateLimitBlock variant="popover-detail" onReady={null} />
  ) : (
    <RateLimitProviderBlock
      providerId={tab}
      profiles={configuredProviderProfiles(providers, tab)}
      fetchEligibility={providerFetchEligibility(providers, tab)}
      variant="popover-detail"
      onReady={null}
      profileSelection={profileSelection}
      openOpenCodeModelProviders={openOpenCodeModelProviders}
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
  displayedHostId,
}: {
  readonly displayedHostId: string | null;
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
    carryViewedHostIntoSettingsScope(displayedHostId);
    openSettings({ section: "providers", resetToGeneral: false });
  };
  return (
    <div className="flex min-h-0 flex-col items-center border-r bg-foreground/3 p-1.5">
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
      <TooltipWrapper
        label="Provider settings"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-label="Provider settings"
          onClick={openProviderSettings}
          className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Settings className="size-4" />
        </button>
      </TooltipWrapper>
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
  openOpenCodeModelProviders,
}: {
  readonly railTabs: ReadonlyArray<RailTabDescriptor>;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
  readonly openOpenCodeModelProviders: () => void;
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
                fetchEligibility={providerFetchEligibility(
                  providers,
                  tab.providerId,
                )}
                variant="popover-overview"
                onReady={onReady}
                profileSelection={profileSelection}
                openOpenCodeModelProviders={openOpenCodeModelProviders}
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
  // The ephemeral lane's app-shell default is configured to the app-wide host,
  // so the unscoped `enqueueRateLimitFetchBatch` would refresh a machine this
  // popover may not be showing. This scope is derived from the same context
  // binding as `hostId` and `client` above, so all three name one host.
  const queueScope = useRateLimitQueueScope();
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
      : providerRateLimitQueryOptions(
          httpFetchProviders[0].providerId,
          null,
          true,
        ).options;
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
        true,
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
  const hasRefreshTarget =
    httpFetchRequests.length > 0 ||
    ephemeralProcessRequests.length > 0 ||
    traycerRefreshTarget.enabled;

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
    void enqueueRateLimitFetchBatchForScope(
      queueScope,
      ephemeralProcessRequests,
      {
        force: true,
      },
    );
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

  if (!hasRefreshTarget) return null;

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
  fetchEligibility,
  variant,
  onReady,
  profileSelection,
  openOpenCodeModelProviders,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly fetchEligibility: RateLimitFetchEligibility;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
  readonly profileSelection: RateLimitProfileSelection;
  readonly openOpenCodeModelProviders: () => void;
}): ReactNode {
  if (profiles.length > 0) {
    return (
      <ProfileRateLimitProviderBlock
        providerId={providerId}
        profiles={profiles}
        fetchEligibility={fetchEligibility}
        variant={variant}
        onReady={onReady}
        profileSelection={profileSelection}
        openOpenCodeModelProviders={openOpenCodeModelProviders}
      />
    );
  }

  return (
    <SingleProfileRateLimitProviderBlock
      providerId={providerId}
      fetchEligible={fetchEligibility.ambient}
      variant={variant}
      onReady={onReady}
      openOpenCodeModelProviders={openOpenCodeModelProviders}
    />
  );
}

function SingleProfileRateLimitProviderBlock({
  providerId,
  fetchEligible,
  variant,
  onReady,
  openOpenCodeModelProviders,
}: {
  readonly providerId: RateLimitProviderId;
  readonly fetchEligible: boolean;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
  readonly openOpenCodeModelProviders: () => void;
}): ReactNode {
  const query = useHostProviderRateLimitsQuery(providerId, null, fetchEligible);
  // Single source of truth for this provider's refresh action + spinner state
  // (fresh-on-open, queue routing, and the ephemeralProcess `draining` fold-in),
  // shared verbatim with the Settings card so they can't drift apart.
  const { refresh, isRefreshing } = useProviderRateLimitRefresh({
    providerId,
    profileId: null,
    usageUpdatedAt: null,
    hasCachedValue: query.data !== undefined && query.data.lastGood !== null,
    fetchEligible,
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
    // A disabled query with no cache stays pending forever by design: it is a
    // passive observer for a signed-out provider, not a queue-owned cold
    // read. Reveal that provider in Overview so its unavailable state cannot
    // remain hidden behind the global loading indicator.
    if ((!fetchEligible || state.kind !== "cold") && onReady !== null) {
      onReady();
    }
  }, [fetchEligible, onReady, state.kind]);

  // Chip next to the name, single-provider tab only (Overview stays
  // condensed - same scoping the plan/tier line used before it moved into
  // this header). `null` for a provider that doesn't report a plan/tier
  // (`resolveProviderPlanLabel`), so no chip renders for e.g. OpenRouter.
  const planLabel =
    variant === "popover-detail" && state.kind === "ready"
      ? resolveProviderPlanLabel(state.data)
      : null;

  return (
    // Ambient (profile-less) providers - grok, openrouter, kilocode - reuse the
    // exact per-profile card container `RateLimitProviderProfileRow` gives
    // codex/claude, so every provider's usage sits inside the same card in both
    // popover tabs (the header+body flat block otherwise floated loose against
    // the sibling cards - the design-language gap the user flagged). Overview
    // keeps its between-provider dividers; this cards each block's own content.
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-2">
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
          {variant === "popover-detail" && fetchEligible ? (
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
      <RateLimitProviderBody
        state={state}
        variant={variant}
        profileId={null}
        openModelProvidersAction={openOpenCodeModelProviders}
      />
    </div>
  );
}

function ProfileRateLimitProviderBlock({
  providerId,
  profiles,
  fetchEligibility,
  variant,
  onReady,
  profileSelection,
  openOpenCodeModelProviders,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly fetchEligibility: RateLimitFetchEligibility;
  readonly variant: PopoverBlockVariant;
  readonly onReady: (() => void) | null;
  readonly profileSelection: RateLimitProfileSelection;
  readonly openOpenCodeModelProviders: () => void;
}): ReactNode {
  const draining = useIsRateLimitQueueDraining();
  const queryClient = useQueryClient();
  // Same reason as `RateLimitRefreshAllButton`'s: this provider's own refresh
  // must reach the host whose numbers it is redrawing, not the app-wide one.
  const queueScope = useRateLimitQueueScope();
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const activeProfileId = resolveRateLimitProfileId(
    profileSelection,
    providerId,
    profiles,
  );
  const targets = profiles.map((profile) => ({
    profile,
    profileId: rateLimitProfileId(profile),
    fetchEligible: isRateLimitProfileFetchEligible(fetchEligibility, profile),
  }));
  const refreshEligibleTargets = targets.filter(
    (target) => target.fetchEligible,
  );
  const passiveTargets = targets.filter((target) => !target.fetchEligible);
  const fetchEligibleQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    requests: refreshEligibleTargets.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        providerId,
        target.profileId,
        true,
      );
      return { method, params };
    }),
    cacheKeyIdentity: undefined,
    options: providerRateLimitQueryOptions(providerId, null, true).options,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const passiveQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    requests: passiveTargets.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        providerId,
        target.profileId,
        false,
      );
      return { method, params };
    }),
    cacheKeyIdentity: undefined,
    options: providerRateLimitQueryOptions(providerId, null, false).options,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const queries = targets.map((target) => {
    const index = target.fetchEligible
      ? refreshEligibleTargets.indexOf(target)
      : passiveTargets.indexOf(target);
    return target.fetchEligible
      ? fetchEligibleQueries[index]
      : passiveQueries[index];
  });
  const lane = rateLimitFetchLane(providerId);
  const isRefreshing =
    lane === "ephemeralProcess"
      ? draining
      : fetchEligibleQueries.some((query) => query.isFetching);

  const refresh = (): Promise<void> => {
    if (lane === "ephemeralProcess") {
      void enqueueRateLimitFetchBatchForScope(
        queueScope,
        refreshEligibleTargets.map((target) => ({
          providerId,
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: target.profileId,
        })),
        { force: true },
      );
      return Promise.resolve();
    }
    refreshEligibleTargets.forEach((target) => {
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

  return (
    <div className="flex flex-col gap-2">
      <ProviderGroupHeader
        providerId={providerId}
        variant={variant}
        refresh={refresh}
        isRefreshing={isRefreshing}
        refreshEligible={refreshEligibleTargets.length > 0}
      />
      <div className="flex flex-col gap-2">
        {targets.map((target, index) => {
          return (
            <RateLimitProviderProfileRow
              key={target.profile.profileId}
              providerId={providerId}
              profile={target.profile}
              profileId={target.profileId}
              fetchEligible={target.fetchEligible}
              active={activeProfileId === target.profileId}
              variant={variant}
              query={queries[index]}
              openOpenCodeModelProviders={openOpenCodeModelProviders}
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
  refreshEligible,
}: {
  readonly providerId: RateLimitProviderId;
  readonly variant: PopoverBlockVariant;
  readonly refresh: () => Promise<void>;
  readonly isRefreshing: boolean;
  readonly refreshEligible: boolean;
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
      {variant === "popover-detail" && refreshEligible ? (
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
  fetchEligible,
  active,
  variant,
  query,
  openOpenCodeModelProviders,
}: {
  readonly providerId: RateLimitProviderId;
  readonly profile: ProviderProfile;
  readonly profileId: string | null;
  readonly fetchEligible: boolean;
  readonly active: boolean;
  readonly variant: PopoverBlockVariant;
  readonly openOpenCodeModelProviders: () => void;
  readonly query: {
    readonly isPending: boolean;
    readonly isFetching: boolean;
    readonly isError: boolean;
    readonly data: ProviderRateLimitEnvelope | undefined;
  };
}): ReactNode {
  useRefreshProviderRateLimitsOnMount({
    providerId,
    profileId,
    usageUpdatedAt: profile.usageUpdatedAt,
    hasCachedValue: query.data !== undefined && query.data.lastGood !== null,
    fetchEligible,
    refetch: null,
  });
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
        openModelProvidersAction={openOpenCodeModelProviders}
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
  openModelProvidersAction,
}: {
  readonly state: PopoverProviderRateLimitState;
  readonly variant: PopoverBlockVariant;
  readonly profileId: string | null;
  readonly openModelProvidersAction: () => void;
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
        <div className="flex flex-col items-start gap-1.5">
          <RateLimitErrorMessage
            message={`Usage limits unavailable - ${formatUnavailableReason(state.reason)}`}
            reportContext={createReportIssueContext({
              title: "Usage limits unavailable",
              message: null,
              code: null,
              source: "Usage limits",
            })}
          />
          {state.provider === "opencode" &&
          state.reason === "insufficient_permissions" ? (
            <OpenModelProvidersButton onClick={openModelProvidersAction} />
          ) : null}
        </div>
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
/**
 * The account-scoped Usage half for a popover whose host-scoped half cannot
 * render: eligible Traycer Inference usage, framed like a pane. Returns null
 * for ineligible accounts, so the caller mounts it unconditionally.
 */
function UnscopedTraycerUsage(): ReactNode {
  const traycerSubscription = useTraycerSubscription();
  if (!traycerSubscription.eligible) return null;
  return (
    <div className="w-full max-w-full rounded-md border border-border/60 bg-foreground/3 p-3">
      <TraycerRateLimitBlock variant="popover-overview" onReady={null} />
    </div>
  );
}

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
 * The per-block `bg-foreground/15` overrides these carried are gone: the
 * `Skeleton` primitive now defaults to a foreground-alpha fill for exactly
 * the reason discovered here (see `ui/skeleton.tsx`), so the default is
 * already correct on this popover.
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
  displayedHostId,
}: {
  readonly onClose: () => void;
  readonly displayedHostId: string | null;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const openProviderSettings = (): void => {
    onClose();
    carryViewedHostIntoSettingsScope(displayedHostId);
    openSettings({ section: "providers", resetToGeneral: false });
  };
  return (
    <div className="flex h-full flex-col items-start gap-3">
      <p className="text-ui-sm text-muted-foreground">
        Connect a supported provider to see usage here.
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
