import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatUnreadCount } from "@/lib/notifications/unread-count";

/**
 * How many unread notifications a row holds, inline beside its label;
 * nothing at zero.
 */
export function UnreadCountBadge(props: {
  readonly count: number;
  readonly size: "xs" | "sm";
  readonly testId: string;
}): ReactNode {
  if (props.count <= 0) return null;
  return (
    <Badge variant="destructive" size={props.size} data-testid={props.testId}>
      <span className="tabular-nums">{formatUnreadCount(props.count)}</span>
      <span className="sr-only"> unread</span>
    </Badge>
  );
}
