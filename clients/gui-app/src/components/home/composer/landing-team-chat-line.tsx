import type { ReactNode } from "react";
import {
  teamFirstChatLine,
  type LandingOwnerTeam,
} from "@/components/home/composer/landing-owner-model";

/** The first-chat line under a team sandbox: who will read the first chat. */
export function LandingTeamChatLine(props: {
  readonly owner: LandingOwnerTeam | null;
}): ReactNode {
  if (props.owner === null) return null;
  return (
    <p
      className="m-0 px-1 text-ui-xs text-muted-foreground"
      data-testid="landing-team-first-chat-line"
    >
      {teamFirstChatLine(props.owner.slug)}
    </p>
  );
}
