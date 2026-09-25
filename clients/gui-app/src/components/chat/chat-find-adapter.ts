import { FIND_VISIBLE_ATTR } from "@/lib/find-engine/find-blocks";
import { findTextMatches } from "@/lib/find-engine/find-text";
import { ChatFindHighlighter } from "@/components/chat/chat-find-highlighter";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import {
  CHAT_FIND_INDEX_ABSENT,
  CHAT_FIND_INDEX_MAX_PAGES,
  FULLY_LOADED_TRANSCRIPT,
  chatFindIndexCoverageMessage,
  olderChatFindIndexHits,
  type ChatFindIndexAnswer,
  type ChatFindIndexDemandSource,
  type ChatFindOlderHit,
  type ChatFindSearch,
  type ChatFindTranscriptPlacement,
} from "@/components/chat/chat-find-index";
import type { ChatFindRow } from "@/components/chat/chat-find-projection";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
} from "@/stores/tile-find";

/** How a transcript landing the tile issued ended; see `ChatScrollRequestOutcome`. */
export type ChatFindLandingOutcome = "landed" | "exhausted" | "cancelled";

export interface ChatFindAdapter extends TileFindAdapter {
  // Signals that the transcript changed. The adapter rebuilds rows from
  // `getRows()` and rescans matches only while a find session has an active
  // query, so a closed bar pays no projection cost on streaming updates.
  notifyRowsChanged(): void;
  syncMountedHighlight(): void;
  /** Leave the current result without closing the query or discarding matches. */
  dismissActiveMatch(): void;
  /**
   * The index's answer about OLDER, unloaded rows (`chat-find-index.ts`). An
   * answer for another search than the bar's is ignored.
   */
  setIndexAnswer(answer: ChatFindIndexAnswer): void;
  /**
   * A transcript landing settled on `rowMessageId`. The hand-off point for an
   * index hit: its row is hydrated and in place, so the client scan's exact
   * match can be revealed without fighting the landing for the viewport.
   */
  notifyTranscriptLanding(
    rowMessageId: string,
    outcome: ChatFindLandingOutcome,
  ): void;
  dispose(): void;
}

interface ChatFindAdapterOptions {
  readonly tileInstanceId: string;
  // Lazy supplier of the current transcript projection. Invoked when a search
  // opens, the query changes, or a notified message change must be rescanned -
  // never while the bar is closed.
  readonly getRows: () => ReadonlyArray<ChatFindRow>;
  /**
   * Lazy supplier of the caveat describing what `getRows()` could NOT see, read
   * at exactly the moments the rows are.
   *
   * On the windowed line (`chat.subscribe@1.8`) the transcript the client holds
   * is a subset, so every count this adapter publishes is a count over a
   * subset. `null` when the scan was complete - the legacy line always, and the
   * windowed line once every row is hydrated.
   */
  readonly getCoverageMessage: () => string | null;
  /**
   * Where records and rows sit in the transcript the tile holds, read with
   * the rows: which index hits describe text the rows do not show, where each
   * falls among them, and what navigating to one jumps to.
   */
  readonly getPlacement: () => ChatFindTranscriptPlacement;
  /** Where the adapter asks for index pages; see `ChatFindIndexDemandSource`. */
  readonly indexDemand: ChatFindIndexDemandSource;
  /**
   * Hydrate and land an older message - by a row id when the window can name
   * the row, else by the persisted message id - through the tile's own
   * transcript jump, the path the History hit list takes.
   */
  readonly jumpToIndexHit: (target: string) => void;
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

/**
 * One place the bar can navigate to, in transcript order: an exact match the
 * client scan found in a row it holds, or an older message the index says
 * contains the query. The second is a whole message, never a position - it
 * becomes exact matches once navigation hydrates it.
 */
type ChatFindStop =
  | {
      readonly kind: "client";
      /** Its row's transcript position; see {@link mergeStops}. */
      readonly key: number;
      readonly match: ChatFindMatch;
    }
  | {
      readonly kind: "index";
      readonly key: number;
      readonly hit: ChatFindOlderHit;
    };

interface PendingIndexJump {
  /** The message the index named. */
  readonly recordId: string;
  /** Every jump target tried for it so far: a landing on one of these is ours. */
  readonly attempted: ReadonlySet<string>;
}

const CHAT_FIND_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find"]);
const EMPTY_STOPS: ReadonlyArray<ChatFindStop> = [];
// How much neighbouring unit text to snapshot on each side of an occurrence for
// active-match re-anchoring across streaming inserts. Long enough to
// disambiguate occurrences of the same query, short enough to ignore edits that
// land elsewhere in the (often concatenated) unit.
const FIND_RECONCILE_CONTEXT_WINDOW = 32;

/**
 * The find bar's caveat for a transcript the client only partly holds.
 *
 * Takes the count rather than the window so the copy stays a pure function of
 * one number and this module keeps no dependency on the transcript store.
 * Phrased like the diff tiles' `bundleCoverageMessage`, because a user meets
 * these two caveats in the same bar and they should read as one feature.
 *
 * The case this matters most for is not a short count - it is **zero** matches
 * over a subset, which without the caveat reads as a definitive "not in this
 * chat".
 */
export function chatFindCoverageMessage(unhydratedRows: number): string | null {
  if (unhydratedRows <= 0) return null;
  const noun = unhydratedRows === 1 ? "message is" : "messages are";
  return `Partial results: ${unhydratedRows.toLocaleString()} older ${noun} not loaded.`;
}

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
  private readonly getCoverageMessage: () => string | null;
  private readonly getPlacement: () => ChatFindTranscriptPlacement;
  private readonly indexDemand: ChatFindIndexDemandSource;
  private readonly jumpToIndexHit: (target: string) => void;
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
  private readonly mountedObserver: MutationObserver;
  private observedRoot: HTMLElement | null = null;
  private paintScope: "unit" | "message" = "unit";

  private rows: ReadonlyArray<ChatFindRow> = [];
  // Refreshed with `rows`, never independently: the caveat has to describe the
  // very scan whose counts are being published, and a window that hydrates
  // between the two reads would otherwise let a stale caveat outlive its scan.
  private coverage: string | null = null;
  private indexAnswer: ChatFindIndexAnswer = CHAT_FIND_INDEX_ABSENT;
  // Client matches and older index hits, merged in transcript order.
  private stops: ReadonlyArray<ChatFindStop> = EMPTY_STOPS;
  // `null` is "no stop selected": the only way to get there is older index
  // hits arriving for a search whose loaded rows matched nothing, and an
  // asynchronous answer never navigates on its own - hydrating and scrolling
  // to a far-away row is the reader's call, one Enter away.
  private activeStopIndex: number | null = null;
  private snapshot: TileFindStateSnapshot;
  private paintFrameId: number | null = null;
  private paintGeneration = 0;
  // Clearing the find target is an explicit user dismissal. Passive rescans
  // and virtual-row mount syncs must preserve that state until navigation or a
  // new search deliberately selects an active match again.
  private activeMatchDismissed = false;
  // Refreshed with `rows`, for the same reason `coverage` is.
  private placement: ChatFindTranscriptPlacement = FULLY_LOADED_TRANSCRIPT;
  // The message an index-stop navigation jumped to, and the targets tried for
  // it, until a landing hands it to the client scan.
  private pendingIndexJump: PendingIndexJump | null = null;
  // Where the reader stood when they stepped back from the oldest stop, while
  // the page that continues the walk is on its way.
  private awaitingOlderThanKey: number | null = null;

  constructor(options: ChatFindAdapterOptions) {
    this.tileInstanceId = options.tileInstanceId;
    this.getRows = options.getRows;
    this.getCoverageMessage = options.getCoverageMessage;
    this.getPlacement = options.getPlacement;
    this.indexDemand = options.indexDemand;
    this.jumpToIndexHit = options.jumpToIndexHit;
    this.revealMatch = options.revealMatch;
    this.reconcileMatch = options.reconcileMatch;
    this.clearReveal = options.clearReveal;
    this.getMountedMessageRoot = options.getMountedMessageRoot;
    this.getMountedUnitRoot = options.getMountedUnitRoot;
    this.highlighter = new ChatFindHighlighter();
    // Only the active unit is observed, only while find has a target. Async
    // diagram rendering can replace its DOM without changing transcript rows.
    // Ignore our own hit attributes so a repaint cannot schedule itself.
    this.mountedObserver = new MutationObserver(() =>
      this.syncMountedHighlight(),
    );
    this.snapshot = createChatFindSnapshot({
      requestId: 0,
      status: "idle",
      query: "",
      matchCase: false,
      current: 0,
      total: 0,
      coverageMessage: null,
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
    this.clearHighlight();
    this.activeMatchDismissed = false;
    this.pendingIndexJump = null;
    this.awaitingOlderThanKey = null;
    if (input.query.length === 0) {
      // An empty query needs no projection: skip the supplier entirely and let
      // publishMatchState reset to the idle snapshot.
      this.indexDemand.setSearch(null);
      this.stops = EMPTY_STOPS;
      this.coverage = null;
      this.activeStopIndex = null;
    } else {
      // A settled query is what the index is asked about - the bar debounces
      // typing before it calls here, so this is that debounce too.
      const search = { query: input.query, matchCase: input.matchCase };
      this.indexDemand.setSearch(search);
      // Opening or changing the query is the point at which rows must be built.
      this.rows = this.getRows();
      this.coverage = this.getCoverageMessage();
      this.placement = this.getPlacement();
      this.stops = this.scanStops(search);
      // The first LOADED match, as before the index existed: a search never
      // jumps to an older hit by itself.
      const firstClient = this.stops.findIndex(
        (stop) => stop.kind === "client",
      );
      this.activeStopIndex = firstClient === -1 ? null : firstClient;
    }
    this.publishMatchState({
      requestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      navigate: true,
    });
  }

  next(): void {
    if (this.stops.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchDismissed = false;
    this.pendingIndexJump = null;
    this.awaitingOlderThanKey = null;
    this.activeStopIndex =
      this.activeStopIndex === null
        ? 0
        : (this.activeStopIndex + 1) % this.stops.length;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  previous(): void {
    if (this.stops.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchDismissed = false;
    this.pendingIndexJump = null;
    this.awaitingOlderThanKey = null;
    if (this.activeStopIndex === 0 && this.olderPagesRemain()) {
      // Stepping back from the OLDEST stop - an older hit, or a loaded match
      // when no older hit is loaded yet - is the one thing that reads another
      // index page. Stay put until it lands; the walk then continues into it
      // instead of wrapping to the newest match.
      this.awaitingOlderThanKey = this.stops[0].key;
      this.requestNextIndexPage();
      return;
    }
    this.activeStopIndex =
      this.activeStopIndex === null
        ? this.stops.length - 1
        : (this.activeStopIndex - 1 + this.stops.length) % this.stops.length;
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
    this.clearHighlight();
    // Closing the bar must end scanning. notifyRowsChanged runs from a layout
    // effect on every `messages` change (i.e. every streaming token) and is
    // gated only on `snapshot.query.length`, so leaving the query/matches set
    // keeps re-building rows and re-running findMatches over the whole
    // transcript forever. Reset the scan state and publish an idle, empty
    // snapshot so a closed bar does no per-token work; reopening re-runs search
    // from scratch. The index goes with it: a closed bar asks nothing, and an
    // in-flight page is dropped.
    this.indexDemand.setSearch(null);
    this.indexAnswer = CHAT_FIND_INDEX_ABSENT;
    this.placement = FULLY_LOADED_TRANSCRIPT;
    this.pendingIndexJump = null;
    this.awaitingOlderThanKey = null;
    this.stops = EMPTY_STOPS;
    this.coverage = null;
    this.activeStopIndex = null;
    this.snapshot = createChatFindSnapshot({
      requestId: this.snapshot.requestId,
      status: "idle",
      query: "",
      matchCase: this.snapshot.matchCase,
      current: 0,
      total: 0,
      coverageMessage: null,
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
    this.coverage = this.getCoverageMessage();
    this.placement = this.getPlacement();
    this.rescanPassively();
  }

  setIndexAnswer(answer: ChatFindIndexAnswer): void {
    this.indexAnswer = answer;
    if (this.snapshot.query.length === 0) return;
    // Against the rows, caveat and placement the loaded scan read: they
    // describe one transcript, and the next row change re-reads all three.
    const navigate = this.rescanStops();
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate,
    });
  }

  notifyTranscriptLanding(
    rowMessageId: string,
    outcome: ChatFindLandingOutcome,
  ): void {
    const pending = this.pendingIndexJump;
    if (pending === null || this.snapshot.query.length === 0) return;
    const { attempted, recordId } = pending;
    const row = this.rows.find(
      (candidate) => candidate.messageId === rowMessageId,
    );
    // Some other navigation's landing.
    if (
      !attempted.has(rowMessageId) &&
      (row === undefined || !rowRendersRecord(row, recordId))
    ) {
      return;
    }
    this.pendingIndexJump = null;
    // A reader gesture, or a newer navigation, took the viewport first: the
    // find does not take it back.
    if (outcome === "cancelled") return;
    const handed = firstClientStopForRecord(this.stops, this.rows, recordId);
    if (handed === -1) {
      // The landed row does not show the match. While more of the message is
      // unhydrated the match is in one of those rows: walk on to the next.
      // With none left the index claimed text the loaded rows do not show - a
      // stale index, or a match the snippet check could not rule out - and the
      // row stays landed and ringed, with no exact position to reveal.
      const next = this.nextIndexTarget(recordId, attempted);
      if (next === null) return;
      this.pendingIndexJump = {
        recordId,
        attempted: new Set([...attempted, next]),
      };
      this.jumpToIndexHit(next);
      return;
    }
    this.activeStopIndex = handed;
    this.activeMatchDismissed = false;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  syncMountedHighlight(): void {
    if (
      this.activeMatchDismissed ||
      this.activeClientMatch() === undefined ||
      this.snapshot.query.length === 0
    ) {
      return;
    }
    this.requestHighlightPaint();
  }

  dismissActiveMatch(): void {
    if (this.snapshot.query.length === 0) return;
    this.cancelScheduledPaint();
    this.clearHighlight();
    this.activeMatchDismissed = true;
    if (
      this.snapshot.activeUnitId === null &&
      this.snapshot.exactHighlight === "none"
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      activeUnitId: null,
      exactHighlight: "none",
    };
    this.notify();
  }

  dispose(): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.observeMountedRoot(null);
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
      this.stops = EMPTY_STOPS;
      this.coverage = null;
      this.activeStopIndex = null;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "idle",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        coverageMessage: null,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.clearHighlight();
      this.notify();
      return;
    }

    const coverageMessage = this.publishedCoverage();
    if (this.stops.length === 0) {
      this.activeStopIndex = null;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        // The load-bearing one: "no matches" over a partial transcript is the
        // reading a caveat has to qualify, not the one it can be dropped from.
        coverageMessage,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.clearHighlight();
      this.notify();
      return;
    }

    const activeStop =
      this.activeStopIndex === null
        ? undefined
        : this.stops.at(this.activeStopIndex);
    if (this.activeStopIndex === null || activeStop === undefined) {
      // Older matches and no loaded one: counted, nothing selected yet.
      this.activeStopIndex = null;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: this.stops.length,
        coverageMessage,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.clearHighlight();
      this.notify();
      return;
    }
    const current = this.activeStopIndex + 1;
    if (this.activeMatchDismissed) {
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current,
        total: this.stops.length,
        coverageMessage,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.clearHighlight();
      this.notify();
      return;
    }
    if (activeStop.kind === "index") {
      // A whole older message: no unit to name until it hydrates, and the
      // highlight stays pending until the client scan can place it.
      this.cancelScheduledPaint();
      this.clearHighlight();
      if (args.navigate) this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current,
        total: this.stops.length,
        coverageMessage,
        activeUnitId: null,
        exactHighlight: "pending",
      });
      this.notify();
      if (args.navigate) {
        const [target] = activeStop.hit.targets;
        this.pendingIndexJump = {
          recordId: activeStop.hit.messageId,
          attempted: new Set([target]),
        };
        this.jumpToIndexHit(target);
      }
      return;
    }
    const activeMatch = activeStop.match;
    this.snapshot = createChatFindSnapshot({
      requestId: args.requestId,
      status: "ready",
      query: args.query,
      matchCase: args.matchCase,
      current,
      total: this.stops.length,
      coverageMessage,
      activeUnitId: activeMatch.unitId,
      exactHighlight: "pending",
    });
    this.notify();
    if (args.navigate) {
      this.requestReveal(activeMatch);
      return;
    }
    // An index jump still landing owns the reveal. The hydration that just
    // handed its message to the client scan must not reconcile the match
    // first: that records the unit as already revealed, and the landing's
    // reveal would then take it for an in-place hop and never scroll to it.
    if (this.pendingIndexJump === null) this.requestReconcile(activeMatch);
    this.requestHighlightPaint();
  }

  /** The client scan over the held rows, merged with the older index hits. */
  private scanStops(search: ChatFindSearch): ReadonlyArray<ChatFindStop> {
    const matches = findMatches({
      rows: this.rows,
      query: search.query,
      matchCase: search.matchCase,
    });
    // A complete scan leaves nothing older for the index to answer, and a
    // stale answer must not outlive the rows it was about.
    if (this.coverage === null) {
      return mergeStops(this.rows, matches, [], this.placement);
    }
    const older = olderChatFindIndexHits({
      answer: this.indexAnswer,
      search,
      placement: this.placement,
    });
    // A held message whose loaded rows already matched is the client scan's:
    // it is counted there, and the rest of it is a scroll away.
    const matchedRecords = new Set<string>();
    for (const match of matches) {
      const row = this.rows.at(match.rowIndex);
      if (row === undefined) continue;
      matchedRecords.add(row.messageId);
      for (const recordId of row.recordIds) matchedRecords.add(recordId);
    }
    const unseen = older.filter(
      (hit) => !hit.held || !matchedRecords.has(hit.messageId),
    );
    return mergeStops(this.rows, matches, unseen, this.placement);
  }

  /**
   * Rescan over the current rows and answer, keeping the active stop on the
   * same logical place, and publish without navigating - unless the rescan
   * completed a step into an older page (see {@link continueOlderWalk}).
   */
  private rescanPassively(): void {
    const navigate = this.rescanStops();
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate,
    });
  }

  private rescanStops(): boolean {
    const previous =
      this.activeStopIndex === null
        ? null
        : (this.stops.at(this.activeStopIndex) ?? null);
    this.stops = this.scanStops({
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
    });
    this.activeStopIndex = nextActiveStopIndex(
      this.stops,
      this.rows,
      previous,
      this.activeStopIndex,
    );
    return this.continueOlderWalk();
  }

  /**
   * Finishes a step back past the oldest loaded older hit once its page is
   * in: onto the hit just older than where the reader stood. Returns whether
   * that is a navigation.
   */
  private continueOlderWalk(): boolean {
    const beforeKey = this.awaitingOlderThanKey;
    if (beforeKey === null) return false;
    const answer = this.indexAnswer;
    if (answer.kind === "ready" && answer.loadingMore) return false;
    // The stop just older than where the reader stood.
    let older = -1;
    this.stops.forEach((stop, index) => {
      if (stop.key < beforeKey) older = index;
    });
    if (older !== -1) {
      this.awaitingOlderThanKey = null;
      this.activeStopIndex = older;
      return true;
    }
    // The page held nothing older this scan can use (all held, or ruled out
    // by the snippet check): read on while the index has more.
    if (this.olderPagesRemain()) {
      this.requestNextIndexPage();
      return false;
    }
    // The end of the walk: wrap to the newest match, like any find.
    this.awaitingOlderThanKey = null;
    if (this.stops.length === 0) return false;
    this.activeStopIndex = this.stops.length - 1;
    return true;
  }

  /** The next target of an index stop's message not tried yet, if any. */
  private nextIndexTarget(
    recordId: string,
    attempted: ReadonlySet<string>,
  ): string | null {
    for (const stop of this.stops) {
      if (stop.kind !== "index" || stop.hit.messageId !== recordId) continue;
      return stop.hit.targets.find((target) => !attempted.has(target)) ?? null;
    }
    return null;
  }

  private olderPagesRemain(): boolean {
    const answer = this.indexAnswer;
    return (
      answer.kind === "ready" &&
      answer.search.query === this.snapshot.query &&
      answer.search.matchCase === this.snapshot.matchCase &&
      answer.more &&
      answer.pages < CHAT_FIND_INDEX_MAX_PAGES
    );
  }

  private requestNextIndexPage(): void {
    const answer = this.indexAnswer;
    if (answer.kind !== "ready") return;
    this.indexDemand.requestPages(answer.pages + 1);
  }

  private publishedCoverage(): string | null {
    if (this.coverage === null) return null;
    let older = 0;
    for (const stop of this.stops) if (stop.kind === "index") older += 1;
    if (older === 0) return this.coverage;
    const answer = this.indexAnswer;
    return chatFindIndexCoverageMessage(
      older,
      answer.kind === "ready" && answer.more,
    );
  }

  private activeClientMatch(): ChatFindMatch | undefined {
    if (this.activeStopIndex === null) return undefined;
    const stop = this.stops.at(this.activeStopIndex);
    return stop?.kind === "client" ? stop.match : undefined;
  }

  private requestReveal(activeMatch: ChatFindMatch): void {
    this.paintScope = "unit";
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
    // A passive repaint replaces only the passive frame already queued. It
    // must not advance the generation: a navigation paint scheduled by the
    // reveal controller waits on the current generation, and it is the one
    // that scrolls the match into view. Bumping here dropped that paint
    // whenever a row re-measured between the reveal's two frames, which a
    // text hit hid behind the unit's own centering and a block hit did not.
    this.cancelPassivePaintFrame();
    const activeMatch = this.activeClientMatch();
    if (activeMatch === undefined) return;
    const matchKey = chatFindMatchKey(activeMatch);
    const generation = this.paintGeneration;
    this.paintFrameId = window.requestAnimationFrame(() => {
      this.paintFrameId = null;
      this.paintMatch(generation, matchKey, this.paintScope, false);
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
    const currentMatch = this.activeClientMatch();
    if (
      currentMatch === undefined ||
      chatFindMatchKey(currentMatch) !== matchKey
    ) {
      return;
    }
    const unitRoot = this.getMountedUnitRoot(
      currentMatch.messageId,
      currentMatch.unitId,
    );
    // A fallback remains message-scoped until the unit anchor exists. Its
    // observer must repaint with the same scope/ordinal instead of clearing
    // a valid fallback merely because the unit is still unavailable.
    const messageScope = scope === "message" && unitRoot === null;
    const root = messageScope
      ? this.getMountedMessageRoot(currentMatch.messageId)
      : unitRoot;
    if (root === null) {
      this.observeMountedRoot(null);
      if (this.getMountedMessageRoot(currentMatch.messageId) !== null) {
        this.clearHighlight();
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
    this.paintScope = messageScope ? "message" : "unit";
    this.observeMountedRoot(root);
    // The unit-scope root walks only the active unit, so the per-unit ordinal is
    // correct. The message-scope fallback root walks every unit in the message,
    // so it must use the message-wide ordinal - otherwise an earlier matching
    // unit steals the highlight.
    const activeOccurrence = messageScope
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

  private observeMountedRoot(root: HTMLElement | null): void {
    if (this.observedRoot === root) return;
    this.mountedObserver.disconnect();
    this.observedRoot = root;
    if (root !== null) {
      this.mountedObserver.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [FIND_VISIBLE_ATTR],
      });
    }
  }

  private clearHighlight(): void {
    this.paintScope = "unit";
    this.observeMountedRoot(null);
    this.highlighter.clear();
  }

  /** Invalidates every pending paint, navigation paints included. */
  private cancelScheduledPaint(): void {
    this.paintGeneration += 1;
    this.cancelPassivePaintFrame();
  }

  private cancelPassivePaintFrame(): void {
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
  readonly coverageMessage: string | null;
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
    coverageMessage: args.coverageMessage,
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
  const matches: ChatFindMatch[] = [];
  input.rows.forEach((row, rowIndex) => {
    let occurrenceInMessage = 0;
    row.units.forEach((unit, unitIndex) => {
      let occurrenceInUnit = 0;
      for (const match of findTextMatches(
        unit.text,
        input.query,
        input.matchCase,
      )) {
        const index = match.offset;
        const end = index + match.length;
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
      }
    });
  });
  return matches;
}

/**
 * Client matches and older index hits in one transcript-ordered list, by
 * skeleton ordinal: each row's own, each hit's from its placement.
 *
 * A row the skeleton has not placed yet (live, pending) keeps the position
 * of the row before it, so everything it holds stays after what precedes it.
 * Linear over rows and matches, both already in transcript order.
 */
function mergeStops(
  rows: ReadonlyArray<ChatFindRow>,
  matches: ReadonlyArray<ChatFindMatch>,
  older: ReadonlyArray<ChatFindOlderHit>,
  placement: ChatFindTranscriptPlacement,
): ReadonlyArray<ChatFindStop> {
  if (older.length === 0 && matches.length === 0) return EMPTY_STOPS;
  const stops: ChatFindStop[] = [];
  let olderIndex = 0;
  let matchIndex = 0;
  let rowKey = Number.NEGATIVE_INFINITY;
  rows.forEach((row, rowIndex) => {
    rowKey = Math.max(rowKey, placement.rowSortKey(row.messageId) ?? rowKey);
    for (
      let hit = older.at(olderIndex);
      hit !== undefined && hit.sortKey < rowKey;
      hit = older.at(olderIndex)
    ) {
      stops.push({ kind: "index", key: hit.sortKey, hit });
      olderIndex += 1;
    }
    for (
      let match = matches.at(matchIndex);
      match !== undefined && match.rowIndex === rowIndex;
      match = matches.at(matchIndex)
    ) {
      stops.push({ kind: "client", key: rowKey, match });
      matchIndex += 1;
    }
  });
  // Later than every loaded row: only when the tail itself is unhydrated.
  for (const hit of older.slice(olderIndex)) {
    stops.push({ kind: "index", key: hit.sortKey, hit });
  }
  return stops;
}

function rowRendersRecord(row: ChatFindRow, recordId: string): boolean {
  return row.messageId === recordId || row.recordIds.includes(recordId);
}

/** The first exact match in a record's rows, once the record is loaded. */
function firstClientStopForRecord(
  stops: ReadonlyArray<ChatFindStop>,
  rows: ReadonlyArray<ChatFindRow>,
  recordId: string,
): number {
  return stops.findIndex((stop) => {
    if (stop.kind !== "client") return false;
    const row = rows.at(stop.match.rowIndex);
    return row !== undefined && rowRendersRecord(row, recordId);
  });
}

/**
 * Re-anchor the active stop after a rescan: the same client occurrence (see
 * {@link sameMatchIndex}), or the same older message - and an older message
 * that has since HYDRATED is handed to the client scan, onto its first exact
 * match, because that is the same logical place.
 *
 * No selection stays no selection for older hits, but adopts a loaded match
 * the moment one exists: that is what a transcript that starts matching while
 * the bar is open always did.
 */
function nextActiveStopIndex(
  stops: ReadonlyArray<ChatFindStop>,
  rows: ReadonlyArray<ChatFindRow>,
  previous: ChatFindStop | null,
  fallbackIndex: number | null,
): number | null {
  if (stops.length === 0) return null;
  if (previous === null || fallbackIndex === null) {
    const firstClient = stops.findIndex((stop) => stop.kind === "client");
    return firstClient === -1 ? null : firstClient;
  }
  if (previous.kind === "index") {
    const sameHit = stops.findIndex(
      (stop) =>
        stop.kind === "index" && stop.hit.messageId === previous.hit.messageId,
    );
    if (sameHit !== -1) return sameHit;
    const handed = firstClientStopForRecord(
      stops,
      rows,
      previous.hit.messageId,
    );
    if (handed !== -1) return handed;
  } else {
    const clientStopIndexes: number[] = [];
    const clientMatches: ChatFindMatch[] = [];
    stops.forEach((stop, index) => {
      if (stop.kind !== "client") return;
      clientStopIndexes.push(index);
      clientMatches.push(stop.match);
    });
    const same = sameMatchIndex(clientMatches, previous.match);
    // Not `.at(same)`: -1 there is the LAST stop, not a miss.
    if (same !== -1) return clientStopIndexes[same];
  }
  return Math.min(fallbackIndex, stops.length - 1);
}

// Re-anchor the active match after a rescan. Streaming rebuilds the match set
// every keystroke/update, so the previously active occurrence must be tracked to
// the same logical spot without re-navigating. The catch: in a concatenated unit
// (subagent task+progress+result) a streamed insert that lands BEFORE the active
// occurrence shifts BOTH its per-unit ordinal (a query insert adds an earlier
// occurrence) AND its absolute offset, so neither alone is a stable identity.
// The occurrence's immediate neighbours are what stay put, so context wins before
// ordinal/offset fallbacks. Returns -1 when no match carries the identity.
function sameMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch,
): number {
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
  return nearestMatchIndexInSameUnit(matches, previousActive);
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
