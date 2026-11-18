import type { ReactNode } from "react";
import {
  DISMISS_LABEL,
  legacyRoleNotice,
} from "@/components/settings/members/copy";
import { Button } from "@/components/ui/button";

/**
 * One-time admin notice naming who gained editing. It stays until the admin
 * dismisses it, and only Dismiss marks it seen; afterwards it is still
 * reachable through the rowDetails slot.
 */
export function LegacyRoleNotice(props: {
  readonly teamName: string;
  readonly names: readonly string[];
  readonly details: ReactNode;
  readonly onDismiss: () => void;
}): ReactNode {
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-ui-sm"
      data-testid="members-legacy-notice"
      role="status"
    >
      <p className="min-w-0 max-w-[72ch]">
        {legacyRoleNotice(props.teamName, props.names)}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {props.details}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onDismiss}
          data-testid="members-legacy-notice-dismiss"
        >
          {DISMISS_LABEL}
        </Button>
      </div>
    </div>
  );
}
