import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";

/**
 * A member's current status and the history the reader may see.
 */
export interface MemberRowDetailsProps {
  readonly environmentId: string;
  readonly userId: string;
}

export function MemberRowDetails(props: MemberRowDetailsProps): ReactNode {
  return (
    <SettingsDetailsButton
      subject={{
        environmentId: props.environmentId,
        kind: "member",
        key: props.userId,
      }}
      title="Member details"
    />
  );
}
