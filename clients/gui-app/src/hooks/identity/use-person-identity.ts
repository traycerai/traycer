import { createContext, use, useCallback, useMemo } from "react";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  flattenCollaborators,
  type EpicCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import {
  resolvePersonIdentity,
  type PersonIdentity,
} from "@/lib/identity/person-identity";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const NO_COLLABORATORS: ReadonlyArray<EpicCollaboratorView> = [];

/** The environment's members, where a surface above has them to offer. */
export const PersonMembersContext = createContext<BotMemberResolver>(
  UNRESOLVED_BOT_MEMBERS,
);

/**
 * Who a user id is, from what is already loaded; this asks for nothing itself.
 * See {@link resolvePersonIdentity} for the order.
 */
export function usePersonIdentity(userId: string): PersonIdentity | null {
  return usePersonIdentityResolver()(userId);
}

/** {@link usePersonIdentity} for a surface that names several people. */
export function usePersonIdentityResolver(): (
  userId: string,
) => PersonIdentity | null {
  const viewer = useAuthStore((state) => state.profile);
  const collaborators = useLoadedTaskCollaborators();
  const resolveMember = use(PersonMembersContext);
  return useCallback(
    (userId) =>
      resolvePersonIdentity({ viewer, collaborators, resolveMember }, userId),
    [viewer, collaborators, resolveMember],
  );
}

/**
 * The surrounding task's `epic.listCollaborators` as its other readers left it
 * in the cache: the session host's entry, observed with fetching off. Withheld
 * without a cloud verdict, as `useEpicCollaboratorsQuery` withholds it,
 * whatever the cache still holds.
 */
function useLoadedTaskCollaborators(): ReadonlyArray<EpicCollaboratorView> {
  const session = use(EpicSessionContext);
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const { data } = useHostQuery({
    cacheKeyIdentity: undefined,
    client: session === null ? null : client,
    method: "epic.listCollaborators",
    params: { epicId: session?.epicId ?? "" },
    options: { enabled: false, poll: false },
  });
  return useMemo(
    () =>
      !cloudAuthorized || data === undefined
        ? NO_COLLABORATORS
        : flattenCollaborators(data.collaborators),
    [cloudAuthorized, data],
  );
}
