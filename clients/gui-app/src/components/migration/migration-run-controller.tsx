import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import {
  MigrationStreamClient,
  type EpicProgressPayload,
  type MigrationCompletePayload,
  type MigrationStartedPayload,
  type ReplayProgressPayload,
  type TaskChainProgressPayload,
} from "@traycer-clients/shared/host-transport/migration-stream-client";
import { useHostClient } from "@/lib/host";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { hostQueryKeys } from "@/lib/query-keys";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";
import {
  getMigrationStartHandle,
  setMigrationStartHandle,
} from "@/components/migration/migration-run-handle";

export function MigrationRunController(): null {
  const queryClient = useQueryClient();
  const hostClient = useHostClient();
  const wsStreamClient = useWsStreamClient();
  const runnerHost = useRunnerHost();
  const clientRef = useRef<MigrationStreamClient | null>(null);

  const closeClient = useCallback(() => {
    const client = clientRef.current;
    if (client !== null) {
      clientRef.current = null;
      client.close();
    }
  }, []);

  const start = useCallback(() => {
    if (wsStreamClient === null) return;
    if (clientRef.current !== null) return;

    const store = useMigrationRunStore.getState();
    const hostIdAtStart = hostClient.getActiveHostId();
    store.markRunning();

    const client = new MigrationStreamClient({
      wsStreamClient,
      callbacks: {
        onStarted: (payload: MigrationStartedPayload) => {
          useMigrationRunStore.getState().applyStarted({
            totalTaskChains: payload.totalTaskChains,
            totalLocalEpics: payload.totalLocalEpics,
          });
        },
        onTaskChainProgress: (payload: TaskChainProgressPayload) => {
          useMigrationRunStore.getState().incrementTaskChain(payload.outcome);
        },
        onEpicProgress: (payload: EpicProgressPayload) => {
          useMigrationRunStore.getState().incrementEpic(payload.outcome);
        },
        onReplayProgress: (payload: ReplayProgressPayload) => {
          if (!payload.required || payload.completed) return;
          useMigrationRunStore.getState().incrementReplayIncomplete();
        },
        onComplete: (payload: MigrationCompletePayload) => {
          useMigrationRunStore.getState().applyComplete({
            success: payload.success,
            counts: {
              taskChainsComplete: payload.counts.taskChainsComplete,
              taskChainsSkipped: payload.counts.taskChainsSkipped,
              taskChainsFailed: payload.counts.taskChainsFailed,
              epicsComplete: payload.counts.epicsComplete,
              epicsFailed: payload.counts.epicsFailed,
              replaysIncomplete: payload.counts.replaysIncomplete,
            },
          });
          if (hostIdAtStart !== null) {
            void queryClient.invalidateQueries({
              queryKey: hostQueryKeys.scope(hostIdAtStart),
            });
          }
          if (payload.success) {
            toast.success("Migration re-attempt complete.");
          } else {
            reportableWarningToast(
              "Migration re-attempt incomplete. Some local data still needs migration.",
              undefined,
              {
                title: "Migration incomplete",
                message: null,
                code: null,
                source: "Data migration",
              },
            );
          }
          closeClient();
        },
        onConnectionStatus: (_status, reason) => {
          if (reason === null) return;
          if (clientRef.current === null) return;
          useMigrationRunStore.getState().applyError();
          closeClient();
        },
      },
    });

    clientRef.current = client;
  }, [closeClient, hostClient, queryClient, wsStreamClient]);

  useEffect(() => {
    setMigrationStartHandle({ start });
    return () => {
      if (getMigrationStartHandle()?.start === start) {
        setMigrationStartHandle(null);
      }
    };
  }, [start]);

  useEffect(
    () => () => {
      closeClient();
    },
    [closeClient],
  );

  // Cross-window sync: a freshly opened window may have missed prior fan-outs,
  // so seed `remoteRunning` from the latest IPC snapshot before binding the
  // listener. The blocking modal subscribes to the resolved bit.
  useEffect(() => {
    const migration = runnerHost.migration;
    if (migration === null) return;
    const setRemote = useMigrationRunStore.getState().setRemoteRunning;
    const thisWindowId = resolveWindowId(runnerHost);

    let disposed = false;
    void migration.getSnapshot().then((snap) => {
      if (disposed) return;
      setRemote(snap.running && snap.originWindowId !== thisWindowId);
    });

    const subscription = migration.onChange((snap) => {
      setRemote(snap.running && snap.originWindowId !== thisWindowId);
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [runnerHost]);

  // Outgoing announce: fire only on running ↔ not-running transitions. Without
  // the wasRunning/isRunning guard, every progress increment would re-broadcast
  // and churn IPC traffic across windows.
  useEffect(() => {
    const migration = runnerHost.migration;
    if (migration === null) return;
    const thisWindowId = resolveWindowId(runnerHost);
    const unsub = useMigrationRunStore.subscribe((state, prev) => {
      const wasRunning = prev.status === "running";
      const isRunning = state.status === "running";
      if (wasRunning === isRunning) return;
      void migration.announceRunning({
        running: isRunning,
        originWindowId: thisWindowId,
      });
    });
    return () => {
      unsub();
    };
  }, [runnerHost]);

  return null;
}

// The shared `IRunnerHost` does not expose `windows` (mobile/web don't have
// multiple windows). This narrowing is only reached when `migration !== null`,
// i.e. on desktop, where the field is guaranteed to be present. The zod
// schema validates the shape at runtime so the cast soup ("host as
// { windows?: unknown }", etc.) stays out of the call path.
const WINDOW_ID_HOST_SCHEMA = z.looseObject({
  windows: z.looseObject({ windowId: z.string() }).optional(),
});

function resolveWindowId(host: unknown): string | null {
  const parsed = WINDOW_ID_HOST_SCHEMA.safeParse(host);
  if (!parsed.success) return null;
  return parsed.data.windows?.windowId ?? null;
}
