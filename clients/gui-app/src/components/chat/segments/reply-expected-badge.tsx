import type { ReactNode } from "react";

/**
 * "Reply expected" indicator shown next to the agent-name link in a sent or
 * received A2A message header.
 */
export function ReplyExpectedBadge(): ReactNode {
  return (
    <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 text-overline font-medium uppercase text-primary">
      reply expected
    </span>
  );
}
