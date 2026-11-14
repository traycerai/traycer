import { useEffect, useState, type ReactNode } from "react";
import type {
  ProvidersCommitProfileMoveRequest,
  ProvidersCommitProfileMoveResponse,
  ProvidersPreviewProfileMoveRequest,
  ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProfileMoveComputerNames } from "@/hooks/providers/use-profile-move-computer-names";
import { displayTitle } from "@/lib/display-title";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  useProvidersCommitProfileMove,
  useProvidersPreviewProfileMove,
} from "@/hooks/providers/use-profile-move";
import { toastFromHostError } from "@/lib/host-error-toast";
import { MOVE_ERROR_FALLBACKS } from "./profile-move-copy";
import type { SwitchAccountSource } from "@/stores/settings/provider-profile-add-flow-store";
import { alreadySignedInAsText, signedInAsText } from "./profile-sync-copy";
import { ProfileMoveResults } from "./profile-move-results";

export const SWITCH_ACCOUNT_TEXT = "Switch account";

interface SwitchAccountMoveProps {
  readonly providerId: ProviderId;
  readonly source: SwitchAccountSource;
  readonly destination: ProviderProfile;
  readonly moveHostId: string | null;
  readonly teamName: string | null;
  readonly onDone: () => void;
}

interface SwitchAccountMoveSession {
  readonly providerId: ProviderId;
  readonly source: SwitchAccountSource;
  readonly destination: SwitchAccountSource;
  readonly moveHostId: string | null;
  readonly teamName: string | null;
}

type SwitchMoveView =
  | {
      readonly kind:
        | "same"
        | "loading"
        | "unsupported"
        | "no-computer"
        | "error";
    }
  | {
      readonly kind: "question" | "empty";
      readonly preview: ProvidersPreviewProfileMoveResponse;
    }
  | {
      readonly kind: "result";
      readonly preview: ProvidersPreviewProfileMoveResponse;
      readonly result: ProvidersCommitProfileMoveResponse;
    };

function switchMoveView(input: {
  readonly sameAccount: boolean;
  readonly hostId: string | null;
  readonly unsupported: boolean;
  readonly preview: ProvidersPreviewProfileMoveResponse | undefined;
  readonly result: ProvidersCommitProfileMoveResponse | undefined;
  readonly failed: boolean;
}): SwitchMoveView {
  if (input.sameAccount) return { kind: "same" };
  if (input.hostId === null) return { kind: "no-computer" };
  if (input.preview !== undefined && input.result !== undefined) {
    return { kind: "result", preview: input.preview, result: input.result };
  }
  if (input.unsupported) return { kind: "unsupported" };
  if (input.preview !== undefined) {
    return {
      kind: input.preview.targets.length > 0 ? "question" : "empty",
      preview: input.preview,
    };
  }
  return { kind: input.failed ? "error" : "loading" };
}

function useSwitchAccountMove(session: SwitchAccountMoveSession) {
  const client = useHostClientForHostId(session.moveHostId);
  const previewSupport = useHostMethodSupport(
    session.moveHostId,
    "providers.previewProfileMove",
  );
  const commitSupport = useHostMethodSupport(
    session.moveHostId,
    "providers.commitProfileMove",
  );
  const sameAccount =
    session.source.profileId === session.destination.profileId;
  const canPreview =
    !sameAccount &&
    session.moveHostId !== null &&
    previewSupport === true &&
    commitSupport === true;
  const previewRequest: ProvidersPreviewProfileMoveRequest = {
    extent: "fleet",
    mode: "switch",
    source: {
      providerId: session.providerId,
      profileId: session.source.profileId,
    },
  };
  const preview = useProvidersPreviewProfileMove(
    client,
    previewRequest,
    canPreview,
  );
  const commit = useProvidersCommitProfileMove(client);
  const [request, setRequest] =
    useState<ProvidersCommitProfileMoveRequest | null>(null);
  const unsupported =
    previewSupport === false ||
    commitSupport === false ||
    preview.error?.code === "E_HOST_UNSUPPORTED";
  useEffect(() => {
    if (preview.error !== null && preview.error.code !== "E_HOST_UNSUPPORTED") {
      toastFromHostError(preview.error, MOVE_ERROR_FALLBACKS.preview);
    }
  }, [preview.error]);
  const confirm = (): void => {
    const data = preview.data;
    if (
      commit.isPending ||
      !canPreview ||
      data === undefined ||
      data.targets.length === 0
    )
      return;
    const body: ProvidersCommitProfileMoveRequest = request ?? {
      ...previewRequest,
      operationId: crypto.randomUUID(),
      destinationProfileId: session.destination.profileId,
      targets: data.targets.map((target) =>
        target.kind === "agent"
          ? { kind: "agent", epicId: target.epicId, agentId: target.agentId }
          : { kind: "bot", botId: target.botId },
      ),
    };
    setRequest(body);
    commit.mutate(body, {
      onError: (error) =>
        toastFromHostError(error, MOVE_ERROR_FALLBACKS.commit),
    });
  };
  return {
    view: switchMoveView({
      sameAccount,
      hostId: session.moveHostId,
      unsupported,
      preview: preview.data,
      result: commit.data,
      failed: preview.error !== null,
    }),
    pending: commit.isPending,
    previewPending: preview.isFetching,
    retryPreview: () => {
      void preview.refetch();
    },
    confirm,
  };
}

/** A completed sign-in chooses another record before any work is offered for moving. */
export function SwitchAccountMoveDialog(
  props: SwitchAccountMoveProps,
): ReactNode {
  // Retrying an operation keeps the computer and both records that its preview counted.
  const [session] = useState<SwitchAccountMoveSession>(() => ({
    providerId: props.providerId,
    source: props.source,
    destination: {
      profileId: props.destination.profileId,
      label: props.destination.label,
    },
    moveHostId: props.moveHostId,
    teamName: props.teamName,
  }));
  const move = useSwitchAccountMove(session);
  const computerName = useProfileMoveComputerNames();
  const question = move.view.kind === "question";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !move.pending) props.onDone();
      }}
    >
      <DialogContent
        layout="banded"
        className="max-w-xl"
        aria-describedby={undefined}
        showCloseButton={!move.pending}
      >
        <DialogHeader>
          {question ? (
            <p className="text-ui-sm text-muted-foreground">
              {signedInAsText(session.destination.label)}
            </p>
          ) : null}
          <DialogTitle>
            {question
              ? `Move work from ${session.source.label}?`
              : SWITCH_ACCOUNT_TEXT}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5 pb-5">
          <SwitchAccountMoveBody
            session={session}
            view={move.view}
            computerName={computerName}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onDone}
            disabled={move.pending}
          >
            {question ? "Don't move anything" : "Done"}
          </Button>
          {move.view.kind === "error" ? (
            <Button onClick={move.retryPreview} disabled={move.previewPending}>
              {move.previewPending ? <MutedAgentSpinner /> : null}Retry
            </Button>
          ) : null}
          {move.view.kind === "question" ? (
            <Button onClick={move.confirm} disabled={move.pending}>
              {move.pending ? <MutedAgentSpinner /> : null}Move{" "}
              {move.view.preview.targets.length}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwitchAccountMoveBody({
  session,
  view,
  computerName,
}: {
  readonly session: SwitchAccountMoveSession;
  readonly view: SwitchMoveView;
  readonly computerName: (hostId: string | null) => string;
}): ReactNode {
  if (view.kind === "same")
    return (
      <p role="status">{alreadySignedInAsText(session.destination.label)}</p>
    );
  if (view.kind === "result")
    return (
      <SwitchAccountMoveResult
        preview={view.preview}
        result={view.result}
        destinationLabel={session.destination.label}
        computerName={computerName}
      />
    );
  return (
    <>
      {view.kind !== "question" ? (
        <p role="status">{signedInAsText(session.destination.label)}</p>
      ) : null}
      {view.kind === "no-computer" && session.teamName !== null ? (
        <p>{`Nothing was moved. To move agents and bots to ${session.destination.label}, open Switch account on one of ${session.teamName}'s computers.`}</p>
      ) : null}
      {view.kind === "unsupported" ? (
        <p>{`Nothing was moved. ${computerName(session.moveHostId)} is running an older version. Update it, then open Switch account again to move agents and bots to ${session.destination.label}.`}</p>
      ) : null}
      {view.kind === "loading" ? <MutedAgentSpinner /> : null}
      {view.kind === "question" ? (
        <>
          <p>{`${view.preview.targets.length} agents and bots use ${session.source.label}. Move them to ${session.destination.label}, or leave them where they are.`}</p>
          <SwitchAccountTargets
            preview={view.preview}
            computerName={computerName}
          />
        </>
      ) : null}
      {view.kind === "question" || view.kind === "empty"
        ? view.preview.pendingComputers.map((computer) => (
            <p key={computer.hostId} className="text-muted-foreground">
              {computer.reason === "unreachable"
                ? `${computerName(computer.hostId)} can't be reached. Its agents are not counted and will not move now.`
                : `${computerName(computer.hostId)} is running an older version. Update it to move its agents.`}
            </p>
          ))
        : null}
    </>
  );
}

function SwitchAccountTargets({
  preview,
  computerName,
}: {
  readonly preview: ProvidersPreviewProfileMoveResponse;
  readonly computerName: (hostId: string | null) => string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {preview.targets.map((target) => (
        <div
          key={
            target.kind === "agent"
              ? `agent:${target.epicId}:${target.agentId}`
              : `bot:${target.botId}`
          }
        >
          <div className="flex flex-wrap justify-between gap-2">
            <span>{displayTitle(target.title ?? "", "agent")}</span>
            <span className="text-muted-foreground">
              {computerName(target.hostId)}
            </span>
          </div>
          {target.kind === "agent" && target.standing === "running" ? (
            <p className="text-muted-foreground">Moves when its turn ends</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SwitchAccountMoveResult(props: {
  readonly preview: ProvidersPreviewProfileMoveResponse;
  readonly result: ProvidersCommitProfileMoveResponse;
  readonly destinationLabel: string;
  readonly computerName: (hostId: string | null) => string;
}): ReactNode {
  const deferred = props.result.results.filter(
    (entry) => entry.outcome === "deferred",
  ).length;
  return (
    <ProfileMoveResults
      {...props}
      afterMoved={
        deferred > 0 ? (
          <p>
            {deferred === 1
              ? "1 more moves when its turn ends."
              : `${deferred} more move when their turns end.`}
          </p>
        ) : null
      }
    />
  );
}
