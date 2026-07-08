import { ChatFindHighlighter } from "@/components/chat/chat-find-highlighter";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import type { ChatFindRow } from "@/components/chat/chat-find-projection";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
} from "@/stores/tile-find";

export interface ChatFindAdapter extends TileFindAdapter {
  // Signals that the transcript changed. The adapter rebuilds rows from
  // `getRows()` and rescans matches only while a find session has an active
  // query, so a closed bar pays no projection cost on streaming updates.
  notifyRowsChanged(): void;
  syncMountedHighlight(): void;
  dispose(): void;
}

interface ChatFindAdapterOptions {
  readonly tileInstanceId: string;
  // Lazy supplier of the current transcript projection. Invoked when a search
  // opens, the query changes, or a notified message change must be rescanned -
  // never while the bar is closed.
  readonly getRows: () => ReadonlyArray<ChatFindRow>;
  readonly revealMatch: (target: ChatFindRevealTarget) => void;
  readonly reconcileMatch: (target: ChatFindReconcileTarget) => void;
  readonly clearReveal: () => void;
  readonly getMountedMessageRoot: (messageId: string) => HTMLElement | null;
  readonly getMountedUnitRoot: (
    messageId: string,
    unitId: string,
  ) => HTMLElement | null;
}

export interface ChatFindRevealTarget {
  readonly messageId: string;
  readonly unitId: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly matchKey: string;
  readonly paint: () => void;
  readonly paintFallback: () => void;
}

export interface ChatFindReconcileTarget {
  readonly messageId: string;
  readonly unitId: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly matchKey: string;
}

interface ChatFindMatch {
  readonly messageId: string;
  readonly rowIndex: number;
  readonly unitId: string;
  readonly unitIndex: number;
  readonly start: number;
  readonly end: number;
  // Occurrence ordinal within the match's own unit. Drives the unit-scope paint
  // and the match key.
  readonly occurrenceInUnit: number;
  // Occurrence ordinal across the WHOLE message (all units, in render order).
  // Drives the message-scope fallback paint, whose root walks every unit - the
  // per-unit ordinal would point at the wrong occurrence there.
  readonly occurrenceInMessage: number;
  // Surrounding unit text immediately before/after this occurrence (capped to a
  // small window). Used to re-anchor the active match across mid-unit streaming
  // inserts, where neither the occurrence ordinal nor the absolute offset is
  // stable but the immediate neighbours are.
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
}

const CHAT_FIND_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find"]);
const EMPTY_MATCHES: ReadonlyArray<ChatFindMatch> = [];
// How much neighbouring unit text to snapshot on each side of an occurrence for
// active-match re-anchoring across streaming inserts. Long enough to
// disambiguate occurrences of the same query, short enough to ignore edits that
// land elsewhere in the (often concatenated) unit.
const FIND_RECONCILE_CONTEXT_WINDOW = 32;

export function createChatFindAdapter(
  options: ChatFindAdapterOptions,
): ChatFindAdapter {
  return new ChatFindAdapterImpl(options);
}

class ChatFindAdapterImpl implements ChatFindAdapter {
  readonly tileInstanceId: string;
  readonly tileKind = "chat" as const;
  readonly replace = null;

  private readonly getRows: () => ReadonlyArray<ChatFindRow>;
  private readonly revealMatch: (target: ChatFindRevealTarget) => void;
  private readonly reconcileMatch: (target: ChatFindReconcileTarget) => void;
  private readonly clearReveal: () => void;
  private readonly getMountedUnitRoot: (
    messageId: string,
    unitId: string,
  ) => HTMLElement | null;
  private readonly getMountedMessageRoot: (
    messageId: string,
  ) => HTMLElement | null;
  private readonly listeners = new Set<() => void>();
  private readonly highlighter: ChatFindHighlighter;

  private rows: ReadonlyArray<ChatFindRow> = [];
  private matches: ReadonlyArray<ChatFindMatch> = EMPTY_MATCHES;
  private activeMatchIndex = 0;
  private snapshot: TileFindStateSnapshot;
  private paintFrameId: number | null = null;
  private paintGeneration = 0;

  constructor(options: ChatFindAdapterOptions) {
    this.tileInstanceId = options.tileInstanceId;
    this.getRows = options.getRows;
    this.revealMatch = options.revealMatch;
    this.reconcileMatch = options.reconcileMatch;
    this.clearReveal = options.clearReveal;
    this.getMountedMessageRoot = options.getMountedMessageRoot;
    this.getMountedUnitRoot = options.getMountedUnitRoot;
    this.highlighter = new ChatFindHighlighter(options.tileInstanceId);
    this.snapshot = createChatFindSnapshot({
      requestId: 0,
      status: "idle",
      query: "",
      matchCase: false,
      current: 0,
      total: 0,
      activeUnitId: null,
      exactHighlight: "none",
    });
  }

  getSnapshot(): TileFindStateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  search(input: TileFindInput): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.clear();
    if (input.query.length === 0) {
      // An empty query needs no projection: skip the supplier entirely and let
      // publishMatchState reset to the idle snapshot.
      this.matches = EMPTY_MATCHES;
    } else {
      // Opening or changing the query is the point at which rows must be built.
      this.rows = this.getRows();
      this.matches = findMatches({
        rows: this.rows,
        query: input.query,
        matchCase: input.matchCase,
      });
    }
    this.activeMatchIndex = 0;
    this.publishMatchState({
      requestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      navigate: true,
    });
  }

  next(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchIndex = (this.activeMatchIndex + 1) % this.matches.length;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  previous(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchIndex =
      (this.activeMatchIndex - 1 + this.matches.length) % this.matches.length;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  clear(): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.clear();
    // Closing the bar must end scanning. notifyRowsChanged runs from a layout
    // effect on every `messages` change (i.e. every streaming token) and is
    // gated only on `snapshot.query.length`, so leaving the query/matches set
    // keeps re-building rows and re-running findMatches over the whole
    // transcript forever. Reset the scan state and publish an idle, empty
    // snapshot so a closed bar does no per-token work; reopening re-runs search
    // from scratch.
    this.matches = EMPTY_MATCHES;
    this.activeMatchIndex = 0;
    this.snapshot = createChatFindSnapshot({
      requestId: this.snapshot.requestId,
      status: "idle",
      query: "",
      matchCase: this.snapshot.matchCase,
      current: 0,
      total: 0,
      activeUnitId: null,
      exactHighlight: "none",
    });
    this.notify();
  }

  notifyRowsChanged(): void {
    // While the bar is closed (empty query) we never build the projection: this
    // is the closed-find fast path that keeps streaming token cost off the
    // transcript projection and markdown tokenizer.
    if (this.snapshot.query.length === 0) return;
    this.rows = this.getRows();
    const previousActive = this.matches[this.activeMatchIndex] ?? null;
    this.matches = findMatches({
      rows: this.rows,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
    });
    this.activeMatchIndex = nextActiveMatchIndex(
      this.matches,
      previousActive,
      this.activeMatchIndex,
    );
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: false,
    });
  }

  syncMountedHighlight(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.requestHighlightPaint();
  }

  dispose(): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.dispose();
    this.listeners.clear();
  }

  private publishMatchState(args: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly navigate: boolean;
  }): void {
    if (args.query.length === 0) {
      this.matches = EMPTY_MATCHES;
      this.activeMatchIndex = 0;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "idle",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.highlighter.clear();
      this.notify();
      return;
    }

    if (this.matches.length === 0) {
      this.activeMatchIndex = 0;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.highlighter.clear();
      this.notify();
      return;
    }

    const activeMatch = this.matches.at(this.activeMatchIndex);
    if (activeMatch === undefined) return;
    this.snapshot = createChatFindSnapshot({
      requestId: args.requestId,
      status: "ready",
      query: args.query,
      matchCase: args.matchCase,
      current: this.activeMatchIndex + 1,
      total: this.matches.length,
      activeUnitId: activeMatch.unitId,
      exactHighlight: "pending",
    });
    this.notify();
    if (args.navigate) {
      this.requestReveal(activeMatch);
      return;
    }
    this.requestReconcile(activeMatch);
    this.requestHighlightPaint();
  }

  private requestReveal(activeMatch: ChatFindMatch): void {
    const matchKey = chatFindMatchKey(activeMatch);
    const generation = this.paintGeneration + 1;
    this.paintGeneration = generation;
    this.revealMatch({
      messageId: activeMatch.messageId,
      unitId: activeMatch.unitId,
      owningChain: activeMatch.owningChain,
      matchKey,
      paint: () => this.paintMatch(generation, matchKey, "unit", true),
      paintFallback: () =>
        this.paintMatch(generation, matchKey, "message", true),
    });
  }

  private requestReconcile(activeMatch: ChatFindMatch): void {
    this.reconcileMatch({
      messageId: activeMatch.messageId,
      unitId: activeMatch.unitId,
      owningChain: activeMatch.owningChain,
      matchKey: chatFindMatchKey(activeMatch),
    });
  }

  private requestHighlightPaint(): void {
    this.cancelScheduledPaint();
    const activeMatch = this.matches.at(this.activeMatchIndex);
    if (activeMatch === undefined) return;
    const matchKey = chatFindMatchKey(activeMatch);
    const generation = this.paintGeneration + 1;
    this.paintGeneration = generation;
    this.paintFrameId = window.requestAnimationFrame(() => {
      this.paintFrameId = null;
      this.paintMatch(generation, matchKey, "unit", false);
    });
  }

  private paintMatch(
    generation: number,
    matchKey: string,
    scope: "unit" | "message",
    scrollActiveIntoView: boolean,
  ): void {
    if (this.paintGeneration !== generation) return;
    const requestId = this.snapshot.requestId;
    const query = this.snapshot.query;
    const matchCase = this.snapshot.matchCase;
    if (query.length === 0) return;
    const currentMatch = this.matches.at(this.activeMatchIndex);
    if (
      currentMatch === undefined ||
      chatFindMatchKey(currentMatch) !== matchKey
    ) {
      return;
    }
    const root =
      scope === "unit"
        ? this.getMountedUnitRoot(currentMatch.messageId, currentMatch.unitId)
        : this.getMountedMessageRoot(currentMatch.messageId);
    if (root === null) {
      if (this.getMountedMessageRoot(currentMatch.messageId) !== null) {
        this.highlighter.clear();
        if (this.snapshot.exactHighlight !== "pending") {
          this.snapshot = {
            ...this.snapshot,
            exactHighlight: "pending",
          };
          this.notify();
        }
      }
      return;
    }
    // The unit-scope root walks only the active unit, so the per-unit ordinal is
    // correct. The message-scope fallback root walks every unit in the message,
    // so it must use the message-wide ordinal - otherwise an earlier matching
    // unit steals the highlight.
    const activeOccurrence =
      scope === "message"
        ? currentMatch.occurrenceInMessage
        : currentMatch.occurrenceInUnit;
    const painted = this.highlighter.paint({
      root,
      query,
      matchCase,
      activeMatchIndex: activeOccurrence,
      scrollActiveIntoView,
    });
    if (this.snapshot.requestId !== requestId) return;
    if (!painted) {
      if (this.snapshot.exactHighlight !== "pending") {
        this.snapshot = {
          ...this.snapshot,
          exactHighlight: "pending",
        };
        this.notify();
      }
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      exactHighlight: "painted",
    };
    this.notify();
  }

  private cancelScheduledPaint(): void {
    this.paintGeneration += 1;
    if (this.paintFrameId === null) return;
    window.cancelAnimationFrame(this.paintFrameId);
    this.paintFrameId = null;
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

function createChatFindSnapshot(args: {
  readonly requestId: number;
  readonly status: TileFindStateSnapshot["status"];
  readonly query: string;
  readonly matchCase: boolean;
  readonly current: number;
  readonly total: number;
  readonly activeUnitId: string | null;
  readonly exactHighlight: TileFindStateSnapshot["exactHighlight"];
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: args.status,
    capabilities: CHAT_FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: "",
    current: args.current,
    total: args.total,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: args.activeUnitId,
    exactHighlight: args.exactHighlight,
  };
}

function findMatches(input: {
  readonly rows: ReadonlyArray<ChatFindRow>;
  readonly query: string;
  readonly matchCase: boolean;
}): ReadonlyArray<ChatFindMatch> {
  const needle = input.matchCase ? input.query : input.query.toLowerCase();
  const matches: ChatFindMatch[] = [];
  input.rows.forEach((row, rowIndex) => {
    let occurrenceInMessage = 0;
    row.units.forEach((unit, unitIndex) => {
      const haystack = input.matchCase ? unit.text : unit.text.toLowerCase();
      const step = Math.max(input.query.length, 1);
      let occurrenceInUnit = 0;
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        const end = index + input.query.length;
        matches.push({
          messageId: row.messageId,
          rowIndex,
          unitId: unit.unitId,
          unitIndex,
          start: index,
          end,
          occurrenceInUnit,
          occurrenceInMessage,
          // Context is sliced from the original-cased unit text so before/after
          // neighbours compare faithfully during reconciliation.
          contextBefore: unit.text.slice(
            Math.max(0, index - FIND_RECONCILE_CONTEXT_WINDOW),
            index,
          ),
          contextAfter: unit.text.slice(
            end,
            end + FIND_RECONCILE_CONTEXT_WINDOW,
          ),
          owningChain: unit.owningChain,
        });
        occurrenceInUnit += 1;
        occurrenceInMessage += 1;
        index = haystack.indexOf(needle, index + step);
      }
    });
  });
  return matches;
}

// Re-anchor the active match after a rescan. Streaming rebuilds the match set
// every keystroke/update, so the previously active occurrence must be tracked to
// the same logical spot without re-navigating. The catch: in a concatenated unit
// (subagent task+progress+result) a streamed insert that lands BEFORE the active
// occurrence shifts BOTH its per-unit ordinal (a query insert adds an earlier
// occurrence) AND its absolute offset, so neither alone is a stable identity.
// The occurrence's immediate neighbours are what stay put, so context wins before
// ordinal/offset fallbacks.
function nextActiveMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch | null,
  fallbackIndex: number,
): number {
  if (matches.length === 0) return 0;
  if (previousActive !== null) {
    // The identical DOM occurrence (unit text unchanged, or only edited
    // elsewhere): same unit and same span. Unambiguous, so take it first.
    const identicalIndex = matches.findIndex(
      (match) =>
        match.messageId === previousActive.messageId &&
        match.unitId === previousActive.unitId &&
        match.start === previousActive.start &&
        match.end === previousActive.end,
    );
    if (identicalIndex !== -1) return identicalIndex;
    // The occurrence whose surrounding text best survives a mid-unit insert.
    const contextual = bestContextMatchIndexInSameUnit(matches, previousActive);
    if (contextual !== -1) return contextual;
    // Context was uninformative (e.g. the query spans the whole unit). Fall back
    // to the prior ordinal identity, then to the nearest offset.
    const sameOrdinal = matches.findIndex(
      (match) =>
        match.messageId === previousActive.messageId &&
        match.unitId === previousActive.unitId &&
        match.occurrenceInUnit === previousActive.occurrenceInUnit,
    );
    if (sameOrdinal !== -1) return sameOrdinal;
    const sameUnit = nearestMatchIndexInSameUnit(matches, previousActive);
    if (sameUnit !== -1) return sameUnit;
  }
  return Math.min(fallbackIndex, matches.length - 1);
}

// Among the candidates in the previously active unit, pick the one whose
// before/after neighbours best overlap the previous active occurrence's
// neighbours. The score is the shared run lengths (suffix of `contextBefore`
// plus prefix of `contextAfter`); an insert that lands on only one side leaves
// the other side fully intact, so the true occurrence still outscores a
// freshly-inserted duplicate. Ties resolve toward the prior ordinal, then the
// nearest offset, for determinism. Returns -1 when nothing overlaps.
function bestContextMatchIndexInSameUnit(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch,
): number {
  let bestIndex = -1;
  let bestScore = 0;
  let bestOrdinalDelta = 0;
  let bestStartDelta = 0;
  matches.forEach((match, index) => {
    if (match.messageId !== previousActive.messageId) return;
    if (match.unitId !== previousActive.unitId) return;
    const score =
      commonSuffixLength(match.contextBefore, previousActive.contextBefore) +
      commonPrefixLength(match.contextAfter, previousActive.contextAfter);
    if (score === 0) return;
    const ordinalDelta = Math.abs(
      match.occurrenceInUnit - previousActive.occurrenceInUnit,
    );
    const startDelta = Math.abs(match.start - previousActive.start);
    if (bestIndex === -1 || score > bestScore) {
      bestIndex = index;
      bestScore = score;
      bestOrdinalDelta = ordinalDelta;
      bestStartDelta = startDelta;
      return;
    }
    if (score < bestScore) return;
    if (
      ordinalDelta < bestOrdinalDelta ||
      (ordinalDelta === bestOrdinalDelta && startDelta < bestStartDelta)
    ) {
      bestIndex = index;
      bestOrdinalDelta = ordinalDelta;
      bestStartDelta = startDelta;
    }
  });
  return bestIndex;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (
    length < limit &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function chatFindMatchKey(match: ChatFindMatch): string {
  return `${match.messageId}:${match.unitId}:${match.occurrenceInUnit}`;
}

function nearestMatchIndexInSameUnit(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch,
): number {
  return matches.reduce((bestIndex, match, index) => {
    if (match.messageId !== previousActive.messageId) return bestIndex;
    if (match.unitId !== previousActive.unitId) return bestIndex;
    if (bestIndex === -1) return index;
    const best = matches.at(bestIndex);
    if (best === undefined) return index;
    const bestDistance = Math.abs(best.start - previousActive.start);
    const candidateDistance = Math.abs(match.start - previousActive.start);
    return candidateDistance < bestDistance ? index : bestIndex;
  }, -1);
}
