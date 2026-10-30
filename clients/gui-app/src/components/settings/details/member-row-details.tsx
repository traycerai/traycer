import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";

/**
 * A member's current status and the history the reader may see.
 *
 * `roleLabel` travels with the subject because the drawer cannot read it: a
 * member's role is committed inside the item's value, and `environment.history`
 * ships no values. `null` on the page's own subject, which names no member.
 */
export interface MemberRowDetailsProps {
  readonly environmentId: string;
  readonly userId: string;
  readonly roleLabel: string | null;
}

export function MemberRowDetails(props: MemberRowDetailsProps): ReactNode {
  return (
    <SettingsDetailsButton
      subject={{
        environmentId: props.environmentId,
        kind: "member",
        key: props.userId,
        roleLabel: props.roleLabel,
      }}
      title="Member details"
      controls={null}
    />
  );
}
