import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  isSettingsSearchActive,
  searchSettings,
  settingsSearchResultKey,
  type SettingsSearchResult,
} from "@/lib/settings-search/settings-search";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";

/** Scopes the highlight's scroll query to this list. See `moveHighlight`. */
const RESULTS_SELECTOR = "[data-settings-search-results]";

export interface SettingsSearchProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/**
 * The search field at the top of the settings rail, and the results it
 * produces.
 *
 * Field and results are ONE component because they share a keyboard: the input
 * keeps focus the whole time — so a wrong first guess can be refined without
 * clicking back — which means the arrow keys that move the highlight arrive as
 * `keydown` on the input, not on the list. Splitting them would have put the
 * highlight index in one component and the events that move it in another.
 *
 * The query itself belongs to the caller, because the caller has to hide its
 * section list while a search is running and cannot ask a child for that.
 */
export function SettingsSearch(props: SettingsSearchProps): ReactNode {
  const { query, onQueryChange } = props;
  const requestReveal = useSettingsSearchStore((state) => state.requestReveal);
  // The highlight, not a selection: nothing is chosen until Enter or a click.
  // Reset to the top on every query change, because result 3 of the previous
  // query has nothing to do with result 3 of this one.
  const [highlighted, setHighlighted] = useState(0);
  // The input owns focus the whole time, so the highlighted option is exposed
  // to assistive tech through `aria-activedescendant` — which needs the list
  // and every option to have an id the input can point at.
  const listboxId = useId();
  // The shell decides which entries exist at all — a row this build never
  // draws must not be offered. The same context the panels gate their rows on.
  const availability = useSettingsAvailabilityContext();

  const results = useMemo(
    () => searchSettings(query, availability),
    [query, availability],
  );
  const active = isSettingsSearchActive(query);
  // Clamped rather than stored-and-corrected: `results` shrinks as the user
  // types, and a highlight index kept in state would spend a render pointing
  // past the end of the list.
  const activeIndex =
    results.length === 0 ? -1 : Math.min(highlighted, results.length - 1);

  const select = (result: SettingsSearchResult): void => {
    const { entry } = result;
    Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
      source: "direct_ui",
      section: entry.section,
    });
    // The reveal is armed BEFORE navigating. The watcher polls for its element
    // until a deadline, so arming first costs nothing and removes any question
    // of which of the two lands in which frame. Armed for page results too
    // (`anchor: null` scrolls the pane to its top): when the section is
    // already on screen, the navigation below moves nothing.
    requestReveal(entry.section, entry.anchor);
    // The surface-agnostic navigator, not a router hook: this component is
    // rendered by the sidebar in BOTH surfaces, and the modal one deliberately
    // uses no router hooks at all. `navigateToSettingsSection` swaps the
    // section in place under the overlay and focuses the settings tab at that
    // section otherwise — the same path the leader-digit shortcuts take.
    navigateToSettingsSection(entry.section);
  };

  const moveHighlight = (delta: number): void => {
    if (results.length === 0) return;
    const next =
      ((((activeIndex < 0 ? 0 : activeIndex) + delta) % results.length) +
        results.length) %
      results.length;
    setHighlighted(next);
    // Queried from the document rather than held as a ref: only one settings
    // rail is ever mounted, so the list is unique, and passing a ref down into
    // the list component reads to `react-hooks/refs` as a render-time ref
    // access. The row may not exist yet on the frame a key repeat produces —
    // `?.` is the whole handling that needs, since the next keypress re-runs
    // this and the highlight itself is already correct in state.
    document
      .querySelector(`${RESULTS_SELECTOR} [data-result-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="mb-3 flex min-h-0 flex-col gap-2">
      <InputGroup className="h-8 w-full">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setHighlighted(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveHighlight(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveHighlight(-1);
              return;
            }
            if (event.key === "Enter") {
              // Guarded on the INDEX, not on the row: `activeIndex` is already
              // clamped into range whenever there is a range at all, and -1 is
              // its own statement that there is nothing to open.
              if (activeIndex < 0) return;
              event.preventDefault();
              select(results[activeIndex]);
              return;
            }
            if (event.key === "Escape" && active) {
              // Clearing a search is not closing the window it runs in. In the
              // modal, the dialog's capture-phase Escape listener fires before
              // this and has already cleared the query (see the settings
              // overlay's `consumeEscape`); this handler is what clears it in
              // the tab surface, and it keeps the key from reaching anything
              // above the rail.
              event.preventDefault();
              event.stopPropagation();
              onQueryChange("");
            }
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-expanded={active}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            active && activeIndex >= 0
              ? settingsSearchOptionId(listboxId, activeIndex)
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          className="text-ui-sm"
        />
        {query.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              size="icon-xs"
              aria-label="Clear settings search"
              onClick={() => {
                onQueryChange("");
                setHighlighted(0);
              }}
            >
              <X className="size-3.5" aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {active ? (
        <SettingsSearchResults
          listboxId={listboxId}
          query={query}
          results={results}
          activeIndex={activeIndex}
          onHighlight={setHighlighted}
          onSelect={select}
        />
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {searchStatusMessage(active, results.length)}
      </p>
    </div>
  );
}

function SettingsSearchResults(props: {
  readonly listboxId: string;
  readonly query: string;
  readonly results: ReadonlyArray<SettingsSearchResult>;
  readonly activeIndex: number;
  readonly onHighlight: (index: number) => void;
  readonly onSelect: (result: SettingsSearchResult) => void;
}): ReactNode {
  if (props.results.length === 0) {
    return (
      <p
        id={props.listboxId}
        className="px-3 py-6 text-center text-ui-xs text-muted-foreground"
      >
        Nothing in settings matches “{props.query.trim()}”.
      </p>
    );
  }
  return (
    <div
      id={props.listboxId}
      data-settings-search-results
      role="listbox"
      aria-label="Settings search results"
      className="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
    >
      {props.results.map((result, index) => (
        <SettingsSearchResultRow
          key={settingsSearchResultKey(result.entry)}
          optionId={settingsSearchOptionId(props.listboxId, index)}
          result={result}
          index={index}
          active={index === props.activeIndex}
          onHighlight={props.onHighlight}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

function SettingsSearchResultRow(props: {
  readonly optionId: string;
  readonly result: SettingsSearchResult;
  readonly index: number;
  readonly active: boolean;
  readonly onHighlight: (index: number) => void;
  readonly onSelect: (result: SettingsSearchResult) => void;
}): ReactNode {
  const { result, index, active } = props;
  return (
    <button
      id={props.optionId}
      type="button"
      role="option"
      aria-selected={active}
      data-result-index={index}
      data-testid={`settings-search-result-${settingsSearchResultKey(result.entry)}`}
      onMouseEnter={() => props.onHighlight(index)}
      onClick={() => props.onSelect(result)}
      className={cn(
        "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground",
      )}
    >
      <span className="w-full truncate text-ui-sm">{result.entry.label}</span>
      <span className="flex w-full min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
        <Breadcrumb result={result} />
      </span>
    </button>
  );
}

/**
 * "Application › Appearance › Typography" — the scope, the page, and the group
 * inside it.
 *
 * The scope is not decoration: two pages are both called "Diagnostics" and two
 * are both called "Notifications", and the ONLY thing that distinguishes them
 * is which of Application and Host they belong to — exactly as the rail's
 * group headings do it. Dropping the scope would leave a user choosing between
 * two identical rows.
 */
function Breadcrumb(props: {
  readonly result: SettingsSearchResult;
}): ReactNode {
  const { scopeLabel, sectionLabel, entry } = props.result;
  const parts = [scopeLabel, sectionLabel, entry.group].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return (
    <>
      {parts.map((part, index) => (
        <span key={part} className="flex min-w-0 items-center gap-1">
          {index === 0 ? null : (
            <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />
          )}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </>
  );
}

/** The id `aria-activedescendant` names for the option at `index`. */
function settingsSearchOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

function searchStatusMessage(active: boolean, count: number): string {
  if (!active) return "";
  if (count === 0) return "No settings match.";
  return `${count} ${count === 1 ? "result" : "results"}.`;
}
