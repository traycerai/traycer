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
import { hostQueryKeys } from "@/lib/query-keys";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  migrationAnyRunning,
  useMigrationRunStore,
} from "@/stores/migration/migration-run-store";
import {
  getMigrationStartHandle,
  setMigrationStartHandle,
  type MigrationRunTarget,
} from "@/components/migration/migration-run-handle";

/**
 * Owns the `migration.run` subscriptions - ONE PER HOST. A migration moves one
 * machine's local data, so two machines can be migrating at once and each has
 * its own progress; a second start for a host that is already migrating is
 * refused, as it always was.
 *
 * The target travels with the request (`MigrationRunTarget`) rather than being
 * read from this component's ambient binding, so a migration started from a
 * host-scoped panel runs on the host that panel is showing.
 */
export function MigrationRunController(): null {
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const runsRef = useRef<Map<string, HostRun>>(new Map());

  const closeRun = useCallback((hostId: string) => {
    const run = runsRef.current.get(hostId);
    if (run === undefined) return;
    runsRef.current.delete(hostId);
    run.client.close();
    // Returns the transport reference this run took at subscribe. A scoped
    // transport closes here if nothing else is reading it; the ambient one
    // has no lease to return.
    run.release?.();
  }, []);

  const start = useCallback(
    (target: MigrationRunTarget) => {
      const hostId = target.hostId;
      if (runsRef.current.has(hostId)) return;

      useMigrationRunStore.getState().markRunning(hostId);

      // Pinned FIRST: the run outlives the surface that handed the binding
      // over, and a scoped transport closes at that surface's unmount
      // otherwise, taking this subscription with it.
      const release = target.binding.retain?.() ?? null;
      const client = new MigrationStreamClient({
        wsStreamClient: target.binding.wsStreamClient,
        callbacks: {
          onStarted: (payload: MigrationStartedPayload) => {
            useMigrationRunStore.getState().applyStarted(hostId, {
              totalTaskChains: payload.totalTaskChains,
              totalLocalEpics: payload.totalLocalEpics,
            });
          },
          onTaskChainProgress: (payload: TaskChainProgressPayload) => {
            useMigrationRunStore
              .getState()
              .incrementTaskChain(hostId, payload.outcome);
          },
          onEpicProgress: (payload: EpicProgressPayload) => {
            useMigrationRunStore
              .getState()
              .incrementEpic(hostId, payload.outcome);
          },
          onReplayProgress: (payload: ReplayProgressPayload) => {
            if (!payload.required || payload.completed) return;
            useMigrationRunStore.getState().incrementReplayIncomplete(hostId);
          },
          onComplete: (payload: MigrationCompletePayload) => {
            useMigrationRunStore.getState().applyComplete(hostId, {
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
            void queryClient.invalidateQueries({
              queryKey: hostQueryKeys.scope(hostId),
            });
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
            closeRun(hostId);
          },
          onConnectionStatus: (_status, reason) => {
            if (reason === null) return;
            if (!runsRef.current.has(hostId)) return;
            useMigrationRunStore.getState().applyError(hostId);
            closeRun(hostId);
          },
        },
      });

      runsRef.current.set(hostId, { client, release });
    },
    [closeRun, queryClient],
  );

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
      for (const hostId of [...runsRef.current.keys()]) closeRun(hostId);
    },
    [closeRun],
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

  // Outgoing announce: fire only on running <-> not-running transitions.
  // Without the wasRunning/isRunning guard, every progress increment would
  // re-broadcast and churn IPC traffic across windows.
  //
  // The bit is about the WINDOW, not a host: the IPC contract carries one
  // running flag and the window that owns it, so what is announced is "some
  // host in this window is migrating". A second host starting while the first
  // still runs is not a transition and stays silent, which is what the
  // receiving windows already assume.
  useEffect(() => {
    const migration = runnerHost.migration;
    if (migration === null) return;
    const thisWindowId = resolveWindowId(runnerHost);
    const unsub = useMigrationRunStore.subscribe((state, prev) => {
      const wasRunning = migrationAnyRunning(prev.runs);
      const isRunning = migrationAnyRunning(state.runs);
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

interface HostRun {
  readonly client: MigrationStreamClient;
  /** Returns the transport lease this run took; `null` for the ambient one. */
  readonly release: (() => void) | null;
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
