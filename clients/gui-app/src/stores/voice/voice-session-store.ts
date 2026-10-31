import { create } from "zustand";
import type { VoiceEngine } from "@/lib/voice/engine";
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
  /** `null`: the channel's top level. */
  readonly threadId: string | null;
  /** The row the open thread hangs off; `null` with no thread. */
  readonly anchorMessageId: string | null;
}

/** One fragment of what the person said, as it was transcribed. */
export interface TranscriptSegment {
  readonly text: string;
  readonly at: number;
}

/**
 * A reply or notice waiting to be spoken, from the same signal the bell uses.
 * The queue is filled by a later ticket; the shape is here so the strip's
 * Waiting slot and the re-mint summary have something to read.
 */
export interface QueueItem {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string | null;
  /** One line: which bot, which thread, the gist. */
  readonly line: string;
}

/**
 * A routed action bound to its target and awaiting acceptance. The router
 * (a later ticket) fills it; without one the whole utterance posts to the
 * focus and nothing is pending between the boundary and the send.
 */
export interface PendingAction {
  readonly kind: "post";
  readonly delegationId: string;
  readonly focus: VoiceFocus;
  readonly text: string;
  /** The selection generation the action was bound at. */
  readonly selectionGeneration: number;
}

export type VoicePhase = "idle" | "connecting" | "live" | "ending";

/** Why the last session ended, for the strip's one line about it. */
export type VoiceEndReason =
  /** The person ended it, or the shell is going away. */
  "ended" | "credits" | "connection" | "locked" | "microphone" | "unavailable";

export type VoiceAvailability =
  /** No mint has answered yet: Talk is offered. */
  | "unknown"
  | "live"
  /** The server answered the dormant empty 200: Talk hides for this window. */
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
  readonly focus: VoiceFocus | null;
  /** Every input segment since the last consumed span, oldest first. */
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
  readonly pausedForDictation: boolean;
  readonly muted: boolean;
  readonly driver: VoiceSessionDriver | null;

  readonly setAvailability: (availability: VoiceAvailability) => void;
  readonly sessionConnecting: () => void;
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
  readonly appendInputSegment: (text: string, at: number) => void;
  /** The utterance so far: every segment since the last consumed span, joined. */
  readonly openSpan: () => string;
  /** The open span was posted (or deliberately dropped): the buffer starts over. */
  readonly consumeSpan: () => void;
  readonly setPendingDelegation: (delegationId: string | null) => void;
  readonly setActivity: (activity: SpeechActivity) => void;
  readonly setQueue: (queue: ReadonlyArray<QueueItem>) => void;
  readonly setPendingAction: (action: PendingAction | null) => void;
  readonly setCaptions: (on: boolean) => void;
  readonly pushCaptionLine: (line: CaptionDelta) => void;
  readonly setPausedForDictation: (paused: boolean) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly setDriver: (driver: VoiceSessionDriver | null) => void;
}

const CLEAR_ACTIVITY: SpeechActivity = {
  inputActiveUntil: null,
  outputPlaying: false,
  ackPending: false,
};

const NO_SEGMENTS: ReadonlyArray<TranscriptSegment> = [];
const NO_QUEUE: ReadonlyArray<QueueItem> = [];
const NO_CAPTIONS: ReadonlyArray<CaptionLine> = [];

export const useVoiceSessionStore = create<VoiceSessionState>()((set, get) => ({
  phase: "idle",
  endReason: null,
  availability: "unknown",
  session: null,
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
  muted: false,
  driver: null,

  setAvailability: (availability) => set({ availability }),
  sessionConnecting: () =>
    set({ phase: "connecting", endReason: null, session: null }),
  sessionLive: (session) =>
    set({ phase: "live", session, availability: "live", endReason: null }),
  sessionEnding: () => set({ phase: "ending" }),
  sessionEnded: (reason) =>
    set({
      phase: "idle",
      endReason: reason,
      session: null,
      focus: null,
      segments: NO_SEGMENTS,
      pendingDelegationId: null,
      activity: CLEAR_ACTIVITY,
      queue: NO_QUEUE,
      pendingAction: null,
      captionLines: NO_CAPTIONS,
      pausedForDictation: false,
      muted: false,
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
  appendInputSegment: (text, at) => {
    if (text.length === 0) return;
    set({ segments: [...get().segments, { text, at }] });
  },
  openSpan: () => joinSegments(get().segments),
  consumeSpan: () => {
    if (get().segments.length === 0) return;
    set({ segments: NO_SEGMENTS });
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
  setPausedForDictation: (pausedForDictation) => set({ pausedForDictation }),
  setMuted: (muted) => set({ muted }),
  setDriver: (driver) => set({ driver }),
}));

export function sameFocus(a: VoiceFocus | null, b: VoiceFocus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.botId === b.botId &&
    a.hostId === b.hostId &&
    a.threadId === b.threadId &&
    a.anchorMessageId === b.anchorMessageId
  );
}

/**
 * The transcript deltas joined as the person said them: the vendor's deltas
 * carry their own spacing, so a bare join keeps the words; a delta that
 * starts a new word without a space gets one.
 */
export function joinSegments(
  segments: ReadonlyArray<TranscriptSegment>,
): string {
  let text = "";
  for (const segment of segments) {
    const piece = segment.text;
    if (piece.length === 0) continue;
    if (
      text.length > 0 &&
      !/\s$/.test(text) &&
      !/^[\s.,;:!?'’)\]]/.test(piece)
    ) {
      text += " ";
    }
    text += piece;
  }
  return text.trim();
}

/** Whether a spoken request is still open: words not yet posted, or a request not yet acted on. */
export function isUtteranceOpen(state: VoiceSessionState): boolean {
  return state.segments.length > 0 || state.pendingDelegationId !== null;
}

/** Whether the session is live and drawn: the strip is on screen. */
export function isVoiceSessionShown(state: VoiceSessionState): boolean {
  return state.phase !== "idle" || state.endReason !== null;
}
