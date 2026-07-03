import type { ReactNode } from "react";
import {
  RotateCcw,
  GitBranch,
  TriangleAlert,
  ChevronRight,
} from "lucide-react";
import type { SubmoduleReferenceRowView } from "@/lib/git/git-repo-tree";
import { cn } from "@/lib/utils";

/**
 * The parent's gitlink row, demoted to a "Submodule reference" summary row -
 * never a text-diff file row. It reads its pins/flags straight off the enriched
 * pointer (recorded pin + checkout HEAD, or the conflict base/ours/theirs
 * triple, via `view.summary`) and is counted separately from the parent's
 * ordinary files so it never reads as a duplicate edit.
 *
 * When the reference has a matching submodule node (`view.repoRoot`), the row is
 * a real `<button>` that selects that node. A conflicted pointer is pointer-only
 * (no section) and maps to `Reference needs attention`, keeping base/ours/theirs
 * in the detail; it renders as a non-interactive row - nothing to navigate to.
 *
 * When the host surfaced a dirty pointer but no submodule details
 * (`detailsUnavailable` - an old host that downgraded to `submodules: []`, or a
 * partial failure), the row surfaces that explicitly with a targeted refresh; the
 * submodule is never silently omitted.
 */
export function SubmoduleReferenceRow(props: {
  readonly view: SubmoduleReferenceRowView;
  readonly onSelect: (repoRoot: string) => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const { view } = props;
  const repoRoot = view.repoRoot;

  const icon = view.isConflicted ? (
    <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
  ) : (
    <GitBranch
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden
    />
  );

  const leadLabel = view.isConflicted ? (
    <span className="shrink-0 font-medium text-warning">
      Reference needs attention
    </span>
  ) : (
    <span className="shrink-0 text-muted-foreground">Submodule reference:</span>
  );

  const content = (
    <>
      {icon}
      {leadLabel}
      <span className="min-w-0 shrink-0 font-medium text-foreground/90">
        {view.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-xs italic text-muted-foreground">
        {view.summary}
      </span>
      {repoRoot !== null ? (
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      ) : null}
    </>
  );

  return (
    <div
      className="flex flex-col gap-1 px-3 py-0.5"
      data-testid={`submodule-reference-row-${view.parentPath}`}
    >
      {repoRoot !== null ? (
        <button
          type="button"
          onClick={() => props.onSelect(repoRoot)}
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-ui-sm transition-colors",
            "hover:bg-accent/50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {content}
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-1.5 px-1 py-0.5 text-ui-sm">
          {content}
        </div>
      )}
      {view.divergence !== null ? (
        <div
          className={cn(
            "px-1 text-ui-xs",
            view.divergence === "diverged"
              ? "font-medium text-foreground/70"
              : "text-muted-foreground",
          )}
          data-testid={`submodule-reference-divergence-${view.parentPath}`}
        >
          {view.divergence === "diverged"
            ? "Checkout differs from parent reference"
            : "Checkout matches parent reference"}
        </div>
      ) : null}
      {view.detailsUnavailable ? (
        <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1 text-ui-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Submodule details unavailable</span>
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
