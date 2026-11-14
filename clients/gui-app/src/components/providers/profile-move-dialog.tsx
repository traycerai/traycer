import { MOVE_ERROR_FALLBACKS } from "./profile-move-copy";
import { displayTitle } from "@/lib/display-title";
import {
  isHostTransportFailure,
  toastFromHostError,
} from "@/lib/host-error-toast";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useEffect, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfileMoveComputerNames } from "@/hooks/providers/use-profile-move-computer-names";
import {
  useProvidersPreviewProfileMove,
  useProvidersCommitProfileMove,
} from "@/hooks/providers/use-profile-move";
import type { HostRpcRegistry } from "@/lib/host";
import { ProfileMoveResults } from "./profile-move-results";
import {
  profileDisplayLabel,
  profileInventoryNotice,
} from "./provider-profile-model";

export function ProfileMoveDialog({
  client,
  source,
  sourceLabel,
  profiles,
  onClose,
  onRestartTerminal,
}: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly source: ProvidersPreviewProfileMoveRequest["source"];
  readonly sourceLabel: string;
  readonly profiles: readonly ProviderProfile[];
  readonly onClose: () => void;
  readonly onRestartTerminal: (
    terminal: ProvidersPreviewProfileMoveResponse["terminals"][number],
  ) => void;
}) {
  // The mounted dialog owns one computer and one source, even if its opener changes.
  const [session] = useState(() => ({
    client,
    source,
    sourceLabel,
    hostId: client.getActiveHostId(),
  }));
  const preview = useProvidersPreviewProfileMove(
    session.client,
    { extent: "fleet", mode: "waiting", source: session.source },
    true,
  );
  const commit = useProvidersCommitProfileMove(session.client);
  const [destinationId, setDestinationId] = useState("");
  const [request, setRequest] =
    useState<ProvidersCommitProfileMoveRequest | null>(null);
  const [destinationLabel, setDestinationLabel] = useState("");
  const computerName = useProfileMoveComputerNames();
  const destinations = profiles.filter(
    (profile) =>
      profile.profileId !== session.source.profileId &&
      profile.enabled &&
      profileInventoryNotice(profile) === null,
  );
  const destination = destinations.find(
    (profile) => profile.profileId === destinationId,
  );
  const previewError = preview.error;
  const commitError = commit.error;
  useEffect(() => {
    reportMoveError(previewError, MOVE_ERROR_FALLBACKS.preview);
  }, [previewError]);
  useEffect(() => {
    reportMoveError(commitError, MOVE_ERROR_FALLBACKS.commit);
  }, [commitError]);
  const result = commit.data;
  const data = preview.data;
  const empty =
    data !== undefined &&
    data.targets.length === 0 &&
    data.pendingComputers.length === 0;
  const confirm = (): void => {
    if (commit.isPending) return;
    if (request !== null) {
      commit.mutate(request);
      return;
    }
    if (
      data === undefined ||
      destination === undefined ||
      data.targets.length === 0
    )
      return;
    const next: ProvidersCommitProfileMoveRequest = {
      operationId: crypto.randomUUID(),
      extent: "fleet",
      mode: "waiting",
      source: session.source,
      destinationProfileId: destination.profileId,
      targets: data.targets.map((target) =>
        target.kind === "agent"
          ? { kind: "agent", epicId: target.epicId, agentId: target.agentId }
          : { kind: "bot", botId: target.botId },
      ),
    };
    setRequest(next);
    setDestinationLabel(profileDisplayLabel(destination));
    commit.mutate(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !commit.isPending) onClose();
      }}
    >
      <DialogContent
        layout="banded"
        className="max-w-xl"
        aria-describedby={undefined}
        showCloseButton={!commit.isPending}
      >
        <DialogHeader>
          <DialogTitle>Move all waiting agents</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <MoveErrorNotice
            error={preview.error}
            computer={computerName(session.hostId)}
            afterCommit={false}
          />
          <MoveErrorNotice
            error={commit.error}
            computer={computerName(session.hostId)}
            afterCommit
          />
          {preview.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {result !== undefined && data !== undefined ? (
            <ProfileMoveResults
              afterMoved={null}
              result={result}
              preview={data}
              destinationLabel={destinationLabel}
              computerName={computerName}
            />
          ) : null}
          {result === undefined && data !== undefined ? (
            <MovePreview
              data={data}
              sourceLabel={session.sourceLabel}
              destinationId={destinationId}
              onDestinationChange={setDestinationId}
              destinationDisabled={request !== null}
              destinations={destinations}
              computerName={computerName}
              terminalDisabled={commit.isPending}
              onRestartTerminal={onRestartTerminal}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={commit.isPending}
          >
            {closeButtonText(result, empty)}
          </Button>
          {result === undefined &&
          data !== undefined &&
          data.targets.length > 0 ? (
            <Button
              onClick={confirm}
              disabled={
                commit.isPending ||
                (request === null && destination === undefined)
              }
            >
              Move {data.targets.length}
              {commit.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovePreview({
  data,
  sourceLabel,
  destinationId,
  onDestinationChange,
  destinationDisabled,
  destinations,
  computerName,
  terminalDisabled,
  onRestartTerminal,
}: {
  readonly data: ProvidersPreviewProfileMoveResponse;
  readonly sourceLabel: string;
  readonly destinationId: string;
  readonly onDestinationChange: (profileId: string) => void;
  readonly destinationDisabled: boolean;
  readonly destinations: readonly ProviderProfile[];
  readonly computerName: (hostId: string | null) => string;
  readonly terminalDisabled: boolean;
  readonly onRestartTerminal: (
    terminal: ProvidersPreviewProfileMoveResponse["terminals"][number],
  ) => void;
}) {
  return (
    <>
      <p>{previewCountText(data, sourceLabel)}</p>
      {data.targets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-move-destination">Move to</Label>
          <Select
            value={destinationId}
            onValueChange={onDestinationChange}
            disabled={destinationDisabled}
          >
            <SelectTrigger id="profile-move-destination" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((profile) => (
                <SelectItem key={profile.profileId} value={profile.profileId}>
                  {profileDisplayLabel(profile)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {data.terminals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Terminal agents</h3>
          <p className="text-muted-foreground">
            These run in a terminal and are not moved. Restart each one on
            another profile.
          </p>
          {data.terminals.map((terminal) => (
            <div
              key={`${terminal.epicId}:${terminal.agentId}`}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <div>
                {displayTitle(terminal.title ?? "", "agent")}
                <span className="ml-2 text-muted-foreground">
                  {computerName(terminal.hostId)}
                </span>
              </div>
              <Button
                variant="link"
                size="inline-xs"
                onClick={() => onRestartTerminal(terminal)}
                disabled={terminalDisabled}
              >
                Restart on another profile
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      {data.pendingComputers.map((computer) => (
        <p key={computer.hostId} className="text-muted-foreground">
          {computer.reason === "unreachable"
            ? `${computerName(computer.hostId)} can't be reached. Its agents are not counted and will not move now.`
            : `${computerName(computer.hostId)} is running an older version. Update it to move its agents.`}
        </p>
      ))}
    </>
  );
}

function previewCountText(
  data: ProvidersPreviewProfileMoveResponse,
  profile: string,
): string {
  if (data.targets.length === 0 && data.pendingComputers.length === 0)
    return `No agents or bots are waiting on ${profile}.`;
  if (data.targets.length === 1) return `1 agent is waiting on ${profile}.`;
  return `${data.targets.length} agents and bots are waiting on ${profile}.`;
}

function closeButtonText(
  result: ProvidersCommitProfileMoveResponse | undefined,
  empty: boolean,
): string {
  if (result !== undefined) return "Done";
  return empty ? "Close" : "Cancel";
}

function reportMoveError(error: HostRpcError | null, fallback: string): void {
  if (
    error === null ||
    error.code === "E_HOST_UNSUPPORTED" ||
    isHostTransportFailure(error)
  )
    return;
  toastFromHostError(error, fallback);
}

function MoveErrorNotice({
  error,
  computer,
  afterCommit,
}: {
  readonly error: HostRpcError | null;
  readonly computer: string;
  readonly afterCommit: boolean;
}) {
  if (error === null) return null;
  if (error.code === "E_HOST_UNSUPPORTED")
    return (
      <p role="status">{`${computer} is running an older version. Update it to move its agents.`}</p>
    );
  if (!isHostTransportFailure(error)) return null;
  if (afterCommit)
    return (
      <section role="status">
        <h3 className="font-medium">Still waiting</h3>
        <p>{`${computer} can't be reached. These move when you run this again while it is online.`}</p>
      </section>
    );
  return (
    <p role="status">{`${computer} can't be reached. Its agents are not counted and will not move now.`}</p>
  );
}
