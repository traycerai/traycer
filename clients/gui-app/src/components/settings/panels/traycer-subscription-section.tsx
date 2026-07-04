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
 */
import { ExternalLink } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import {
  TraycerAccountSelect,
  TraycerSubscriptionView,
} from "@/components/settings/panels/traycer-subscription-views";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import {
  accountContextValue,
  parseAccountContextValue,
  selectSubscription,
  type TraycerSubscription,
} from "@/lib/auth/traycer-subscription-content";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
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
  const stored = useAccountContextStore((s) => s.accountContext);
  const setAccountContext = useAccountContextStore((s) => s.setAccountContext);

  const user = query.data ?? null;
  const teams = user?.teamSubscriptions ?? [];
  const teamIds = new Set(teams.map((t) => t.team.id));
  const resolved = resolveAccountContext(stored, teamIds);
  const subscription = selectSubscription(user, resolved, teams);

  const manageUrl = resolveManageSubscriptionUrl(runnerHost.authnBaseUrl);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Subscription
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void runnerHost.openExternalLink(manageUrl);
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded px-1 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Manage subscription
            <ExternalLink className="size-3" />
          </button>
          <RefreshIconButton
            onRefresh={async () => {
              await query.refetch();
            }}
            label="Refresh subscription"
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

      <SubscriptionBody query={query} subscription={subscription} />
    </div>
  );
}

function SubscriptionBody({
  query,
  subscription,
}: {
  readonly query: UseQueryResult<AuthenticatedUser | null>;
  readonly subscription: TraycerSubscription | null;
}) {
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading subscription
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn't load your subscription. Try refreshing.
      </div>
    );
  }
  if (subscription === null) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No subscription found for this account.
      </div>
    );
  }
  return <TraycerSubscriptionView subscription={subscription} />;
}
