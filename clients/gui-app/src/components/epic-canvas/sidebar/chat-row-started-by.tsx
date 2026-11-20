import type { ReactElement } from "react";
import { HostTeamPeopleProvider } from "@/hooks/identity/use-host-team-people";
import { usePersonIdentity } from "@/hooks/identity/use-person-identity";
import { startedByText } from "@/lib/identity/started-by";

/** The hover's "Started by <name>", named from the team computer's directory. */
export function ChatRowStartedBy(props: {
  readonly hostId: string;
  readonly starterUserId: string;
}): ReactElement {
  return (
    <HostTeamPeopleProvider hostId={props.hostId}>
      <StartedByName starterUserId={props.starterUserId} />
    </HostTeamPeopleProvider>
  );
}

function StartedByName(props: { readonly starterUserId: string }) {
  const identity = usePersonIdentity(props.starterUserId);
  return (
    <span data-testid="chat-row-started-by" className="break-words">
      {startedByText(props.starterUserId, identity?.displayName ?? null)}
    </span>
  );
}
