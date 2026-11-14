import {
  use,
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import type { EnvironmentPersonResult } from "@traycer-clients/shared/auth/environment-people";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import type { BotMember, BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useHostBinding, useOptionalHostClient } from "@/lib/host";
import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";
import { authQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The people of the team that owns `hostId`, for everything drawn inside:
 * the team's member directory (`environment.members`), consulted before any
 * directory a surface above already offers, and for an id no directory names
 * once the team's is complete, authn's person read, which still names someone
 * who has left the team. A host no team owns, or one whose owner cannot be
 * read yet, passes the surface above's directory through unchanged, so a
 * personal computer asks for nothing.
 */
export function HostTeamPeopleProvider(props: {
  readonly hostId: string;
  readonly children: ReactNode;
}): ReactNode {
  const resolveMember = useHostTeamMembers(props.hostId);
  return (
    <PersonMembersContext value={resolveMember}>
      {props.children}
    </PersonMembersContext>
  );
}

function useHostTeamMembers(hostId: string): BotMemberResolver {
  const outer = use(PersonMembersContext);
  const teamId = useHostOwnerTeamId(hostId);
  // The directory is a pool-tier read, so any client of this runtime reaches
  // it; optional, because a tile under test renders with no runtime.
  const client = useOptionalHostClient();
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const directory = useEnvironmentMemberDirectory(
    client,
    teamId,
    teamId !== null && cloudAuthorized && membersSupported,
  );
  const former = useFormerMembers(
    teamId,
    cloudAuthorized && directory.members !== null,
  );
  const team = directory.resolve;
  const composed = useCallback(
    (userId: string) => team(userId) ?? outer(userId) ?? former(userId),
    [team, outer, former],
  );
  return teamId === null ? outer : composed;
}

/**
 * The ids a surface asked about that no directory names, gathered during
 * render and published after it: a resolver is a plain function a render
 * calls, so it records the miss here and the provider asks authn on the next
 * render, never inside the one that missed.
 */
class MissedPeople {
  private readonly ids = new Set<string>();
  private published: ReadonlyArray<string> = [];
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  miss(userId: string): void {
    if (this.ids.has(userId)) return;
    this.ids.add(userId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.published = [...this.ids];
      for (const listener of this.listeners) listener();
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly read = (): ReadonlyArray<string> => this.published;
}

/**
 * authn's person read for each id the team's complete directory does not
 * name, asked once per id for the life of the session. A 404
 * `person_not_found`, or a read that failed, names nobody, and the surface
 * shows the id it has.
 */
function useFormerMembers(
  teamId: string | null,
  readable: boolean,
): BotMemberResolver {
  const auth = useHostBinding()?.auth ?? null;
  const viewerId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const [missed] = useState(() => new MissedPeople());
  const asked = useSyncExternalStore(
    missed.subscribe,
    missed.read,
    missed.read,
  );
  const named = useQueries({
    queries: asked.map((userId) =>
      queryOptions({
        queryKey: authQueryKeys.environmentPerson(
          auth,
          viewerId,
          teamId,
          userId,
        ),
        enabled: readable && auth !== null && teamId !== null,
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: ({ signal }): Promise<EnvironmentPersonResult> => {
          if (auth === null || teamId === null) {
            throw new Error("No sign-in to read this person with.");
          }
          return auth.readEnvironmentPerson(teamId, userId, signal);
        },
      }),
    ),
    combine: namedPeople,
  });
  return useCallback(
    (userId: string) => {
      if (!readable || userId === SYSTEM_ACTOR_ID || userId === viewerId) {
        return null;
      }
      const person = named.get(userId);
      if (person !== undefined) return person;
      missed.miss(userId);
      return null;
    },
    [readable, viewerId, named, missed],
  );
}

/**
 * The people the answered reads name, by id. Module-level so the query
 * observer keeps one result while the answers do not change.
 */
function namedPeople(
  answers: ReadonlyArray<{
    readonly data: EnvironmentPersonResult | undefined;
  }>,
): ReadonlyMap<string, BotMember> {
  const byUserId = new Map<string, BotMember>();
  for (const answer of answers) {
    if (answer.data?.kind !== "found") continue;
    const person = answer.data.person;
    byUserId.set(person.userId, {
      displayName: person.name ?? person.handle,
      avatarUrl: person.avatarUrl,
    });
  }
  return byUserId;
}
