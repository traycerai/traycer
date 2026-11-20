import type { ReactNode } from "react";

export function BotUnreadDivider(): ReactNode {
  return (
    <div
      role="separator"
      aria-label="New"
      data-unread-divider=""
      className="flex items-center gap-2 py-2 text-ui-xs font-medium text-destructive"
    >
      <span className="h-px flex-1 bg-destructive" />
      <span>New</span>
      <span className="h-px flex-1 bg-destructive" />
    </div>
  );
}
