import type { ReactNode } from "react";
import { legacyRoleNotice } from "@/components/settings/members/copy";

/**
 * One-time admin notice naming who gained editing. Stays reachable through
 * the rowDetails slot after it is dismissed from this banner.
 */
export function LegacyRoleNotice(props: {
  readonly teamName: string;
  readonly names: readonly string[];
  readonly details: ReactNode;
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
      <div className="shrink-0">{props.details}</div>
    </div>
  );
}
