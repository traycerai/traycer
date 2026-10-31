import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionStrip } from "../voice-session-strip";

const BOT_ID = "bot-1";
const FOCUS: VoiceFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
};

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({ navigateToTabIntent: vi.fn() }));
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

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: "host-a", title: "Tracy" });
});

afterEach(() => {
  cleanup();
  useBotOpenThreadStore.getState().setRail(BOT_ID, null);
});

function goLive(driver: FakeDriver) {
  useVoiceSessionStore.setState({ phase: "live", focus: FOCUS, driver });
  render(<VoiceSessionStrip />);
  return driver;
}

describe("VoiceSessionStrip", () => {
  it("renders nothing when idle with no end reason", () => {
    render(<VoiceSessionStrip />);
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it("says Listening and where the next post goes", () => {
    goLive(makeDriver());

    // The state word alone is announced; the controls and the captions
    // sit in the plain region around it.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Listening");
    expect(
      screen.getByRole("region", { name: "Voice session" }).contains(status),
    ).toBe(true);
    expect(status.contains(screen.getByRole("button", { name: "Mute" }))).toBe(
      false,
    );
    expect(screen.getByTestId("voice-strip-focus").textContent).toContain(
      "Personal›Tracy",
    );
  });

  it("names the focused thread by its opening post", () => {
    useBotOpenThreadStore.getState().setRail(BOT_ID, {
      kind: "thread",
      anchorMessageId: "m-1",
      announcement: false,
      anchorKind: null,
      sent: {
        threadId: "t-1",
        requestId: "r-1",
        text: "Is the Safari fix in?",
        senderUserId: null,
        sentAt: 1,
        delivery: "written",
      },
    });
    useVoiceSessionStore.setState({
      phase: "live",
      focus: { ...FOCUS, threadId: "t-1", anchorMessageId: "m-1" },
      driver: makeDriver(),
    });
    render(<VoiceSessionStrip />);

    expect(screen.getByTestId("voice-strip-focus").textContent).toContain(
      "Is the Safari fix in?",
    );
  });

  it("mutes through the driver, then reads Muted and Unmute", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(driver.setMuted).toHaveBeenCalledWith(true);

    act(() => useVoiceSessionStore.setState({ muted: true }));
    expect(screen.getByTestId("voice-strip-state").textContent).toBe("Muted");
    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");
  });

  it("reads Voice paused for dictation with Resume, which waits for dictation to end and is never automatic", async () => {
    goLive(makeDriver());
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(screen.getByRole("status").textContent).toBe(
      "Voice paused for dictation",
    );
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveProperty("disabled", true);

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    expect(screen.getByRole("status").textContent).toBe(
      "Voice paused for dictation",
    );
    expect(resume).toHaveProperty("disabled", false);

    await userEvent.click(resume);
    expect(screen.getByRole("status").textContent).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("ends the session through the driver", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "End" }));

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("draws no captions until they are turned on, then prefixes each speaker", async () => {
    goLive(makeDriver());
    useVoiceSessionStore
      .getState()
      .pushCaptionLine({ direction: "input", text: "never kept" });
    expect(screen.queryByTestId("voice-strip-captions-lines")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Captions" }));
    expect(useVoiceSessionStore.getState().captions).toBe(true);

    act(() => {
      const store = useVoiceSessionStore.getState();
      store.pushCaptionLine({ direction: "input", text: "hello" });
      store.pushCaptionLine({ direction: "output", text: "hi there" });
    });
    const lines = screen.getByTestId("voice-strip-captions-lines");
    expect(screen.getByRole("status").contains(lines)).toBe(false);
    expect(lines.textContent).toContain("You: hello");
    expect(lines.textContent).toContain("Tracy: hi there");
    expect(lines.textContent).not.toContain("never kept");
  });

  it("says why a session ended and clears the line on dismiss", async () => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "credits" });
    render(<VoiceSessionStrip />);

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended: credits.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().endReason).toBeNull();
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it("says the sound could not be played when the end was a playback failure", () => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "playback" });
    render(<VoiceSessionStrip />);

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended: the sound could not be played.",
    );
  });
});
