import { TeamComputerUnattendedSetup } from "./team-computer-unattended-setup";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useState, type ReactNode } from "react";
import type { TeamComputer } from "@traycer-clients/shared/host-client/team-computers";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCanEditConfiguration } from "@/components/settings/environment/configuration-source";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const { read, setBotHost, claim } = useTeamComputers(props.environmentId);
  const canEdit = useCanEditConfiguration();
  const teamName = usePickedTeamLabel(props.environmentId) ?? "this team";
  const [claiming, setClaiming] = useState<TeamComputer | null>(null);
  const computers = (read.data ?? []).filter(
    (host) => host.hostKind === "personal",
  );
  const botHost = (read.data ?? []).find(
    (host) => host.holdsBotSlot && !host.purgePending,
  );
  const busy = setBotHost.isPending || claim.isPending;
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
        Could not read this team's computers.
      </p>
    );
  } else {
    contents = (
      <>
        <TeamBotHostPicker
          computers={computers}
          botHost={botHost ?? null}
          canEdit={canEdit}
          busy={busy}
          onChoose={(host) =>
            setBotHost.mutate({
              hostId: host.hostId,
              sharingGeneration: host.sharingGeneration,
            })
          }
        />
        {computers.length === 0 ? (
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
        )}
      </>
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
          {canEdit ? (
            <AddComputerDialog
              teamName={teamName}
              teamSelector={props.environmentId}
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
      {setBotHost.error !== null ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {setBotHost.error.message}
        </p>
      ) : null}
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

function TeamBotHostPicker(props: {
  readonly computers: readonly TeamComputer[];
  readonly botHost: TeamComputer | null;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onChoose: (host: TeamComputer) => void;
}): ReactNode {
  const selected = props.computers.find(
    (host) => host.hostId === props.botHost?.hostId,
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-ui-sm font-medium">Run the team's bots on</p>
        <p className="text-ui-xs text-muted-foreground">
          {props.botHost?.hostName ?? "No bot host chosen"}
        </p>
      </div>
      <Select
        value={selected?.hostId ?? ""}
        disabled={
          !props.canEdit ||
          props.busy ||
          props.computers.every((host) => host.purgePending)
        }
        onValueChange={(hostId) => {
          const host = props.computers.find((row) => row.hostId === hostId);
          if (host !== undefined && !host.purgePending && !host.holdsBotSlot)
            props.onChoose(host);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full sm:w-auto"
          aria-label="Bot host"
        >
          <SelectValue placeholder="Choose a computer" />
        </SelectTrigger>
        <SelectContent>
          {props.computers.map((host) => (
            <SelectItem
              key={host.hostId}
              value={host.hostId}
              disabled={host.purgePending}
            >
              {host.hostName ?? "Unnamed computer"}
              {host.holdsBotSlot ? " · Current bot host" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
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
        {!props.host.purgePending && props.host.holdsBotSlot
          ? " · Runs the team's bots"
          : null}
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
