import { useEffect, useRef, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import {
  MoveExportDiagnosticsButton,
  MoveRetryButton,
} from "@/components/settings/move/move-progress-line";
import {
  hostSettingsCardState,
  moveItemCounts,
  moveProgressText,
  moveStoppedText,
} from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveProgressDialogStore } from "@/stores/settings/move-progress-dialog-store";
import type { MoveSheetTarget } from "@/stores/settings/move-sheet-store";

const MOVE_DONE_CLOSE_DELAY_MS = 4000;

/**
 * The accepted move's progress, from the moment the computer took the
 * acceptance: items applied while it runs; once the computer runs Personal,
 * that it does, and the dialog closes itself; on a stop, today's stopped line
 * with Retry and Export diagnostics, open until the person closes it. Read
 * from the computer's own `environment.status`, the read the Overview card
 * and the Local row show the move from. Closing it does not stop the move.
 */
export function MoveProgressDialog(): ReactNode {
  const target = useMoveProgressDialogStore((state) => state.target);
  const closeDialog = useMoveProgressDialogStore((state) => state.closeDialog);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      {target === null ? null : (
        <MoveProgressDialogBody
          key={target.hostId}
          target={target}
          onClose={closeDialog}
        />
      )}
    </Dialog>
  );
}

function MoveProgressDialogBody(props: {
  readonly target: MoveSheetTarget;
  readonly onClose: () => void;
}): ReactNode {
  const { target, onClose } = props;
  const client = useHostClientForHostId(target.hostId);
  const status = useEnvironmentStatusRead(client, target.hostId, true);
  const data = status.data;
  const state = data === null ? null : hostSettingsCardState(data);
  const moved = state?.kind === "moved";
  // Opened only after the accept, on a computer that had not moved: `moved`
  // turning true is this move finishing. A close before the timer fires
  // unmounts this body, which clears it.
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(onClose, MOVE_DONE_CLOSE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [moved, onClose]);
  // Once the status has shown this move past the accept, a computer read back
  // as Local (asked again, given to a team, or a plane still local) has no
  // move here to show: the dialog closes rather than wait on a bar that never
  // fills. Before then, Local is the status from before the accept.
  const pastAccept = useRef(false);
  const kind = state?.kind ?? null;
  useEffect(() => {
    if (kind === "moving" || kind === "move_stopped") {
      pastAccept.current = true;
      return;
    }
    if ((kind === "local" || kind === "other") && pastAccept.current) onClose();
  }, [kind, onClose]);
  const lineProps: OverviewCardLineProps | null =
    client === null || data === null
      ? null
      : {
          client,
          hostId: target.hostId,
          hostName: target.hostName,
          status: data,
        };
  let view: ReactNode;
  if (moved && data !== null) {
    view = (
      <MoveDoneView
        hostName={target.hostName}
        {...moveItemCounts(data)}
        connected={data.reachability === "connected"}
        onDone={onClose}
      />
    );
  } else if (state?.kind === "move_stopped") {
    view = (
      <MoveStoppedView
        hostId={target.hostId}
        hostName={target.hostName}
        text={moveStoppedText(state.reason, state.left)}
        client={client}
        lineProps={lineProps}
      />
    );
  } else {
    view = (
      <MovingView
        hostName={target.hostName}
        applied={state?.kind === "moving" ? state.applied : 0}
        total={state?.kind === "moving" ? state.total : 0}
        lineProps={lineProps}
      />
    );
  }
  return (
    <DialogContent
      className="sm:max-w-lg"
      showCloseButton={false}
      data-testid="move-progress-dialog"
    >
      {view}
    </DialogContent>
  );
}

/** Also before the status shows the move under way: the accept was taken. */
function MovingView(props: {
  readonly hostName: string;
  readonly applied: number;
  readonly total: number;
  readonly lineProps: OverviewCardLineProps | null;
}): ReactNode {
  const { applied, total } = props;
  const title = `Moving ${props.hostName} to Personal`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <p data-testid="move-progress-dialog-progress">
        {moveProgressText(applied, total)}
      </p>
      <UpdateProgressBar
        percent={total === 0 ? null : (applied / total) * 100}
        label={title}
        className={undefined}
      />
      <DialogDescription>
        This computer keeps its own settings until the move finishes.
      </DialogDescription>
      <DialogFooter>
        {props.lineProps === null ? null : (
          <OverviewCardDetailsLine {...props.lineProps} />
        )}
        <MoveProgressDialogClose />
      </DialogFooter>
    </>
  );
}

function MoveDoneView(props: {
  readonly hostName: string;
  readonly applied: number;
  readonly total: number;
  readonly connected: boolean;
  readonly onDone: () => void;
}): ReactNode {
  const { applied, total } = props;
  const title = `${props.hostName} is on Personal`;
  // Until the computer's new reader has answered, its items are the ones it
  // opened from cache, not this move's.
  const counted = props.connected && total > 0;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {counted ? (
        <p data-testid="move-progress-dialog-done-count">
          {`${String(applied)} of ${String(total)} items applied`}
        </p>
      ) : null}
      <UpdateProgressBar percent={100} label={title} className={undefined} />
      <DialogDescription>
        {"It uses Personal's settings from now. This closes by itself."}
      </DialogDescription>
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          data-testid="move-progress-dialog-done"
          onClick={props.onDone}
        >
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function MoveStoppedView(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly text: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly lineProps: OverviewCardLineProps | null;
}): ReactNode {
  const { client, lineProps } = props;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{`Moving ${props.hostName} to Personal`}</DialogTitle>
      </DialogHeader>
      <p
        role="status"
        className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning-foreground"
        data-testid="move-progress-dialog-stopped"
      >
        {props.text}
      </p>
      <DialogDescription>
        This computer is still on its own settings. Retry applies nothing twice.
      </DialogDescription>
      <DialogFooter>
        {lineProps === null ? null : (
          <MoveExportDiagnosticsButton {...lineProps} />
        )}
        <MoveProgressDialogClose />
        {client === null ? null : (
          <MoveRetryButton
            client={client}
            hostId={props.hostId}
            variant="default"
          />
        )}
      </DialogFooter>
    </>
  );
}

function MoveProgressDialogClose(): ReactNode {
  return (
    <DialogClose asChild>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="move-progress-dialog-close"
      >
        Close
      </Button>
    </DialogClose>
  );
}
