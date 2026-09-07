import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
} from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FindEngine,
  getFindSkipAttribute,
  isFindEngineSupported,
} from "@/lib/find-engine/find-engine";
import { cn } from "@/lib/utils";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import { useTerminalFindStore } from "@/stores/find-in-page/terminal-find-store";

const LIVE_SEARCH_DEBOUNCE_MS = 140;

/**
 * Legacy global find bar driven by the CSS-highlight-based `FindEngine`.
 * Quarantined after the tile-local Command+F cutover; do not mount for the
 * default find command path.
 *
 * The engine paints matches via `CSS.highlights` and never mutates
 * `window.getSelection()` - so contenteditable editors (TipTap composer,
 * etc.) don't observe a selection change and don't grab focus from the
 * find input. Live-search runs on every keystroke (debounced) without
 * any focus-reclamation gymnastics.
 */
export function FindInPageBar() {
  const isOpen = useFindInPageStore((s) => s.isOpen);
  const matches = useFindInPageStore((s) => s.matches);
  const matchCase = useFindInPageStore((s) => s.matchCase);
  const query = useFindInPageStore((s) => s.query);
  const setQuery = useFindInPageStore((s) => s.setQuery);
  const setMatches = useFindInPageStore((s) => s.setMatches);
  const setMatchCase = useFindInPageStore((s) => s.setMatchCase);
  const close = useFindInPageStore((s) => s.close);

  const advanceForwardNonce = useFindInPageStore((s) => s.advanceForwardNonce);
  const advanceBackwardNonce = useFindInPageStore(
    (s) => s.advanceBackwardNonce,
  );
  const focusRequestNonce = useFindInPageStore((s) => s.focusRequestNonce);
  const terminalFindController = useTerminalFindStore(
    (s) => s.activeController,
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<FindEngine | null>(null);
  const supported = useMemo(() => isFindEngineSupported(), []);
  const terminalSearchActive = terminalFindController !== null;
  const runSearch = useCallback(
    (nextQuery: string, scrollActiveMatch: boolean): void => {
      const engine = engineRef.current;
      if (engine === null) return;
      if (nextQuery.length === 0) {
        engine.search("");
        setMatches(null);
        return;
      }
      engine.search(nextQuery);
      setMatches(engine.getResult());
      if (scrollActiveMatch) engine.scrollActiveIntoView();
    },
    [setMatches],
  );
  const runScheduledSearch = useEffectEvent((nextQuery: string) => {
    if (terminalFindController !== null) {
      terminalFindController.findNext(nextQuery, matchCase, true);
      return;
    }
    runSearch(nextQuery, true);
  });

  // Re-create the engine whenever the bar opens or matchCase flips - the
  // engine's case-folding is set once at construction. Disposes on close.
  useEffect(() => {
    if (!isOpen || !supported || terminalSearchActive) {
      engineRef.current?.dispose();
      engineRef.current = null;
      return;
    }
    engineRef.current = new FindEngine({
      root: document.body,
      matchCase,
    });
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [isOpen, matchCase, supported, terminalSearchActive]);

  // Run / re-run the search whenever the query (or matchCase, via engine
  // recreation) changes - debounced so fast typists don't trigger a
  // TreeWalker pass per keystroke.
  useEffect(() => {
    if (!isOpen) return;
    if (!terminalSearchActive && !supported) return;
    if (query.length === 0) {
      if (terminalFindController !== null) {
        terminalFindController.clear();
        setMatches(null);
      }
      return;
    }
    const handle = setTimeout(() => {
      runScheduledSearch(query);
    }, LIVE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [
    isOpen,
    query,
    matchCase,
    supported,
    terminalSearchActive,
    terminalFindController,
    setMatches,
  ]);

  // Focus on every open request. Repeated Cmd+F calls arrive while the bar is
  // already mounted, so `isOpen` alone is not enough to re-run this effect.
  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen, focusRequestNonce]);

  const advance = useCallback(
    (forward: boolean): void => {
      if (terminalFindController !== null) {
        if (query.length === 0) return;
        if (forward) terminalFindController.findNext(query, matchCase, false);
        else terminalFindController.findPrevious(query, matchCase);
        return;
      }
      const engine = engineRef.current;
      if (engine === null) return;
      if (forward) engine.next();
      else engine.previous();
      setMatches(engine.getResult());
      engine.scrollActiveIntoView();
    },
    [matchCase, query, setMatches, terminalFindController],
  );

  // React to Cmd+G / Cmd+Shift+G fired from the Edit menu. Each menu
  // press bumps the matching nonce; we advance once per bump. Skip the
  // initial render (when both nonces start at 0).
  const lastForwardSeen = useRef(advanceForwardNonce);
  const lastBackwardSeen = useRef(advanceBackwardNonce);
  useEffect(() => {
    if (advanceForwardNonce === lastForwardSeen.current) return;
    lastForwardSeen.current = advanceForwardNonce;
    if (!isOpen) return;
    advance(true);
  }, [advanceForwardNonce, isOpen, advance]);
  useEffect(() => {
    if (advanceBackwardNonce === lastBackwardSeen.current) return;
    lastBackwardSeen.current = advanceBackwardNonce;
    if (!isOpen) return;
    advance(false);
  }, [advanceBackwardNonce, isOpen, advance]);

  const handleClose = useCallback(() => {
    engineRef.current?.dispose();
    engineRef.current = null;
    terminalFindController?.clear();
    close();
  }, [close, terminalFindController]);

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
        advance(!event.shiftKey);
      }
    },
    [handleClose, advance],
  );

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextQuery = event.target.value;
      setQuery(nextQuery);
      if (nextQuery.length === 0) {
        if (terminalFindController !== null) {
          terminalFindController.clear();
          setMatches(null);
        } else {
          runSearch(nextQuery, false);
        }
      }
    },
    [runSearch, setMatches, setQuery, terminalFindController],
  );

  if (!isOpen || (!supported && !terminalSearchActive)) return null;

  const matchLabel = ((): string | null => {
    if (matches === null) return null;
    if (matches.total === 0) return "No matches";
    return `${matches.current} of ${matches.total}`;
  })();

  return (
    <search
      {...{ [getFindSkipAttribute()]: "" }}
      className={cn(
        "pointer-events-auto absolute right-3 top-3 z-30 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 shadow-md",
      )}
      aria-label="Find in page"
    >
      <Input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Find in page"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-7 w-48 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
      />
      {matchLabel === null ? null : (
        <span
          className={cn(
            "min-w-[5ch] text-right text-ui-xs text-muted-foreground",
            matches?.total === 0 && "text-destructive",
          )}
        >
          {matchLabel}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous match"
        onMouseDown={(event) => {
          event.preventDefault();
          advance(false);
        }}
        disabled={query.length === 0}
        className="size-7"
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next match"
        onMouseDown={(event) => {
          event.preventDefault();
          advance(true);
        }}
        disabled={query.length === 0}
        className="size-7"
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={matchCase}
        aria-label="Match case"
        onMouseDown={(event) => {
          event.preventDefault();
          setMatchCase(!matchCase);
        }}
        className={cn(
          "size-7 text-ui-xs font-medium",
          matchCase && "bg-accent text-accent-foreground",
        )}
      >
        Aa
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close find"
        onMouseDown={(event) => {
          event.preventDefault();
          handleClose();
        }}
        className="size-7"
      >
        <X className="size-4" />
      </Button>
    </search>
  );
}
