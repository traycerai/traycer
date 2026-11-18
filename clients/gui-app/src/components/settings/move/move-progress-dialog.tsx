import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { useHostQueryEntryHash } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveProgressDialogStore } from "@/stores/settings/move-progress-dialog-store";
import type { MoveSheetTarget } from "@/stores/settings/move-sheet-store";

const MOVE_DONE_CLOSE_DELAY_MS = 4000;
const MOVE_DONE_REREAD_MS = 500;
/** No re-read starts later than this after the finish, so none at or after the close. */
const MOVE_DONE_LAST_REREAD_MS = MOVE_DONE_CLOSE_DELAY_MS - MOVE_DONE_REREAD_MS;

/**
 * The accepted move's progress, from the moment the computer took the
 * acceptance: that it runs, with no count; once the computer runs Personal,
 * that it does, with its count only once every item is applied, and the
 * dialog closes itself; on a stop, today's stopped line
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
  const queryClient = useQueryClient();
  const statusHash = useHostQueryEntryHash<
    HostRpcRegistry,
    "environment.status"
  >({
    client,
    method: "environment.status",
    params: {},
    cacheKeyIdentity: undefined,
  });
  // The status cached when the dialog opened is from before the accept: a
  // finish, a stop or a count is read only from an answer since.
  const data = useAnsweredSinceMount(queryClient, statusHash, status.data);
  const state = data === null ? null : hostSettingsCardState(data);
  const moved = state?.kind === "moved";
  const finishedAt = useRef<number | null>(null);
  // Opened only after the accept, on a computer that had not moved: `moved`
  // turning true is this move finishing. A close before the timer fires
  // unmounts this body, which clears it.
  useEffect(() => {
    if (!moved) return;
    finishedAt.current ??= Date.now();
    const timer = setTimeout(onClose, MOVE_DONE_CLOSE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [moved, onClose]);
  const counts = moved && data !== null ? moveItemCounts(data) : null;
  const allApplied =
    counts !== null && counts.applied === counts.total && counts.total > 0
      ? counts.total
      : null;
  const awaitingCount = moved && allApplied === null;
  // While the finished view waits on its count, this host's status is asked
  // again, until MOVE_DONE_LAST_REREAD_MS after the finish, and never over a
  // read in flight.
  const rereadInFlight = useRef(false);
  useEffect(() => {
    if (!awaitingCount) return;
    const interval = setInterval(() => {
      const finished = finishedAt.current;
      if (
        finished === null ||
        Date.now() - finished > MOVE_DONE_LAST_REREAD_MS
      ) {
        clearInterval(interval);
        return;
      }
      const query = queryClient.getQueryCache().get(statusHash);
      if (rereadInFlight.current || query?.state.fetchStatus === "fetching")
        return;
      rereadInFlight.current = true;
      void queryClient
        .invalidateQueries({
          predicate: (entry) => entry.queryHash === statusHash,
        })
        .finally(() => {
          rereadInFlight.current = false;
        });
    }, MOVE_DONE_REREAD_MS);
    return () => {
      clearInterval(interval);
    };
  }, [awaitingCount, queryClient, statusHash]);
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
  if (moved) {
    view = (
      <MoveDoneView
        hostName={target.hostName}
        allApplied={allApplied}
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
    view = <MovingView hostName={target.hostName} lineProps={lineProps} />;
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

/** The answers, data or refusal, a cache entry has taken; 0 for none. */
function answerCount(queryClient: QueryClient, hash: string): number {
  const state = queryClient.getQueryCache().get(hash)?.state;
  return state === undefined
    ? 0
    : state.dataUpdateCount + state.errorUpdateCount;
}

/** `data`, once the entry `hash` names has answered since this component first read it; null before. */
function useAnsweredSinceMount<Data>(
  queryClient: QueryClient,
  hash: string,
  data: Data | null,
): Data | null {
  const [start, setStart] = useState(() => ({
    hash,
    count: answerCount(queryClient, hash),
  }));
  if (start.hash !== hash)
    setStart({ hash, count: answerCount(queryClient, hash) });
  const count = useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => answerCount(queryClient, hash),
  );
  return start.hash === hash && count > start.count ? data : null;
}

/** Also before the status shows the move under way: the accept was taken. */
function MovingView(props: {
  readonly hostName: string;
  readonly lineProps: OverviewCardLineProps | null;
}): ReactNode {
  const title = `Moving ${props.hostName} to Personal`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <p data-testid="move-progress-dialog-progress">
        {moveProgressText(0, 0)}
      </p>
      <UpdateProgressBar percent={null} label={title} className={undefined} />
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
  readonly allApplied: number | null;
  readonly onDone: () => void;
}): ReactNode {
  const { allApplied } = props;
  const title = `${props.hostName} is on Personal`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {allApplied === null ? null : (
        <p data-testid="move-progress-dialog-done-count">
          {`${String(allApplied)} of ${String(allApplied)} items applied`}
        </p>
      )}
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
