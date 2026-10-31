import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionChrome } from "../voice-session-chrome";

const BOT_ID = "bot-1";
const FOCUS: VoiceFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
};

const navigation = vi.hoisted(() => ({ navigateToTabIntent: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => navigation);
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
const runnerHost = vi.hoisted(() => ({ openMicrophoneSettings: vi.fn() }));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHost,
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data: {
      bots: [{ botId: "bot-1", title: "Tracy", environmentId: "env-1" }],
    },
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: [{ environmentId: "env-1", label: "Personal" }] },
  }),
}));

const initial = useVoiceSessionStore.getState();

interface FakeDriver {
  start: Mock<VoiceSessionDriver["start"]>;
  end: Mock<VoiceSessionDriver["end"]>;
  setMuted: Mock<VoiceSessionDriver["setMuted"]>;
}

function makeDriver(): FakeDriver {
  return {
    start: vi.fn<VoiceSessionDriver["start"]>(),
    end: vi.fn<VoiceSessionDriver["end"]>(),
    setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
  };
}

/** A session that has gone live on the channel, drawn in the current layout. */
function goLive(driver: FakeDriver): FakeDriver {
  act(() => {
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.setState({ phase: "live", focus: FOCUS, driver });
  });
  render(<VoiceSessionChrome />);
  return driver;
}

function talkState(): string | null {
  return screen.getByTestId("voice-phone-talk-state").textContent;
}

// jsdom has no pointer capture; the talk button takes it on press.
const pointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "setPointerCapture",
);

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  navigation.navigateToTabIntent.mockReset();
  runnerHost.openMicrophoneSettings.mockReset();
  setPhoneLayoutOnly(true);
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: "host-a", title: "Tracy" });
});

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
  if (pointerCapture === undefined) {
    Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  } else {
    Object.defineProperty(
      Element.prototype,
      "setPointerCapture",
      pointerCapture,
    );
  }
  useBotOpenThreadStore.getState().setRail(BOT_ID, null);
});

describe("the phone voice view", () => {
  it("opens on the open microphone, and a tap on the talk button mutes it", async () => {
    const driver = goLive(makeDriver());

    expect(talkState()).toBe("Listening · tap to mute");
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));

    expect(driver.setMuted).toHaveBeenCalledTimes(1);
    expect(driver.setMuted).toHaveBeenCalledWith(true);
  });

  it("holds the microphone open only while the talk button is held under push-to-talk, and the open microphone returns on the switch back", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "Push to talk" }));
    expect(useVoiceSessionStore.getState().pushToTalk).toBe(true);
    expect(talkState()).toBe("Hold to talk");

    const talk = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(talk, { pointerId: 1 });
    expect(useVoiceSessionStore.getState().talkHeld).toBe(true);
    expect(talkState()).toBe("Listening");

    fireEvent.pointerUp(talk, { pointerId: 1 });
    expect(useVoiceSessionStore.getState().talkHeld).toBe(false);
    expect(talkState()).toBe("Hold to talk");

    // A cancelled press (the system took the touch) releases as well, and the
    // click that follows a press never mutes.
    fireEvent.pointerDown(talk, { pointerId: 2 });
    expect(useVoiceSessionStore.getState().talkHeld).toBe(true);
    fireEvent.pointerCancel(talk, { pointerId: 2 });
    expect(useVoiceSessionStore.getState().talkHeld).toBe(false);
    fireEvent.click(talk);
    expect(driver.setMuted).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open mic" }));
    expect(useVoiceSessionStore.getState().pushToTalk).toBe(false);
    expect(talkState()).toBe("Listening · tap to mute");
  });

  it("draws no captions until they are turned on, then the empty line, then each speaker's words", async () => {
    goLive(makeDriver());
    act(() => {
      useVoiceSessionStore
        .getState()
        .pushCaptionLine({ direction: "input", text: "never kept" });
    });
    expect(screen.queryByTestId("voice-phone-captions-lines")).toBeNull();

    await userEvent.click(screen.getByTestId("voice-phone-captions"));
    const lines = screen.getByTestId("voice-phone-captions-lines");
    expect(lines.textContent).toBe("Nothing said yet.");

    act(() => {
      const store = useVoiceSessionStore.getState();
      store.pushCaptionLine({ direction: "input", text: "hello" });
      store.pushCaptionLine({ direction: "output", text: "hi there" });
    });
    expect(lines.textContent).toContain("You: hello");
    expect(lines.textContent).toContain("Tracy: hi there");
    expect(lines.textContent).not.toContain("never kept");
  });

  it("ends the session from the cross", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByTestId("voice-phone-end"));

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("puts the view down on the focus line, keeps the session in the bar, and the bar brings the view back or ends the session", async () => {
    const driver = goLive(makeDriver());
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();
    expect(screen.getByTestId("voice-phone-focus").textContent).toContain(
      "Tracy",
    );

    await userEvent.click(screen.getByTestId("voice-phone-focus"));

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(navigation.navigateToTabIntent).toHaveBeenCalledWith(
      expect.anything(),
      botTabIntent(BOT_ID),
      undefined,
    );
    expect(screen.getByTestId("voice-phone-bar-state").textContent).toBe(
      "Listening · tap to mute",
    );

    await userEvent.click(screen.getByTestId("voice-phone-bar-open"));
    await screen.findByTestId("voice-phone-view");
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();

    await userEvent.click(screen.getByTestId("voice-phone-focus"));
    await screen.findByTestId("voice-phone-bar");
    await userEvent.click(screen.getByTestId("voice-phone-bar-end"));
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("says on return that the session ended in the background", () => {
    act(() => useVoiceSessionStore.getState().sessionEnded("background"));
    render(<VoiceSessionChrome />);

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended when you left the app.",
    );
    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("sends a refused microphone to the OS settings page", async () => {
    act(() =>
      useVoiceSessionStore.getState().sessionEnded("microphone-denied"),
    );
    render(<VoiceSessionChrome />);

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice needs the microphone. Allow it in Settings.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Settings" }),
    );

    expect(runnerHost.openMicrophoneSettings).toHaveBeenCalledTimes(1);
  });

  it("is the strip, not the phone view, on the desktop layout", () => {
    setPhoneLayoutOnly(false);
    goLive(makeDriver());

    expect(screen.getByTestId("voice-strip-mute")).toBeTruthy();
    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();
  });
});
