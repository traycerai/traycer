import type { ReactNode } from "react";
import { Clock } from "lucide-react";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDoorState } from "@/stores/host/host-door-state-store";

/**
 * The window's host could not renew this account's access, and keeps the
 * connection meanwhile. One quiet line where the host update banner sits: it
 * blocks nothing, has no button and no dismiss, and goes when a renewal
 * succeeds and clears the state.
 */
export function AccessCheckNotice(): ReactNode {
  const doorState = useHostDoorState(useEffectiveHostId());
  if (doorState?.kind !== "access-check-delayed") return null;
  return (
    <div
      role="status"
      data-testid="access-check-notice"
      className="flex items-center gap-2 rounded-md border border-border/60 bg-foreground/3 px-3 py-2 text-ui-sm text-muted-foreground"
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>Access checks are delayed. You can keep working.</span>
    </div>
  );
}
