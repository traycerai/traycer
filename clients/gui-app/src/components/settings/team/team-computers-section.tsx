import { TeamComputerUnattendedSetup } from "./team-computer-unattended-setup";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useState, type ReactNode } from "react";
import type { TeamComputer } from "@traycer-clients/shared/host-client/team-computers";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCanEditConfiguration } from "@/components/settings/environment/configuration-source";
import {
  usePickedTeamHandle,
  usePickedTeamLabel,
} from "@/components/settings/environment/team-pick-label";
import { useTeamComputers } from "@/hooks/auth/use-team-computers";
import { AddComputerDialog } from "./add-computer-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function TeamComputersSection(props: {
  readonly environmentId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  return (
    <TeamComputers
      key={JSON.stringify([userId, props.environmentId])}
      environmentId={props.environmentId}
    />
  );
}

function TeamComputers(props: { readonly environmentId: string }): ReactNode {
  const { read, claim } = useTeamComputers(props.environmentId);
  const canEdit = useCanEditConfiguration();
  const teamName = usePickedTeamLabel(props.environmentId) ?? "this team";
  const teamHandle = usePickedTeamHandle(props.environmentId);
  const [claiming, setClaiming] = useState<TeamComputer | null>(null);
  const computers = (read.data ?? []).filter(
    (host) => host.hostKind === "personal",
  );
  const busy = claim.isPending;
  let contents: ReactNode;
  if (read.isPending) {
    contents = (
      <p role="status" className="text-ui-sm text-muted-foreground">
        Reading computers…
      </p>
    );
  } else if (read.isError) {
    contents = (
      <p role="alert" className="text-ui-sm">
        {read.error.message}
      </p>
    );
  } else {
    contents =
      computers.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          This team has no computers.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {computers.map((host) => (
            <TeamComputerRow
              key={host.hostId}
              host={host}
              busy={busy}
              onClaim={() => {
                claim.reset();
                setClaiming(host);
              }}
            />
          ))}
        </ul>
      );
  }
  return (
    <section
      aria-label="Computers"
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-base font-medium">Computers</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={read.isFetching}
            onClick={() => {
              void read.refetch();
            }}
          >
            {read.isFetching ? (
              <AgentSpinningDots
                className={undefined}
                testId="team-computers-refresh-progress"
                variant={undefined}
              />
            ) : null}
            Refresh
          </Button>
          {canEdit && teamHandle !== null ? (
            <AddComputerDialog
              teamName={teamName}
              teamSelector={teamHandle}
              unattended={
                <TeamComputerUnattendedSetup
                  environmentId={props.environmentId}
                />
              }
              testId="team-computers-add"
            />
          ) : null}
        </div>
      </div>
      {contents}
      <TeamComputerClaimDialog
        computer={claiming}
        pending={claim.isPending}
        failure={claim.error?.message ?? null}
        onClose={() => setClaiming(null)}
        onClaim={(hostId) =>
          claim.mutate(hostId, {
            onSuccess: () => setClaiming(null),
          })
        }
      />
    </section>
  );
}

function TeamComputerClaimDialog(props: {
  readonly computer: TeamComputer | null;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onClose: () => void;
  readonly onClaim: (hostId: string) => void;
}): ReactNode {
  return (
    <Dialog
      open={props.computer !== null}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogContent className="w-full sm:max-w-prose">
        <DialogHeader>
          <DialogTitle>
            Claim {props.computer?.hostName ?? "the computer"}?
          </DialogTitle>
          <DialogDescription>
            This computer will become yours. The team will lose access to it.
          </DialogDescription>
        </DialogHeader>
        {props.failure !== null ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {props.failure}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={props.pending}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={props.pending}
            onClick={() => {
              if (props.computer !== null) props.onClaim(props.computer.hostId);
            }}
          >
            {props.pending ? (
              <AgentSpinningDots
                className={undefined}
                testId="team-computer-claim-progress"
                variant={undefined}
              />
            ) : null}
            Claim this computer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TeamComputerRow(props: {
  readonly host: TeamComputer;
  readonly busy: boolean;
  readonly onClaim: () => void;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 break-words text-ui-sm">
        {props.host.hostName ?? "Unnamed computer"}
        {props.host.purgePending ? " · Unavailable" : null}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.busy || props.host.purgePending}
        onClick={props.onClaim}
      >
        Claim this computer
      </Button>
    </li>
  );
}
