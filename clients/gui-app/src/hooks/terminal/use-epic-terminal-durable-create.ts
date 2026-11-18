import { useMemo, useSyncExternalStore } from "react";
import {
  getEpicTerminalDurableCreateJobsSnapshot,
  subscribeEpicTerminalDurableCreates,
  type EpicTerminalDurableCreateJobView,
  type EpicTerminalDurableCreateRequest,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";

export function useEpicTerminalDurableCreateJobs(
  epicId: string,
): readonly EpicTerminalDurableCreateRequest[] {
  const jobs = useSyncExternalStore(
    subscribeEpicTerminalDurableCreates,
    getEpicTerminalDurableCreateJobsSnapshot,
    getEpicTerminalDurableCreateJobsSnapshot,
  );
  return useMemo(
    () =>
      jobs
        .filter((job) => job.request.epicId === epicId)
        .map((job) => job.request),
    [epicId, jobs],
  );
}

export function useEpicTerminalDurableCreateJobViews(
  epicId: string,
): readonly EpicTerminalDurableCreateJobView[] {
  const jobs = useSyncExternalStore(
    subscribeEpicTerminalDurableCreates,
    getEpicTerminalDurableCreateJobsSnapshot,
    getEpicTerminalDurableCreateJobsSnapshot,
  );
  return useMemo(
    () => jobs.filter((job) => job.request.epicId === epicId),
    [epicId, jobs],
  );
}

export function useEpicTerminalDurableCreate(
  hostId: string,
  terminalId: string,
): EpicTerminalDurableCreateJobView | null {
  const jobs = useSyncExternalStore(
    subscribeEpicTerminalDurableCreates,
    getEpicTerminalDurableCreateJobsSnapshot,
    getEpicTerminalDurableCreateJobsSnapshot,
  );
  return useMemo(
    () =>
      jobs.find(
        (job) =>
          job.request.hostId === hostId &&
          job.request.terminalId === terminalId,
      ) ?? null,
    [hostId, jobs, terminalId],
  );
}
