import type { ReactNode } from "react";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  deriveAboutThisHost,
  type HostOverviewAboutSource,
} from "@/components/settings/panels/host-overview-installation-model";
import { SettingsGroup } from "@/components/settings/settings-group";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * Installation ▸ About this host: the facts the ACCOUNT actually has for this
 * machine. Unknown facts are not cells — a host that has never checked in is
 * one line under the date it was added.
 *
 * Read from the account's host record, never from the host, so it reads the
 * same whether or not the host can be reached. Platform, version and the host
 * id live in the tab's Details. A host the account has no record of gets no
 * group (the caller passes none), the way it gets no Danger zone.
 */
export function HostOverviewAboutThisHost(
  props: HostOverviewAboutSource,
): ReactNode {
  const about = deriveAboutThisHost(props);
  const compact = useSettingsDensity() === "compact";
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.aboutThisHost}
      showTitle
      tone="default"
      dataTestId="host-overview-about"
      fill={false}
    >
      <div
        className={cn(
          "flex flex-col gap-2",
          compact ? "px-4 py-3" : "px-5 py-4",
        )}
        data-testid="host-overview-about-facts"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-ui-xs uppercase tracking-wide text-muted-foreground">
            Added to account
          </div>
          <div
            className="min-w-0 break-words text-ui-sm text-foreground"
            data-testid="host-overview-about-added"
          >
            {about.addedToAccount}
          </div>
        </div>
        {about.unseenLine === null ? null : (
          <p
            className="min-w-0 break-words text-ui-sm text-muted-foreground"
            data-testid="host-overview-about-last-seen"
          >
            {about.unseenLine}
          </p>
        )}
        {about.lastSeenLine === null ? null : (
          <p
            className="min-w-0 break-words text-ui-sm text-muted-foreground"
            data-testid="host-overview-about-last-seen"
          >
            {about.lastSeenLine}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
