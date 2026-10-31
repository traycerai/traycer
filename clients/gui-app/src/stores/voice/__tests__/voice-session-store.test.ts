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
  const seg = (text: string) => ({ text, at: 0 });

  it("adds a space between words, none before punctuation or after a space", () => {
    expect(
      joinSegments([
        seg("hello"),
        seg("world"),
        seg("."),
        seg(" ok"),
        seg("yes"),
      ]),
    ).toBe("hello world. ok yes");
  });
});

describe("isUtteranceOpen and sameFocus", () => {
  it("is open with segments or a pending delegation, closed otherwise", () => {
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(false);
    useVoiceSessionStore.getState().setPendingDelegation("d-1");
    expect(isUtteranceOpen(useVoiceSessionStore.getState())).toBe(true);
  });

  it("compares foci by value", () => {
    expect(sameFocus(FOCUS, { ...FOCUS })).toBe(true);
    expect(sameFocus(FOCUS, THREAD_FOCUS)).toBe(false);
    expect(sameFocus(null, FOCUS)).toBe(false);
  });
});
