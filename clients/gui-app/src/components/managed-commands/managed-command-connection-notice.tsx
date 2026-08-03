import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

/**
 * Shown while a managed-command stream is not open. A lost host does not empty
 * the surface - whatever was already read stays put, marked as possibly stale,
 * the way a terminal keeps its last frame. Without it a frozen list or timeline
 * is indistinguishable from a quiet one.
 */
export function ManagedCommandConnectionNotice(props: {
  readonly hasContent: boolean;
  readonly testId: string;
  readonly className: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-ui-xs text-muted-foreground",
        props.className,
      )}
      data-testid={props.testId}
      role="status"
    >
      <AgentSpinningDots
        className="shrink-0 text-muted-foreground/70"
        testId={undefined}
        variant={undefined}
      />
      <span>{props.hasContent ? "Reconnecting…" : "Connecting…"}</span>
    </div>
  );
}
