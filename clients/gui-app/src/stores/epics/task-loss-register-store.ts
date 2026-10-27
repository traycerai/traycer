import { create } from "zustand";

/**
 * What the window has learned about a task it may still hold a title for:
 * `gone` (deleted: the delete tombstone, or a lookup answering
 * `confirmed-absent`) and `denied` (a lookup answering that the person cannot
 * reach it) settle it; `recheck` (an access-loss signal, which has causes
 * other than a revoke) only asks for a fresh answer.
 */
export type TaskLoss = "gone" | "denied" | "recheck";

export interface TaskLossEntry {
  readonly loss: TaskLoss;
  /** When it was learned, on {@link currentTaskLossSequence}'s clock. */
  readonly sequence: number;
  /** The host it was learned on; `null` for every host. */
  readonly hostId: string | null;
}

interface TaskLossRegisterState {
  /** Per user, per task: the latest entry for each host scope. */
  readonly byUserId: Readonly<
    Record<string, Readonly<Record<string, ReadonlyArray<TaskLossEntry>>>>
  >;
}

/**
 * Session-scoped, like the list delete tombstones: it outlives every cached
 * answer, so a title held anywhere, or an answer to a read started before the
 * loss, cannot make the task reachable again.
 */
export const useTaskLossRegister = create<TaskLossRegisterState>()(() => ({
  byUserId: {},
}));

let lastSequence = 0;

/**
 * The register's clock as of now. A read captures it when it is sent, so an
 * entry with a later sequence was learned after the read began.
 */
export function currentTaskLossSequence(): number {
  return lastSequence;
}

/**
 * Records `loss` for each task in `scope`, over what that scope learned
 * before; a deletion stands whatever is learned after it.
 */
export function recordTaskLoss(
  scope: { readonly hostId: string | null; readonly userId: string },
  taskIds: ReadonlyArray<string>,
  loss: TaskLoss,
): void {
  if (taskIds.length === 0) return;
  lastSequence += 1;
  const entry: TaskLossEntry = {
    loss,
    sequence: lastSequence,
    hostId: scope.hostId,
  };
  useTaskLossRegister.setState((state) => {
    const tasks = { ...state.byUserId[scope.userId] };
    for (const taskId of taskIds) {
      const entries = tasks[taskId] ?? [];
      const deleted = entries.some(
        (existing) =>
          existing.hostId === scope.hostId && existing.loss === "gone",
      );
      if (deleted) continue;
      tasks[taskId] = [
        ...entries.filter((existing) => existing.hostId !== scope.hostId),
        entry,
      ];
    }
    return { byUserId: { ...state.byUserId, [scope.userId]: tasks } };
  });
}

/**
 * Forgets what `hostId` (and every-host scope) learned about a task before
 * `sequence`, a read sent after it having found the task reachable. A
 * deletion is never forgotten.
 */
export function clearTaskLoss(
  userId: string,
  hostId: string | null,
  taskId: string,
  sequence: number,
): void {
  useTaskLossRegister.setState((state) => {
    const tasks = Object.hasOwn(state.byUserId, userId)
      ? state.byUserId[userId]
      : null;
    if (tasks === null || !Object.hasOwn(tasks, taskId)) return state;
    const entries = tasks[taskId];
    const kept = entries.filter(
      (entry) =>
        entry.loss === "gone" ||
        !reaches(entry, hostId) ||
        entry.sequence > sequence,
    );
    if (kept.length === entries.length) return state;
    return {
      byUserId: {
        ...state.byUserId,
        [userId]: { ...tasks, [taskId]: kept },
      },
    };
  });
}

/**
 * What the window has learned about the task on `hostId`, or `null`: a
 * deletion that reaches it, whatever was learned after it in any scope, else
 * the latest entry that reaches it.
 */
export function taskLossFor(
  state: TaskLossRegisterState,
  userId: string | null,
  hostId: string | null,
  taskId: string,
): TaskLossEntry | null {
  if (userId === null) return null;
  const entries = (state.byUserId[userId]?.[taskId] ?? []).filter((entry) =>
    reaches(entry, hostId),
  );
  const deleted = entries.filter((entry) => entry.loss === "gone");
  return latestOf(deleted.length > 0 ? deleted : entries);
}

function latestOf(entries: ReadonlyArray<TaskLossEntry>): TaskLossEntry | null {
  let latest: TaskLossEntry | null = null;
  for (const entry of entries) {
    if (latest === null || entry.sequence > latest.sequence) latest = entry;
  }
  return latest;
}

function reaches(entry: TaskLossEntry, hostId: string | null): boolean {
  return entry.hostId === null || entry.hostId === hostId;
}
