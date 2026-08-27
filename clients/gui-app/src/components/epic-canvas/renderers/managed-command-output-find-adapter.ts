import type { ManagedCommandTimelineLine } from "@/stores/managed-commands/managed-command-output-store";
import {
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindExactHighlight,
  type TileFindInput,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import { TILE_FIND_NO_CAPABILITIES } from "@/stores/tile-find/types";

export interface ManagedCommandOutputFindMatch {
  readonly seq: number;
  readonly lineIndex: number;
  readonly startCol: number;
  readonly length: number;
}

export interface ManagedCommandOutputFindEnvironment {
  readonly lines: readonly ManagedCommandTimelineLine[];
  /**
   * `true` when the loaded log can be searched. `false` uses the default
   * unavailable copy; a string is that copy (no snapshot yet, or the panel
   * replaced the log).
   */
  readonly available: boolean | string;
  readonly reachedStart: boolean;
  readonly detached: boolean;
  readonly revealMatch: (match: ManagedCommandOutputFindMatch) => void;
}

export interface ManagedCommandOutputFindAdapter extends TileFindAdapter {
  // Every command here settles against the already-loaded window, so nothing
  // is ever awaited. Narrowing the contract's `void | Promise<void>` to `void`
  // says so, and spares callers laundering a promise that is never created.
  search(input: TileFindInput): void;
  next(): void;
  previous(): void;
  updateEnvironment(environment: ManagedCommandOutputFindEnvironment): void;
  getMatches(): readonly ManagedCommandOutputFindMatch[];
}

const FIND_CAPABILITIES = new Set<TileFindCapability>(["find"]);

export const MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE =
  "Search covers loaded output only. Scroll up to load more.";

const DEFAULT_UNAVAILABLE_MESSAGE = "Output is not available for search.";

const EMPTY_ENVIRONMENT: ManagedCommandOutputFindEnvironment = {
  lines: [],
  available: DEFAULT_UNAVAILABLE_MESSAGE,
  reachedStart: false,
  detached: false,
  revealMatch: () => undefined,
};

const EMPTY_MATCHES: readonly ManagedCommandOutputFindMatch[] = [];

export function createManagedCommandOutputFindAdapter(args: {
  readonly tileInstanceId: string;
}): ManagedCommandOutputFindAdapter {
  const { tileInstanceId } = args;
  let environment = EMPTY_ENVIRONMENT;
  let snapshot = createUnavailableSnapshot({
    requestId: 0,
    query: "",
    matchCase: false,
    replaceText: "",
    message: DEFAULT_UNAVAILABLE_MESSAGE,
  });
  let matches: readonly ManagedCommandOutputFindMatch[] = EMPTY_MATCHES;
  let publishedMatches = matches;
  let activeIndex = 0;
  const listeners = new Set<() => void>();

  // The find store subscribes to this adapter for as long as the tile is
  // registered, open bar or not, and `updateEnvironment` re-runs on every
  // streamed line. Publishing an identical snapshot each time would write that
  // store once per line of output on the highest-volume surface in the app.
  // Matches are compared by reference rather than deeply: a live query rebuilds
  // the array on every scan, so only the empty-query case -- a tailing log with
  // nothing typed, which is the common one -- actually skips.
  const publish = (next: TileFindStateSnapshot): void => {
    if (publishedMatches === matches && snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    publishedMatches = matches;
    listeners.forEach((listener) => listener());
  };

  const publishForCurrentEnvironment = (run: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly replaceText: string;
    readonly preserveActive: boolean;
    readonly reveal: boolean;
  }): void => {
    const unavailableMessage = unavailableMessageFor(environment.available);
    if (unavailableMessage !== null) {
      matches = EMPTY_MATCHES;
      activeIndex = 0;
      publish(
        createUnavailableSnapshot({
          requestId: run.requestId,
          query: run.query,
          matchCase: run.matchCase,
          replaceText: run.replaceText,
          message: unavailableMessage,
        }),
      );
      return;
    }

    if (run.query.length === 0) {
      matches = EMPTY_MATCHES;
      activeIndex = 0;
      publish(
        createSearchableSnapshot({
          tileInstanceId,
          requestId: run.requestId,
          query: run.query,
          matchCase: run.matchCase,
          replaceText: run.replaceText,
          partial: isPartialCoverage(environment),
          current: 0,
          total: 0,
          activeSeq: null,
          exactHighlight: "none",
        }),
      );
      return;
    }

    const previous =
      run.preserveActive && matches.length > 0
        ? (matches[activeIndex] ?? null)
        : null;
    matches = collectMatches({
      lines: environment.lines,
      query: run.query,
      matchCase: run.matchCase,
    });
    activeIndex = preservedActiveIndex(matches, previous);
    const activeMatch = matchAt(matches, activeIndex);
    // Only a command the human gave reveals. A re-scan is not one, even when
    // it lands on a different match: `updateEnvironment` runs on every append,
    // prepend and rebase, and revealing there would scroll the tile and drop
    // follow mode with nobody having asked. Someone tailing live output with a
    // query still in the bar would silently stop following the moment the line
    // holding their active match aged out of the window.
    if (activeMatch !== null && run.reveal) {
      environment.revealMatch(activeMatch);
    }
    publish(
      createSearchableSnapshot({
        tileInstanceId,
        requestId: run.requestId,
        query: run.query,
        matchCase: run.matchCase,
        replaceText: run.replaceText,
        partial: isPartialCoverage(environment),
        current: activeMatch === null ? 0 : activeIndex + 1,
        total: matches.length,
        activeSeq: activeMatch === null ? null : activeMatch.seq,
        exactHighlight: activeMatch === null ? "none" : "painted",
      }),
    );
  };

  const move = (direction: 1 | -1): void => {
    if (snapshot.query.length === 0 || matches.length === 0) return;
    activeIndex = (activeIndex + direction + matches.length) % matches.length;
    const activeMatch = matches[activeIndex];
    environment.revealMatch(activeMatch);
    publish(
      createSearchableSnapshot({
        tileInstanceId,
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        partial: isPartialCoverage(environment),
        current: activeIndex + 1,
        total: matches.length,
        activeSeq: activeMatch.seq,
        exactHighlight: "painted",
      }),
    );
  };

  return {
    tileInstanceId,
    tileKind: "managed-command-output",
    replace: null,
    getSnapshot: () => snapshot,
    getMatches: () => matches,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: (input: TileFindInput) => {
      publishForCurrentEnvironment({
        requestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        replaceText: snapshot.replaceText,
        preserveActive: false,
        reveal: true,
      });
    },
    next: () => {
      move(1);
    },
    previous: () => {
      move(-1);
    },
    clear: () => {
      publishForCurrentEnvironment({
        requestId: snapshot.requestId,
        query: "",
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        preserveActive: false,
        reveal: false,
      });
    },
    updateEnvironment: (nextEnvironment) => {
      environment = nextEnvironment;
      publishForCurrentEnvironment({
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        preserveActive: true,
        reveal: false,
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
  readonly tileInstanceId: string;
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly partial: boolean;
  readonly current: number;
  readonly total: number;
  readonly activeSeq: number | null;
  readonly exactHighlight: TileFindExactHighlight;
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: searchableStatus(args.query, args.partial),
    capabilities: FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: args.replaceText,
    current: args.current,
    total: args.total,
    coverageMessage: args.partial
      ? MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE
      : null,
    errorMessage: null,
    activeUnitId:
      args.activeSeq === null
        ? null
        : `${args.tileInstanceId}:line-${String(args.activeSeq)}`,
    exactHighlight: args.exactHighlight,
  };
}

function searchableStatus(
  query: string,
  partial: boolean,
): "idle" | "ready" | "partial" {
  if (query.length === 0) return "idle";
  return partial ? "partial" : "ready";
}

function isPartialCoverage(
  environment: ManagedCommandOutputFindEnvironment,
): boolean {
  return !environment.reachedStart || environment.detached;
}

function unavailableMessageFor(available: boolean | string): string | null {
  if (available === true) return null;
  if (available === false) return DEFAULT_UNAVAILABLE_MESSAGE;
  return available;
}

function collectMatches(args: {
  readonly lines: readonly ManagedCommandTimelineLine[];
  readonly query: string;
  readonly matchCase: boolean;
}): readonly ManagedCommandOutputFindMatch[] {
  if (args.query.length === 0) return EMPTY_MATCHES;
  const needle = args.matchCase ? args.query : args.query.toLowerCase();
  const step = Math.max(args.query.length, 1);
  const found: ManagedCommandOutputFindMatch[] = [];
  for (let lineIndex = 0; lineIndex < args.lines.length; lineIndex += 1) {
    const line = args.lines[lineIndex];
    const haystack = args.matchCase ? line.text : line.text.toLowerCase();
    let index = haystack.indexOf(needle, 0);
    while (index !== -1) {
      found.push({
        seq: line.seq,
        lineIndex,
        startCol: index,
        length: args.query.length,
      });
      index = haystack.indexOf(needle, index + step);
    }
  }
  return found;
}

function preservedActiveIndex(
  nextMatches: readonly ManagedCommandOutputFindMatch[],
  previous: ManagedCommandOutputFindMatch | null,
): number {
  if (previous === null || nextMatches.length === 0) return 0;
  const exact = nextMatches.findIndex(
    (match) =>
      match.seq === previous.seq && match.startCol === previous.startCol,
  );
  if (exact >= 0) return exact;
  for (let index = 0; index < nextMatches.length; index += 1) {
    const match = nextMatches[index];
    if (match.seq > previous.seq) return index;
    if (match.seq === previous.seq && match.startCol >= previous.startCol) {
      return index;
    }
  }
  return nextMatches.length - 1;
}

function matchAt(
  nextMatches: readonly ManagedCommandOutputFindMatch[],
  index: number,
): ManagedCommandOutputFindMatch | null {
  if (index < 0) return null;
  return nextMatches.at(index) ?? null;
}

// Capabilities are the two module-level sets, so reference equality is the
// right comparison for that field; everything else on the snapshot is a
// primitive.
function snapshotsEqual(
  left: TileFindStateSnapshot,
  right: TileFindStateSnapshot,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.status === right.status &&
    left.capabilities === right.capabilities &&
    left.query === right.query &&
    left.matchCase === right.matchCase &&
    left.replaceText === right.replaceText &&
    left.current === right.current &&
    left.total === right.total &&
    left.coverageMessage === right.coverageMessage &&
    left.errorMessage === right.errorMessage &&
    left.activeUnitId === right.activeUnitId &&
    left.exactHighlight === right.exactHighlight
  );
}
