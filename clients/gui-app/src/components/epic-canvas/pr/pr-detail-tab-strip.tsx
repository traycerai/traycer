import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  PR_DETAIL_TABS,
  prDetailTabButtonId,
  prDetailTabPanelId,
  type PrDetailTabId,
} from "@/stores/epics/pr-detail-view-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
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

interface PrDetailTabPickerProps {
  readonly tab: PrDetailTabId;
  readonly onSelectTab: (tab: PrDetailTabId) => void;
  readonly counts: PrDetailTabCounts;
  readonly blocking: PrDetailTabBlocking;
}

/**
 * The document's tab picker, in the sticky bar's one tab slot.
 *
 * Two presentations of the SAME five tabs, chosen by viewport width alone: a
 * segmented strip at desktop widths, and - despite the name this component
 * keeps - a dropdown MENU below the phone breakpoint. The split is viewport,
 * not build: a narrow desktop window is a narrow window, and a phone-width
 * website should read the same as the installed app.
 *
 * Both arms derive labels, order, counts and blocking state from the same
 * `TABS`/`tabCount`/`tabBlocking` above, so a tab added to `PR_DETAIL_TABS`
 * reaches both or neither.
 */
export function PrDetailTabStrip(props: PrDetailTabPickerProps): ReactNode {
  const mobileViewport = useIsMobileViewport();
  if (mobileViewport) {
    return (
      <PrDetailTabMenu
        tab={props.tab}
        onSelectTab={props.onSelectTab}
        counts={props.counts}
        blocking={props.blocking}
      />
    );
  }
  return (
    <PrDetailTabRow
      tab={props.tab}
      onSelectTab={props.onSelectTab}
      counts={props.counts}
      blocking={props.blocking}
    />
  );
}

/**
 * The desktop arm: a segmented control inside the reading column.
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
 *
 * That equal share is also exactly why the phone gets a menu instead. Five
 * tabs splitting a phone-width column leave each one under 70px, and the count
 * badge inside every cell does not shrink - so `truncate` eats the LABELS, all
 * five at once, and the control becomes unreadable rather than merely tight.
 * Scrolling the strip would trade that for tabs you cannot see; a menu keeps
 * every label at full length and gives each a real touch target.
 */
function PrDetailTabRow(props: PrDetailTabPickerProps): ReactNode {
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
            <PrTabCountBadge count={count} blocking={blocking} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The phone arm: the same five tabs as a dropdown menu filling the same slot.
 *
 * MENU semantics rather than a listbox - picking a tab navigates the document,
 * it does not edit a form value - so the `role="tab"`/`tablist` contract and
 * its arrow-key roving focus do not carry over; Radix owns the keyboard model
 * here. `role="tabpanel"` on the panel below is unaffected, and stays labelled
 * by `prDetailTabButtonId`, which the trigger's LABEL span carries: Radix owns
 * the trigger element's own `id` and points the open menu's `aria-labelledby`
 * at it, so taking that id would leave the menu unnamed to name the panel.
 * Naming the panel from the label alone is the better read anyway - "Files"
 * rather than "Files 324, collapsed menu button".
 */
function PrDetailTabMenu(props: PrDetailTabPickerProps): ReactNode {
  // Total by construction: `props.tab` is a `PrDetailTabId` and `TABS` is
  // built from every member of `PR_DETAIL_TABS`.
  const active =
    TABS.find((definition) => definition.id === props.tab) ?? TABS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="pr-detail-tabs"
          className={cn(
            // `min-h-11` is the touch target the strip never had: its tabs are
            // `py-1.5`, which lands around 30px.
            "flex min-h-11 w-full min-w-0 items-center gap-2",
            "rounded-xl border border-border/50 bg-muted/30 px-3 py-2 text-ui-sm",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <span
            id={prDetailTabButtonId(props.tab)}
            className="min-w-0 flex-1 truncate text-left font-medium text-foreground"
          >
            {active.label}
          </span>
          <PrTabCountBadge
            count={tabCount(active.id, props.counts)}
            blocking={tabBlocking(active.id, props.blocking)}
          />
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      {/* No `aria-label` here: Radix already points the menu's
          `aria-labelledby` at its trigger, and `aria-labelledby` wins - so one
          would be a silent no-op rather than the name it looks like. */}
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={props.tab}
          onValueChange={(value) => {
            // Narrowed by lookup rather than a cast: Radix hands back the bare
            // `string` it was given, and an unrecognised one must select
            // nothing rather than be asserted into a `PrDetailTabId`.
            const next = TABS.find((definition) => definition.id === value);
            if (next === undefined) return;
            props.onSelectTab(next.id);
          }}
        >
          {TABS.map((definition) => (
            <DropdownMenuRadioItem
              key={definition.id}
              value={definition.id}
              data-testid={`pr-detail-tab-${definition.id}`}
              className="min-h-11 gap-2"
            >
              <span className="min-w-0 flex-1 truncate">
                {definition.label}
              </span>
              <PrTabCountBadge
                count={tabCount(definition.id, props.counts)}
                blocking={tabBlocking(definition.id, props.blocking)}
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A tab's count, or its blocking count in that count's place.
 *
 * A red "2" meaning "two failures" is a different fact from a grey "324"
 * meaning "this many files", so the blocking value SUBSTITUTES rather than
 * sits beside - one number per tab, either way. Overview has neither and
 * renders nothing.
 */
function PrTabCountBadge(props: {
  readonly count: number | null;
  readonly blocking: number;
}): ReactNode {
  if (props.count === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-ui-xs tabular-nums",
        props.blocking > 0
          ? "bg-destructive/15 text-destructive"
          : "bg-muted-foreground/10 text-muted-foreground",
      )}
    >
      {props.blocking > 0 ? props.blocking : props.count}
    </span>
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
