import type { EpicCollaboratorView } from "@/hooks/epics/use-epic-collaborators-query";
import { normalizeAvatarUrl } from "@/lib/avatar-url";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import type { AuthProfile } from "@/stores/auth/auth-store";

/**
 * Who a user id is, as far as the GUI knows. `displayName` is null when the
 * source names them no better than their id, so the caller keeps the name it
 * has; `avatarUrl` is null when there is no picture.
 */
export interface PersonIdentity {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface PersonIdentitySources {
  readonly viewer: AuthProfile | null;
  readonly collaborators: ReadonlyArray<EpicCollaboratorView>;
  readonly resolveMember: BotMemberResolver;
}

/**
 * The viewer's own profile, else the task's collaborators, else the
 * environment's members, else null. A collaborator row with no profile only
 * repeats the id it was asked about, so it does not stop the search.
 */
export function resolvePersonIdentity(
  sources: PersonIdentitySources,
  userId: string,
): PersonIdentity | null {
  if (sources.viewer?.userId === userId) {
    return identity(
      userId,
      sources.viewer.userName,
      sources.viewer.avatarUrl ?? null,
    );
  }
  for (const row of sources.collaborators) {
    if (row.userId !== userId) continue;
    const collaborator = identity(userId, row.displayName, row.avatarUrl);
    if (collaborator.displayName !== null || collaborator.avatarUrl !== null) {
      return collaborator;
    }
  }
  const member = sources.resolveMember(userId);
  return member === null
    ? null
    : identity(userId, member.displayName, member.avatarUrl);
}

function identity(
  userId: string,
  displayName: string | null,
  avatarUrl: string | null,
): PersonIdentity {
  const name = displayName?.trim() ?? "";
  return {
    userId,
    displayName: name.length === 0 || name === userId ? null : name,
    avatarUrl: normalizeAvatarUrl(avatarUrl),
  };
}
