import { beforeEach, describe, expect, it } from "vitest";
import {
  isUtteranceOpen,
  joinSegments,
  sameFocus,
  useVoiceSessionStore,
  type VoiceFocus,
  type VoiceSessionDriver,
} from "../voice-session-store";

const FOCUS: VoiceFocus = {
  botId: "bot-1",
  hostId: "host-1",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
};
const THREAD_FOCUS: VoiceFocus = {
  ...FOCUS,
  threadId: "thread-1",
  anchorMessageId: "msg-1",
};
const DRIVER: VoiceSessionDriver = {
  start: () => undefined,
  end: () => undefined,
  setMuted: () => undefined,
};

const initial = useVoiceSessionStore.getState();

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
});

describe("focus and selection generation", () => {
  it("selectionChanged bumps the generation and setFocus does not", () => {
    const store = useVoiceSessionStore.getState();
    store.setFocus(FOCUS);
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(0);

    store.selectionChanged(THREAD_FOCUS);
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(1);
    expect(useVoiceSessionStore.getState().focus).toEqual(THREAD_FOCUS);
  });
});

describe("sessionEnded", () => {
  it("forgets the session's state but keeps availability and the driver", () => {
    const store = useVoiceSessionStore.getState();
    store.setAvailability("live");
    store.setDriver(DRIVER);
    store.setFocus(FOCUS);
    store.appendInputSegment("hello", 1);
    store.setPendingDelegation("d-1");

    store.sessionEnded("ended");

    const state = useVoiceSessionStore.getState();
    expect(state.focus).toBeNull();
    expect(state.segments).toEqual([]);
    expect(state.pendingDelegationId).toBeNull();
    expect(state.endReason).toBe("ended");
    expect(state.availability).toBe("live");
    expect(state.driver).toBe(DRIVER);
  });
});

describe("the dictation pause", () => {
  it("is held per owner: it outlives the session, and ends only when every owner has released its own hold", () => {
    const store = useVoiceSessionStore.getState();
    store.acquireDictationHold("composer-a");
    store.sessionConnecting();
    store.engineReplacing();
    store.sessionEnded("ended");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);

    store.sessionConnecting();
    store.acquireDictationHold("composer-b");
    // An owner that never acquired releases nothing; one that did releases
    // only its own.
    store.releaseDictationHold("composer-idle");
    store.releaseDictationHold("composer-a");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.releaseDictationHold("composer-b");
    expect(useVoiceSessionStore.getState().dictationHolds.size).toBe(0);
    // The session started under a hold: it stays paused for the Resume.
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.resumeFromDictation();
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
  });

  it("outlives dictation while a session runs: only Resume ends it, and Resume waits for the microphone", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting();
    store.acquireDictationHold("composer");
    store.resumeFromDictation();
    // Dictation still records: Resume is refused.
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);

    store.releaseDictationHold("composer");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.resumeFromDictation();
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);

    // Paused again, then the session ends: the pause goes with it.
    store.acquireDictationHold("composer");
    store.releaseDictationHold("composer");
    store.sessionEnded("ended");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
    expect(useVoiceSessionStore.getState().dictationPauseLatched).toBe(false);
  });

  it("is dictation's alone with no session: a hold taken and released while idle leaves nothing to resume", () => {
    const store = useVoiceSessionStore.getState();
    store.acquireDictationHold("composer");
    store.releaseDictationHold("composer");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
    expect(useVoiceSessionStore.getState().dictationPauseLatched).toBe(false);
  });
});

describe("reservations", () => {
  it("reserves every open segment, consumes only its own and releases in order", () => {
    const store = useVoiceSessionStore.getState();
    store.appendInputSegment("Check build A.", 1);
    const a = store.reserveOpenSpan("a");
    store.appendInputSegment(" Then check build B.", 2);
    const b = useVoiceSessionStore.getState().reserveOpenSpan("b");

    expect(a?.text).toBe("Check build A.");
    expect(b?.text).toBe("Then check build B.");
    expect(useVoiceSessionStore.getState().reserveOpenSpan("c")).toBeNull();

    useVoiceSessionStore.getState().consumeReservation(a?.seqs ?? []);
    expect(
      useVoiceSessionStore.getState().segments.map((s) => s.reservedBy),
    ).toEqual(["b"]);

    useVoiceSessionStore.getState().releaseReservation(b?.seqs ?? []);
    expect(useVoiceSessionStore.getState().openSpan()).toBe(
      "Then check build B.",
    );
  });

  it("moves the session token on connecting and on ended", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting();
    const connecting = useVoiceSessionStore.getState().sessionToken;
    store.sessionEnded(null);
    expect(useVoiceSessionStore.getState().sessionToken).toBe(connecting + 1);
  });
});

describe("pushCaptionLine", () => {
  it("stores nothing while captions are off", () => {
    useVoiceSessionStore
      .getState()
      .pushCaptionLine({ direction: "input", text: "hi" });
    expect(useVoiceSessionStore.getState().captionLines).toEqual([]);
  });

  it("extends the last line of the same direction and keeps the last four", () => {
    const store = useVoiceSessionStore.getState();
    store.setCaptions(true);
    store.pushCaptionLine({ direction: "input", text: "hel" });
    store.pushCaptionLine({ direction: "input", text: "lo" });
    expect(
      useVoiceSessionStore
        .getState()
        .captionLines.map(({ direction, text }) => ({ direction, text })),
    ).toEqual([{ direction: "input", text: "hello" }]);

    for (const direction of ["output", "input", "output", "input"] as const) {
      store.pushCaptionLine({ direction, text: direction });
    }
    const lines = useVoiceSessionStore.getState().captionLines;
    expect(lines.map((line) => line.direction)).toEqual([
      "output",
      "input",
      "output",
      "input",
    ]);
  });
});

describe("joinSegments", () => {
  const seg = (text: string) => ({ seq: 0, text, at: 0, reservedBy: null });

  it("joins a word split across deltas without inventing a space", () => {
    expect(joinSegments([seg("hel"), seg("lo")])).toBe("hello");
  });

  it("joins a path split across deltas without inventing a space", () => {
    expect(joinSegments([seg("/src/"), seg("voice.ts")])).toBe("/src/voice.ts");
  });

  it("keeps the vendor's own spacing and trims only the ends", () => {
    expect(joinSegments([seg(" Check "), seg("build. ")])).toBe("Check build.");
  });
});

describe("isUtteranceOpen and sameFocus", () => {
  it("is open with segments, a pending delegation or a pending action, closed otherwise", () => {
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(false);
    useVoiceSessionStore.getState().setPendingDelegation("d-1");
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(true);
    useVoiceSessionStore.getState().setPendingDelegation(null);
    useVoiceSessionStore.getState().appendInputSegment("hi", 1);
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(true);
    useVoiceSessionStore.getState().dropOpenSpan();
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(false);
    useVoiceSessionStore.getState().setPendingAction({
      kind: "interrupted",
      text: "x",
      delegationId: null,
      selectionGeneration: 0,
      askState: "asking",
    });
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(true);
  });

  it("compares foci by value", () => {
    expect(sameFocus(FOCUS, { ...FOCUS })).toBe(true);
    expect(sameFocus(FOCUS, THREAD_FOCUS)).toBe(false);
    expect(sameFocus(null, FOCUS)).toBe(false);
  });
});
