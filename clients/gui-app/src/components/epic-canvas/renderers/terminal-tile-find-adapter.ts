import type {
  ISearchOptions,
  ISearchResultChangeEvent,
  SearchAddon,
} from "@xterm/addon-search";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
} from "@/stores/tile-find";

export type TerminalTileFindKind = Extract<
  TileKindId,
  "terminal" | "terminal-agent"
>;

export type TerminalSearchResultSource = "legacy" | "tile";

export type TerminalSearchResultSourceSink = (
  source: TerminalSearchResultSource,
) => void;

export interface TerminalTileFindAdapter extends TileFindAdapter {
  publishResults(result: ISearchResultChangeEvent): void;
  setSearchAddon(addon: SearchAddon | null): void;
  setSearchResultSourceSink(sink: TerminalSearchResultSourceSink | null): void;
}

export interface RunTerminalXtermSearchInput {
  readonly addon: SearchAddon | null;
  readonly query: string;
  readonly matchCase: boolean;
  readonly forward: boolean;
  readonly incremental: boolean;
}

export interface RunTerminalXtermSearchResult {
  readonly attempted: boolean;
  readonly cleared: boolean;
  readonly found: boolean;
}

const TERMINAL_SEARCH_DECORATIONS: ISearchOptions["decorations"] = {
  matchBackground: "#854d0e",
  matchOverviewRuler: "#f59e0b",
  activeMatchBackground: "#facc15",
  activeMatchColorOverviewRuler: "#facc15",
};

const TERMINAL_FIND_CAPABILITIES = new Set<TileFindCapability>(["find"]);
const TERMINAL_BUFFER_UNIT_ID = "terminal-buffer";

export function createTerminalTileFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TerminalTileFindKind;
}): TerminalTileFindAdapter {
  let searchAddon: SearchAddon | null = null;
  let markSearchResultSource: TerminalSearchResultSourceSink =
    noopSearchResultSourceSink;
  let snapshot = createTerminalSnapshot({
    tileInstanceId: args.tileInstanceId,
    requestId: 0,
    status: "idle",
    query: "",
    matchCase: false,
    current: 0,
    total: 0,
  });
  const listeners = new Set<() => void>();

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const publishSearchUnavailable = (input: TileFindInput): void => {
    publish({
      ...snapshot,
      requestId: input.requestId,
      status: "unavailable",
      query: input.query,
      matchCase: input.matchCase,
      current: 0,
      total: 0,
      coverageMessage: "Terminal search is not ready yet.",
      errorMessage: null,
      activeUnitId: null,
      exactHighlight: "none",
    });
  };

  const publishNoMatches = (input: TileFindInput): void => {
    publish(
      createTerminalSnapshot({
        tileInstanceId: args.tileInstanceId,
        requestId: input.requestId,
        status: "ready",
        query: input.query,
        matchCase: input.matchCase,
        current: 0,
        total: 0,
      }),
    );
  };

  const runSearch = (input: TileFindInput, forward: boolean): void => {
    markSearchResultSource("tile");
    if (input.query.length === 0) {
      runTerminalXtermSearch({
        addon: searchAddon,
        query: input.query,
        matchCase: input.matchCase,
        forward,
        incremental: false,
      });
      publish(
        createTerminalSnapshot({
          tileInstanceId: args.tileInstanceId,
          requestId: input.requestId,
          status: "idle",
          query: "",
          matchCase: input.matchCase,
          current: 0,
          total: 0,
        }),
      );
      return;
    }

    publish({
      ...snapshot,
      requestId: input.requestId,
      status: "searching",
      query: input.query,
      matchCase: input.matchCase,
      current: 0,
      total: 0,
      coverageMessage: null,
      errorMessage: null,
      activeUnitId: null,
      exactHighlight: "pending",
    });

    const result = runTerminalXtermSearch({
      addon: searchAddon,
      query: input.query,
      matchCase: input.matchCase,
      forward,
      incremental: forward,
    });
    if (!result.attempted) {
      publishSearchUnavailable(input);
      return;
    }
    if (!result.found) {
      publishNoMatches(input);
    }
  };

  const navigate = (forward: boolean): void => {
    const input: TileFindInput = {
      requestId: snapshot.requestId,
      query: snapshot.query,
      matchCase: snapshot.matchCase,
    };
    if (input.query.length === 0) return;
    markSearchResultSource("tile");
    const result = runTerminalXtermSearch({
      addon: searchAddon,
      query: input.query,
      matchCase: input.matchCase,
      forward,
      incremental: false,
    });
    if (!result.attempted) {
      publishSearchUnavailable(input);
      return;
    }
    if (!result.found) {
      publishNoMatches(input);
    }
  };

  return {
    tileInstanceId: args.tileInstanceId,
    tileKind: args.tileKind,
    replace: null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: (input) => {
      runSearch(input, true);
    },
    next: () => {
      navigate(true);
    },
    previous: () => {
      navigate(false);
    },
    clear: () => {
      markSearchResultSource("tile");
      searchAddon?.clearDecorations();
      publish(
        createTerminalSnapshot({
          tileInstanceId: args.tileInstanceId,
          requestId: snapshot.requestId,
          status: "idle",
          query: "",
          matchCase: snapshot.matchCase,
          current: 0,
          total: 0,
        }),
      );
    },
    publishResults: (result) => {
      const totals = totalsFromSearchResult(result);
      publish({
        ...snapshot,
        status: "ready",
        current: totals.current,
        total: totals.total,
        coverageMessage: null,
        errorMessage: null,
        activeUnitId:
          totals.total > 0
            ? `${args.tileInstanceId}:${TERMINAL_BUFFER_UNIT_ID}`
            : null,
        exactHighlight: totals.total > 0 ? "painted" : "none",
      });
    },
    setSearchAddon: (addon) => {
      searchAddon = addon;
    },
    setSearchResultSourceSink: (sink) => {
      markSearchResultSource = sink ?? noopSearchResultSourceSink;
    },
  };
}

export function runTerminalXtermSearch(
  input: RunTerminalXtermSearchInput,
): RunTerminalXtermSearchResult {
  const { addon, query, matchCase, forward, incremental } = input;
  if (addon === null) {
    return { attempted: false, cleared: false, found: false };
  }
  if (query.length === 0) {
    addon.clearDecorations();
    return { attempted: true, cleared: true, found: false };
  }
  const options: ISearchOptions = {
    caseSensitive: matchCase,
    incremental,
    decorations: TERMINAL_SEARCH_DECORATIONS,
  };
  const found = forward
    ? addon.findNext(query, options)
    : addon.findPrevious(query, options);
  return { attempted: true, cleared: false, found };
}

function createTerminalSnapshot(args: {
  readonly tileInstanceId: string;
  readonly requestId: number;
  readonly status: TileFindStateSnapshot["status"];
  readonly query: string;
  readonly matchCase: boolean;
  readonly current: number;
  readonly total: number;
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: args.status,
    capabilities: TERMINAL_FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: "",
    current: args.current,
    total: args.total,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId:
      args.total > 0
        ? `${args.tileInstanceId}:${TERMINAL_BUFFER_UNIT_ID}`
        : null,
    exactHighlight: args.total > 0 ? "painted" : "none",
  };
}

function totalsFromSearchResult(result: ISearchResultChangeEvent): {
  readonly current: number;
  readonly total: number;
} {
  if (result.resultCount === 0) return { current: 0, total: 0 };
  if (result.resultIndex < 0) return { current: 0, total: result.resultCount };
  return {
    current: result.resultIndex + 1,
    total: result.resultCount,
  };
}

function noopSearchResultSourceSink(
  _source: TerminalSearchResultSource,
): void {}
