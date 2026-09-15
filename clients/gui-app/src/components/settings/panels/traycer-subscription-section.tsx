/**
 * The signed-in user's Traycer subscription + credits, shown under the Traycer
 * provider. A global account-context selector (Personal / each Team) drives
 * which subscription is rendered. Data comes from `useAuthUser` (TanStack
 * Query) - never the auth store, which keeps only its narrow projections.
 *
 * This card owns its query wiring (`useAuthUser`, `useRefreshCreditsOnTraycerTurn`,
 * and - inside the shared `RateLimitView` - `useHostRateLimitUsageQuery` +
 * `useRefreshRateLimitUsageOnTraycerTurn`) and renders through the shared,
 * host/query-free views in `traycer-subscription-views.tsx`, so it and the
 * header popover's Traycer tab can never disagree.
 *
 * On the INSTALLED mobile app the card is "Usage", not "Subscription": App
 * Store review guideline 3.1.1 forbids presenting or linking to a subscription
 * that cannot be bought through Apple, and Traycer's is bought on the web. So
 * the phone drops the "Manage subscription" link and every word that names the
 * purchase, and keeps the half the user genuinely needs - how much credit has
 * been consumed (the shared body renders those amounts currency-free; see
 * `creditMeterDetail`). Refresh and the account picker stay: neither offers
 * anything to buy. Branched on `isMobileApp()`, the build-level installed-app
 * signal, NOT the viewport - this is product policy, so a narrow desktop
 * window must keep its billing.
 */
import { ExternalLink } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import {
  TraycerAccountSelect,
  TraycerSubscriptionView,
} from "@/components/settings/panels/traycer-subscription-views";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  accountContextValue,
  parseAccountContextValue,
  selectSubscription,
  type TraycerSubscription,
} from "@/lib/auth/traycer-subscription-content";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
import { isMobileApp } from "@/lib/mobile-app";
import { useOpenLink } from "@/lib/links/open-link";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  resolveAccountContext,
  useAccountContextStore,
} from "@/stores/auth/account-context-store";

export function TraycerSubscriptionSection() {
  const query = useAuthUser();
  // Keep the balance live: a Traycer turn finishing while this card is open
  // refetches credits. Only mounted here, so it costs nothing elsewhere.
  useRefreshCreditsOnTraycerTurn();
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  const stored = useAccountContextStore((s) => s.accountContext);
  const setAccountContext = useAccountContextStore((s) => s.setAccountContext);
  // Immutable after boot, so a plain read is stable for this component's whole
  // life - no resize can flip it the way the viewport hook flips.
  const installedApp = isMobileApp();

  const user = query.data ?? null;
  const teams = user?.teamSubscriptions ?? [];
  const teamIds = new Set(teams.map((t) => t.team.id));
  const resolved = resolveAccountContext(stored, teamIds);
  const subscription = selectSubscription(user, resolved, teams);

  const manageUrl = resolvePlatformBaseUrl(runnerHost.signInUrl);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          {installedApp ? "Usage" : "Subscription"}
        </div>
        <div className="flex items-center gap-1">
          {installedApp ? null : (
            <button
              type="button"
              onClick={(event) => {
                // Same as the user menu: the event carries the modifiers (L9),
                // and the analytics event means "opened", not "asked" (R11).
                void openLink(manageUrl, "account", event).then(
                  () =>
                    Analytics.getInstance().track(
                      AnalyticsEvent.SubscriptionManagementOpened,
                      { source: "direct_ui" },
                    ),
                  ignoreError,
                );
              }}
              className="inline-flex w-fit items-center gap-1.5 rounded px-1 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Manage subscription
              <ExternalLink className="size-3" />
            </button>
          )}
          <RefreshIconButton
            onRefresh={async () => {
              const result = await query.refetch();
              if (result.status === "success") {
                Analytics.getInstance().track(
                  AnalyticsEvent.SubscriptionRefreshed,
                  { source: "direct_ui" },
                );
              }
            }}
            label={installedApp ? "Refresh usage" : "Refresh subscription"}
            refreshing={query.isFetching}
          />
        </div>
      </div>

      <TraycerAccountSelect
        teams={teams}
        value={accountContextValue(resolved)}
        onValueChange={(value) =>
          setAccountContext(parseAccountContextValue(value))
        }
      />

      <SubscriptionBody
        query={query}
        subscription={subscription}
        accountContext={resolved}
      />
    </div>
  );
}

function SubscriptionBody({
  query,
  subscription,
  accountContext,
}: {
  readonly query: UseQueryResult<AuthenticatedUser | null>;
  readonly subscription: TraycerSubscription | null;
  readonly accountContext: AccountContext;
}) {
  // The card's own noun, so the states under a "Usage" heading don't announce
  // a "subscription" the phone is not allowed to talk about. The report
  // context below keeps its original title: that string identifies the failure
  // in telemetry and issue reports, and is not the card's copy.
  const subject = isMobileApp() ? "usage" : "subscription";
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading {subject}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn&apos;t load your {subject}. Try refreshing.
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't load your subscription",
            message: null,
            code: null,
            source: "Subscription",
          })}
          presentation="link"
          className="ml-1 h-auto p-0 text-current"
        />
      </div>
    );
  }
  if (subscription === null) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No {subject} found for this account.
      </div>
    );
  }
  return (
    <TraycerSubscriptionView
      subscription={subscription}
      accountContext={accountContext}
    />
  );
}
