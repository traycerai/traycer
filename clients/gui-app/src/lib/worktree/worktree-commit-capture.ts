import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { TeardownStopTarget } from "@/lib/worktree/owner-teardown-snapshot";

/**
 * Gesture-time snapshot of the draft a disclosure was computed from. Confirm
 * must apply this capture (or re-disclose) — never a later staging mutation.
 * `stopTargets` are the GUI-composed teardown actions for the holders shown
 * at disclosure time (phase-1; see `runGuiComposedTeardown`).
 */
export type WorktreeCommitCapture = {
  readonly draft: WorktreeIntent | null;
  readonly revision: number;
  readonly binding: WorktreeBinding | null;
  readonly removedWorkspacePaths: readonly string[];
  readonly stopTargets: readonly TeardownStopTarget[];
};

export type ArmedTeardownSubmit<T> = {
  readonly input: T;
  readonly capture: WorktreeCommitCapture;
  readonly ownerId: string;
};

export function takeArmedTeardownSubmit<T>(slot: {
  current: ArmedTeardownSubmit<T> | null;
}): ArmedTeardownSubmit<T> | null {
  const armed = slot.current;
  slot.current = null;
  return armed;
}

export function worktreeCommitCaptureIsStale(
  capture: WorktreeCommitCapture,
  live: WorktreeCommitCapture,
): boolean {
  if (capture.revision !== live.revision) return true;
  if (!samePathSet(capture.removedWorkspacePaths, live.removedWorkspacePaths)) {
    return true;
  }
  if (!sameBinding(capture.binding, live.binding)) return true;
  return !sameDraft(capture.draft, live.draft);
}

function samePathSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((path) => rightSet.has(path));
}

function sameBinding(
  left: WorktreeBinding | null,
  right: WorktreeBinding | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      entry.workspacePath === other.workspacePath &&
      entry.worktreePath === other.worktreePath &&
      entry.mode === other.mode
    );
  });
}

function sameDraft(
  left: WorktreeIntent | null,
  right: WorktreeIntent | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return entry.workspacePath === other.workspacePath;
  });
}
