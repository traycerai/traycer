import { use, type ReactNode } from "react";
import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HostCompatibilityContext } from "@/lib/host/compatibility-state";

/**
 * Slim strip shown while a compatible host verdict is being HELD through a
 * failed probe refetch.
 *
 * This is the visible half of the traycer#860 fix. A host-scoped invalidation
 * (every stream availability recovery issues one) re-runs the `host.status`
 * compat probe; under heavy machine load that refetch can fail even though the
 * host is alive and completing the user's agent turns. The gate used to read
 * that as `status: "failed"` and replace the entire workspace with a
 * startup-failure card. It now keeps the verdict - and the workspace - and says
 * the connection is degraded here instead.
 *
 * Reads the context directly rather than through `useHostCompatibility` so a
 * surface mounted outside the provider (test harnesses, the gui-app dev
 * preview) renders nothing instead of throwing.
 */
export function HostConnectionDegradedBanner(): ReactNode {
  const compatibility = use(HostCompatibilityContext);
  if (compatibility === null) return null;
  if (compatibility.status !== "compatible") return null;
  if (!compatibility.degraded) return null;
  return (
    <output
      aria-label="Traycer Host connection degraded"
      data-testid="host-connection-degraded-banner"
      className="flex w-full items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-ui-xs text-amber-950 dark:text-amber-100"
    >
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Traycer Host is not responding. Your work is still open - reconnecting.
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="host-connection-degraded-spinner"
        variant={undefined}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-current"
        data-testid="host-connection-degraded-retry"
        onClick={compatibility.retry}
      >
        Retry now
      </Button>
    </output>
  );
}
