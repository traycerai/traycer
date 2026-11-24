import type { ReactNode } from "react";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { OverviewCardDatedLines } from "@/components/settings/environment/overview-card-dated-lines";
import {
  SettingsDetailsButton,
  SettingsDetailsDialog,
} from "@/components/settings/details/settings-details-button";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";

/**
 * Opens the named host's configuration, independently of the Environment pick.
 */
export function OverviewCardDetailsLine(
  props: OverviewCardLineProps,
): ReactNode {
  const subject = useHostSettingsDetailsSubject(props, false);
  return (
    <SettingsDetailsButton
      subject={subject}
      title="Settings"
      controls={<OverviewCardDatedLines {...props} />}
    />
  );
}

/** The Overview owns this opening independently of the Settings row. */
export function OverviewCardDetailsDialog(
  props: OverviewCardLineProps & {
    readonly confirmBlocked: boolean;
    readonly onClose: () => void;
  },
): ReactNode {
  const subject = useHostSettingsDetailsSubject(props, true);
  return (
    <SettingsDetailsDialog
      subject={subject}
      title="Settings"
      controls={<OverviewCardDatedLines {...props} />}
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      initialTab="status"
    />
  );
}
