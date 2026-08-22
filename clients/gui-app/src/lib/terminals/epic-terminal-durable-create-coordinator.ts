import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";

export const EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS = 80;
export const EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS = 24;

export interface EpicTerminalDurableCreateRequest {
  readonly hostId: string;
  readonly terminalId: string;
  readonly epicId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export type EpicTerminalDurableCreateStatus =
  "accepted" | "in-flight" | "failed";

export interface EpicTerminalDurableCreateListSnapshot {
  readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
}

export interface EpicTerminalDurableCreateJobView {
  readonly request: EpicTerminalDurableCreateRequest;
  readonly status: EpicTerminalDurableCreateStatus;
  readonly error: Error | null;
}

interface EpicTerminalDurableCreateJob {
  readonly request: EpicTerminalDurableCreateRequest;
  generation: number;
  status: EpicTerminalDurableCreateStatus;
  error: Error | null;
  inflight: Promise<void> | null;
}

const jobsByLifetimeKey = new Map<string, EpicTerminalDurableCreateJob>();
const listeners = new Set<() => void>();
let jobsSnapshot: readonly EpicTerminalDurableCreateJobView[] = [];
let nextGeneration = 1;

function lifetimeKey(hostId: string, terminalId: string): string {
  return plainTerminalFleetIdentityKey({ hostId, terminalId });
}

function allocateGeneration(): number {
  const generation = nextGeneration;
  nextGeneration += 1;
  return generation;
}

function notify(): void {
  jobsSnapshot = [...jobsByLifetimeKey.values()].map(toView);
  listeners.forEach((listener) => listener());
}

function toView(
  job: EpicTerminalDurableCreateJob,
): EpicTerminalDurableCreateJobView {
  return {
    request: job.request,
    status: job.status,
    error: job.error,
  };
}

function isCompletingAttempt(
  current: EpicTerminalDurableCreateJob | undefined,
  inflight: Promise<void>,
  generation: number,
): current is EpicTerminalDurableCreateJob {
  return (
    current !== undefined &&
    current.inflight === inflight &&
    current.generation === generation
  );
}

export function subscribeEpicTerminalDurableCreates(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEpicTerminalDurableCreateJobsSnapshot(): readonly EpicTerminalDurableCreateJobView[] {
  return jobsSnapshot;
}

export function acceptEpicTerminalDurableCreate(
  request: EpicTerminalDurableCreateRequest,
): void {
  const key = lifetimeKey(request.hostId, request.terminalId);
  if (jobsByLifetimeKey.has(key)) return;
  jobsByLifetimeKey.set(key, {
    request,
    generation: allocateGeneration(),
    status: "accepted",
    error: null,
    inflight: null,
  });
  notify();
}

export function shouldPreserveEpicTerminalPendingCreate(
  hostId: string,
  terminalId: string,
): boolean {
  return jobsByLifetimeKey.has(lifetimeKey(hostId, terminalId));
}

export function listEpicTerminalDurableCreateJobsForEpic(
  epicId: string,
): readonly EpicTerminalDurableCreateRequest[] {
  return listEpicTerminalDurableCreateJobViewsForEpic(epicId).map(
    (job) => job.request,
  );
}

export function listEpicTerminalDurableCreateJobViewsForEpic(
  epicId: string,
): readonly EpicTerminalDurableCreateJobView[] {
  return [...jobsByLifetimeKey.values()]
    .filter((job) => job.request.epicId === epicId)
    .map(toView);
}

export function peekEpicTerminalDurableCreate(
  hostId: string,
  terminalId: string,
): EpicTerminalDurableCreateJobView | null {
  const job = jobsByLifetimeKey.get(lifetimeKey(hostId, terminalId));
  return job === undefined ? null : toView(job);
}

function resolveCreateError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Could not create terminal.");
}

/**
 * Dispatches at most one create per accepted terminal identity. Unmounting a
 * tile or owner cannot cancel an in-flight job; a remount joins the same
 * promise. Capability resolution is a dispatch gate, not an accept gate.
 *
 * `create` must be observationally silent (RPC only). Optional `commit` runs
 * only after a failed/uncertain create and this attempt still owns the
 * generation. It must not write shared cache; it returns an isolated list
 * snapshot. After a generation re-check, `onCommit` may publish that snapshot.
 * `onSuccess` / `onFailure` run only for the still-current attempt.
 */
export function requestEpicTerminalDurableCreate(args: {
  readonly hostId: string;
  readonly terminalId: string;
  readonly ready: boolean;
  readonly create: () => Promise<void>;
  readonly commit:
    (() => Promise<EpicTerminalDurableCreateListSnapshot>) | undefined;
  readonly onCommit:
    ((snapshot: EpicTerminalDurableCreateListSnapshot) => void) | undefined;
  readonly onSuccess: () => void;
  readonly onFailure: ((error: Error) => void) | undefined;
}): Promise<void> | null {
  const key = lifetimeKey(args.hostId, args.terminalId);
  const job = jobsByLifetimeKey.get(key);
  if (job === undefined || job.status === "failed") {
    return null;
  }
  if (job.inflight !== null) return job.inflight;
  if (!args.ready) return null;

  const generation = job.generation;
  job.status = "in-flight";
  job.error = null;
  const inflight = Promise.resolve()
    .then(async () => {
      try {
        await args.create();
        return { ok: true as const, error: null };
      } catch (error: unknown) {
        return { ok: false as const, error: resolveCreateError(error) };
      }
    })
    .then(async (outcome) => {
      if (
        !isCompletingAttempt(jobsByLifetimeKey.get(key), inflight, generation)
      ) {
        return;
      }
      let snapshot: EpicTerminalDurableCreateListSnapshot | undefined;
      if (!outcome.ok && args.commit !== undefined) {
        try {
          snapshot = await args.commit();
        } catch {
          snapshot = undefined;
        }
        if (
          !isCompletingAttempt(jobsByLifetimeKey.get(key), inflight, generation)
        ) {
          return;
        }
      }
      if (snapshot !== undefined) {
        args.onCommit?.(snapshot);
      }
      const discovered =
        snapshot !== undefined &&
        snapshot.sessions.some(
          (session) => session.sessionId === args.terminalId,
        );
      if (outcome.ok || discovered) {
        jobsByLifetimeKey.delete(key);
        notify();
        args.onSuccess();
        return;
      }
      const current = jobsByLifetimeKey.get(key);
      if (!isCompletingAttempt(current, inflight, generation)) {
        return;
      }
      current.status = "failed";
      current.error = outcome.error;
      current.inflight = null;
      notify();
      args.onFailure?.(outcome.error);
      throw outcome.error;
    });
  job.inflight = inflight;
  notify();
  return inflight;
}

/**
 * Re-accepts a failed job so the owner re-issues create with the same
 * identity. A legacy same-owner/same-kind/same-scope `terminal.create` for
 * an already-running session collapses onto that session, so Retry after an
 * isolated `terminal.list` transport failure does not need a discovery-first
 * preflight and does not spawn a second PTY.
 */
export function retryEpicTerminalDurableCreate(
  hostId: string,
  terminalId: string,
): void {
  const job = jobsByLifetimeKey.get(lifetimeKey(hostId, terminalId));
  if (job === undefined || job.status !== "failed") return;
  job.status = "accepted";
  job.error = null;
  job.inflight = null;
  job.generation = allocateGeneration();
  notify();
}

export function discardEpicTerminalDurableCreate(
  hostId: string,
  terminalId: string,
): boolean {
  const removed = jobsByLifetimeKey.delete(lifetimeKey(hostId, terminalId));
  if (removed) notify();
  return removed;
}

/**
 * Settles a failed (or any remaining) job because an authoritative row now
 * exists. The job is removed so Retry cannot resurrect it after a later delete.
 */
export function settleEpicTerminalDurableCreate(
  hostId: string,
  terminalId: string,
): boolean {
  return discardEpicTerminalDurableCreate(hostId, terminalId);
}

export function purgeEpicTerminalDurableCreatesForEpic(
  epicId: string,
): readonly EpicTerminalDurableCreateRequest[] {
  const removed: EpicTerminalDurableCreateRequest[] = [];
  for (const [key, job] of jobsByLifetimeKey) {
    if (job.request.epicId !== epicId) continue;
    jobsByLifetimeKey.delete(key);
    removed.push(job.request);
  }
  if (removed.length > 0) notify();
  return removed;
}

export function resetEpicTerminalDurableCreatesForTests(): void {
  jobsByLifetimeKey.clear();
  nextGeneration = 1;
  notify();
}
