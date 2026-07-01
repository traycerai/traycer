import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Replace,
  ReplaceAll,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  selectTileFindUi,
  useTileFindStore,
} from "@/stores/tile-find/tile-find-store";
import type { TileFindStateSnapshot } from "@/stores/tile-find/types";

// Chat search scans the whole transcript, so keystrokes are coalesced into a
// single search instead of one per character. Mirrors the artifact adapter's
// rescan debounce window (ARTIFACT_FIND_RESCAN_DEBOUNCE_MS).
const CHAT_FIND_QUERY_DEBOUNCE_MS = 80;

interface TileFindBarProps {
  readonly tileInstanceId: string;
}

export function TileFindBar(props: TileFindBarProps) {
  const { tileInstanceId } = props;
  const ui = useTileFindStore(selectTileFindUi(tileInstanceId));
  const setQuery = useTileFindStore((state) => state.setQuery);
  const setMatchCase = useTileFindStore((state) => state.setMatchCase);
  const setReplaceText = useTileFindStore((state) => state.setReplaceText);
  const setReplaceExpanded = useTileFindStore(
    (state) => state.setReplaceExpanded,
  );
  const search = useTileFindStore((state) => state.search);
  const next = useTileFindStore((state) => state.next);
  const previous = useTileFindStore((state) => state.previous);
  const registerPendingSearchFlush = useTileFindStore(
    (state) => state.registerPendingSearchFlush,
  );
  const replaceCurrent = useTileFindStore((state) => state.replaceCurrent);
  const replaceAll = useTileFindStore((state) => state.replaceAll);
  const close = useTileFindStore((state) => state.close);
  const tileKind = useTileFindStore(
    (state) => state.targetsByTileInstanceId[tileInstanceId]?.tileKind ?? null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchDebounceRef = useRef<number | null>(null);

  const debounceSearch = tileKind === "chat";

  useEffect(() => {
    if (ui?.isOpen !== true) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [ui?.isOpen, ui?.focusRequestNonce]);

  const cancelPendingSearch = useCallback(() => {
    if (searchDebounceRef.current === null) return;
    window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = null;
  }, []);

  // Run a pending debounced search now. Returns true when one was flushed so the
  // caller can skip an extra advance (the search itself reveals the first match).
  const flushPendingSearch = useCallback(() => {
    if (searchDebounceRef.current === null) return false;
    window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = null;
    search(tileInstanceId);
    return true;
  }, [search, tileInstanceId]);

  useEffect(() => {
    return () => {
      cancelPendingSearch();
    };
  }, [cancelPendingSearch]);

  // Expose the flush to the store so store-driven navigation (the desktop menu's
  // Find Next/Previous, which bypasses this bar's `handleNavigate`) flushes a
  // pending debounced search before advancing, instead of advancing the prior
  // query's stale matches.
  useEffect(() => {
    registerPendingSearchFlush(tileInstanceId, flushPendingSearch);
    return () => {
      registerPendingSearchFlush(tileInstanceId, null);
    };
  }, [flushPendingSearch, registerPendingSearchFlush, tileInstanceId]);

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextQuery = event.target.value;
      setQuery(tileInstanceId, nextQuery);
      // Always cancel any in-flight debounce so the latest query wins. Chat
      // debounces non-empty queries; every other tile kind (and an emptied
      // query, which clears instantly) searches immediately.
      cancelPendingSearch();
      if (debounceSearch && nextQuery.length > 0) {
        searchDebounceRef.current = window.setTimeout(() => {
          searchDebounceRef.current = null;
          search(tileInstanceId);
        }, CHAT_FIND_QUERY_DEBOUNCE_MS);
        return;
      }
      search(tileInstanceId);
    },
    [cancelPendingSearch, debounceSearch, search, setQuery, tileInstanceId],
  );

  const handleMatchCase = useCallback(() => {
    if (ui === null) return;
    // A match-case toggle re-runs the search with the current query, so it
    // supersedes any pending debounced search.
    cancelPendingSearch();
    setMatchCase(tileInstanceId, !ui.matchCase);
    search(tileInstanceId);
  }, [cancelPendingSearch, search, setMatchCase, tileInstanceId, ui]);

  const handleNavigate = useCallback(
    (direction: 1 | -1) => {
      // A still-pending debounced search means the adapter holds stale matches;
      // flush it now (which reveals the first match) instead of advancing past
      // them. Otherwise navigate immediately.
      if (flushPendingSearch()) return;
      if (direction === 1) next(tileInstanceId);
      else previous(tileInstanceId);
    },
    [flushPendingSearch, next, previous, tileInstanceId],
  );

  const handleClose = useCallback(() => {
    cancelPendingSearch();
    close(tileInstanceId);
  }, [cancelPendingSearch, close, tileInstanceId]);

  const handleReplaceTextChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setReplaceText(tileInstanceId, event.target.value);
    },
    [setReplaceText, tileInstanceId],
  );
  const handleReplaceCurrent = useCallback(() => {
    replaceCurrent(tileInstanceId);
  }, [replaceCurrent, tileInstanceId]);
  const handleReplaceAll = useCallback(() => {
    replaceAll(tileInstanceId);
  }, [replaceAll, tileInstanceId]);

  const handleReplaceExpanded = useCallback(() => {
    if (ui === null) return;
    setReplaceExpanded(tileInstanceId, !ui.replaceExpanded);
  }, [setReplaceExpanded, tileInstanceId, ui]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleClose();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        handleNavigate(event.shiftKey ? -1 : 1);
        return;
      }
      const isModG =
        event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey);
      if (!isModG) return;
      event.preventDefault();
      event.stopPropagation();
      handleNavigate(event.shiftKey ? -1 : 1);
    },
    [handleClose, handleNavigate],
  );

  if (ui === null || !ui.isOpen) return null;

  const snapshot = ui.lastSnapshot;
  const replaceEnabled = snapshot.capabilities.has("replace");
  const replaceAllEnabled = snapshot.capabilities.has("replaceAll");
  const canNavigate = ui.query.length > 0 && snapshot.status !== "unavailable";
  const canSearch = snapshot.capabilities.has("find");

  const statusLabel = (
    <TileFindStatusLabel
      snapshot={snapshot}
      noMatchesLabel={replaceEnabled ? "No results" : "No matches"}
    />
  );
  const findRow = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1",
        !replaceEnabled && "flex-wrap",
      )}
    >
      <Input
        ref={inputRef}
        type="text"
        value={ui.query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Find in tile"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-7 w-[min(42vw,14rem)] min-w-[8rem] border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
      />
      {!replaceEnabled ? statusLabel : null}
      <Button
        type="button"
        variant={ui.matchCase ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Match case"
        aria-pressed={ui.matchCase}
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleMatchCase}
        disabled={!canSearch}
      >
        <CaseSensitive className="size-4" />
      </Button>
      {replaceEnabled ? statusLabel : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Previous match"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleNavigate(-1)}
        disabled={!canNavigate}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Next match"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleNavigate(1)}
        disabled={!canNavigate}
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close find"
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );

  return (
    <search
      data-testid="tile-find-bar"
      className={cn(
        "pointer-events-auto absolute right-3 top-3 z-30 flex max-w-[min(92vw,42rem)] gap-1 rounded-md border border-border bg-popover px-2 py-1 shadow-md",
        replaceEnabled ? "items-start" : "flex-wrap items-center",
      )}
      aria-label="Find in tile"
    >
      {replaceEnabled ? (
        <TileFindReplaceToggle
          expanded={ui.replaceExpanded}
          onToggle={handleReplaceExpanded}
        />
      ) : null}
      {replaceEnabled ? (
        <div className="flex min-w-0 flex-col gap-1">
          {findRow}
          {ui.replaceExpanded ? (
            <TileFindReplaceRow
              query={ui.query}
              replaceText={ui.replaceText}
              replaceAllEnabled={replaceAllEnabled}
              onReplaceTextChange={handleReplaceTextChange}
              onReplaceCurrent={handleReplaceCurrent}
              onReplaceAll={handleReplaceAll}
            />
          ) : null}
        </div>
      ) : (
        findRow
      )}
    </search>
  );
}

function TileFindReplaceToggle(props: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      aria-label={props.expanded ? "Collapse replace" : "Expand replace"}
      aria-expanded={props.expanded}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onToggle}
    >
      {props.expanded ? (
        <ChevronDown className="size-4" />
      ) : (
        <ChevronRight className="size-4" />
      )}
    </Button>
  );
}

function TileFindReplaceRow(props: {
  readonly query: string;
  readonly replaceText: string;
  readonly replaceAllEnabled: boolean;
  readonly onReplaceTextChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onReplaceCurrent: () => void;
  readonly onReplaceAll: () => void;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-testid="tile-find-replace-row"
    >
      <Input
        type="text"
        value={props.replaceText}
        onChange={props.onReplaceTextChange}
        placeholder="Replace"
        aria-label="Replace with"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Replace current match"
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onReplaceCurrent}
        disabled={props.query.length === 0}
      >
        <Replace className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Replace all matches"
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onReplaceAll}
        disabled={!props.replaceAllEnabled || props.query.length === 0}
      >
        <ReplaceAll className="size-4" />
      </Button>
    </div>
  );
}

function TileFindStatusLabel(props: {
  readonly snapshot: TileFindStateSnapshot;
  readonly noMatchesLabel: string;
}) {
  const { snapshot, noMatchesLabel } = props;
  const label = statusLabel(snapshot, noMatchesLabel);
  if (label === null) return null;
  const destructive =
    snapshot.status === "error" ||
    (snapshot.status !== "searching" &&
      snapshot.query.length > 0 &&
      snapshot.total === 0);
  return (
    <span
      className={cn(
        "min-w-[5ch] text-right text-ui-xs text-muted-foreground",
        destructive && "text-destructive",
        snapshot.status === "partial" && "text-amber-600 dark:text-amber-400",
      )}
      data-status={snapshot.status}
      title={snapshot.coverageMessage ?? snapshot.errorMessage ?? undefined}
    >
      {label}
    </span>
  );
}

function statusLabel(
  snapshot: TileFindStateSnapshot,
  noMatchesLabel: string,
): string | null {
  if (snapshot.status === "searching") return "Searching";
  if (snapshot.status === "unavailable") {
    return snapshot.coverageMessage ?? "Unavailable";
  }
  if (snapshot.status === "error") {
    return snapshot.errorMessage ?? "Error";
  }
  if (snapshot.query.length === 0) return null;
  // Partial coverage with zero loaded matches is not a definitive no-match:
  // more may exist in unloaded content, so don't show the exhaustive label.
  if (snapshot.status === "partial") {
    if (snapshot.total === 0) {
      return snapshot.coverageMessage ?? `${noMatchesLabel} in loaded content`;
    }
    return `${snapshot.current} of ${snapshot.total} partial`;
  }
  if (snapshot.total === 0) return noMatchesLabel;
  return `${snapshot.current} of ${snapshot.total}`;
}
