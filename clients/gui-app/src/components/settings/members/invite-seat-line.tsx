import type { ReactNode } from "react";
import {
  RETRY_LABEL,
  inviteSeatCopy,
  inviteSeatsReadFailed,
} from "@/components/settings/members/copy";
import { Button } from "@/components/ui/button";
import { useEnvironmentMembersSeatsQuery } from "@/hooks/environment/use-environment-members-seats-query";

/**
 * The invite sheet's seat sentence, read before Invite: the design's
 * sentence and delta for a paid team, nothing for a free one, nothing while
 * it is read. A failed read says so with Retry; Invite does not wait on it.
 */
export function InviteSeatLine(props: {
  readonly environmentId: string;
}): ReactNode {
  const query = useEnvironmentMembersSeatsQuery(props.environmentId, true);
  // A failed read being read again shows nothing until it answers.
  if (query.isError && !query.isFetching) {
    return (
      <p
        className="flex max-w-[72ch] flex-wrap items-baseline gap-x-1 text-ui-sm text-destructive"
        role="status"
        data-testid="members-invite-seats-failed"
      >
        {inviteSeatsReadFailed()}
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
    query.data === undefined ? null : inviteSeatCopy(query.data.seats);
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
