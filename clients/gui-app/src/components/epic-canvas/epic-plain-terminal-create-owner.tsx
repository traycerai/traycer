import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import {
  useEpicTerminalDurableCreateJobs,
  useEpicTerminalDurableCreateJobViews,
} from "@/hooks/terminal/use-epic-terminal-durable-create";
import {
  acceptEpicTerminalDurableCreate,
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
  requestEpicTerminalDurableCreate,
  settleEpicTerminalDurableCreate,
  type EpicTerminalDurableCreateRequest,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  failedCreateHasAuthoritativeRow,
  hasTerminalPendingCreate,
} from "@/lib/terminals/pending-create-identity";
import { getPlainTerminal } from "@/lib/terminals/plain-terminal-authority";
import {
  captureCreatedPlainTerminalBarrier,
  fetchIsolatedLegacyTerminalList,
  runSilentCapableEpicTerminalCreate,
  runSilentLegacyEpicTerminalCreate,
  writeCreatedPlainTerminalCollection,
} from "@/lib/terminals/epic-terminal-silent-create";
import {
  publishExactTerminalListSnapshot,
  upsertCreatedSessionIntoExactTerminalList,
  type CreatedTerminalSession,
} from "@/lib/terminals/refresh-host-terminal-list";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  HostRpcError,
  toHostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { PlainTerminalProjectionBarrier } from "@/lib/terminals/plain-terminal-authority";
import {
  isHostEpicTerminalRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

/**
 * Session-level owner for pending durable epic-terminal creation. Lives outside
 * any canvas tile so tab unmount cannot cancel an accepted create job.
 */
function recoverAcceptedCreatesFromCanvas(epicId: string): void {
  const state = useEpicCanvasStore.getState();
  for (const tab of Object.values(state.tabsById)) {
    if (tab?.epicId !== epicId) continue;
    const live = Object.values(
      state.canvasByTabId[tab.tabId]?.tilesByInstanceId ?? {},
    );
    const closed = Object.values(
      state.closedTilePayloadsByTabId[tab.tabId] ?? {},
    ).map((payload) => payload?.node);
    const refs: Array<EpicCanvasTileRef | undefined> = [...live, ...closed];
    for (const ref of refs) {
      if (
        ref === undefined ||
        ref.type !== "terminal" ||
        !isHostEpicTerminalRef(ref) ||
        !hasTerminalPendingCreate(
          state.pendingCreateTerminalIdentities,
          ref.hostId,
          ref.id,
        )
      ) {
        continue;
      }
      acceptEpicTerminalDurableCreate({
        hostId: ref.hostId,
        terminalId: ref.id,
        epicId,
        cwd: ref.legacyFallback.cwd,
        cols: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
        rows: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
      });
    }
  }
}

function toastCreateFailure(
  error: Error,
  method: string,
  fallback: string,
): void {
  toastFromHostError(
    error instanceof HostRpcError ? error : toHostRpcError(error, method),
    fallback,
  );
}

export function EpicPlainTerminalCreateOwner(props: {
  readonly epicId: string;
}): ReactNode {
  const pendingCreateTerminalIdentities = useEpicCanvasStore(
    (state) => state.pendingCreateTerminalIdentities,
  );
  useEffect(() => {
    recoverAcceptedCreatesFromCanvas(props.epicId);
  }, [pendingCreateTerminalIdentities, props.epicId]);
  const jobs = useEpicTerminalDurableCreateJobs(props.epicId);
  const hostIds = useMemo(() => {
    const ids = new Set<string>();
    jobs.forEach((job) => ids.add(job.hostId));
    return [...ids].sort();
  }, [jobs]);
  return (
    <>
      {hostIds.map((hostId) => (
        <EpicPlainTerminalCreateHostOwner
          key={hostId}
          epicId={props.epicId}
          hostId={hostId}
          jobs={jobs}
        />
      ))}
    </>
  );
}

function EpicPlainTerminalCreateHostOwner(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly jobs: readonly EpicTerminalDurableCreateRequest[];
}): null {
  const authority = useHostPlainTerminalAuthority({
    hostId: props.hostId,
    scope: { kind: "epic", epicId: props.epicId },
  });
  const hostClient = useHostClientForHostId(props.hostId);
  const queryClient = useQueryClient();
  const hostClientRef = useRef(hostClient);
  useEffect(() => {
    hostClientRef.current = hostClient;
  }, [hostClient]);
  const capability = authority.capability.status;
  const canMutate = authority.canMutate;
  const ready =
    capability === "legacy" || (capability === "capable" && canMutate);
  const jobs = useMemo(
    () => props.jobs.filter((job) => job.hostId === props.hostId),
    [props.hostId, props.jobs],
  );
  const jobViews = useEpicTerminalDurableCreateJobViews(props.epicId);
  const unmarkTerminalPendingCreate = useEpicCanvasStore(
    (state) => state.unmarkTerminalPendingCreate,
  );

  useEffect(() => {
    for (const job of jobViews) {
      if (job.status !== "failed") continue;
      if (job.request.hostId !== props.hostId) continue;
      if (
        !failedCreateHasAuthoritativeRow({
          jobHostId: job.request.hostId,
          jobTerminalId: job.request.terminalId,
          sessionHostId: props.hostId,
          durableHasTerminalId: (terminalId) =>
            getPlainTerminal(
              authority.collection,
              job.request.hostId,
              terminalId,
            ) !== undefined,
        })
      ) {
        continue;
      }
      settleEpicTerminalDurableCreate(
        job.request.hostId,
        job.request.terminalId,
      );
      unmarkTerminalPendingCreate(job.request.hostId, job.request.terminalId);
    }
  }, [
    authority.collection,
    jobViews,
    props.hostId,
    unmarkTerminalPendingCreate,
  ]);

  useEffect(() => {
    const scope = { kind: "epic" as const, epicId: props.epicId };
    for (const job of jobs) {
      let createdTerminal: PlainTerminalProjection | undefined;
      let createdSession: CreatedTerminalSession | undefined;
      let createBarrier: PlainTerminalProjectionBarrier | undefined;
      const pending = requestEpicTerminalDurableCreate({
        hostId: job.hostId,
        terminalId: job.terminalId,
        ready,
        create: async () => {
          if (capability === "legacy") {
            createdSession = await runSilentLegacyEpicTerminalCreate({
              client: hostClientRef.current,
              request: {
                scope,
                sessionKind: "terminal",
                tuiHarnessId: null,
                cwd: job.cwd,
                shellCommand: null,
                shellArgs: null,
                cols: job.cols,
                rows: job.rows,
                desiredSessionId: job.terminalId,
                worktreeBusyPaths: [],
              },
            });
            return;
          }
          createBarrier = captureCreatedPlainTerminalBarrier(
            queryClient,
            job.hostId,
            scope,
          );
          createdTerminal = await runSilentCapableEpicTerminalCreate({
            client: hostClientRef.current,
            request: {
              terminalId: job.terminalId,
              scope,
              cwd: job.cwd,
              cols: job.cols,
              rows: job.rows,
            },
          });
        },
        commit:
          capability === "legacy"
            ? () =>
                fetchIsolatedLegacyTerminalList({
                  client: hostClientRef.current,
                  scope,
                })
            : undefined,
        onCommit:
          capability === "legacy"
            ? (snapshot) => {
                publishExactTerminalListSnapshot(
                  queryClient,
                  job.hostId,
                  scope,
                  snapshot,
                );
              }
            : undefined,
        onSuccess: () => {
          const adopted = createdTerminal;
          const barrier = createBarrier;
          const session = createdSession;
          if (adopted !== undefined && barrier !== undefined) {
            writeCreatedPlainTerminalCollection(queryClient, {
              hostId: job.hostId,
              scope,
              terminal: adopted,
              barrier,
            });
            useEpicCanvasStore
              .getState()
              .adoptHostTerminalProjection(job.hostId, adopted);
          }
          if (session !== undefined) {
            upsertCreatedSessionIntoExactTerminalList(
              queryClient,
              job.hostId,
              scope,
              session,
            );
          }
          useEpicCanvasStore
            .getState()
            .unmarkTerminalPendingCreate(job.hostId, job.terminalId);
        },
        onFailure: (error) => {
          toastCreateFailure(
            error,
            capability === "legacy"
              ? "terminal.create"
              : "terminal.plain.create",
            capability === "legacy"
              ? "Could not create terminal"
              : "Couldn't create the terminal.",
          );
        },
      });
      if (pending !== null) void pending.catch(() => undefined);
    }
  }, [capability, jobs, props.epicId, queryClient, ready]);

  return null;
}
