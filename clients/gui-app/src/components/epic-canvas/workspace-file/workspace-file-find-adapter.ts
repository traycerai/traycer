import {
  FindEngine,
  isFindEngineSupported,
} from "@/lib/find-engine/find-engine";
import {
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindInput,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import { TILE_FIND_NO_CAPABILITIES } from "@/stores/tile-find/types";

export type WorkspaceFileFindViewMode = "source" | "preview";

export interface WorkspaceFileSourceFindRange {
  readonly line: number;
  readonly column: number;
  // Absolute character offset of the match start into the (loaded) file
  // content, and its length. Together they let the renderer paint the exact
  // text span - including matches that straddle Shiki token boundaries - while
  // `line`/`column` keep the gutter marker and scroll target addressable.
  readonly offset: number;
  readonly length: number;
}

export interface WorkspaceFileSourceFindTarget {
  readonly active: WorkspaceFileSourceFindRange;
  readonly matches: readonly WorkspaceFileSourceFindRange[];
}

export interface WorkspaceFileFindEnvironment {
  readonly viewMode: WorkspaceFileFindViewMode;
  readonly content: string | null;
  readonly isLoading: boolean;
  readonly displayError: string | null;
  readonly truncated: boolean;
  readonly previewRoot: HTMLElement | null;
  readonly revealSourceMatch: (
    target: WorkspaceFileSourceFindTarget | null,
  ) => void;
}

export interface WorkspaceFileFindAdapter extends TileFindAdapter {
  updateEnvironment(environment: WorkspaceFileFindEnvironment): void;
}

type SourceMatch = WorkspaceFileSourceFindRange;

const FIND_CAPABILITIES = new Set<TileFindCapability>(["find"]);
const TRUNCATED_COVERAGE_MESSAGE =
  "File preview is truncated. Search covers loaded content only.";

const EMPTY_ENVIRONMENT: WorkspaceFileFindEnvironment = {
  viewMode: "source",
  content: null,
  isLoading: true,
  displayError: null,
  truncated: false,
  previewRoot: null,
  revealSourceMatch: () => undefined,
};

export function createWorkspaceFileFindAdapter(args: {
  readonly tileInstanceId: string;
}): WorkspaceFileFindAdapter {
  let environment = EMPTY_ENVIRONMENT;
  let snapshot = createUnavailableSnapshot({
    requestId: 0,
    query: "",
    matchCase: false,
    replaceText: "",
    message:
      unavailableMessageFor(environment) ?? "File content is unavailable.",
  });
  let sourceMatches: readonly SourceMatch[] = [];
  let activeSourceIndex = 0;
  let previewEngine: FindEngine | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const clearPreviewEngine = (): void => {
    previewEngine?.dispose();
    previewEngine = null;
  };

  const clearVisibleHighlights = (): void => {
    clearPreviewEngine();
    environment.revealSourceMatch(null);
  };

  const publishForCurrentEnvironment = (args: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly replaceText: string;
  }): void => {
    clearVisibleHighlights();
    sourceMatches = [];
    activeSourceIndex = 0;

    const unavailableMessage = unavailableMessageFor(environment);
    if (unavailableMessage !== null) {
      publish(
        createUnavailableSnapshot({
          requestId: args.requestId,
          query: args.query,
          matchCase: args.matchCase,
          replaceText: args.replaceText,
          message: unavailableMessage,
        }),
      );
      return;
    }

    if (args.query.length === 0) {
      publish(
        createSearchableSnapshot({
          requestId: args.requestId,
          query: args.query,
          matchCase: args.matchCase,
          replaceText: args.replaceText,
          truncated: environment.truncated,
          current: 0,
          total: 0,
          activeUnitId: null,
          exactHighlight: "none",
        }),
      );
      return;
    }

    if (environment.viewMode === "preview") {
      runPreviewSearch(args);
      return;
    }

    runSourceSearch(args);
  };

  const runSourceSearch = (args: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly replaceText: string;
  }): void => {
    sourceMatches = collectSourceMatches({
      content: environment.content ?? "",
      query: args.query,
      matchCase: args.matchCase,
    });
    activeSourceIndex = 0;
    const activeMatch = sourceMatchAt(sourceMatches, activeSourceIndex);
    if (activeMatch !== null) {
      environment.revealSourceMatch({
        active: activeMatch,
        matches: sourceMatches,
      });
    }
    publish(
      createSearchableSnapshot({
        requestId: args.requestId,
        query: args.query,
        matchCase: args.matchCase,
        replaceText: args.replaceText,
        truncated: environment.truncated,
        current: activeMatch === null ? 0 : 1,
        total: sourceMatches.length,
        activeUnitId:
          activeMatch === null ? null : sourceActiveUnitId(activeMatch.line),
        exactHighlight: activeMatch === null ? "none" : "pending",
      }),
    );
  };

  const runPreviewSearch = (args: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly replaceText: string;
  }): void => {
    const root = environment.previewRoot;
    if (root === null || !isFindEngineSupported()) {
      publish(
        createUnavailableSnapshot({
          requestId: args.requestId,
          query: args.query,
          matchCase: args.matchCase,
          replaceText: args.replaceText,
          message:
            root === null
              ? "Markdown preview is not ready for search."
              : "Markdown preview search is unavailable in this browser.",
        }),
      );
      return;
    }

    previewEngine = new FindEngine({
      root,
      matchCase: args.matchCase,
    });
    previewEngine.search(args.query);
    previewEngine.scrollActiveIntoView();
    const result = previewEngine.getResult();
    const current = result?.current ?? 0;
    const total = result?.total ?? 0;
    publish(
      createSearchableSnapshot({
        requestId: args.requestId,
        query: args.query,
        matchCase: args.matchCase,
        replaceText: args.replaceText,
        truncated: environment.truncated,
        current,
        total,
        activeUnitId: total === 0 ? null : "markdown-preview",
        exactHighlight: total === 0 ? "none" : "painted",
      }),
    );
  };

  const moveSourceMatch = (direction: 1 | -1): void => {
    if (sourceMatches.length === 0) return;
    activeSourceIndex =
      (activeSourceIndex + direction + sourceMatches.length) %
      sourceMatches.length;
    const activeMatch = sourceMatches[activeSourceIndex];
    environment.revealSourceMatch({
      active: activeMatch,
      matches: sourceMatches,
    });
    publish(
      createSearchableSnapshot({
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        truncated: environment.truncated,
        current: activeSourceIndex + 1,
        total: sourceMatches.length,
        activeUnitId: sourceActiveUnitId(activeMatch.line),
        exactHighlight: "pending",
      }),
    );
  };

  const movePreviewMatch = (direction: 1 | -1): void => {
    if (previewEngine === null) return;
    if (direction === 1) previewEngine.next();
    else previewEngine.previous();
    previewEngine.scrollActiveIntoView();
    const result = previewEngine.getResult();
    if (result === null) return;
    const hasMatches = result.total > 0;
    publish(
      createSearchableSnapshot({
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        truncated: environment.truncated,
        current: result.current,
        total: result.total,
        activeUnitId: hasMatches ? "markdown-preview" : null,
        exactHighlight: hasMatches ? "painted" : "none",
      }),
    );
  };

  const search = (input: TileFindInput, replaceText: string): void => {
    publishForCurrentEnvironment({
      requestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      replaceText,
    });
  };

  return {
    tileInstanceId: args.tileInstanceId,
    tileKind: "workspace-file",
    replace: null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: (input) => {
      search(input, snapshot.replaceText);
    },
    next: () => {
      if (snapshot.query.length === 0) return;
      if (environment.viewMode === "preview") {
        movePreviewMatch(1);
        return;
      }
      moveSourceMatch(1);
    },
    previous: () => {
      if (snapshot.query.length === 0) return;
      if (environment.viewMode === "preview") {
        movePreviewMatch(-1);
        return;
      }
      moveSourceMatch(-1);
    },
    clear: () => {
      publishForCurrentEnvironment({
        requestId: snapshot.requestId,
        query: "",
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
      });
    },
    updateEnvironment: (nextEnvironment) => {
      environment = nextEnvironment;
      publishForCurrentEnvironment({
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
      });
    },
  };
}

function createUnavailableSnapshot(args: {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly message: string;
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: "unavailable",
    capabilities: TILE_FIND_NO_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: args.replaceText,
    current: 0,
    total: 0,
    coverageMessage: args.message,
    errorMessage: null,
    activeUnitId: null,
    exactHighlight: "none",
  };
}

function createSearchableSnapshot(args: {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly truncated: boolean;
  readonly current: number;
  readonly total: number;
  readonly activeUnitId: string | null;
  readonly exactHighlight: "none" | "pending" | "painted";
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: environmentStatus(args.query, args.truncated),
    capabilities: FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: args.replaceText,
    current: args.current,
    total: args.total,
    coverageMessage: args.truncated ? TRUNCATED_COVERAGE_MESSAGE : null,
    errorMessage: null,
    activeUnitId: args.activeUnitId,
    exactHighlight: args.exactHighlight,
  };
}

function environmentStatus(
  query: string,
  truncated: boolean,
): "idle" | "ready" | "partial" {
  if (query.length === 0) return "idle";
  return truncated ? "partial" : "ready";
}

function unavailableMessageFor(
  environment: WorkspaceFileFindEnvironment,
): string | null {
  if (environment.isLoading) return "File is still loading.";
  if (environment.displayError !== null) return environment.displayError;
  if (environment.content === null) return "File content is unavailable.";
  return null;
}

function collectSourceMatches(args: {
  readonly content: string;
  readonly query: string;
  readonly matchCase: boolean;
}): readonly SourceMatch[] {
  if (args.query.length === 0) return [];
  const haystack = args.matchCase ? args.content : args.content.toLowerCase();
  const needle = args.matchCase ? args.query : args.query.toLowerCase();
  const lineStarts = collectLineStarts(args.content);
  const matches: SourceMatch[] = [];
  const step = Math.max(args.query.length, 1);
  // Matches are found in increasing offset order, so advance the line cursor
  // forward monotonically instead of rescanning lineStarts for every hit.
  let lineCursor = 0;
  let index = haystack.indexOf(needle, 0);
  while (index !== -1) {
    while (
      lineCursor + 1 < lineStarts.length &&
      (lineStarts.at(lineCursor + 1) ?? Number.POSITIVE_INFINITY) <= index
    ) {
      lineCursor += 1;
    }
    const lineStart = lineStarts.at(lineCursor) ?? 0;
    matches.push({
      line: lineCursor + 1,
      column: index - lineStart + 1,
      offset: index,
      length: args.query.length,
    });
    index = haystack.indexOf(needle, index + step);
  }
  return matches;
}

function collectLineStarts(content: string): readonly number[] {
  const starts = [0];
  let index = content.indexOf("\n", 0);
  while (index !== -1) {
    starts.push(index + 1);
    index = content.indexOf("\n", index + 1);
  }
  return starts;
}

function sourceActiveUnitId(line: number): string {
  return `line:${line}`;
}

function sourceMatchAt(
  matches: readonly SourceMatch[],
  index: number,
): SourceMatch | null {
  if (index < 0) return null;
  return matches.at(index) ?? null;
}
