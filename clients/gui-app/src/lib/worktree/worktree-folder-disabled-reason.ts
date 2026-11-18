import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import {
  worktreeRowState,
  type WorktreeRowState,
} from "@traycer-clients/shared/worktree/worktree-row-state";

/**
 * Row badge for worktree pickers (terminal creation, file tree).
 * `disabled` is deliberately independent from badge visibility: setup can
 * remain visible as progress or a warning without blocking the created row.
 * `pending: true` marks a row whose only defect is unverified git facts, so it
 * renders as "checking" instead of a destructive "missing". A cold local folder
 * stays browsable with no badge.
 */
export type WorktreeFolderRowBadge = {
  readonly label: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly tone: "neutral" | "warning" | "error";
  readonly detail: string;
};

/**
 * Presentation for each non-ready state. WHICH state a row is in is the shared
 * ladder's call (`worktreeRowState`, in `clients/shared`, alongside
 * `classifyWorktreeTier`); this table only says how the GUI renders each one,
 * which is why `traycer workspace list` can spell the same states differently
 * without the two ever disagreeing about a row.
 *
 * Keyed by the state rather than matched with `if`s so a state added to the
 * shared union breaks this build instead of silently rendering no badge.
 */
const ROW_BADGES: Record<
  Exclude<WorktreeRowState, "ready">,
  WorktreeFolderRowBadge
> = {
  checking: {
    label: "checking",
    pending: true,
    disabled: true,
    tone: "neutral",
    detail: "Checking whether the worktree is available.",
  },
  missing: {
    label: "missing",
    pending: false,
    disabled: true,
    tone: "error",
    detail:
      "This worktree is unavailable because its directory could not be found.",
  },
  "setup-pending": {
    label: "setup pending",
    pending: false,
    disabled: false,
    tone: "neutral",
    detail: "The worktree is ready to use. Setup is waiting to start.",
  },
  "setting-up": {
    label: "setting up",
    pending: true,
    disabled: false,
    tone: "neutral",
    detail: "The worktree is ready to use while setup continues.",
  },
  "setup-failed": {
    label: "setup failed",
    pending: false,
    disabled: false,
    tone: "warning",
    detail: "Setup did not complete, but the worktree is still usable.",
  },
  "setup-cancelled": {
    label: "setup cancelled",
    pending: false,
    disabled: false,
    tone: "warning",
    detail: "Setup was cancelled, but the worktree is still usable.",
  },
};

export function worktreeFolderRowBadge(
  row: WorktreeBindingSelectorRowV12,
): WorktreeFolderRowBadge | null {
  const state = worktreeRowState(row);
  return state === "ready" ? null : ROW_BADGES[state];
}

/**
 * The short "why is this row unavailable" word, for the two surfaces that
 * render their own disabled copy rather than the badge (the palette's terminal
 * hint, the git-diff repo switcher). `null` means the row is not unavailable -
 * a setup state is not, since those rows stay selectable.
 *
 * Both call sites resolve pending themselves before asking (the palette filters
 * pending rows into a separate "Checking workspace…" hint, the switcher returns
 * "checking" ahead of this call), so a `checking` row folding in with `missing`
 * here is unreachable in practice and matches what this returned before the
 * ladder moved to `clients/shared`.
 */
export function formatWorktreeFolderDisabledReason(
  row: WorktreeBindingSelectorRowV12,
): string | null {
  const state = worktreeRowState(row);
  return state === "checking" || state === "missing" ? "missing" : null;
}
