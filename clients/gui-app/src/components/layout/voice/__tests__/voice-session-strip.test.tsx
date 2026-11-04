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
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import {
  useVoiceSessionStore,
  type CallFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionStrip } from "../voice-session-strip";

const FOCUS: CallFocus = {
  botId: "bot-1",
  hostId: "host-a",
  threadId: null,
};

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
  links.openLink.mockReset();
  links.openLink.mockResolvedValue(undefined);
});

afterEach(cleanup);

function goLive(driver: FakeDriver) {
  useVoiceSessionStore.setState({
    phase: "live",
    focus: FOCUS,
    callTitle: "Tracy",
    driver,
  });
  render(<VoiceSessionStrip />);
  return driver;
}

describe("VoiceSessionStrip", () => {
  it("renders nothing when idle with no end reason", () => {
    render(<VoiceSessionStrip />);
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it("says Listening and the bot's name, with the state word alone as the live region", () => {
    goLive(makeDriver());

    // The state word alone is announced; the controls and the captions
    // sit in the plain region around it.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Listening");
    expect(screen.getByRole("region", { name: "Call" }).contains(status)).toBe(
      true,
    );
    expect(status.contains(screen.getByRole("button", { name: "Mute" }))).toBe(
      false,
    );
    expect(screen.getByTestId("voice-strip-bot").textContent).toBe("Tracy");
  });

  it("says Calling the bot while connecting, with Mute unavailable and End ready", async () => {
    const driver = makeDriver();
    useVoiceSessionStore.setState({
      phase: "connecting",
      focus: FOCUS,
      callTitle: "Tracy",
      driver,
    });
    render(<VoiceSessionStrip />);

    expect(screen.getByRole("status").textContent).toBe("Calling Tracy…");
    expect(screen.getByRole("button", { name: "Mute" })).toHaveProperty(
      "disabled",
      true,
    );

    await userEvent.click(screen.getByRole("button", { name: "End" }));
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("says Ending while the call winds down and takes no second End", () => {
    useVoiceSessionStore.setState({
      phase: "ending",
      focus: FOCUS,
      callTitle: "Tracy",
      driver: makeDriver(),
    });
    render(<VoiceSessionStrip />);

    expect(screen.getByRole("status").textContent).toBe("Ending…");
    expect(screen.getByRole("button", { name: "End" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("mutes through the driver, then reads Muted and Unmute, which unmutes through the driver", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(driver.setMuted).toHaveBeenCalledWith(true);

    act(() => useVoiceSessionStore.setState({ muted: true }));
    expect(screen.getByTestId("voice-strip-state").textContent).toBe("Muted");
    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(unmute);
    expect(driver.setMuted).toHaveBeenLastCalledWith(false);
  });

  it("reads Call paused for dictation with Resume, which waits for dictation to end and is never automatic", async () => {
    goLive(makeDriver());
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(screen.getByRole("status").textContent).toBe(
      "Call paused for dictation",
    );
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveProperty("disabled", true);

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    expect(screen.getByRole("status").textContent).toBe(
      "Call paused for dictation",
    );
    expect(resume).toHaveProperty("disabled", false);

    await userEvent.click(resume);
    expect(screen.getByRole("status").textContent).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("ends the call through the driver", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "End" }));

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("draws no captions until they are turned on, then names each speaker, the bot by its title", async () => {
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

  it.each([
    {
      state: "connecting",
      setup: () => useVoiceSessionStore.setState({ phase: "connecting" }),
    },
    {
      state: "listening",
      setup: () => useVoiceSessionStore.setState({ phase: "live" }),
    },
    {
      state: "muted",
      setup: () =>
        useVoiceSessionStore.setState({ phase: "live", muted: true }),
    },
    {
      state: "paused for dictation",
      setup: () => {
        useVoiceSessionStore.setState({ phase: "live" });
        useVoiceSessionStore.getState().acquireDictationHold("composer");
      },
    },
    {
      state: "captions open",
      setup: () => {
        useVoiceSessionStore.setState({ phase: "live" });
        useVoiceSessionStore.getState().setCaptions(true);
      },
    },
  ])(
    "keeps Mute, Captions and End on the strip while a call is $state",
    ({ setup }) => {
      useVoiceSessionStore.setState({
        focus: FOCUS,
        callTitle: "A bot with a rather long name to take away",
        driver: makeDriver(),
      });
      setup();
      render(<VoiceSessionStrip />);

      const strip = screen.getByRole("region", { name: "Call" });
      for (const name of [/^(Mute|Unmute)$/, "Captions", "End"]) {
        expect(
          screen
            .getAllByRole("button", { name })
            .some((b) => strip.contains(b)),
        ).toBe(true);
      }
    },
  );

  describe("the line about a call that did not run", () => {
    it("says why a call ended with the bot's title and clears the line on dismiss", async () => {
      useVoiceSessionStore.setState({
        phase: "idle",
        endReason: "credits",
        callTitle: "Tracy",
      });
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      const line = screen.getByTestId("voice-session-strip");
      expect(line.getAttribute("data-state")).toBe("ended");
      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Call ended: out of credits.",
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

    it("names the bot that cannot be reached", () => {
      useVoiceSessionStore.setState({
        phase: "idle",
        endReason: "unreachable",
        callTitle: "Tracy",
      });
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Call ended: Tracy can't be reached right now.",
      );
      expect(screen.queryByTestId("voice-strip-get-credits")).toBeNull();
    });

    it("says a refused start needs credits, offers Get credits, and is not an ending", async () => {
      useVoiceSessionStore.getState().sessionRefused("credits", null);
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(
        screen.getByTestId("voice-session-strip").getAttribute("data-state"),
      ).toBe("refused");
      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Calls need credits.",
      );
      expect(useVoiceSessionStore.getState().endReason).toBeNull();

      await userEvent.click(
        screen.getByRole("button", { name: "Get credits" }),
      );
      expect(links.openLink).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      expect(useVoiceSessionStore.getState().refusal).toBeNull();
      expect(screen.queryByTestId("voice-session-strip")).toBeNull();
    });

    it("shows the paused bot's own line for a paused refusal", async () => {
      useVoiceSessionStore
        .getState()
        .sessionRefused("paused", "Tracy is paused until Friday.");
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Tracy is paused until Friday.",
      );

      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(useVoiceSessionStore.getState().pausedCopy).toBeNull();
      expect(screen.queryByTestId("voice-session-strip")).toBeNull();
    });

    it("offers no Get credits when the start failed for another reason", () => {
      useVoiceSessionStore.getState().sessionRefused("unavailable", null);
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Call did not start. Try again in a moment.",
      );
      expect(screen.queryByTestId("voice-strip-get-credits")).toBeNull();
    });

    it("says the sound could not be played when the end was a playback failure", () => {
      useVoiceSessionStore.setState({ phase: "idle", endReason: "playback" });
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Call ended: the sound could not be played.",
      );
    });

    it("says the account changed when the end was a switch of accounts, and offers no Get credits", async () => {
      useVoiceSessionStore.setState({ phase: "idle", endReason: "account" });
      render(<VoiceSessionStrip />, { wrapper: WithTestQueryClient });

      expect(screen.getByTestId("voice-strip-state").textContent).toBe(
        "Call ended when you switched accounts.",
      );
      expect(screen.queryByTestId("voice-strip-get-credits")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      expect(useVoiceSessionStore.getState().endReason).toBeNull();
    });
  });
});
