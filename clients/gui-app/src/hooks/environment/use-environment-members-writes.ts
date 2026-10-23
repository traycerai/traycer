import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import type {
  MembersInviteOutcome,
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  TeamRole,
} from "@/components/settings/members/types";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

export interface EnvironmentMembersWrites {
  readonly invite: (input: {
    readonly email: string;
    readonly role: TeamRole;
  }) => Promise<MembersInviteOutcome>;
  readonly setRole: (input: {
    readonly userId: string;
    readonly role: TeamRole;
  }) => Promise<MembersSetRoleOutcome>;
  readonly remove: (input: {
    readonly userId: string;
  }) => Promise<MembersRemoveOutcome>;
  readonly noticeSeen: () => void;
  readonly loadRemovePreview: (
    userId: string,
  ) => Promise<EnvironmentMembersRemovePreviewResponse | null>;
}

/**
 * Members writes against `environment.members.invite` / `.setRole` /
 * `.remove` / `.noticeSeen` / `.removePreview`. A missing client answers
 * `forbidden` / `null` rather than throwing at the call site.
 */
export function useEnvironmentMembersWrites(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string,
): EnvironmentMembersWrites {
  const inviteMutation = useHostScopedMutationForClient(client, {
    method: "environment.members.invite",
    mutationKey: environmentMutationKeys.membersInvite(),
    errorMessage: "Couldn't send that invitation.",
    invalidateMethods: ["environment.members"],
  });
  const setRoleMutation = useHostScopedMutationForClient(client, {
    method: "environment.members.setRole",
    mutationKey: environmentMutationKeys.membersSetRole(),
    errorMessage: "Couldn't change that role.",
    invalidateMethods: ["environment.members"],
  });
  const removeMutation = useHostScopedMutationForClient(client, {
    method: "environment.members.remove",
    mutationKey: environmentMutationKeys.membersRemove(),
    errorMessage: "Couldn't remove that member.",
    invalidateMethods: ["environment.members"],
  });
  const noticeSeenMutation = useHostScopedMutationForClient(client, {
    method: "environment.members.noticeSeen",
    mutationKey: environmentMutationKeys.membersNoticeSeen(),
    errorMessage: "Couldn't dismiss that notice.",
    invalidateMethods: ["environment.members"],
  });

  const invite = useCallback(
    (input: {
      readonly email: string;
      readonly role: TeamRole;
    }): Promise<MembersInviteOutcome> => {
      return inviteMutation
        .mutateAsync({
          environmentId,
          email: input.email,
          role: input.role,
        })
        .then(
          (response): MembersInviteOutcome => response,
          (): MembersInviteOutcome => ({ outcome: "forbidden" }),
        );
    },
    [environmentId, inviteMutation],
  );

  const setRole = useCallback(
    (input: {
      readonly userId: string;
      readonly role: TeamRole;
    }): Promise<MembersSetRoleOutcome> => {
      return setRoleMutation
        .mutateAsync({
          environmentId,
          userId: input.userId,
          role: input.role,
        })
        .then(
          (response): MembersSetRoleOutcome => ({ outcome: response.outcome }),
          (): MembersSetRoleOutcome => ({ outcome: "forbidden" }),
        );
    },
    [environmentId, setRoleMutation],
  );

  const remove = useCallback(
    (input: { readonly userId: string }): Promise<MembersRemoveOutcome> => {
      return removeMutation
        .mutateAsync({
          environmentId,
          userId: input.userId,
        })
        .then(
          (response): MembersRemoveOutcome => response,
          (): MembersRemoveOutcome => ({ outcome: "forbidden" }),
        );
    },
    [environmentId, removeMutation],
  );

  const noticeSeen = useCallback((): void => {
    void noticeSeenMutation.mutateAsync({ environmentId });
  }, [environmentId, noticeSeenMutation]);

  const loadRemovePreview = useCallback(
    (
      userId: string,
    ): Promise<EnvironmentMembersRemovePreviewResponse | null> => {
      if (client === null) return Promise.resolve(null);
      return client
        .request("environment.members.removePreview", {
          environmentId,
          userId,
        })
        .then(
          (response) => response,
          () => null,
        );
    },
    [client, environmentId],
  );

  return {
    invite,
    setRole,
    remove,
    noticeSeen,
    loadRemovePreview,
  };
}
