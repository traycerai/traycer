import { type ReactNode } from "react";
import type { PrDetailTabId } from "@/stores/epics/pr-detail-view-store";
import { cn } from "@/lib/utils";

interface PrTabDefinition {
  readonly id: PrDetailTabId;
  readonly label: string;
}

const TABS: readonly PrTabDefinition[] = [
  { id: "overview", label: "Overview" },
  { id: "commits", label: "Commits" },
  { id: "feedback", label: "Feedback" },
  { id: "checks", label: "Checks" },
  { id: "files", label: "Files" },
];

export interface PrDetailTabCounts {
  readonly feedback: number;
  readonly files: number;
  readonly checks: number;
  readonly commits: number;
}

/** Counts that should read as a problem rather than a size. */
export interface PrDetailTabBlocking {
  readonly feedback: number;
  readonly checks: number;
}

/**
 * The document's tab strip: a segmented control inside the reading column.
 *
 * Deliberately NOT GitHub's underlined tab row spanning a full-width rule -
 * that rule is the single strongest "this is a GitHub page" signal in the
 * layout, and it also fights the card language every surface below it uses.
 * A contained pill group sits inside the same column as everything else and
 * reads as one control rather than page chrome.
 *
 * The group spans the column and its tabs share the space evenly. Hugging its
 * own content left it ending short of every card below it, so the strip read
 * as a stray element floating above the page rather than as its header - and
 * the ragged gap after the last tab had no meaning to carry.
 */
export function PrDetailTabStrip(props: {
  readonly tab: PrDetailTabId;
  readonly onSelectTab: (tab: PrDetailTabId) => void;
  readonly counts: PrDetailTabCounts;
  readonly blocking: PrDetailTabBlocking;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label="Pull request sections"
      data-testid="pr-detail-tabs"
      className="flex w-full min-w-0 items-center gap-0.5 rounded-xl border border-border/50 bg-muted/30 p-1"
    >
      {TABS.map((definition) => {
        const count = tabCount(definition.id, props.counts);
        const blocking = tabBlocking(definition.id, props.blocking);
        const selected = definition.id === props.tab;
        return (
          <button
            key={definition.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`pr-detail-tab-${definition.id}`}
            data-state={selected ? "active" : "inactive"}
            onClick={() => props.onSelectTab(definition.id)}
            className={cn(
              // `flex-1` + `basis-0` so every tab gets an equal share of the
              // row rather than a share proportional to its label: otherwise
              // "Overview" and "Files" end up visibly different widths and the
              // control reads as misaligned.
              "inline-flex min-w-0 flex-1 basis-0 items-center justify-center gap-1.5",
              "rounded-lg px-2 py-1.5 text-ui-sm transition-colors",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              selected
                ? "bg-canvas font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <span className="min-w-0 truncate">{definition.label}</span>
            {count !== null ? (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-ui-xs tabular-nums",
                  blocking > 0
                    ? "bg-destructive/15 text-destructive"
                    : "bg-muted-foreground/10 text-muted-foreground",
                )}
              >
                {blocking > 0 ? blocking : count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function tabCount(id: PrDetailTabId, counts: PrDetailTabCounts): number | null {
  if (id === "overview") return null;
  if (id === "feedback") return counts.feedback;
  if (id === "files") return counts.files;
  if (id === "checks") return counts.checks;
  return counts.commits;
}

function tabBlocking(id: PrDetailTabId, blocking: PrDetailTabBlocking): number {
  if (id === "feedback") return blocking.feedback;
  if (id === "checks") return blocking.checks;
  return 0;
}
