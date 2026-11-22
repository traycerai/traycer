import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatUnreadCount } from "@/lib/notifications/unread-count";

/**
 * How many unread notifications a row or glyph holds, or how many things of
 * another kind a tab lists (`noun` names them); nothing at zero.
 *
 * Unread is information, not a failure, so the count is never `destructive`.
 * Inline beside a label it is the filled `secondary` tag the channel
 * column's Threads pill wears, so the column reads in one tone, and it
 * announces itself as the count and its `noun` ("3 unread"). Seated on a
 * glyph's corner (`corner` holds the placement classes) it is the solid
 * primary fill the phone bell's count uses, hidden from assistive tech,
 * because the control it sits on carries the count in its own label.
 */
export function UnreadCountBadge(props: {
  readonly count: number;
  readonly size: "xs" | "sm";
  readonly testId: string;
  readonly corner: string | null;
  /** What the count counts, read after it where it announces itself. */
  readonly noun: string;
}): ReactNode {
  if (props.count <= 0) return null;
  if (props.corner !== null) {
    return (
      <Badge
        variant="default"
        size={props.size}
        aria-hidden
        data-testid={props.testId}
        className={props.corner}
      >
        <span className="tabular-nums">{formatUnreadCount(props.count)}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" size={props.size} data-testid={props.testId}>
      <span className="tabular-nums">{formatUnreadCount(props.count)}</span>
      <span className="sr-only"> {props.noun}</span>
    </Badge>
  );
}
