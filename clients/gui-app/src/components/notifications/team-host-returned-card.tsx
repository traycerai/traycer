import type { ReactNode } from "react";
import { teamHostReturnedBody } from "@/components/settings/members/copy";

/**
 * Extra content for `team.host.returned`. Details: `kind: "member", key: ""`.
 */
export function TeamHostReturnedCard(props: {
  readonly hostName: string;
  readonly teamName: string;
  readonly details: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1.5 text-ui-xs"
      data-testid="team-host-returned-card"
    >
      <p data-testid="team-host-returned-body">
        {teamHostReturnedBody(props.hostName, props.teamName)}
      </p>
      {props.details}
    </div>
  );
}
