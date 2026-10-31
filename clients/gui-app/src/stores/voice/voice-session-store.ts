import { create } from "zustand";
import type { VoiceEngine } from "@/lib/voice/engine";
import type { QueueVerb, QueueVerbOutcome } from "@/lib/voice/queue-verbs";
import type { SpeechActivity } from "@/lib/voice/scheduler";

/**
 * The voice layer's one state, in memory only (Tracy Bots voice, VT2). A
 * voice session has no record in the product: the posts it makes and the
 * replies it reads are the channel's rows, and the only durable thing it
 * leaves is the server's billing row. Nothing here is persisted, and the
 * session's end forgets everything but the dormant answer.
 */

/**
 * Where the next spoken request goes: the app's own selection, a bot and
 * optionally one of its threads. Writes to it drive the bot tab and its rail;
 * selection changes in those stores write it back.
 */
export interface VoiceFocus {
  readonly botId: string;
  /** The host the bot's tab is bound to, which carries the send. */
  readonly hostId: string;
  /** `null`: the channel's top level, or a thread not yet known by its id (see `anchorThread`). */
  readonly threadId: string | null;
  /** The row the open thread hangs off; `null` with no thread. */
  readonly anchorMessageId: string | null;
  /**
   * The thread behind the anchor while `threadId` is `null`: `"unopened"`,
   * nobody has replied under the anchor yet, so a post goes under it as the
   * first reply that opens its thread (the thread panel's "Reply in a new
   * thread"); `"resolving"`, the thread list has not said yet, so nothing is
   * posted until it does. `null` when `threadId` says where, or there is no
   * anchor and posts go to the channel's top level.
   */
  readonly anchorThread: "unopened" | "resolving" | null;
}

/**
 * One fragment of what the person said, exactly as it was transcribed. A
 * segment belongs to the open utterance until an action reserves it; a
 * reserved segment is that action's alone until the action consumes or
 * releases it.
 */
export interface TranscriptSegment {
  /** Monotonic within the window: the order the person said things in. */
  readonly seq: number;
  readonly text: string;
  readonly at: number;
  /** The action that owns this segment, or `null` while it is open. */
  readonly reservedBy: string | null;
}

/** The segments an action took: their raw text and which ones. */
export interface SpanReservation {
  readonly text: string;
  readonly seqs: ReadonlyArray<number>;
}

/**
 * What a queued thing is, by the record it was hydrated from: a bot's reply,
 * a bot's own question to the person (a row with `question`), a task agent's
 * question or approval a bot's post points at (a row with `surface`), a
 * teammate's message in a thread the person follows, an answer the bot
 * failed or parked, or an announcement at a channel's top level (spoken only
 * in a briefing).
 */
export type QueueItemKind =
  | "reply"
  | "question"
  | "surface"
  | "message"
  | "failed"
  | "announcement";

/**
 * Where the voice is with an item, kept apart from the bell's read state:
 * `offered`, its one line was heard ("want it?"); `heard`, its content was
 * confirmed spoken (the only state that marks anything read); `dismissed`,
 * the person said later. Looking at the channel changes none of these.
 */
export type QueueItemState = "queued" | "offered" | "heard" | "dismissed";

/**
 * Something waiting to be said, from one named source and hydrated from the
 * records (never from notification copy). The queue keeps its own ids and is
 * not the unread count.
 */
export interface QueueItem {
  /** The dedupe key: the reply's message id, the surface id, the stopped request. */
  readonly id: string;
  readonly kind: QueueItemKind;
  readonly botId: string;
  /** The host that serves the bot's records, and takes the mark. */
  readonly hostId: string;
  readonly threadId: string | null;
  /** The chat the row lives in: the thread, or the channel at the top level. */
  readonly chatId: string;
  readonly messageId: string | null;
  readonly surfaceId: string | null;
  /** What it is about, from the row itself. */
  readonly title: string;
  /** Who wrote a `message`, by the name the member directory gives; `null` for the bot's own. */
  readonly author: string | null;
  /** One line: which bot, which thread, the gist. */
  readonly line: string;
  /** When it happened, epoch ms; its age is measured from this. */
  readonly at: number;
  readonly state: QueueItemState;
}

/** What the queue's executor runs; the controller that owns the queue installs it. */
export interface VoiceQueueDriver {
  readonly run: (verb: QueueVerb) => QueueVerbOutcome;
  /** A switch to the item the router carries out itself: the queue's side of it. */
  readonly noteSwitched: (itemId: string) => void;
}

/**
 * Words the voice holds instead of posting: the open utterance when the
 * person moved to another channel or thread mid-sentence. The voice asks
 * them to say the request again; until the ask is heard, words that reach a
 * boundary are held with these, and the first boundary after it closes the
 * interruption without posting.
 */
export interface InterruptedAction {
  readonly kind: "interrupted";
  readonly text: string;
  /** The delegation that was open when the person moved, if one was. */
  readonly delegationId: string | null;
  /** The selection generation the move produced. */
  readonly selectionGeneration: number;
  /**
   * Whether the person has heard the voice ask them to say the request
   * again. While `"asking"`, words that reach a boundary are held with the
   * interrupted ones, since nothing has told the person to start over; once
   * `"heard"`, the next boundary closes the interruption. `"closing"` is the
   * ask given up on while an utterance was already under way: that utterance
   * is still the interrupted one, so its boundary closes the interruption
   * without posting, and only words said after it are a request.
   */
  readonly askState: "asking" | "heard" | "closing";
}

/**
 * Where a routed action goes, as one immutable tuple: validated together
 * against the directory when the action is bound, and again at execution.
 * `threadId` `null` is the bot's channel (or the focus's own unresolved
 * anchor, for a post to the focus).
 */
export interface VoiceTargetTuple {
  readonly environmentId: string;
  readonly botId: string;
  readonly threadId: string | null;
  readonly hostId: string;
}

/**
 * A routed post the voice confirms before sending: the router was unsure of
 * the destination, or it is a team's channel other than the focus. The words
 * stay the action's; the person's next answer is consumed by it (yes posts
 * them, anything else drops them) and is never posted itself.
 */
export interface ConfirmingAction {
  readonly kind: "confirming";
  readonly target: VoiceTargetTuple;
  /** The words that post on a yes, verbatim. */
  readonly text: string;
  /** The delegation of the request being confirmed. */
  readonly delegationId: string;
  /** The selection generation the action was bound under. */
  readonly selectionGeneration: number;
  /**
   * Whether the person has heard the question. Only once `"heard"` is a
   * boundary's words the answer; words said before it answer nothing.
   */
  readonly askState: "asking" | "heard";
}

/** The one spoken request the voice holds instead of acting on at once. */
export type PendingAction = InterruptedAction | ConfirmingAction;

export type VoicePhase = "idle" | "connecting" | "live" | "ending";

/** Why the last session ended, for the strip's one line about it. */
export type VoiceEndReason =
  /** The person ended it, or the shell is going away. */
  | "ended"
  | "credits"
  | "connection"
  | "locked"
  | "microphone"
  /** The voice's sound could not be played, so nothing could be heard. */
  | "playback"
  | "unavailable";

export type VoiceAvailability =
  /** The server has not said yet: Talk waits. */
  | "unknown"
  | "live"
  /** The server offers no voice: Talk hides for this window. */
  | "dormant";

export interface VoiceSessionRecord {
  readonly id: string;
  /** Epoch milliseconds, from the mint. */
  readonly expiresAt: number;
  readonly engine: VoiceEngine;
}

/** What the Talk control and the strip ask of the controller that owns the session. */
export interface VoiceSessionDriver {
  readonly start: () => void;
  readonly end: () => void;
  readonly setMuted: (muted: boolean) => void;
}

/** A line the captions draw; nothing beyond the last few is kept. */
export interface CaptionLine {
  /** Unique within the session, for the list's keys. */
  readonly id: number;
  readonly direction: "input" | "output";
  readonly text: string;
}

/** What a caller pushes: the line's id is the store's. */
export type CaptionDelta = Omit<CaptionLine, "id">;

const CAPTION_LINES_KEPT = 4;

export interface VoiceSessionState {
  readonly phase: VoicePhase;
  readonly endReason: VoiceEndReason | null;
  readonly availability: VoiceAvailability;
  readonly session: VoiceSessionRecord | null;
  /**
   * The user session's lifetime: bumped when Talk starts a session and when
   * it ends, never by an engine replacement. An action carries the token it
   * was made under and is inert once the token has moved: a late acceptance
   * from an ended session recreates nothing, while one that crosses a
   * replacement completes as the work it is.
   */
  readonly sessionToken: number;
  /**
   * The engine's generation within the user session: bumped by every attempt
   * (the first and each replacement). A delegation id belongs to one
   * generation; a reply bound to an earlier one is appended under none.
   */
  readonly engineGeneration: number;
  readonly focus: VoiceFocus | null;
  /** Every segment not yet consumed, oldest first: open ones and reserved ones. */
  readonly segments: ReadonlyArray<TranscriptSegment>;
  /** The delegation whose request has not been acted on yet. */
  readonly pendingDelegationId: string | null;
  /**
   * Bumped on every MANUAL selection change (a click on a channel or a
   * thread), never on a focus the voice itself wrote. An action binds it and
   * compares at acceptance: a changed generation means the person moved.
   */
  readonly selectionGeneration: number;
  readonly activity: SpeechActivity;
  readonly queue: ReadonlyArray<QueueItem>;
  readonly pendingAction: PendingAction | null;
  /** The one card the voice is reading; a later ticket fills it. */
  readonly activeCard: null;
  readonly captions: boolean;
  readonly captionLines: ReadonlyArray<CaptionLine>;
  /**
   * The session's capture and the voice's sound are paused for dictation:
   * true while `dictationHolds` has an owner, and after that while
   * `dictationPauseLatched` waits for the person's Resume. The holds are
   * dictation's state, which no session transition writes, so a Talk ended
   * and started again while dictation records starts paused.
   */
  readonly pausedForDictation: boolean;
  /**
   * Who holds the microphone for dictation, by owner token: one per
   * dictation hook instance while it takes or records. An owner releases
   * only its own hold, so an idle instance never frees another's.
   */
  readonly dictationHolds: ReadonlySet<string>;
  /**
   * Dictation paused a running session, and the session stays paused until
   * the person resumes it (`resumeFromDictation`): dictation ending never
   * resumes the voice on its own. The session's state: set when a hold is
   * taken while a session runs or a session starts under a hold, and
   * forgotten when the session ends.
   */
  readonly dictationPauseLatched: boolean;
  /**
   * Whether a session started now would have a bot to talk to: the bot tab
   * the person has open, else the personal environment's main bot. Set by
   * the controller; `false` draws Talk disabled and refuses the start, so
   * no session is minted with nowhere to post.
   */
  readonly destinationKnown: boolean;
  readonly muted: boolean;
  readonly driver: VoiceSessionDriver | null;
  /** The queue's executor while the controller is mounted; the session's state says whether it acts. */
  readonly queueDriver: VoiceQueueDriver | null;

  readonly setAvailability: (availability: VoiceAvailability) => void;
  /** A new user session begins: a new token and a new engine generation. */
  readonly sessionConnecting: () => void;
  /** The engine is being replaced under the same user session: a new generation only. */
  readonly engineReplacing: () => void;
  readonly sessionLive: (session: VoiceSessionRecord) => void;
  readonly sessionEnding: () => void;
  /**
   * The session is over. Focus, segments, delegations, captions and the
   * pending action are forgotten; the availability and the driver stay.
   */
  readonly sessionEnded: (reason: VoiceEndReason | null) => void;
  /** The strip's line about the last end was read; the strip leaves. */
  readonly clearEndReason: () => void;
  /**
   * A focus the voice wrote (a session start, a post whose thread opened):
   * the selection follows it, so the generation does not move.
   */
  readonly setFocus: (focus: VoiceFocus | null) => void;
  /** The person selected something else: the focus follows, the generation moves. */
  readonly selectionChanged: (focus: VoiceFocus | null) => void;
  /**
   * The person moved back to where the focus already is (while a voice
   * navigation was out, the focus still names where the voice left): the
   * focus stays, the generation moves.
   */
  readonly selectionReturned: () => void;
  readonly appendInputSegment: (text: string, at: number) => void;
  /** The open utterance: every unreserved segment, as said. */
  readonly openSpan: () => string;
  /**
   * Takes every open segment for `actionId`: they are that action's from now
   * on, and no later action sees them. `null` with nothing open.
   */
  readonly reserveOpenSpan: (actionId: string) => SpanReservation | null;
  /** Exactly these segments are posted (or deliberately dropped): gone. */
  readonly consumeReservation: (seqs: ReadonlyArray<number>) => void;
  /** Exactly these segments return to the open utterance, in order. */
  readonly releaseReservation: (seqs: ReadonlyArray<number>) => void;
  /** Lets the open utterance go, returning what it said; `null` with nothing open. */
  readonly dropOpenSpan: () => string | null;
  readonly setPendingDelegation: (delegationId: string | null) => void;
  readonly setActivity: (activity: SpeechActivity) => void;
  readonly setQueue: (queue: ReadonlyArray<QueueItem>) => void;
  readonly setPendingAction: (action: PendingAction | null) => void;
  readonly setCaptions: (on: boolean) => void;
  readonly pushCaptionLine: (line: CaptionDelta) => void;
  readonly acquireDictationHold: (owner: string) => void;
  readonly releaseDictationHold: (owner: string) => void;
  /**
   * The person's Resume after dictation: the latched pause ends. Refused
   * while dictation still holds the microphone, whose words must not reach
   * the voice.
   */
  readonly resumeFromDictation: () => void;
  readonly setDestinationKnown: (known: boolean) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly setDriver: (driver: VoiceSessionDriver | null) => void;
  readonly setQueueDriver: (driver: VoiceQueueDriver | null) => void;
}

const CLEAR_ACTIVITY: SpeechActivity = {
  inputActiveUntil: null,
  outputPlaying: false,
  ackPending: false,
};

const NO_SEGMENTS: ReadonlyArray<TranscriptSegment> = [];
const NO_QUEUE: ReadonlyArray<QueueItem> = [];
const NO_CAPTIONS: ReadonlyArray<CaptionLine> = [];
const NO_HOLDS: ReadonlySet<string> = new Set();

/** One per window; a segment's `seq` never repeats within it. */
let nextSegmentSeq = 1;

export const useVoiceSessionStore = create<VoiceSessionState>()((set, get) => ({
  phase: "idle",
  endReason: null,
  availability: "unknown",
  session: null,
  sessionToken: 0,
  engineGeneration: 0,
  focus: null,
  segments: NO_SEGMENTS,
  pendingDelegationId: null,
  selectionGeneration: 0,
  activity: CLEAR_ACTIVITY,
  queue: NO_QUEUE,
  pendingAction: null,
  activeCard: null,
  captions: false,
  captionLines: NO_CAPTIONS,
  pausedForDictation: false,
  dictationHolds: NO_HOLDS,
  dictationPauseLatched: false,
  destinationKnown: true,
  muted: false,
  driver: null,
  queueDriver: null,

  setAvailability: (availability) => set({ availability }),
  sessionConnecting: () =>
    set({
      phase: "connecting",
      endReason: null,
      session: null,
      sessionToken: get().sessionToken + 1,
      engineGeneration: get().engineGeneration + 1,
      // Started while dictation records: paused until the person resumes.
      dictationPauseLatched: get().dictationHolds.size > 0,
    }),
  engineReplacing: () =>
    set({
      phase: "connecting",
      session: null,
      engineGeneration: get().engineGeneration + 1,
    }),
  sessionLive: (session) =>
    set({ phase: "live", session, availability: "live", endReason: null }),
  sessionEnding: () => set({ phase: "ending" }),
  sessionEnded: (reason) =>
    set({
      phase: "idle",
      endReason: reason,
      session: null,
      sessionToken: get().sessionToken + 1,
      focus: null,
      segments: NO_SEGMENTS,
      pendingDelegationId: null,
      activity: CLEAR_ACTIVITY,
      queue: NO_QUEUE,
      pendingAction: null,
      captionLines: NO_CAPTIONS,
      muted: false,
      dictationPauseLatched: false,
      pausedForDictation: get().dictationHolds.size > 0,
    }),
  clearEndReason: () => {
    if (get().endReason === null) return;
    set({ endReason: null });
  },
  setFocus: (focus) => {
    if (sameFocus(get().focus, focus)) return;
    set({ focus });
  },
  selectionChanged: (focus) => {
    if (sameFocus(get().focus, focus)) return;
    set({ focus, selectionGeneration: get().selectionGeneration + 1 });
  },
  selectionReturned: () =>
    set({ selectionGeneration: get().selectionGeneration + 1 }),
  appendInputSegment: (text, at) => {
    if (text.length === 0) return;
    const seq = nextSegmentSeq;
    nextSegmentSeq += 1;
    set({
      segments: [...get().segments, { seq, text, at, reservedBy: null }],
    });
  },
  openSpan: () => joinSegments(openSegments(get().segments)),
  reserveOpenSpan: (actionId) => {
    const open = openSegments(get().segments);
    if (open.length === 0) return null;
    set({
      segments: get().segments.map((segment) =>
        segment.reservedBy === null
          ? { ...segment, reservedBy: actionId }
          : segment,
      ),
    });
    return {
      text: joinSegments(open),
      seqs: open.map((segment) => segment.seq),
    };
  },
  consumeReservation: (seqs) => {
    const gone = new Set(seqs);
    const kept = get().segments.filter((segment) => !gone.has(segment.seq));
    if (kept.length !== get().segments.length) set({ segments: kept });
  },
  releaseReservation: (seqs) => {
    const freed = new Set(seqs);
    if (!get().segments.some((segment) => freed.has(segment.seq))) return;
    set({
      segments: get().segments.map((segment) =>
        freed.has(segment.seq) ? { ...segment, reservedBy: null } : segment,
      ),
    });
  },
  dropOpenSpan: () => {
    const open = openSegments(get().segments);
    if (open.length === 0) return null;
    set({
      segments: get().segments.filter((segment) => segment.reservedBy !== null),
    });
    return joinSegments(open);
  },
  setPendingDelegation: (delegationId) => {
    if (get().pendingDelegationId === delegationId) return;
    set({ pendingDelegationId: delegationId });
  },
  setActivity: (activity) => {
    const current = get().activity;
    if (
      current.inputActiveUntil === activity.inputActiveUntil &&
      current.outputPlaying === activity.outputPlaying &&
      current.ackPending === activity.ackPending
    ) {
      return;
    }
    set({ activity });
  },
  setQueue: (queue) => set({ queue }),
  setPendingAction: (pendingAction) => set({ pendingAction }),
  setCaptions: (captions) =>
    set({
      captions,
      captionLines: captions ? get().captionLines : NO_CAPTIONS,
    }),
  pushCaptionLine: (line) => {
    if (!get().captions) return;
    const lines = get().captionLines;
    const last = lines.at(-1);
    // Deltas of one utterance extend its line; a change of speaker starts one.
    const next =
      last !== undefined && last.direction === line.direction
        ? [...lines.slice(0, -1), { ...last, text: last.text + line.text }]
        : [...lines, { ...line, id: (last?.id ?? 0) + 1 }];
    set({ captionLines: next.slice(-CAPTION_LINES_KEPT) });
  },
  acquireDictationHold: (owner) => {
    if (get().dictationHolds.has(owner)) return;
    const dictationHolds = new Set(get().dictationHolds);
    dictationHolds.add(owner);
    set({
      dictationHolds,
      pausedForDictation: true,
      dictationPauseLatched:
        get().dictationPauseLatched || get().phase !== "idle",
    });
  },
  setDestinationKnown: (destinationKnown) => set({ destinationKnown }),
  releaseDictationHold: (owner) => {
    if (!get().dictationHolds.has(owner)) return;
    const dictationHolds = new Set(get().dictationHolds);
    dictationHolds.delete(owner);
    set({
      dictationHolds,
      pausedForDictation:
        dictationHolds.size > 0 || get().dictationPauseLatched,
    });
  },
  resumeFromDictation: () => {
    const { dictationHolds, dictationPauseLatched } = get();
    if (dictationHolds.size > 0 || !dictationPauseLatched) return;
    set({ dictationPauseLatched: false, pausedForDictation: false });
  },
  setMuted: (muted) => set({ muted }),
  setDriver: (driver) => set({ driver }),
  setQueueDriver: (queueDriver) => set({ queueDriver }),
}));

/**
 * What the Waiting control lists and counts: the items still waiting
 * (queued, or offered and not taken up), newest first. Announcements are
 * left out: they are spoken only in a briefing (V3).
 */
export function waitingItems(
  queue: ReadonlyArray<QueueItem>,
): ReadonlyArray<QueueItem> {
  return queue
    .filter(
      (item) =>
        item.kind !== "announcement" &&
        (item.state === "queued" || item.state === "offered"),
    )
    .sort((a, b) => b.at - a.at);
}

function openSegments(
  segments: ReadonlyArray<TranscriptSegment>,
): ReadonlyArray<TranscriptSegment> {
  return segments.filter((segment) => segment.reservedBy === null);
}

export function sameFocus(a: VoiceFocus | null, b: VoiceFocus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.botId === b.botId &&
    a.hostId === b.hostId &&
    a.threadId === b.threadId &&
    a.anchorMessageId === b.anchorMessageId &&
    a.anchorThread === b.anchorThread
  );
}

/**
 * The transcript deltas joined exactly as they arrived. A delta is a
 * transport chunk, not a word: the vendor's deltas carry their own spacing,
 * and a chunk boundary can fall inside a word or a path, so nothing is added
 * between them. Only the ends are trimmed.
 */
export function joinSegments(
  segments: ReadonlyArray<TranscriptSegment>,
): string {
  return segments
    .map((segment) => segment.text)
    .join("")
    .trim();
}

/**
 * Whether a spoken request is still open: words not yet taken by an action,
 * words an action holds but has not posted, or a request not yet acted on.
 */
export function isUtteranceOpen(state: VoiceSessionState): boolean {
  return (
    state.segments.length > 0 ||
    state.pendingDelegationId !== null ||
    state.pendingAction !== null
  );
}

/**
 * What Talk (the control's toggle and its shortcut) would do now: end a
 * session that is connecting or live, start one when none runs and Talk can
 * start one (voice offered, a bot to talk to), or nothing (no session owner
 * mounted, or a session already ending).
 */
export function talkToggleAction(
  state: VoiceSessionState,
): "start" | "end" | null {
  if (state.driver === null) return null;
  if (state.phase === "connecting" || state.phase === "live") return "end";
  if (
    state.phase === "idle" &&
    state.availability === "live" &&
    state.destinationKnown
  ) {
    return "start";
  }
  return null;
}

/** Whether the session is live and drawn: the strip is on screen. */
export function isVoiceSessionShown(state: VoiceSessionState): boolean {
  return state.phase !== "idle" || state.endReason !== null;
}
