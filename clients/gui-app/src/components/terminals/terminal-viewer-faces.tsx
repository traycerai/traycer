import { useSyncExternalStore, type ReactNode } from "react";
import { useStore, type StoreApi, type UseBoundStore } from "zustand";
import { PersonAvatar } from "@/components/bots/bot-avatars";
import { AvatarGroup } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HostTeamPeopleProvider } from "@/hooks/identity/use-host-team-people";
import { usePersonIdentityResolver } from "@/hooks/identity/use-person-identity";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";
import type { TerminalSessionState } from "@/stores/terminals/terminal-session-store";

/** Faces drawn before the rest fold into "+N" (board C16). */
const SHOWN_VIEWERS = 3;

function subscribeToSessions(listener: () => void): () => void {
  return getTerminalSessionRegistry().subscribe(listener);
}

/**
 * Who has this terminal on screen, as the host publishes it
 * (`terminal.subscribe@1.8`'s `viewers` frame): a picture per person, the
 * first three and "+N" for the rest, each name on hover. Nothing while the
 * set is unknown (no frame yet, or a host older than 1.8) or empty.
 */
export function TerminalViewerFaces(props: {
  readonly instanceId: string;
  readonly hostId: string;
}): ReactNode {
  const readHandle = () => getTerminalSessionRegistry().get(props.instanceId);
  const handle = useSyncExternalStore(
    subscribeToSessions,
    readHandle,
    readHandle,
  );
  if (handle === null) return null;
  // A tab's title row sits outside its tile, so it reads the host's team
  // directory itself.
  return (
    <HostTeamPeopleProvider hostId={props.hostId}>
      <ViewerFaces store={handle.store} />
    </HostTeamPeopleProvider>
  );
}

function ViewerFaces(props: {
  readonly store: UseBoundStore<StoreApi<TerminalSessionState>>;
}): ReactNode {
  const viewers = useStore(props.store, (state) => state.viewers);
  const identify = usePersonIdentityResolver();
  if (viewers === null || viewers.length === 0) return null;
  const people = viewers.map((userId) => {
    const identity = identify(userId);
    return {
      userId,
      name: identity?.displayName ?? "",
      avatarUrl: identity?.avatarUrl ?? null,
    };
  });
  const shown = people.slice(0, SHOWN_VIEWERS);
  const rest = people.slice(SHOWN_VIEWERS);
  return (
    <span
      data-testid="terminal-viewers"
      className="flex shrink-0 items-center gap-1"
    >
      <AvatarGroup>
        {shown.map((person) => (
          <Tooltip key={person.userId}>
            <TooltipTrigger asChild>
              <span data-shape="circle" className="inline-flex rounded-full">
                <PersonAvatar
                  userId={person.userId}
                  name={person.name}
                  avatarUrl={person.avatarUrl}
                  size="xs"
                />
              </span>
            </TooltipTrigger>
            {person.name.length === 0 ? null : (
              <TooltipContent>{person.name}</TooltipContent>
            )}
          </Tooltip>
        ))}
      </AvatarGroup>
      {rest.length === 0 ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="terminal-viewers-more"
              className="text-ui-xs text-muted-foreground"
            >
              +{rest.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {rest
              .map((person) => person.name)
              .filter((name) => name.length > 0)
              .join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
