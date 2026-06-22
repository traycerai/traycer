/**
 * Maps GitFileStatus to a display letter and semantic tone for status badges.
 * Includes exhaustiveness check to ensure all status values are handled.
 */

import type { GitFileStatus } from "@traycer/protocol/host";

export interface StatusBadgeStyle {
  readonly letter: string;
  readonly tone: "success" | "destructive" | "muted" | "primary" | "warning";
  readonly label: string;
}

export function statusBadgeStyle(status: GitFileStatus): StatusBadgeStyle {
  switch (status) {
    case "added":
      return { letter: "A", tone: "success", label: "Added" };
    case "modified":
      return { letter: "M", tone: "warning", label: "Modified" };
    case "deleted":
      return { letter: "D", tone: "destructive", label: "Deleted" };
    case "renamed":
      return { letter: "R", tone: "primary", label: "Renamed" };
    case "copied":
      return { letter: "C", tone: "muted", label: "Copied" };
    case "untracked":
      return { letter: "A", tone: "success", label: "New file" };
    case "conflicted":
      return { letter: "!", tone: "destructive", label: "Conflicted" };
    // Exhaustiveness check: if a new status is added to GitFileStatus,
    // this switch will fail to compile until it is handled here.
    default: {
      const _check: never = status;
      return _check;
    }
  }
}
