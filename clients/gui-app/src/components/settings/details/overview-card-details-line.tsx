import type { ReactNode } from "react";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { OverviewCardDatedLines } from "@/components/settings/environment/overview-card-dated-lines";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";

/**
 * Opens the named host's configuration, independently of the Environment pick.
 */
export function OverviewCardDetailsLine(
  props: OverviewCardLineProps & {
    readonly currentStatus: string | null;
  },
): ReactNode {
  const subject = useHostSettingsDetailsSubject(props);
  return (
    <SettingsDetailsButton
      currentStatus={props.currentStatus}
      subject={subject}
      title="Settings"
      controls={<OverviewCardDatedLines {...props} />}
    />
  );
}
