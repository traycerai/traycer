import { useMemo, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { Skeleton } from "@/components/ui/skeleton";
import { profileWireId } from "@/components/providers/provider-profile-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
  type UsageSummaryResponse,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import { useUsageSummaryProfileFilterSupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { useHostClient } from "@/lib/host";

/**
 * D27: the fixed window this card reads. No picker, unlike the Settings ▸
 * Usage dashboard - this card states one number for the selected profile,
 * it is not a browsing surface. `30` matches that dashboard's own default.
 */
const PROFILE_USAGE_TOTALS_WINDOW_DAYS = 30;

/** Same local alias the chat/epic usage dialogs keep (`chat-usage-dialog.tsx:37`). */
type UsageSummaryQueryResult = UseQueryResult<
  UsageSummaryResponse,
  HostRpcError
>;

export interface ProviderUsageTotalsSectionProps {
  readonly hostId: string | null;
  /** The provider tab this card is rendered under - what scopes the totals. */
  readonly providerId: ProviderId;
  /** The Profiles switcher's current selection (D25) - `null` = the Default account. */
  readonly profileId: string | null;
}

/**
 * D21/D27: the selected profile's cumulative tokens/cost for the window,
 * rendered above the Usage tab's existing rate-limit block
 * (`provider-rate-limit-section.tsx`). Owns no plan/rate-limit gauge - that
 * stays that sibling section's job, split by `authType` at the call site.
 *
 * Gated on {@link useUsageSummaryProfileFilterSupported}: an older host
 * cannot filter `host.usage.summary` by profile, and this card must never
 * mislabel an account-wide total as one profile's, so it renders an
 * unsupported notice instead of a number there. The same `@2.0` gate covers
 * the harness filter - both fields ship on that major.
 */
export function ProviderUsageTotalsSection(
  props: ProviderUsageTotalsSectionProps,
): ReactNode {
  const client = useHostClient();
  const supported = useUsageSummaryProfileFilterSupported(props.hostId);
  // `props.profileId` is a COMMIT id (`profile-store.ts`'s vocabulary):
  // `null` for the Default account, same as every other run/session-level
  // profile selection in this app - never the wire sentinel. This card
  // always narrows to the switcher's current selection (there is no
  // "every profile" mode here, unlike the account-wide dashboard), so the
  // Default account must translate to the wire's `"ambient"` token
  // (`profileWireId`) - sending `null` on the wire would ask for every
  // profile's totals instead of just the Default account's.
  const wireProfileId = profileWireId(props.profileId);
  // Wave-5 review O1: the profile filter alone is NOT provider-scoped. The
  // Default account is `effectiveProfileId: null` on every provider, so
  // `"ambient"` on its own selects Claude + Grok + OpenCode facts too and
  // renders them under this tab. The facts are keyed by HARNESS id
  // (`claude`), not by the provider-config id (`claude-code`), so this is
  // the one place that translation happens - the host holds no table.
  const wireHarnessId = providerIdToGuiHarnessId(props.providerId);
  const request = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays: PROFILE_USAGE_TOTALS_WINDOW_DAYS,
        epicId: null,
        profileId: wireProfileId,
        harnessId: wireHarnessId,
      }),
    [wireProfileId, wireHarnessId],
  );
  // Gated through `enabled`, not by nulling the client - see
  // `useUsageSummaryForClient`'s own doc comment for why the two are not
  // equivalent. `poll: false` matches every other actively-viewed usage
  // surface in Settings.
  const query = useUsageSummaryForClient(client, request, supported, false);

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      data-testid="provider-usage-totals-section"
    >
      <div className="text-ui-sm font-medium text-foreground">Usage</div>
      <ProviderUsageTotalsBody supported={supported} query={query} />
    </div>
  );
}

/** The card's body states, split out of the render so each is a plain early
 *  return - the same shape the chat/epic usage dialogs already use
 *  (`chat-usage-dialog.tsx`'s `ChatUsageDialogContent`). */
function ProviderUsageTotalsBody(props: {
  readonly supported: boolean;
  readonly query: UsageSummaryQueryResult;
}): ReactNode {
  const { supported, query } = props;

  if (!supported) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="provider-usage-totals-unsupported"
      >
        This host needs an update to show per-profile usage totals.
      </p>
    );
  }
  if (query.isLoading) {
    return (
      <Skeleton
        className="h-8 w-24"
        data-testid="provider-usage-totals-pending"
      />
    );
  }
  if (query.error !== null) {
    return (
      <UsageErrorCard
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="provider-usage-totals-unavailable"
      >
        Usage data unavailable.
      </p>
    );
  }
  return (
    <UsageCostFigure
      totals={query.data.summary.totals}
      coverage={query.data.coverage}
      servedBy={query.data.servedBy}
      // The host dimension is irrelevant at this scope: a profile's usage is
      // the same usage wherever it ran, same reasoning the epic/chat usage
      // dialogs already use.
      hostScopeName={null}
      size="compact"
    />
  );
}
