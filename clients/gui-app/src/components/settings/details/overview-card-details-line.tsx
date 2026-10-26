import type { ReactNode } from "react";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";

/**
 * Opens the named host's configuration, independently of the Environment pick.
 */
export function OverviewCardDetailsLine(
  props: OverviewCardLineProps,
): ReactNode {
  const subject = useHostSettingsDetailsSubject(props);
  if (subject === null) return null;
  return (
    <SettingsDetailsButton subject={subject} title="Settings" controls={null} />
  );
}
