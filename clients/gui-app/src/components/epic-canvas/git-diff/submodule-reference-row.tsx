import type { ReactNode } from "react";
import { RotateCcw, GitBranch, TriangleAlert } from "lucide-react";
import type { SubmoduleReferenceRowView } from "@/lib/git/git-repo-composition";
import { cn } from "@/lib/utils";

/**
 * The parent's gitlink row, demoted to a "Submodule reference" summary row -
 * never a text-diff file row. It stays semantically complete (recorded/staged
 * pins + checkout HEAD, or the conflict base/ours/theirs triple, via
 * `view.summary`) and is counted separately from the parent's ordinary files so
 * it never reads as a duplicate edit.
 *
 * A conflicted pointer is a pointer-only case that the two-bucket copy maps to
 * `Reference needs attention` (its primary label), keeping base/ours/theirs in
 * the detail summary. Rendered as a non-interactive row: activation / opening a
 * reference summary is T06, so a `<button>` would advertise a keyboard/SR
 * affordance that does nothing.
 *
 * When the host surfaced a dirty pointer but no submodule details
 * (`detailsUnavailable` - an old host that downgraded, or a partial failure),
 * the row surfaces that explicitly with a targeted refresh; the submodule is
 * never silently omitted.
 */
export function SubmoduleReferenceRow(props: {
  readonly view: SubmoduleReferenceRowView;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const { view } = props;
  const isConflicted = view.pointer.kind === "conflicted";
  return (
    <div
      className="flex flex-col gap-1 px-3 py-1"
      data-testid={`submodule-reference-row-${view.parentPath}`}
    >
      <div className="flex w-full min-w-0 items-center gap-1.5 px-1 py-0.5 text-ui-sm">
        {isConflicted ? (
          <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        ) : (
          <GitBranch
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        {isConflicted ? (
          <span className="shrink-0 font-medium text-warning">
            Reference needs attention
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground">
            Submodule reference:
          </span>
        )}
        <span className="min-w-0 shrink-0 font-medium text-foreground/90">
          {view.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-xs italic text-muted-foreground">
          {view.summary}
        </span>
      </div>
      {view.detailsUnavailable ? (
        <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1 text-ui-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Submodule details unavailable on this host version
          </span>
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={props.isRefreshing}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-colors hover:bg-warning/20",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            data-testid={`submodule-reference-refresh-${view.parentPath}`}
          >
            <RotateCcw
              className={cn("size-3", props.isRefreshing && "animate-spin")}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      ) : null}
    </div>
  );
}
