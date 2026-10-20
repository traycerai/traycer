import type { ReactNode } from "react";
import { DashboardLinkButton } from "@/components/settings/host-scope/dashboard-link-button";
import { teamOwnedText } from "@/components/settings/host-scope/host-access-model";
import { settingsDashboardUrl } from "@/lib/sandboxes/secrets-dashboard";

/**
 * A team's host: its settings are the team's, read here and changed in the
 * dashboard. Drawn above the read-only page, outside its inert region, so it
 * and its link stay usable.
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
      {/* With no team name there is no team page to open. */}
      {props.teamName === "" ? null : (
        <DashboardLinkButton
          page={(signInUrl) => settingsDashboardUrl(signInUrl, props.teamName)}
          label="Open the dashboard"
          testId="team-owned-dashboard-link"
        />
      )}
    </div>
  );
}
