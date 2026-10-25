import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostMethodVersionUnsatisfiedError } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  RETRY_LABEL,
  inviteSeatCopy,
  inviteSeatsReadFailed,
} from "@/components/settings/members/copy";
import { Button } from "@/components/ui/button";
import { useEnvironmentMembersSeatsQuery } from "@/hooks/environment/use-environment-members-seats-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The invite sheet's seat sentence, read before Invite: the design's
 * sentence and delta for a paid team, nothing for a free one, nothing while
 * it is read or on a host without the read. A failed read says so with
 * Retry; Invite does not wait on it.
 */
export function InviteSeatLine(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly environmentId: string;
  readonly teamName: string;
  /** Whether the host serves `environment.members.seats`. */
  readonly supported: boolean;
}): ReactNode {
  const query = useEnvironmentMembersSeatsQuery(
    props.client,
    props.environmentId,
    props.supported,
  );
  if (!props.supported) return null;
  // A failed read being read again shows nothing until it answers.
  if (query.isError && !query.isFetching) {
    // A connection that negotiated below the method refuses it unsent.
    if (query.error instanceof HostMethodVersionUnsatisfiedError) return null;
    return (
      <p
        className="flex max-w-[72ch] flex-wrap items-baseline gap-x-1 text-ui-sm text-destructive"
        role="status"
        data-testid="members-invite-seats-failed"
      >
        {inviteSeatsReadFailed(props.teamName)}
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={() => {
            void query.refetch();
          }}
        >
          {RETRY_LABEL}
        </Button>
      </p>
    );
  }
  const copy =
    query.data === undefined
      ? null
      : inviteSeatCopy(props.teamName, query.data.seats);
  if (copy === null) return null;
  return (
    <p
      className="max-w-[72ch] text-ui-sm"
      data-testid="members-invite-seat-copy"
    >
      {copy}
    </p>
  );
}
