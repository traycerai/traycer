import { useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  PR_DETAIL_TABS,
  prDetailTabButtonId,
  prDetailTabPanelId,
  type PrDetailTabId,
} from "@/stores/epics/pr-detail-view-store";
import { cn } from "@/lib/utils";

interface PrTabDefinition {
  readonly id: PrDetailTabId;
  readonly label: string;
}

/**
 * Labels only - membership and reading order come from `PR_DETAIL_TABS`, which
 * declares the contract. A second ordered list here would let a tab added to
 * the store go silently missing from the strip; as a `Record` keyed by the tab
 * id, a new tab is a compile error until it is given a label.
 */
const TAB_LABELS: Record<PrDetailTabId, string> = {
  overview: "Overview",
  commits: "Commits",
  feedback: "Feedback",
  checks: "Checks",
  files: "Files",
};

const TABS: readonly PrTabDefinition[] = PR_DETAIL_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
}));

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
  const buttonsRef = useRef<Map<PrDetailTabId, HTMLButtonElement>>(new Map());

  // Arrow-key roving focus per the WAI-ARIA tabs pattern: Left/Right move (and
  // select) the adjacent tab with wraparound, Home/End jump to an end. Every
  // other key falls through untouched.
  //
  // Bound to each TAB rather than the tablist: under a roving tabindex the
  // focus always sits on a tab button, so the container never needs to be
  // focusable to receive the key.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = TABS.findIndex(
      (definition) => definition.id === props.tab,
    );
    if (currentIndex === -1) return;
    const nextIndex = ((): number | null => {
      if (event.key === "ArrowRight") return (currentIndex + 1) % TABS.length;
      if (event.key === "ArrowLeft") {
        return (currentIndex - 1 + TABS.length) % TABS.length;
      }
      if (event.key === "Home") return 0;
      if (event.key === "End") return TABS.length - 1;
      return null;
    })();
    if (nextIndex === null) return;
    event.preventDefault();
    // `nextIndex` is always produced modulo `TABS.length`, so the lookup is
    // total.
    const next = TABS[nextIndex];
    props.onSelectTab(next.id);
    buttonsRef.current.get(next.id)?.focus();
  };

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
            ref={(node) => {
              if (node === null) {
                buttonsRef.current.delete(definition.id);
              } else {
                buttonsRef.current.set(definition.id, node);
              }
            }}
            type="button"
            role="tab"
            id={prDetailTabButtonId(definition.id)}
            aria-selected={selected}
            aria-controls={prDetailTabPanelId(definition.id)}
            tabIndex={selected ? 0 : -1}
            data-testid={`pr-detail-tab-${definition.id}`}
            data-state={selected ? "active" : "inactive"}
            onClick={() => props.onSelectTab(definition.id)}
            onKeyDown={handleKeyDown}
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
