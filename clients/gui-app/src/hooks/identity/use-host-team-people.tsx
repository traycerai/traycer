import { use, useCallback, type ReactNode } from "react";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useOptionalHostClient } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The people of the team that owns `hostId`, for everything drawn inside:
 * the team's member directory (`environment.members`), consulted before any
 * directory a surface above already offers. A host no team owns, or one whose
 * owner cannot be read yet, passes the surface above's directory through
 * unchanged, so a personal computer asks for nothing.
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
  const team = directory.resolve;
  const composed = useCallback(
    (userId: string) => team(userId) ?? outer(userId),
    [team, outer],
  );
  return teamId === null ? outer : composed;
}
