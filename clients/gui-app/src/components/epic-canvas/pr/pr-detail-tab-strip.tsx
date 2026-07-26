import { type ReactNode } from "react";
import type { PrDetailTabId } from "@/stores/epics/pr-detail-view-store";
import { PR_TONE_TEXT_CLASS } from "@/components/epic-canvas/pr/pr-detail-tone";
import { cn } from "@/lib/utils";

interface PrTabDefinition {
  readonly id: PrDetailTabId;
  readonly label: string;
}

const TABS: readonly PrTabDefinition[] = [
  { id: "overview", label: "Overview" },
  { id: "feedback", label: "Feedback" },
  { id: "files", label: "Files" },
  { id: "checks", label: "Checks" },
  { id: "history", label: "History" },
];

export interface PrDetailTabCounts {
  readonly feedback: number;
  readonly files: number;
  readonly checks: number;
  readonly history: number;
}

/** Counts that should read as a problem rather than a size. */
export interface PrDetailTabBlocking {
  readonly feedback: number;
  readonly checks: number;
}

/**
 * The document's tab strip, inside the reading column rather than spanning the
 * tile. Everything - header, tabs, content - shares one left edge, so the view
 * reads as a document with a card beside it instead of app chrome with a
 * centred body bolted underneath.
 *
 * `capsule` is the slot for the summary on full-bleed tabs, where the content
 * takes the whole width and leaves no gutter for the card to float in. The tab
 * strip's right end is dead space on every tab, so the summary lands there as
 * inline chrome and never covers content.
 */
export function PrDetailTabStrip(props: {
  readonly tab: PrDetailTabId;
  readonly onSelectTab: (tab: PrDetailTabId) => void;
  readonly counts: PrDetailTabCounts;
  readonly blocking: PrDetailTabBlocking;
  readonly capsule: ReactNode;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label="Pull request sections"
      data-testid="pr-detail-tabs"
      className="mb-4 flex min-w-0 flex-wrap items-center gap-1 border-b border-border/60 pb-2"
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
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-sm transition-colors",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              selected
                ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_var(--color-border)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {definition.label}
            {count !== null ? (
              <span
                className={cn(
                  "text-ui-xs tabular-nums",
                  blocking > 0
                    ? PR_TONE_TEXT_CLASS.fail
                    : "text-muted-foreground/70",
                )}
              >
                {blocking > 0 ? blocking : count}
              </span>
            ) : null}
          </button>
        );
      })}
      {props.capsule !== null ? (
        <div className="ml-auto flex min-w-0 shrink-0 items-center pl-2">
          {props.capsule}
        </div>
      ) : null}
    </div>
  );
}

function tabCount(id: PrDetailTabId, counts: PrDetailTabCounts): number | null {
  if (id === "overview") return null;
  if (id === "feedback") return counts.feedback;
  if (id === "files") return counts.files;
  if (id === "checks") return counts.checks;
  return counts.history;
}

function tabBlocking(id: PrDetailTabId, blocking: PrDetailTabBlocking): number {
  if (id === "feedback") return blocking.feedback;
  if (id === "checks") return blocking.checks;
  return 0;
}
