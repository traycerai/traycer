/**
 * Active-query artifact search for the Epic sidebar's artifact panel.
 *
 * Search is a MODE, not a permanent fixture: there is no resting search box.
 * The panel header owns the affordance (a search icon, shown only once the
 * Epic has enough artifacts for filtering to beat scanning), and entering
 * search trades the header row for the input rather than stacking a second row
 * under it. Typing into the focused tree enters the mode too; Escape leaves it.
 *
 * While the mode is on, the input's DOM is portaled into the header's slot but
 * the component tree is unchanged - so the host query, same-scope retention,
 * combobox keyboard navigation, every load / empty / mirror-unavailable /
 * unsupported / error state, and opening a hit through the authoritative
 * selection route all stay in ONE component, right next to the results they
 * drive.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FileText, Search, SearchX, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type {
  SearchArtifactHit,
  SearchArtifactsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import { useEpicStore } from "@/hooks/use-epic-store";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";
import {
  ARTIFACT_READ,
  useArtifactFilter,
} from "@/stores/epics/left-panel-store";
import { useEpicSearchArtifacts } from "@/hooks/epic/use-epic-search-artifacts-query";
import {
  highlightSegmentsFromByteRanges,
  type SnippetByteRange,
} from "@/lib/artifacts/highlight-byte-ranges";
import {
  EPIC_NODE_ICONS,
  isEpicArtifactKind,
} from "@/lib/artifacts/node-display";
import { displayTitle } from "@/lib/display-title";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  STATUS_DOT_CLASSES,
  STATUS_LABELS,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useArtifactSearchAvailable } from "@/components/epic-canvas/sidebar/artifact-search-availability";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchQuery,
  usePanelHeaderSearchSlot,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";
import { SidebarContent } from "@/components/ui/sidebar";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

const EMPTY_HITS: ReadonlyArray<SearchArtifactHit> = Object.freeze([]);

/** The panel whose header this search takes over while it is active. */
const ARTIFACTS_PANEL_ID = "artifacts";

/**
 * A bare printable character with no modifier - the type-to-filter trigger.
 * Excludes space so it can keep its tree-row activation meaning, and anything
 * carrying a modifier so shortcuts still reach their handlers.
 */
function isTypeToFilterKey(event: globalThis.KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 && event.key !== " ";
}

interface ArtifactPanelSearchShellProps {
  readonly epicId: string;
  readonly tabId: string;
  /** The artifact tree; kept mounted (just hidden) while results are shown. */
  readonly children: ReactNode;
}

/**
 * Composes the artifact panel. In browse mode this is JUST the tree - no
 * search box occupies the panel. Entering search mode mounts
 * `ArtifactSearchBox`, which portals its input up into the header row.
 *
 * While a query is active the tree is HIDDEN (display:none) rather than
 * unmounted, so its expansion/filter state and its scroll viewport both survive
 * a round-trip through search mode. Leaving search short-circuits the debounce
 * so the tree returns in the same update cycle, not after the 200 ms delay.
 */
export function ArtifactPanelSearchShell(props: ArtifactPanelSearchShellProps) {
  const searchOpen = usePanelHeaderSearchOpen(ARTIFACTS_PANEL_ID);
  const searchQuery = usePanelHeaderSearchQuery(ARTIFACTS_PANEL_ID);
  const openSearch = usePanelHeaderSearchStore((s) => s.openSearch);
  const searchAvailable = useArtifactSearchAvailable();

  const debouncedRaw = useDebouncedValue(searchQuery, 200);
  // Treat an empty/whitespace box as immediate: clearing or leaving search must
  // restore the tree in the same cycle, not after the typing debounce.
  const debouncedQuery = searchQuery.trim().length === 0 ? "" : debouncedRaw;
  const searchActive = searchOpen && debouncedQuery.trim().length > 0;

  // Preserve the tree's scroll viewport across search mode. `onScroll` captures
  // the live position while the tree is visible (a hidden element reports 0), and
  // the layout effect restores it the moment search is cleared.
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const treeScrollTopRef = useRef(0);
  const handleTreeScroll = useCallback(() => {
    const element = treeScrollRef.current;
    if (element !== null) treeScrollTopRef.current = element.scrollTop;
  }, []);
  useLayoutEffect(() => {
    if (!searchActive && treeScrollRef.current !== null) {
      treeScrollRef.current.scrollTop = treeScrollTopRef.current;
    }
  }, [searchActive]);

  // Type-to-filter: a bare printable key anywhere in the focused tree enters
  // search mode seeded with that character, so the keystroke that started the
  // search is not swallowed by the focus handoff to the header input.
  //
  // Subscribed imperatively rather than via `onKeyDown`: this region is a
  // scroll container, and a JSX key handler would oblige it to claim an
  // interactive role it does not have (the tree inside owns `role="tree"`).
  useEffect(() => {
    const region = treeScrollRef.current;
    if (region === null) return;
    if (!searchAvailable || searchOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable='true']") !==
          null
      ) {
        return;
      }
      if (!isTypeToFilterKey(event)) return;
      event.preventDefault();
      openSearch(ARTIFACTS_PANEL_ID, event.key);
    };
    region.addEventListener("keydown", onKeyDown);
    return () => region.removeEventListener("keydown", onKeyDown);
  }, [searchAvailable, searchOpen, openSearch]);

  return (
    // `overflow-hidden` overrides SidebarContent's default `overflow-auto` so the
    // outer surface never competes with the inner scroll surfaces below: the
    // hidden-scrollbar tree viewport (browse mode) and the results list (search
    // mode) are each the single active scroller for their mode.
    <SidebarContent className="gap-0 overflow-hidden">
      {searchOpen ? (
        <ArtifactSearchBox
          epicId={props.epicId}
          tabId={props.tabId}
          searchQuery={searchQuery}
          debouncedQuery={debouncedQuery}
        />
      ) : null}
      <div
        ref={treeScrollRef}
        onScroll={handleTreeScroll}
        className={cn(
          // `no-scrollbar` keeps the sidebar's hidden-scrollbar presentation
          // that SidebarContent used to provide for the tree.
          "no-scrollbar flex min-h-0 flex-1 flex-col overflow-auto",
          searchActive && "hidden",
        )}
        data-testid="epic-artifact-tree-region"
      >
        {props.children}
      </div>
    </SidebarContent>
  );
}

interface ArtifactSearchBoxProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly searchQuery: string;
  /** Debounced form of `searchQuery`; drives the host request. */
  readonly debouncedQuery: string;
}

/**
 * The artifact-panel search control plus its result surface. Mounted only in
 * search mode. The input row is portaled into the header's slot (so it visually
 * replaces the header) while the results render here in the panel body - one
 * component, two DOM homes.
 */
// Composes the query, scope-retention, read-filter, keyboard, and open flows in
// a fixed hook order; the branches are independent, not reducible nesting.
// eslint-disable-next-line complexity
export function ArtifactSearchBox(props: ArtifactSearchBoxProps) {
  const { epicId, tabId, searchQuery, debouncedQuery } = props;
  const client = useHostClient();
  const activeHostId = useReactiveActiveHostId();
  const filter = useArtifactFilter(epicId);
  const inputRef = useRef<HTMLInputElement>(null);
  const headerSlot = usePanelHeaderSearchSlot(ARTIFACTS_PANEL_ID);
  const setSearchQuery = usePanelHeaderSearchStore((s) => s.setSearchQuery);
  const closeSearch = usePanelHeaderSearchStore((s) => s.closeSearch);
  const onSearchQueryChange = useCallback(
    (value: string) => setSearchQuery(ARTIFACTS_PANEL_ID, value),
    [setSearchQuery],
  );

  const searchActive = debouncedQuery.trim().length > 0;

  // Compose the sidebar's kind/status filters into the host request; `read` is
  // renderer-only state applied to the response below. Empty axes stay `null`.
  const kinds = filter.kinds.length > 0 ? filter.kinds : null;
  const statuses = filter.statuses.length > 0 ? filter.statuses : null;

  const query = useEpicSearchArtifacts({
    client,
    epicId,
    query: debouncedQuery,
    kinds,
    statuses,
    subtreePath: null,
    enabled: searchActive,
  });

  // A response must never render for a scope it wasn't fetched in. The query key
  // already isolates late async responses per scope; this signature additionally
  // gates the same-scope retention below so a prior Epic / host / filter result
  // can't linger on-screen after the scope changes (only the query string
  // changing keeps the retained results).
  const scopeSignature = [
    epicId,
    activeHostId ?? "",
    kinds === null ? "" : kinds.join(","),
    statuses === null ? "" : statuses.join(","),
  ].join(" ");

  // `useEpicSearchArtifacts` intentionally omits `keepPreviousData`, so
  // `query.data` is only ever the current key's result. Retain the last
  // *same-scope* success so the list doesn't blank between keystrokes, but drop
  // it the instant the scope changes. The setState-during-render idiom keeps
  // the retained value in sync without an effect and never leaks a prior scope.
  const [retained, setRetained] = useState<{
    readonly signature: string;
    readonly response: SearchArtifactsResponse;
  } | null>(null);
  if (
    query.isSuccess &&
    (retained === null ||
      retained.response !== query.data ||
      retained.signature !== scopeSignature)
  ) {
    setRetained({ signature: scopeSignature, response: query.data });
  }
  const sameScopeRetained =
    retained !== null && retained.signature === scopeSignature
      ? retained.response
      : null;
  const response: SearchArtifactsResponse | null = query.isSuccess
    ? query.data
    : sameScopeRetained;

  const isUnsupported = query.error?.code === "E_HOST_UNSUPPORTED";
  const isError = query.isError && !isUnsupported;

  // Read filter (renderer-only). Resolve each hit's authoritative `updatedAt`
  // from the open-Epic projection; a hit missing from the projection is stale
  // and cannot be classified, so it drops out whenever a read filter is active.
  const readFilter = filter.read;
  const artifactsById = useEpicStore((s) => s.artifacts.byId);
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  const results = useMemo<ReadonlyArray<SearchArtifactHit>>(() => {
    if (response === null) return EMPTY_HITS;
    if (readFilter === ARTIFACT_READ.All) return response.results;
    return response.results.filter((hit) => {
      if (!Object.hasOwn(artifactsById, hit.artifactId)) return false;
      const unread = isArtifactUnread({
        epicId,
        artifactId: hit.artifactId,
        updatedAt: artifactsById[hit.artifactId].updatedAt,
        seedAtByEpic: readState.seedAtByEpic,
        lastSeenByArtifact: readState.lastSeenByArtifact,
      });
      return readFilter === ARTIFACT_READ.Unread ? unread : !unread;
    });
  }, [response, readFilter, artifactsById, readState, epicId]);

  // ── Opening a hit (authoritative selection route) ─────────────────────────
  const handle = useOpenEpicHandle();
  const tileNavigation = useEpicTileNavigation();
  const [staleArtifactId, setStaleArtifactId] = useState<string | null>(null);

  const openHit = useCallback(
    (hit: SearchArtifactHit) => {
      // Re-resolve the hit against the authoritative Y.Doc projection rather
      // than the disk mirror it was found in: a stale / deleted hit resolves to
      // `null` and is reported in place instead of opening anything.
      const ref = epicNodeRefForNodeId(
        handle.store.getState(),
        hit.artifactId,
        activeHostId ?? UNKNOWN_HOST_PLACEHOLDER,
      );
      if (ref === null) {
        setStaleArtifactId(hit.artifactId);
        return;
      }
      setStaleArtifactId(null);
      tileNavigation.openTilePreviewInTab(tabId, ref);
    },
    [handle, activeHostId, tileNavigation, tabId],
  );

  // ── Combobox keyboard navigation ──────────────────────────────────────────
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const resultCount = results.length;

  // When the visible result set changes (new query, filter, retained→fresh),
  // reset the active row to the top and clear any stale marker. Done at render
  // time keyed on `results` identity rather than in an effect, so there is no
  // extra commit/paint cycle.
  const [prevResults, setPrevResults] = useState(results);
  if (prevResults !== results) {
    setPrevResults(results);
    setActiveIndex(0);
    setStaleArtifactId(null);
  }

  const clampedActiveIndex =
    resultCount === 0 ? -1 : Math.min(activeIndex, resultCount - 1);
  const activeOptionId =
    clampedActiveIndex >= 0
      ? `${listboxId}-option-${clampedActiveIndex}`
      : undefined;

  // Scroll the active option into view without stealing focus from the input.
  useEffect(() => {
    if (activeOptionId === undefined) return;
    const element = document.getElementById(activeOptionId);
    element?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  const clearSearch = useCallback(() => {
    onSearchQueryChange("");
    inputRef.current?.focus();
  }, [onSearchQueryChange]);

  // Leaving search restores the header row and the tree in one step. Escape is
  // unconditional (not "clear first, then exit"): the mode is the thing the
  // user wants out of, and an empty box has no separate resting state now.
  const exitSearch = useCallback(() => {
    closeSearch(ARTIFACTS_PANEL_ID);
  }, [closeSearch]);

  // Focus the portaled input as soon as the header slot exists, so both entry
  // paths (header icon, type-to-filter) land the caret without a mouse click.
  useEffect(() => {
    if (headerSlot === null) return;
    inputRef.current?.focus();
  }, [headerSlot]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        exitSearch();
        return;
      }
      if (resultCount === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, resultCount - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(resultCount - 1);
      } else if (event.key === "Enter") {
        if (clampedActiveIndex < 0) return;
        event.preventDefault();
        openHit(results[clampedActiveIndex]);
      }
    },
    [exitSearch, resultCount, clampedActiveIndex, openHit, results],
  );

  // The listbox (`role="listbox"`) is only in the DOM when ranked results are
  // actually shown - not during loading / empty / error / unsupported /
  // mirror-unavailable. The combobox's `aria-expanded` / `aria-controls` /
  // `aria-activedescendant` are gated on this so they never reference an absent
  // element or a non-existent active option.
  const listboxRendered =
    searchActive &&
    !isUnsupported &&
    !isError &&
    response !== null &&
    response.outcome === "ready" &&
    results.length > 0;

  const statusMessage = deriveStatusMessage({
    searchActive,
    isUnsupported,
    isError,
    response,
    resultCount,
    staleActive: staleArtifactId !== null,
  });

  const inputRow = (
    <InputGroup className="h-7 w-full">
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="text"
        role="combobox"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Search artifacts…"
        aria-label="Search artifacts"
        aria-autocomplete="list"
        aria-expanded={listboxRendered}
        aria-controls={listboxRendered ? listboxId : undefined}
        aria-activedescendant={listboxRendered ? activeOptionId : undefined}
        autoComplete="off"
        spellCheck={false}
        className="text-ui-sm"
        data-testid="epic-artifact-search-input"
      />
      <InputGroupAddon align="inline-end">
        {searchQuery.length > 0 ? (
          <InputGroupButton
            type="button"
            size="icon-xs"
            aria-label="Clear artifact search"
            onClick={clearSearch}
            data-testid="epic-artifact-search-clear"
          >
            <X className="size-3.5" aria-hidden />
          </InputGroupButton>
        ) : null}
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label="Close artifact search"
          onClick={exitSearch}
          data-testid="epic-artifact-search-close"
        >
          <span aria-hidden className="text-overline uppercase">
            esc
          </span>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        searchActive ? "flex-1" : "shrink-0",
      )}
    >
      {/* The header slot is written by a ref callback during the header's
          commit, so it is null only on this component's very first render;
          the resulting store write re-renders us with the target in hand. */}
      {headerSlot === null ? null : createPortal(inputRow, headerSlot)}

      <p className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </p>

      {searchActive ? (
        <ArtifactSearchResultsRegion
          epicId={epicId}
          listboxId={listboxId}
          isUnsupported={isUnsupported}
          isError={isError}
          isPending={response === null}
          isFetching={query.isFetching}
          onRetry={() => void query.refetch()}
          response={response}
          results={results}
          activeIndex={clampedActiveIndex}
          onActivate={openHit}
          onHoverIndex={setActiveIndex}
          staleArtifactId={staleArtifactId}
        />
      ) : null}
    </div>
  );
}

function deriveStatusMessage(args: {
  readonly searchActive: boolean;
  readonly isUnsupported: boolean;
  readonly isError: boolean;
  readonly response: SearchArtifactsResponse | null;
  readonly resultCount: number;
  readonly staleActive: boolean;
}): string {
  if (!args.searchActive) return "";
  if (args.isUnsupported)
    return "Artifact search isn't available on this host.";
  if (args.isError) return "Artifact search failed.";
  if (args.staleActive) return "That artifact no longer exists.";
  if (args.response === null) return "Searching artifacts…";
  if (args.response.outcome === "mirror-unavailable") {
    return "Artifact search isn't ready yet.";
  }
  if (args.resultCount === 0) {
    return args.response.truncated
      ? "No matches shown; more results exist beyond the search limit."
      : "No artifacts match your search.";
  }
  const base = `${args.resultCount} artifact ${
    args.resultCount === 1 ? "result" : "results"
  }.`;
  return args.response.truncated
    ? `${base} More are available; refine your search.`
    : base;
}

interface ArtifactSearchResultsRegionProps {
  readonly epicId: string;
  readonly listboxId: string;
  readonly isUnsupported: boolean;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly onRetry: () => void;
  readonly response: SearchArtifactsResponse | null;
  readonly results: ReadonlyArray<SearchArtifactHit>;
  readonly activeIndex: number;
  readonly onActivate: (hit: SearchArtifactHit) => void;
  readonly onHoverIndex: (index: number) => void;
  readonly staleArtifactId: string | null;
}

function ArtifactSearchResultsRegion(props: ArtifactSearchResultsRegionProps) {
  if (props.isUnsupported) {
    return (
      <SidebarPanelEmptyState
        icon={SearchX}
        title="Search isn't available on this host."
        description="Update this device's Traycer host to search artifacts."
        testId="epic-artifact-search-unsupported"
      />
    );
  }
  if (props.isError) {
    return (
      <div
        className="flex flex-col items-center gap-2 px-4 py-8 text-center"
        data-testid="epic-artifact-search-error"
      >
        <SearchX className="size-8 text-muted-foreground/45" aria-hidden />
        <p className="text-ui-sm text-muted-foreground/70">
          Artifact search failed.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
          data-testid="epic-artifact-search-retry"
        >
          Retry
        </Button>
      </div>
    );
  }
  if (props.isPending) {
    // Decorative only: the box's persistent `role="status"` region already
    // announces "Searching artifacts…", so this spinner must not double-announce.
    return (
      <div
        aria-hidden
        className="flex flex-1 items-center justify-center py-8"
        data-testid="epic-artifact-search-loading"
      >
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (
    props.response !== null &&
    props.response.outcome === "mirror-unavailable"
  ) {
    return (
      <SidebarPanelEmptyState
        icon={Search}
        title="Artifact search isn't ready yet."
        description="This Epic's artifacts are still syncing to this device."
        testId="epic-artifact-search-mirror-unavailable"
      />
    );
  }
  if (props.results.length === 0) {
    // A renderer-only read filter can empty a truncated host page while matches
    // exist beyond the 50-result cap; say so rather than a flat "no matches".
    const truncated = props.response?.truncated === true;
    return (
      <SidebarPanelEmptyState
        icon={FileText}
        title="No artifacts match your search."
        description={
          truncated
            ? "More results exist beyond the search limit - refine your query."
            : null
        }
        testId="epic-artifact-search-empty"
      />
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ul
        id={props.listboxId}
        role="listbox"
        aria-label="Artifact search results"
        aria-busy={props.isFetching}
        className="no-scrollbar min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2"
        data-testid="epic-artifact-search-results"
      >
        {props.results.map((hit, index) => (
          <ArtifactSearchResultRow
            key={hit.artifactId}
            optionId={`${props.listboxId}-option-${index}`}
            hit={hit}
            active={index === props.activeIndex}
            stale={props.staleArtifactId === hit.artifactId}
            onActivate={props.onActivate}
            onHover={() => props.onHoverIndex(index)}
          />
        ))}
      </ul>
      {props.response?.truncated === true ? (
        // Count-free so it stays truthful after the renderer-only read filter,
        // which can drop hits from the host's already-truncated page.
        <p className="shrink-0 px-3 pb-1 pt-1 text-ui-xs text-muted-foreground">
          More matches exist - refine your search to narrow results.
        </p>
      ) : null}
    </div>
  );
}

interface ArtifactSearchResultRowProps {
  readonly optionId: string;
  readonly hit: SearchArtifactHit;
  readonly active: boolean;
  readonly stale: boolean;
  readonly onActivate: (hit: SearchArtifactHit) => void;
  readonly onHover: () => void;
}

const ArtifactSearchResultRow = memo(function ArtifactSearchResultRow(
  props: ArtifactSearchResultRowProps,
) {
  const { hit, active, stale, onActivate, onHover } = props;
  const Icon = isEpicArtifactKind(hit.kind)
    ? EPIC_NODE_ICONS[hit.kind]
    : FileText;
  const title = displayTitle(hit.title, hit.kind);
  // The RPC breadcrumb includes the artifact's own folder slug last; drop it so
  // only the ancestor trail shows (the title already names the artifact). These
  // are folder slugs relative to the artifact root - never host-absolute paths.
  const ancestors = hit.breadcrumb.slice(0, -1);
  const showStatusDot =
    hit.status !== null && Object.hasOwn(STATUS_DOT_CLASSES, hit.status);

  return (
    <li
      id={props.optionId}
      role="option"
      aria-selected={active}
      aria-disabled={stale}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 outline-none",
        active ? "bg-accent" : "hover:bg-accent/50",
        stale && "opacity-60",
      )}
      onMouseEnter={onHover}
      onClick={() => onActivate(hit)}
      onKeyDown={(event) => {
        // The combobox input owns navigation; this only matters if a row ever
        // receives direct focus (satisfies the click/key-parity a11y rule).
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(hit);
        }
      }}
      data-testid={`epic-artifact-search-result-${hit.artifactId}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {showStatusDot && hit.status !== null ? (
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              STATUS_DOT_CLASSES[hit.status],
            )}
            aria-label={STATUS_LABELS[hit.status]}
          />
        ) : null}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {title}
        </span>
      </div>
      {ancestors.length > 0 ? (
        <p className="truncate pl-5 text-ui-xs text-muted-foreground/70">
          {ancestors.join(" › ")}
        </p>
      ) : null}
      {stale ? (
        <p className="pl-5 text-ui-xs text-destructive">
          This artifact no longer exists.
        </p>
      ) : (
        <ArtifactSnippetList hit={hit} />
      )}
    </li>
  );
});

function ArtifactSnippetList(props: { readonly hit: SearchArtifactHit }) {
  if (props.hit.snippets.length === 0) return null;
  return (
    <div className="space-y-0.5 pl-5 pt-0.5">
      {props.hit.snippets.map((snippet) => (
        <ArtifactSnippetLine
          key={`${snippet.lineNumber}:${snippet.text}`}
          text={snippet.text}
          ranges={snippet.ranges}
        />
      ))}
    </div>
  );
}

function ArtifactSnippetLine(props: {
  readonly text: string;
  readonly ranges: ReadonlyArray<SnippetByteRange>;
}) {
  const segments = useMemo(
    () => highlightSegmentsFromByteRanges(props.text, props.ranges),
    [props.text, props.ranges],
  );
  return (
    <p className="truncate text-ui-xs text-muted-foreground">
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.start}
            className="rounded-sm bg-primary/20 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
