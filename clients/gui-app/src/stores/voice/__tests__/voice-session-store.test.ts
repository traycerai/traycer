import { beforeEach, describe, expect, it } from "vitest";
import {
  callToggleAction,
  useVoiceSessionStore,
  type CallFocus,
  type VoiceSessionDriver,
  type VoiceSessionRecord,
} from "../voice-session-store";
import type { VoiceEngine } from "@/lib/voice/engine";

const FOCUS: CallFocus = {
  botId: "bot-1",
  hostId: "host-1",
  threadId: null,
};
const DRIVER: VoiceSessionDriver = {
  start: () => undefined,
  end: () => undefined,
  setMuted: () => undefined,
};
const ENGINE: VoiceEngine = {
  connect: () => Promise.resolve(),
  appendCommentary: () => undefined,
  appendThinking: () => undefined,
  close: () => Promise.resolve(),
};
const RECORD: VoiceSessionRecord = {
  id: "session-1",
  expiresAt: 0,
  engine: ENGINE,
};

beforeEach(() => {
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
});

describe("sessionConnecting", () => {
  it("begins a call with its focus and title, clears the last end's line, and opens the phone view", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionEnded("credits");
    store.appendInput("stale");

    store.sessionConnecting(FOCUS, "Tracy");

    expect(useVoiceSessionStore.getState()).toMatchObject({
      phase: "connecting",
      focus: FOCUS,
      callTitle: "Tracy",
      endReason: null,
      refusal: null,
      openSpan: "",
      phoneViewOpen: true,
    });
  });

  it("takes the dial down: the call replaces it", () => {
    const store = useVoiceSessionStore.getState();
    store.openDial({ botId: "bot-1", threadId: null }, "Tracy");
    store.sessionConnecting(FOCUS, "Tracy");
    expect(useVoiceSessionStore.getState().dial).toBeNull();
  });

  it("moves the session token on connecting and on ended", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    const connecting = useVoiceSessionStore.getState().sessionToken;
    store.sessionEnded(null);
    expect(useVoiceSessionStore.getState().sessionToken).toBe(connecting + 1);
  });
});

describe("sessionEnded", () => {
  it("forgets the call's state but keeps availability, the driver, the title, and the phone view for the ended line", () => {
    const store = useVoiceSessionStore.getState();
    store.setAvailability("live");
    store.setDriver(DRIVER);
    store.sessionConnecting(FOCUS, "Tracy");
    store.sessionLive(RECORD);
    store.appendInput("hello");
    store.setCaptions(true);
    store.pushCaptionLine({ direction: "input", text: "hello" });

    store.sessionEnded("ended");

    expect(useVoiceSessionStore.getState()).toMatchObject({
      phase: "idle",
      focus: null,
      session: null,
      openSpan: "",
      captionLines: [],
      endReason: "ended",
      callTitle: "Tracy",
      availability: "live",
      driver: DRIVER,
      phoneViewOpen: true,
    });
  });

  it("keeps the phone view up with the reason until the line is dismissed, which puts the view down", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.sessionEnded("unreachable");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      endReason: "unreachable",
      phoneViewOpen: true,
    });

    store.clearEndReason();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      endReason: null,
      phoneViewOpen: false,
    });
  });

  it("leaves the view alone when there is no line to clear", () => {
    const store = useVoiceSessionStore.getState();
    store.openDial({ botId: "bot-1", threadId: null }, "Tracy");
    store.clearEndReason();
    expect(useVoiceSessionStore.getState().phoneViewOpen).toBe(true);
  });

  it("resets push-to-talk and the held button", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.setPushToTalk(true);
    store.setTalkHeld(true);
    store.sessionEnded("background");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      endReason: "background",
      pushToTalk: false,
      talkHeld: false,
    });
  });
});

describe("sessionRefused", () => {
  it("resets the call like an end but says a refusal, leaving endReason null, until it is cleared", () => {
    const store = useVoiceSessionStore.getState();
    store.setAvailability("live");
    store.setDriver(DRIVER);
    store.sessionConnecting(FOCUS, "Tracy");

    store.sessionRefused("credits", null);

    expect(useVoiceSessionStore.getState()).toMatchObject({
      phase: "idle",
      refusal: "credits",
      endReason: null,
      focus: null,
      phoneViewOpen: true,
      availability: "live",
      driver: DRIVER,
    });

    store.clearRefusal();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      refusal: null,
      phoneViewOpen: false,
    });
  });

  it("keeps a paused bot's copy until the refusal is cleared", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionRefused("paused", "Tracy is paused until Friday.");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      refusal: "paused",
      pausedCopy: "Tracy is paused until Friday.",
    });

    store.clearRefusal();
    expect(useVoiceSessionStore.getState().pausedCopy).toBeNull();
  });

  it("is replaced by the next start, and an end replaces a refusal rather than joining it", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionRefused("paused", "paused");
    store.sessionConnecting(FOCUS, "Tracy");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      refusal: null,
      pausedCopy: null,
    });

    store.sessionRefused("microphone", null);
    store.sessionEnded("ended");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      refusal: null,
      endReason: "ended",
    });
  });
});

describe("bindThread", () => {
  it("binds the call's thread once it opens, keeping the rest of the focus", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.bindThread("thread-1");
    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...FOCUS,
      threadId: "thread-1",
    });
  });

  it("does nothing with no call running", () => {
    useVoiceSessionStore.getState().bindThread("thread-1");
    expect(useVoiceSessionStore.getState().focus).toBeNull();
  });

  it("keeps the same focus object when the thread is already bound", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting({ ...FOCUS, threadId: "thread-1" }, "Tracy");
    const before = useVoiceSessionStore.getState().focus;
    store.bindThread("thread-1");
    expect(useVoiceSessionStore.getState().focus).toBe(before);
  });
});

describe("the dial", () => {
  it("openDial raises the phone view with the target and title, and closeDial lowers it", () => {
    const store = useVoiceSessionStore.getState();
    store.openDial({ botId: "bot-2", threadId: "thread-9" }, "Scout");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      dial: { botId: "bot-2", threadId: "thread-9" },
      callTitle: "Scout",
      phoneViewOpen: true,
    });

    store.closeDial();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      dial: null,
      phoneViewOpen: false,
    });
  });

  it("openDial replaces the last call's line", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionRefused("paused", "Paused.");
    store.openDial({ botId: "bot-1", threadId: null }, "Tracy");
    expect(useVoiceSessionStore.getState()).toMatchObject({
      refusal: null,
      pausedCopy: null,
      endReason: null,
    });
  });

  it("closeDial leaves a running call's view alone", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.closeDial();
    expect(useVoiceSessionStore.getState().phoneViewOpen).toBe(true);
  });
});

describe("what the person said", () => {
  it("takeOpenSpan joins the deltas as they arrived, trims only the ends, and empties the span", () => {
    const store = useVoiceSessionStore.getState();
    store.appendInput(" Check ");
    store.appendInput("/src/");
    store.appendInput("voice.ts now. ");

    expect(store.takeOpenSpan()).toBe("Check /src/voice.ts now.");
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
  });

  it("takeOpenSpan returns null with nothing said, or only blanks, and empties the blanks", () => {
    const store = useVoiceSessionStore.getState();
    expect(store.takeOpenSpan()).toBeNull();

    store.appendInput("   ");
    expect(store.takeOpenSpan()).toBeNull();
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
  });

  it("dropOpenSpan lets what was said go", () => {
    const store = useVoiceSessionStore.getState();
    store.appendInput("never mind");
    store.dropOpenSpan();
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
    expect(store.takeOpenSpan()).toBeNull();
  });
});

describe("the phone's talk mode and view", () => {
  it("switching push-to-talk either way starts the new mode listening, and a repeat switch changes nothing", () => {
    const store = useVoiceSessionStore.getState();
    store.setPushToTalk(true);
    store.setTalkHeld(true);
    store.setMuted(true);

    store.setPushToTalk(true);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      pushToTalk: true,
      talkHeld: true,
      muted: true,
    });

    store.setPushToTalk(false);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      pushToTalk: false,
      talkHeld: false,
      muted: false,
    });

    store.setMuted(true);
    store.setPushToTalk(true);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      pushToTalk: true,
      talkHeld: false,
      muted: false,
    });
  });

  it("hiding the view releases the hold but nothing else, and reopening it preserves a hold set while hidden", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.setPushToTalk(true);
    store.setTalkHeld(true);

    store.setPhoneViewOpen(false);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      phoneViewOpen: false,
      talkHeld: false,
      pushToTalk: true,
    });

    store.setTalkHeld(true);
    store.setPhoneViewOpen(true);
    expect(useVoiceSessionStore.getState()).toMatchObject({
      phoneViewOpen: true,
      talkHeld: true,
    });
  });

  it("leavePushToTalkMuted closes the microphone only while push-to-talk is on", () => {
    const store = useVoiceSessionStore.getState();
    store.leavePushToTalkMuted();
    expect(useVoiceSessionStore.getState().muted).toBe(false);

    store.setPushToTalk(true);
    store.setTalkHeld(true);
    store.leavePushToTalkMuted();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      pushToTalk: false,
      talkHeld: false,
      muted: true,
    });
  });
});

describe("the dictation pause", () => {
  it("is held per owner: it outlives the call, and ends only when every owner has released its own hold", () => {
    const store = useVoiceSessionStore.getState();
    store.acquireDictationHold("composer-a");
    store.sessionConnecting(FOCUS, "Tracy");
    store.engineReplacing();
    store.sessionEnded("ended");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);

    store.sessionConnecting(FOCUS, "Tracy");
    store.acquireDictationHold("composer-b");
    // An owner that never acquired releases nothing; one that did releases
    // only its own.
    store.releaseDictationHold("composer-idle");
    store.releaseDictationHold("composer-a");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.releaseDictationHold("composer-b");
    expect(useVoiceSessionStore.getState().dictationHolds.size).toBe(0);
    // The call started under a hold: it stays paused for the Resume.
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.resumeFromDictation();
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
  });

  it("outlives dictation while a call runs: only Resume ends it, and Resume waits for the microphone", () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting(FOCUS, "Tracy");
    store.acquireDictationHold("composer");
    store.resumeFromDictation();
    // Dictation still records: Resume is refused.
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);

    store.releaseDictationHold("composer");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    store.resumeFromDictation();
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);

    // Paused again, then the call ends: the pause goes with it.
    store.acquireDictationHold("composer");
    store.releaseDictationHold("composer");
    store.sessionEnded("ended");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
    expect(useVoiceSessionStore.getState().dictationPauseLatched).toBe(false);
  });

  it("is dictation's alone with no call: a hold taken and released while idle leaves nothing to resume", () => {
    const store = useVoiceSessionStore.getState();
    store.acquireDictationHold("composer");
    store.releaseDictationHold("composer");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(false);
    expect(useVoiceSessionStore.getState().dictationPauseLatched).toBe(false);
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

describe("callToggleAction", () => {
  it("is nothing without a call owner mounted, whatever else is true", () => {
    const store = useVoiceSessionStore.getState();
    store.setAvailability("live");
    expect(callToggleAction(useVoiceSessionStore.getState())).toBeNull();
    store.sessionConnecting(FOCUS, "Tracy");
    expect(callToggleAction(useVoiceSessionStore.getState())).toBeNull();
  });

  it("ends a call that is connecting or live", () => {
    const store = useVoiceSessionStore.getState();
    store.setDriver(DRIVER);
    store.sessionConnecting(FOCUS, "Tracy");
    expect(callToggleAction(useVoiceSessionStore.getState())).toBe("end");
    store.sessionLive(RECORD);
    expect(callToggleAction(useVoiceSessionStore.getState())).toBe("end");
  });

  it("starts a call when none runs and voice is offered", () => {
    const store = useVoiceSessionStore.getState();
    store.setDriver(DRIVER);
    store.setAvailability("live");
    expect(callToggleAction(useVoiceSessionStore.getState())).toBe("start");
  });

  it("does nothing while the server has not said, or offers no voice", () => {
    const store = useVoiceSessionStore.getState();
    store.setDriver(DRIVER);
    expect(callToggleAction(useVoiceSessionStore.getState())).toBeNull();
    store.setAvailability("dormant");
    expect(callToggleAction(useVoiceSessionStore.getState())).toBeNull();
  });

  it("does nothing while a call is ending", () => {
    useVoiceSessionStore.setState({
      driver: DRIVER,
      availability: "live",
      phase: "ending",
    });
    expect(callToggleAction(useVoiceSessionStore.getState())).toBeNull();
  });
});
