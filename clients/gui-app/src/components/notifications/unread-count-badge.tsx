import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatUnreadCount } from "@/lib/notifications/unread-count";

/**
 * How many unread notifications a row or glyph holds; nothing at zero.
 *
 * Unread is information, not a failure, so the count wears the bell's
 * plain-unread primary tone, never `destructive`. Inline beside a label it is
 * the `accent` tint and announces itself. Seated on a glyph's corner
 * (`corner` holds the placement classes) it is the solid `default` fill the
 * phone bell's count uses: `text-primary` on the 15% tint falls under 3:1 on
 * the strip's ground in several presets, and the solid fill reads on any
 * ground. A corner count is hidden from assistive tech, because the control
 * it sits on carries the count in its own label.
 */
export function UnreadCountBadge(props: {
  readonly count: number;
  readonly size: "xs" | "sm";
  readonly testId: string;
  readonly corner: string | null;
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
    <Badge variant="accent" size={props.size} data-testid={props.testId}>
      <span className="tabular-nums">{formatUnreadCount(props.count)}</span>
      <span className="sr-only"> unread</span>
    </Badge>
  );
}
