import type { ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProfileCopyDraftStatusQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import type { ProfileCopyAttempt } from "@/lib/profile-copy/profile-copy-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { ProfileCopyDraftPanel } from "./profile-copy-draft-panel";
import {
  openProfileCopySourceOperation,
  retryFromSourceOffered,
} from "./profile-copy-source-operation";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "./profile-copy-shared";

/**
 * One draft waiting on this destination, opened from its Incoming list. The
 * route it was previewed with is not on the wire, so Sign in is offered and
 * withdrawn for the revision if the destination refuses it (Q4 ruling).
 */
export function ProfileCopyIncomingDraftView(props: {
  readonly attempt: ProfileCopyAttempt;
  readonly profileName: string;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { attempt, hosts } = props;
  const closeFlow = useProfileCopyFlowStore((state) => state.close);
  const draft = useProfileCopyDraftStatusQuery(attempt, true);
  const destinationName = hosts.nameFor(attempt.destinationHostId);
  const sourceName = hosts.nameFor(attempt.sourceHostId);
  const names = {
    source: sourceName,
    destination: destinationName,
    provider: profileCopyProviderLabel(attempt.providerId),
    profile: props.profileName,
  };
  const outcome = draft.data?.outcome ?? null;

  return (
    <>
      <DialogHeader className="gap-1.5">
        <DialogTitle>
          “{props.profileName}” on {destinationName}
        </DialogTitle>
        <DialogDescription>
          Copied from {sourceName}. Agents can&apos;t use it until it finishes,
          and it never appears in profile pickers before then.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
        {outcome === null && draft.isPending ? (
          <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
            <MutedAgentSpinner />
            Checking {destinationName}…
          </div>
        ) : null}
        {outcome === null && draft.isError ? (
          <p className="text-ui-xs text-destructive" role="alert">
            {draft.error.code === "E_HOST_UNSUPPORTED"
              ? `Update Traycer on ${destinationName} to continue here.`
              : profileCopyRequestErrorText(draft.error, destinationName)}
          </p>
        ) : null}
        {outcome !== null ? (
          <ProfileCopyDraftPanel
            outcome={outcome}
            names={names}
            route={null}
            cancelRequested={false}
            destinationIsLocal={hosts.isLocalMachine(attempt.destinationHostId)}
            extraActions={
              retryFromSourceOffered(outcome) ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => openProfileCopySourceOperation(attempt)}
                >
                  Retry from {sourceName}
                </Button>
              ) : null
            }
          />
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeFlow}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
