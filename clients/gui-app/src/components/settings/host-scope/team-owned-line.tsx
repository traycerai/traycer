import type { ReactNode } from "react";
import { teamOwnedText } from "@/components/settings/host-scope/host-access-model";

/**
 * A team's host: its settings are the team's, read here. Drawn above the
 * read-only page, outside its inert region, so the line stays usable.
 */
export function TeamOwnedLine(props: { readonly teamName: string }): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
      data-testid="team-owned-line"
    >
      <span className="min-w-0 max-w-[72ch]">
        {teamOwnedText(props.teamName)}
      </span>
    </div>
  );
}
