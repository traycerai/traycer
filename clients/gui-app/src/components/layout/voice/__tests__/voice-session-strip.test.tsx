import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import type { RouteSeen } from "@/lib/voice/miss-report";
import {
  filedMisses,
  NO_OFFERED_IDS,
  scrubbedMisses,
} from "@/lib/voice/__tests__/fixtures/filed-misses";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionStrip } from "../voice-session-strip";

const captureMessage = vi.hoisted(() => vi.fn());
const isInitialized = vi.hoisted(() => vi.fn(() => true));
vi.mock("@sentry/browser", () => ({ captureMessage, isInitialized }));

const BOT_ID = "bot-1";
const FOCUS: VoiceFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
};

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
const navigation = vi.hoisted(() => ({
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  activateTabIntent: (_navigate: unknown, intent: unknown) => {
    navigation.activateTabIntent(intent);
    return true;
  },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-a"], resolved: true }),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
const runnerHost = vi.hoisted(() => ({
  openMicrophoneSettings: vi.fn(),
  signInUrl: "https://platform.test/sign-in",
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHost,
}));
// The OS handoff is the external boundary; the billing URL is the real one.
const links = vi.hoisted(() => ({
  openLink:
    vi.fn<(url: string, kind: string, event: unknown) => Promise<void>>(),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => links.openLink,
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
  navigation.activateTabIntent.mockReset();
  captureMessage.mockReset();
  isInitialized.mockReset();
  isInitialized.mockReturnValue(true);
  links.openLink.mockReset();
  links.openLink.mockResolvedValue(undefined);
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useTracySurfaceStore.getState().openSurface("host-a");
  useTracySurfaceStore.getState().selectChannel(BOT_ID);
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

const EXECUTED_ACT: RouteSeen = {
  route: {
    action: "act",
    target: {
      environmentId: null,
      botId: null,
      threadId: null,
      itemId: null,
      actionId: "action:tab.next",
      agentId: null,
    },
    span: { fromSegment: 0, toSegment: 0 },
    uncertain: false,
    question: null,
    control: null,
    choice: null,
  },
  viewKind: "task",
  rowIds: ["action:tab.next", "action:tab.close"],
  offered: NO_OFFERED_IDS,
  pageTakesWords: false,
  actTakesWords: false,
  segments: ["next tab"],
};

/** An agent tell that ran, over words that name a person and carry a secret. */
const EXECUTED_TELL: RouteSeen = {
  ...EXECUTED_ACT,
  route: {
    ...EXECUTED_ACT.route,
    target: { ...EXECUTED_ACT.route.target, actionId: "agent.tell:chat_1" },
    span: { fromSegment: 0, toSegment: 1 },
  },
  rowIds: ["agent.tell:chat_1"],
  pageTakesWords: true,
  actTakesWords: true,
  segments: [
    "Please remind Ada at ada.lovelace@example.com ",
    "that my password is tangerine-oyster-42",
  ],
};

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

  it("brings the surface to the focused bot's channel from Change", async () => {
    goLive(makeDriver());

    await userEvent.click(screen.getByTestId("voice-strip-change"));

    expect(navigation.activateTabIntent).toHaveBeenCalledWith(
      botTabIntent(BOT_ID),
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

  it("names the destination in the state word's tooltip only while the focus line is hidden, on one status node", async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {
          observers.push(() => this.callback([], this));
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    goLive(makeDriver());
    const status = screen.getByRole("status");
    const lineWidth = vi.spyOn(
      screen.getByTestId("voice-strip-focus"),
      "getBoundingClientRect",
    );
    const setLineWidth = (width: number): void => {
      lineWidth.mockReturnValue(new DOMRect(0, 0, width, 20));
      act(() => {
        for (const report of observers) report();
      });
    };

    setLineWidth(0);
    await userEvent.hover(status);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Personal › Tracy");

    setLineWidth(120);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.getByRole("status")).toBe(status);

    setLineWidth(0);
    await screen.findByRole("tooltip");
    expect(screen.getByRole("status")).toBe(status);
    vi.unstubAllGlobals();
  });

  it("does not carry a shown focus line over to the next session's, which lays out to nothing", async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {
          observers.push(() => this.callback([], this));
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    goLive(makeDriver());
    vi.spyOn(
      screen.getByTestId("voice-strip-focus"),
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 120, 20));
    act(() => {
      for (const report of observers) report();
    });

    act(() => useVoiceSessionStore.setState({ focus: null }));
    expect(screen.queryByTestId("voice-strip-focus")).toBeNull();
    observers.length = 0;
    act(() => useVoiceSessionStore.setState({ focus: FOCUS }));

    // The new line has no width and no observer has reported on it.
    expect(observers).toHaveLength(1);
    await userEvent.hover(screen.getByRole("status"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Personal › Tracy");
    vi.unstubAllGlobals();
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

  it("says why a live session ended and clears the line on dismiss", async () => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "credits" });
    render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

    const line = screen.getByTestId("voice-session-strip");
    expect(line.getAttribute("data-state")).toBe("ended");
    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended: credits.",
    );
    await userEvent.click(screen.getByTestId("voice-strip-get-credits"));
    expect(links.openLink).toHaveBeenCalledWith(
      "https://platform.test/billing",
      "account",
      expect.objectContaining({ type: "click" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().endReason).toBeNull();
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it("says a refused start needs credits, offers Get credits, and is not an ending", async () => {
    useVoiceSessionStore.getState().sessionRefused("credits");
    render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

    expect(
      screen.getByTestId("voice-session-strip").getAttribute("data-state"),
    ).toBe("refused");
    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice needs credits.",
    );
    expect(useVoiceSessionStore.getState().endReason).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Get credits" }));
    expect(links.openLink).toHaveBeenCalledTimes(1);
    expect(links.openLink).toHaveBeenCalledWith(
      "https://platform.test/billing",
      "account",
      expect.objectContaining({ type: "click" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().refusal).toBeNull();
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it("offers no Get credits when the start failed for another reason", () => {
    useVoiceSessionStore.getState().sessionRefused("unavailable");
    render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice did not start. Try again in a moment.",
    );
    expect(screen.queryByTestId("voice-strip-get-credits")).toBeNull();
  });

  it("says the sound could not be played when the end was a playback failure", () => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "playback" });
    render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended: the sound could not be played.",
    );
  });

  it("says the account changed when the end was a switch of accounts, offers Dismiss, and does not offer Get credits", async () => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "account" });
    render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

    expect(screen.getByTestId("voice-strip-state").textContent).toBe(
      "Voice ended when you switched accounts.",
    );
    expect(screen.queryByTestId("voice-strip-get-credits")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().endReason).toBeNull();
  });
  describe("Not what I meant", () => {
    it("is not offered while no page action has run", () => {
      goLive(makeDriver());

      expect(
        screen.queryByRole("button", { name: "Not what I meant" }),
      ).toBeNull();
    });

    it("files the act that ran as not meant, and goes", async () => {
      goLive(makeDriver());
      act(() => {
        useVoiceSessionStore.getState().setExecutedAct(EXECUTED_ACT);
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Not what I meant" }),
      );

      const filed = filedMisses(captureMessage.mock.calls);
      expect(filed).toHaveLength(1);
      expect(filed[0]?.message).toMatch(
        /^voice\.route\.miss task not-meant #\d+$/,
      );
      expect(filed[0]?.options.tags).toMatchObject({
        viewKind: "task",
        missKind: "not-meant",
        routerAction: "act",
      });
      expect(filed[0]?.options.tags.spanDropped).toBe("act");
      expect(filed[0]?.options.extra).toEqual({
        rows: EXECUTED_ACT.rowIds,
        route: {
          action: "act",
          target: EXECUTED_ACT.route.target,
          uncertain: false,
          choice: null,
          control: null,
        },
        span: null,
        spanWords: 2,
      });
      expect(useVoiceSessionStore.getState().executedAct).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Not what I meant" }),
      ).toBeNull();
    });

    it("files a tell that ran with none of the words said, only how many", async () => {
      goLive(makeDriver());
      act(() => {
        useVoiceSessionStore.getState().setExecutedAct(EXECUTED_TELL);
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Not what I meant" }),
      );

      const filed = filedMisses(captureMessage.mock.calls);
      expect(filed).toHaveLength(1);
      expect(filed[0]?.options.tags.spanDropped).toBe("tell");
      expect(filed[0]?.options.extra).toMatchObject({
        span: null,
        spanWords: 10,
      });
      const events = scrubbedMisses(captureMessage.mock.calls).join("\n");
      for (const word of [
        "Please",
        "remind",
        "ada.lovelace@example.com",
        "password",
        "tangerine-oyster-42",
      ]) {
        expect(events).not.toContain(word);
      }
    });
  });
});
