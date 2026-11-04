import { create } from "zustand";
import type { VoiceEngine } from "@/lib/voice/engine";
import type { SpeechActivity } from "@/lib/voice/scheduler";

/**
 * The call's one state, in memory only (Call Tracy, VC3). A call has no
 * record of its own in the product: what the person says is the call
 * thread's member rows, what the bot answers is its reply rows, and the only
 * durable thing the call itself leaves is the server's billing row. Nothing
 * here is persisted, and the call's end clears its transient state.
 */

/**
 * Who the call is with: one bot, on the host that carries its sends, and the
 * thread the call writes into. `threadId` is `null` until the first thing the
 * person says opens the call's thread; a call started from an open thread
 * names that thread from the start.
 */
export interface CallFocus {
  readonly botId: string;
  /** The host the bot's tab is bound to, which carries the send. */
  readonly hostId: string;
  readonly threadId: string | null;
}

/**
 * What a Call control or the dial asks for: the bot, and the thread the call
 * continues (`null` opens a new one with the first thing said). The host is
 * the controller's: the one that serves the bot surface.
 */
export interface CallTarget {
  readonly botId: string;
  readonly threadId: string | null;
}

export type VoicePhase = "idle" | "connecting" | "live" | "ending";

/** Why the last call ended, for the one line about it. */
export type VoiceEndReason =
  /** The person ended it, or the shell is going away. */
  | "ended"
  | "credits"
  | "connection"
  | "locked"
  /** The app went to the background (the phone, where the screen lock is one). */
  | "background"
  /** A call or another app took the sound while the call was live. */
  | "interrupted"
  /** The voice's sound could not be played, so nothing could be heard. */
  | "playback"
  /** Another account took over the window; the call was the outgoing one's. */
  | "account"
  /** A send was queued: no host can reach the bot now. What was said is kept. */
  | "unreachable";

/** Why a call never began; nothing ended, so this is not a `VoiceEndReason`. */
export type VoiceRefusal =
  /** The mint answered that the account has no credits for voice. */
  | "credits"
  | "microphone"
  /** The person refused the microphone; only the OS settings repair it. */
  | "microphone-denied"
  /** The voice's sound could not be played, so nothing could be heard. */
  | "playback"
  | "unavailable"
  /** `bot.open` said the bot is paused; `pausedCopy` is the tab's own line. */
  | "paused"
  /** The bot's host is too old to take a call's words as spoken. */
  | "update";

export type VoiceAvailability =
  /** The server has not said yet: Call waits. */
  | "unknown"
  | "live"
  /** The server offers no voice: Call hides for this window. */
  | "dormant";

export interface VoiceSessionRecord {
  readonly id: string;
  /** Epoch milliseconds, from the mint. */
  readonly expiresAt: number;
  readonly engine: VoiceEngine;
}

/** What the call controls and the shortcut ask of the controller that owns the call. */
export interface VoiceSessionDriver {
  /** Dials `target`: refused while the bot is paused, else mints and connects. */
  readonly start: (target: CallTarget) => void;
  readonly end: () => void;
  readonly setMuted: (muted: boolean) => void;
}

/** A line the captions draw; nothing beyond the last few is kept. */
export interface CaptionLine {
  /** Unique within the call, for the list's keys. */
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
  readonly refusal: VoiceRefusal | null;
  /** The paused bot's line, from its tab's copy, while `refusal` is `"paused"`. */
  readonly pausedCopy: string | null;
  readonly availability: VoiceAvailability;
  readonly session: VoiceSessionRecord | null;
  /**
   * The call's lifetime: bumped when a call starts and when it ends, never by
   * an engine replacement. A send carries the token it was made under and is
   * inert once the token has moved.
   */
  readonly sessionToken: number;
  /** The engine's generation within the call: bumped by every attempt. */
  readonly engineGeneration: number;
  /** Who the call is with; `null` with no call. */
  readonly focus: CallFocus | null;
  /**
   * The called bot's name, as the call and its ended line say it. Set at the
   * dial, kept after the end until the line about it is dismissed.
   */
  readonly callTitle: string | null;
  /**
   * The phone's dial: the call view's first state, with this bot preselected.
   * `null` while no dial is up. Nothing is minted until the person dials.
   */
  readonly dial: CallTarget | null;
  /** What the person said since the last utterance boundary, as transcribed. */
  readonly openSpan: string;
  /**
   * How much the person has said on this call, in transcript characters: a
   * position in what was said, which an utterance boundary can name.
   */
  readonly inputHeard: number;
  /** The position where `openSpan` begins. */
  readonly openSpanStart: number;
  readonly activity: SpeechActivity;
  readonly captions: boolean;
  readonly captionLines: ReadonlyArray<CaptionLine>;
  /**
   * The call's capture and the voice's sound are paused for dictation: true
   * while `dictationHolds` has an owner, and after that while
   * `dictationPauseLatched` waits for the person's Resume.
   */
  readonly pausedForDictation: boolean;
  /** Who holds the microphone for dictation, by owner token. */
  readonly dictationHolds: ReadonlySet<string>;
  /** Dictation paused a running call, which stays paused until the person resumes it. */
  readonly dictationPauseLatched: boolean;
  readonly muted: boolean;
  /**
   * Push-to-talk, the phone's per-call switch: the microphone carries the
   * person only while the talk button is held. Off at every start.
   */
  readonly pushToTalk: boolean;
  /** The talk button is held down, under push-to-talk. */
  readonly talkHeld: boolean;
  /**
   * The phone's full-screen call view is up: for the dial, at every start, and
   * after the end until its line is dismissed; down while the person looks at
   * the channel behind it, with the call still live.
   */
  readonly phoneViewOpen: boolean;
  readonly driver: VoiceSessionDriver | null;

  readonly setAvailability: (availability: VoiceAvailability) => void;
  /** A new call begins with `focus`: a new token and a new engine generation. */
  readonly sessionConnecting: (focus: CallFocus, title: string) => void;
  /** The engine is being replaced under the same call: a new generation only. */
  readonly engineReplacing: () => void;
  readonly sessionLive: (session: VoiceSessionRecord) => void;
  /** The call is over: its focus, words and captions are forgotten. */
  readonly sessionEnded: (reason: VoiceEndReason | null) => void;
  /** A dial that never became a call: the same reset, with the refusal said. */
  readonly sessionRefused: (
    refusal: VoiceRefusal,
    pausedCopy: string | null,
  ) => void;
  /** The line about the last end was read; it leaves. */
  readonly clearEndReason: () => void;
  /** The line about the refusal was read; Call returns. */
  readonly clearRefusal: () => void;
  /** The first send opened the call's thread: later sends go into it. */
  readonly bindThread: (threadId: string) => void;
  readonly openDial: (target: CallTarget, title: string) => void;
  readonly closeDial: () => void;
  readonly appendInput: (text: string) => void;
  /**
   * Takes what was said since the last boundary up to `position` (an
   * `inputHeard` reading); `null` with nothing said there.
   */
  readonly takeOpenSpanTo: (position: number) => string | null;
  /** Lets what was said since the last boundary go. */
  readonly dropOpenSpan: () => void;
  readonly setActivity: (activity: SpeechActivity) => void;
  readonly setCaptions: (on: boolean) => void;
  readonly pushCaptionLine: (line: CaptionDelta) => void;
  readonly acquireDictationHold: (owner: string) => void;
  readonly releaseDictationHold: (owner: string) => void;
  /** The person's Resume after dictation; refused while dictation still holds the microphone. */
  readonly resumeFromDictation: () => void;
  readonly setMuted: (muted: boolean) => void;
  /** Switching either way starts the new mode listening: unmuted, not held. */
  readonly setPushToTalk: (on: boolean) => void;
  readonly setTalkHeld: (held: boolean) => void;
  readonly setPhoneViewOpen: (open: boolean) => void;
  /**
   * Leaves push-to-talk with the microphone closed: the open microphone,
   * muted. For a layout with no talk button to hold. Nothing while
   * push-to-talk is off.
   */
  readonly leavePushToTalkMuted: () => void;
  readonly setDriver: (driver: VoiceSessionDriver | null) => void;
}

const CLEAR_ACTIVITY: SpeechActivity = {
  inputActiveUntil: null,
  outputPlaying: false,
  ackPending: false,
};

const NO_CAPTIONS: ReadonlyArray<CaptionLine> = [];
const NO_HOLDS: ReadonlySet<string> = new Set();

/**
 * What every way out of a call leaves behind, whatever the line says about it.
 * The phone's call view stays as it was: up, it shows how the call ended
 * until the line is dismissed.
 */
function idleSession(state: VoiceSessionState): Partial<VoiceSessionState> {
  return {
    phase: "idle",
    session: null,
    sessionToken: state.sessionToken + 1,
    focus: null,
    dial: null,
    openSpan: "",
    inputHeard: 0,
    openSpanStart: 0,
    activity: CLEAR_ACTIVITY,
    captionLines: NO_CAPTIONS,
    muted: false,
    pushToTalk: false,
    talkHeld: false,
    dictationPauseLatched: false,
    pausedForDictation: state.dictationHolds.size > 0,
  };
}

export const useVoiceSessionStore = create<VoiceSessionState>()((set, get) => ({
  phase: "idle",
  endReason: null,
  refusal: null,
  pausedCopy: null,
  availability: "unknown",
  session: null,
  sessionToken: 0,
  engineGeneration: 0,
  focus: null,
  callTitle: null,
  dial: null,
  openSpan: "",
  inputHeard: 0,
  openSpanStart: 0,
  activity: CLEAR_ACTIVITY,
  captions: false,
  captionLines: NO_CAPTIONS,
  pausedForDictation: false,
  dictationHolds: NO_HOLDS,
  dictationPauseLatched: false,
  muted: false,
  pushToTalk: false,
  talkHeld: false,
  phoneViewOpen: false,
  driver: null,

  setAvailability: (availability) => set({ availability }),
  sessionConnecting: (focus, title) =>
    set({
      phase: "connecting",
      endReason: null,
      refusal: null,
      pausedCopy: null,
      session: null,
      focus,
      callTitle: title,
      dial: null,
      openSpan: "",
      inputHeard: 0,
      openSpanStart: 0,
      sessionToken: get().sessionToken + 1,
      engineGeneration: get().engineGeneration + 1,
      // Started while dictation records: paused until the person resumes.
      dictationPauseLatched: get().dictationHolds.size > 0,
      phoneViewOpen: true,
    }),
  engineReplacing: () =>
    set({
      phase: "connecting",
      session: null,
      engineGeneration: get().engineGeneration + 1,
    }),
  sessionLive: (session) =>
    set({
      phase: "live",
      session,
      availability: "live",
      endReason: null,
      refusal: null,
      pausedCopy: null,
    }),
  sessionEnded: (reason) =>
    set({
      ...idleSession(get()),
      endReason: reason,
      refusal: null,
      pausedCopy: null,
    }),
  sessionRefused: (refusal, pausedCopy) =>
    set({ ...idleSession(get()), endReason: null, refusal, pausedCopy }),
  clearEndReason: () => {
    if (get().endReason === null) return;
    set({ endReason: null, phoneViewOpen: false });
  },
  clearRefusal: () => {
    if (get().refusal === null) return;
    set({ refusal: null, pausedCopy: null, phoneViewOpen: false });
  },
  bindThread: (threadId) => {
    const focus = get().focus;
    if (focus === null || focus.threadId === threadId) return;
    set({ focus: { ...focus, threadId } });
  },
  openDial: (target, title) =>
    set({
      dial: target,
      callTitle: title,
      endReason: null,
      refusal: null,
      pausedCopy: null,
      phoneViewOpen: true,
    }),
  closeDial: () => {
    if (get().dial === null) return;
    set({ dial: null, phoneViewOpen: false });
  },
  appendInput: (text) => {
    if (text.length === 0) return;
    set({
      openSpan: get().openSpan + text,
      inputHeard: get().inputHeard + text.length,
    });
  },
  takeOpenSpanTo: (position) => {
    const { openSpan, openSpanStart } = get();
    const length = position - openSpanStart;
    if (length <= 0) return null;
    // The deltas carry their own spacing: joined as they arrived, only the
    // ends trimmed.
    const said = openSpan.slice(0, length).trim();
    set({ openSpan: openSpan.slice(length), openSpanStart: position });
    return said.length === 0 ? null : said;
  },
  dropOpenSpan: () => {
    if (get().openSpan.length === 0) return;
    set({ openSpan: "", openSpanStart: get().inputHeard });
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
  setPushToTalk: (pushToTalk) => {
    if (get().pushToTalk === pushToTalk) return;
    set({ pushToTalk, talkHeld: false, muted: false });
  },
  setTalkHeld: (talkHeld) => {
    if (get().talkHeld === talkHeld) return;
    set({ talkHeld });
  },
  setPhoneViewOpen: (phoneViewOpen) =>
    set(phoneViewOpen ? { phoneViewOpen } : { phoneViewOpen, talkHeld: false }),
  leavePushToTalkMuted: () => {
    if (!get().pushToTalk) return;
    set({ pushToTalk: false, talkHeld: false, muted: true });
  },
  setDriver: (driver) => set({ driver }),
}));

/**
 * What the call's toggle (the Call control and the shortcut on a bot surface)
 * would do now: end a call that is connecting or live, start one when none
 * runs and voice is offered, or nothing (no call owner mounted, or a call
 * already ending).
 */
export function callToggleAction(
  state: VoiceSessionState,
): "start" | "end" | null {
  if (state.driver === null) return null;
  if (state.phase === "connecting" || state.phase === "live") return "end";
  if (state.phase === "idle" && state.availability === "live") return "start";
  return null;
}
