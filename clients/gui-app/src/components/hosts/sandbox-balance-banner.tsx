import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxRunwayWarning } from "@/hooks/sandboxes/use-sandbox-runway-warning";
import {
  formatRunway,
  type SandboxRunwayWarning,
} from "@/lib/sandboxes/sandbox-balance";
import { cn } from "@/lib/utils";

/**
 * The two-hour and thirty-minute balance warnings (core flows, flow 5) in
 * the host list. Renders nothing while the balance covers more than two
 * hours or nothing is awake, and reads no cost at all for a user with no
 * sandboxes.
 */
export function SandboxBalanceBanner(): ReactNode {
  const count = useSandboxList().data?.sandboxes.length ?? 0;
  return count === 0 ? null : <LiveSandboxBalanceBanner />;
}

function LiveSandboxBalanceBanner(): ReactNode {
  useRefreshSandboxCosts();
  const warning = useSandboxRunwayWarning();
  return <SandboxRunwayWarningLine warning={warning} />;
}

/** The warning itself, with no queries of its own. */
export function SandboxRunwayWarningLine(props: {
  readonly warning: SandboxRunwayWarning;
}): ReactNode {
  const { warning } = props;
  if (warning.kind === "none") return null;
  const critical = warning.kind === "critical";
  return (
    <p
      role="status"
      data-testid="sandbox-balance-warning"
      data-level={warning.kind}
      className={cn(
        "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-ui-xs leading-snug",
        critical
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
    >
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>
        {critical
          ? `Credits run out in ${formatRunway(warning.runwayMinutes)} at your sandboxes' current burn. Awake sandboxes freeze when they do; add credits to keep them running.`
          : `Credits cover about ${formatRunway(warning.runwayMinutes)} at your sandboxes' current burn. Add credits to keep them running.`}
      </span>
    </p>
  );
}
