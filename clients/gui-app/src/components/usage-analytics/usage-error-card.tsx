import type { ReactNode } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { Button } from "@/components/ui/button";

export interface UsageErrorCardProps {
  readonly error: Error;
  readonly onRetry: () => void;
}

/**
 * Cloud-unavailable (and every other `host.usage.summary` failure) renders
 * as a retryable error card - NEVER a silent swap to local/stale-looking
 * data (the replication-and-read-path artifact's explicit rule: a
 * single-host history posing as the account's totals is the comm-graph
 * fallback bug this capability must not repeat). The host resolver's
 * cloud-unavailable path answers a plain `RPC_ERROR` with no `retryable`
 * flag on this transport (unary responses never carry `fatalDetails`), so
 * this card offers Retry unconditionally rather than trying to classify
 * the error first.
 */
export function UsageErrorCard(props: UsageErrorCardProps): ReactNode {
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-ui-sm"
      data-testid="usage-error-card"
      role="alert"
    >
      <div>
        <p className="font-medium text-destructive">
          {errorHeadline(props.error)}
        </p>
        <p className="text-muted-foreground">{props.error.message}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="usage-error-retry"
        onClick={props.onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * The fallback is deliberately plane-NEUTRAL. Which reader answers is the
 * host's decision and is only ever revealed by a successful response's
 * `servedBy`, so at the moment a request fails the plane is genuinely
 * unknown - naming Traycer Cloud there sends a local-plane account chasing
 * connectivity for what was a host-transport or local-database failure. The
 * specific cause is not lost: the card renders `error.message` underneath,
 * and the host's cloud-unavailable path says so in that message.
 */
function errorHeadline(error: Error): string {
  if (error instanceof HostRpcError) {
    if (error.code === "UNAUTHORIZED") return "Please sign in again.";
    if (error.code === "FORBIDDEN") {
      return "You don't have permission to view usage for this host.";
    }
  }
  return "Couldn't load usage data.";
}
