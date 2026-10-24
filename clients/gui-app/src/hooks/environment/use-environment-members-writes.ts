import { useCallback } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  MembersInviteOutcome,
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  TeamRole,
} from "@/components/settings/members/types";
import {
  useHostScopedMutationForClient,
  type HostScopedMutationContext,
} from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

type MembersWriteMutation<Method extends keyof HostRpcRegistry & string> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    HostScopedMutationContext<undefined>
  >;

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
  /** The requests behind `invite`, `setRole` and `remove`: their pending state. */
  readonly inviteMutation: MembersWriteMutation<"environment.members.invite">;
  readonly setRoleMutation: MembersWriteMutation<"environment.members.setRole">;
  readonly removeMutation: MembersWriteMutation<"environment.members.remove">;
}

/**
 * Members writes against `environment.members.invite` / `.setRole` /
 * `.remove` / `.noticeSeen`. A missing client answers `forbidden` rather
 * than throwing at the call site.
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

  return {
    invite,
    setRole,
    remove,
    noticeSeen,
    inviteMutation,
    setRoleMutation,
    removeMutation,
  };
}
