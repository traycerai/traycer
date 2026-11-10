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
  const { read, setBotHost, release } = useTeamComputers(props.environmentId);
  const canEdit = useCanEditConfiguration();
  const teamName = usePickedTeamLabel(props.environmentId) ?? "this team";
  const [returning, setReturning] = useState<TeamComputer | null>(null);
  const computers = (read.data ?? []).filter(
    (host) => host.hostKind === "personal",
  );
  const botHost = (read.data ?? []).find(
    (host) => host.holdsBotSlot && !host.purgePending,
  );
  const busy = setBotHost.isPending || release.isPending;
  let contents: ReactNode;
  if (read.isPending) {
    contents = (
      <p role="status" className="text-ui-sm text-muted-foreground">
        Reading computers…
      </p>
    );
  } else if (read.isError) {
    contents = (
      <div role="alert" className="text-ui-sm">
        <p>Could not read this team's computers.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void read.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
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
                canEdit={canEdit}
                busy={busy}
                onReturn={() => {
                  release.reset();
                  setReturning(host);
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
        {canEdit ? (
          <AddComputerDialog
            teamName={teamName}
            teamSelector={props.environmentId}
            unattended={null}
            testId="team-computers-add"
          />
        ) : null}
      </div>
      {contents}
      {setBotHost.error !== null ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {setBotHost.error.message}
        </p>
      ) : null}
      <Dialog
        open={returning !== null}
        onOpenChange={(open) => {
          if (!open && !release.isPending) setReturning(null);
        }}
      >
        <DialogContent className="w-full sm:max-w-prose">
          <DialogHeader>
            <DialogTitle>
              Return {returning?.hostName ?? "this computer"} to its owner?
            </DialogTitle>
            <DialogDescription>
              The team will lose access to this computer. Its owner will be
              notified.
            </DialogDescription>
          </DialogHeader>
          {release.error !== null ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {release.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={release.isPending}
              onClick={() => setReturning(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={release.isPending || !canEdit}
              onClick={() => {
                if (returning !== null && canEdit)
                  release.mutate(returning.hostId, {
                    onSuccess: () => setReturning(null),
                  });
              }}
            >
              {release.isPending ? "Returning…" : "Return computer"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
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
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onReturn: () => void;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 break-words text-ui-sm">
        {props.host.hostName ?? "Unnamed computer"}
        {props.host.purgePending ? " · Return pending" : null}
        {!props.host.purgePending && props.host.holdsBotSlot
          ? " · Runs the team's bots"
          : null}
      </span>
      {props.canEdit ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy || props.host.purgePending}
          onClick={props.onReturn}
        >
          Return this computer to its owner
        </Button>
      ) : null}
    </li>
  );
}
