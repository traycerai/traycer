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
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import type { DirectoryBot } from "@/lib/voice/directory";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionChrome } from "../voice-session-chrome";

const BOT_ID = "bot-1";
const FOCUS: CallFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
};

const DIRECTORY: ReadonlyArray<DirectoryBot> = [
  {
    botId: "bot-1",
    title: "Tracy",
    environmentId: "env-1",
    environmentLabel: "Personal",
  },
  {
    botId: "bot-2",
    title: "Scout",
    environmentId: "env-2",
    environmentLabel: "Acme",
  },
];

// The dial's list is the directory's own subject; here it is the list the
// dial draws.
const directory = vi.hoisted(() => ({
  bots: [] as ReadonlyArray<DirectoryBot>,
}));
vi.mock("@/hooks/voice/use-voice-directory", () => ({
  useVoiceDirectory: () => directory.bots,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
const runnerHost = vi.hoisted(() => ({
  openMicrophoneSettings: vi.fn(),
  signInUrl: "https://platform.test/sign-in",
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => runnerHost,
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

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

/** The outcome line reaches TanStack Query, so the chrome mounts under a client. */
function renderChrome() {
  return render(<VoiceSessionChrome />, { wrapper: WithTestQueryClient });
}

/** A call that has gone live with Tracy, its view up. */
function markLive(driver: FakeDriver): FakeDriver {
  act(() => {
    useVoiceSessionStore.getState().sessionConnecting(FOCUS, "Tracy");
    useVoiceSessionStore.setState({ phase: "live", driver });
  });
  return driver;
}

function goLive(driver: FakeDriver): FakeDriver {
  markLive(driver);
  renderChrome();
  return driver;
}

/** The phone's dial up for Tracy, a thread of hers continued. */
function goDial(driver: FakeDriver): FakeDriver {
  act(() => {
    useVoiceSessionStore.setState({ driver, availability: "live" });
    useVoiceSessionStore
      .getState()
      .openDial({ botId: BOT_ID, threadId: "thread-1" }, "Tracy");
  });
  renderChrome();
  return driver;
}

function talkState(): string | null {
  return screen.getByTestId("voice-phone-talk-state").textContent;
}

function viewState(): string | null {
  return screen.getByTestId("voice-phone-view").getAttribute("data-view");
}

// jsdom has no pointer capture; the talk button takes it on press.
const pointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "setPointerCapture",
);

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  directory.bots = DIRECTORY;
  runnerHost.openMicrophoneSettings.mockReset();
  runnerHost.openMicrophoneSettings.mockResolvedValue(undefined);
  setPhoneLayoutOnly(true);
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useTracySurfaceStore.getState().openSurface("host-a");
  useTracySurfaceStore.getState().selectChannel(BOT_ID);
});

afterEach(() => {
  cleanup();
  toast.dismiss();
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
});

describe("the phone call view, dialling", () => {
  it("lists the directory's bots with the bot whose message box was tapped selected", () => {
    goDial(makeDriver());

    expect(viewState()).toBe("dial");
    const bots = screen.getAllByRole("radio");
    expect(bots.map((bot) => bot.closest("label")?.textContent)).toEqual([
      "TracyPersonal",
      "ScoutAcme",
    ]);
    expect(bots.map((bot) => bot.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
  });

  it("calls the preselected bot into the thread the dial came from", async () => {
    const driver = goDial(makeDriver());

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.start).toHaveBeenCalledWith({
      botId: BOT_ID,
      threadId: "thread-1",
    });
  });

  it("calls another bot into a new thread", async () => {
    const driver = goDial(makeDriver());

    await userEvent.click(screen.getByRole("radio", { name: /Scout/ }));
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.start).toHaveBeenCalledWith({
      botId: "bot-2",
      threadId: null,
    });
  });

  it("lists the preselected bot alone while the directory is not read yet", async () => {
    directory.bots = [];
    const driver = goDial(makeDriver());

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));
    expect(driver.start).toHaveBeenCalledWith({
      botId: BOT_ID,
      threadId: "thread-1",
    });
  });

  it("places nothing until Call is pressed, and Close lowers the dial and the view", async () => {
    const driver = goDial(makeDriver());
    expect(driver.start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState()).toMatchObject({
      dial: null,
      phoneViewOpen: false,
    });
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("lowers the dial on the back gesture", async () => {
    goDial(makeDriver());

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState().dial).toBeNull();
  });

  it("gives way to the call once it is placed", () => {
    goDial(makeDriver());
    expect(viewState()).toBe("dial");

    act(() =>
      useVoiceSessionStore.getState().sessionConnecting(FOCUS, "Tracy"),
    );

    expect(viewState()).toBe("call");
    expect(screen.queryByTestId("call-dial")).toBeNull();
  });
});

describe("the phone call view, on a call", () => {
  it("names the bot, opens on the open microphone, and a tap on the talk button mutes it", async () => {
    const driver = goLive(makeDriver());

    expect(viewState()).toBe("call");
    expect(screen.getByTestId("voice-phone-bot").textContent).toBe("Tracy");
    expect(talkState()).toBe("Listening · tap to mute");
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));

    expect(driver.setMuted).toHaveBeenCalledTimes(1);
    expect(driver.setMuted).toHaveBeenCalledWith(true);
  });

  it("says Calling the bot while connecting, with the talk button unavailable", () => {
    useVoiceSessionStore.getState().sessionConnecting(FOCUS, "Tracy");
    useVoiceSessionStore.setState({ driver: makeDriver() });
    renderChrome();

    expect(talkState()).toBe("Calling Tracy…");
    expect(screen.getByTestId("voice-phone-talk")).toHaveProperty(
      "disabled",
      true,
    );
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

  it("draws no captions until they are turned on, then the empty line, then each speaker's words by name", async () => {
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

  it("ends the call from the cross", async () => {
    const driver = goLive(makeDriver());

    await userEvent.click(screen.getByTestId("voice-phone-end"));

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("puts the view down on the bot's name, keeps the call in the bar, and the bar brings the view back or ends the call", async () => {
    const driver = goLive(makeDriver());
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();

    await userEvent.click(screen.getByTestId("voice-phone-bot"));

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(screen.getByTestId("voice-phone-bar-state").textContent).toBe(
      "Listening · tap to mute",
    );
    expect(screen.getByTestId("voice-phone-bar").textContent).toContain(
      "Tracy",
    );

    await userEvent.click(screen.getByTestId("voice-phone-bar-open"));
    await screen.findByTestId("voice-phone-view");
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();

    await userEvent.click(screen.getByTestId("voice-phone-bot"));
    await screen.findByTestId("voice-phone-bar");
    await userEvent.click(screen.getByTestId("voice-phone-bar-end"));
    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("lets go of a held talk button when Escape puts the view down, with the call still live", async () => {
    goLive(makeDriver());
    await userEvent.click(screen.getByRole("button", { name: "Push to talk" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Hold to talk" }),
      { pointerId: 1 },
    );
    expect(useVoiceSessionStore.getState().talkHeld).toBe(true);

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState()).toMatchObject({
      phoneViewOpen: false,
      talkHeld: false,
      phase: "live",
    });
  });

  it("lets go of a held talk button when the view unmounts under the finger", async () => {
    goLive(makeDriver());
    await userEvent.click(screen.getByRole("button", { name: "Push to talk" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Hold to talk" }),
      { pointerId: 1 },
    );
    expect(useVoiceSessionStore.getState().talkHeld).toBe(true);

    cleanup();

    expect(useVoiceSessionStore.getState().talkHeld).toBe(false);
  });

  it("reads Call paused for dictation, with Resume and the talk button unavailable", () => {
    goLive(makeDriver());
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));

    expect(talkState()).toBe("Call paused for dictation");
    expect(screen.getByTestId("voice-phone-talk")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });
});

describe("the phone call view, after the call", () => {
  it("keeps the view up with how the call ended, naming the bot, until it is dismissed", async () => {
    goLive(makeDriver());
    act(() => useVoiceSessionStore.getState().sessionEnded("unreachable"));

    expect(viewState()).toBe("ended");
    expect(
      within(screen.getByTestId("voice-phone-ended")).getByTestId(
        "voice-outcome-line",
      ).textContent,
    ).toBe("Call ended: Tracy can't be reached right now.");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState()).toMatchObject({
      endReason: null,
      phoneViewOpen: false,
    });
  });

  it("puts the line away on the back gesture", async () => {
    goLive(makeDriver());
    act(() => useVoiceSessionStore.getState().sessionEnded("ended"));

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("voice-phone-view")).toBeNull(),
    );
    expect(useVoiceSessionStore.getState().endReason).toBeNull();
  });

  it("says in the bar that a call ended in the background when the view was down", async () => {
    goLive(makeDriver());
    await userEvent.click(screen.getByTestId("voice-phone-bot"));
    await screen.findByTestId("voice-phone-bar");

    act(() => useVoiceSessionStore.getState().sessionEnded("background"));

    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
    expect(screen.getByTestId("voice-outcome-line").textContent).toBe(
      "Call ended when you left the app.",
    );
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("shows a paused bot's own line for a refused dial", () => {
    goDial(makeDriver());
    act(() =>
      useVoiceSessionStore
        .getState()
        .sessionRefused("paused", "Tracy is paused until Friday."),
    );

    expect(viewState()).toBe("ended");
    expect(screen.getByTestId("voice-outcome-line").textContent).toBe(
      "Tracy is paused until Friday.",
    );
  });

  it("sends a refused microphone to the OS settings page", async () => {
    goDial(makeDriver());
    act(() =>
      useVoiceSessionStore.getState().sessionRefused("microphone-denied", null),
    );

    expect(screen.getByTestId("voice-outcome-line").textContent).toBe(
      "Calls need the microphone. Allow it in Settings.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Settings" }),
    );

    expect(runnerHost.openMicrophoneSettings).toHaveBeenCalledTimes(1);
  });

  it("tells the person when the settings page could not be opened", async () => {
    runnerHost.openMicrophoneSettings.mockRejectedValue(
      new Error("no settings app"),
    );
    goDial(makeDriver());
    act(() =>
      useVoiceSessionStore.getState().sessionRefused("microphone-denied", null),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Open Settings" }),
    );

    await waitFor(() =>
      expect(toast.getToasts().find((entry) => "title" in entry)).toMatchObject(
        {
          title: "Couldn't open the microphone settings",
          description: "no settings app",
        },
      ),
    );
    expect(
      screen.getByRole("button", { name: "Open Settings" }),
    ).toHaveProperty("disabled", false);
  });

  it("disables Open Settings while the settings page is opening", async () => {
    let finish: () => void = () => undefined;
    runnerHost.openMicrophoneSettings.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    goDial(makeDriver());
    act(() =>
      useVoiceSessionStore.getState().sessionRefused("microphone-denied", null),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Open Settings" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Settings" }),
      ).toHaveProperty("disabled", true),
    );

    act(() => finish());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Settings" }),
      ).toHaveProperty("disabled", false),
    );
    expect(runnerHost.openMicrophoneSettings).toHaveBeenCalledTimes(1);
  });
});

describe("the desktop layout", () => {
  it("leaves push-to-talk with the microphone closed when the layout widens to the desktop one", async () => {
    markLive(makeDriver());
    const { rerender } = renderChrome();
    await userEvent.click(screen.getByRole("button", { name: "Push to talk" }));

    setPhoneLayoutOnly(false);
    rerender(<VoiceSessionChrome />);

    expect(useVoiceSessionStore.getState()).toMatchObject({
      pushToTalk: false,
      talkHeld: false,
      muted: true,
    });
    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
  });

  it("never mutes an open-microphone call when the layout widens", () => {
    markLive(makeDriver());
    const { rerender } = renderChrome();

    setPhoneLayoutOnly(false);
    rerender(<VoiceSessionChrome />);

    expect(useVoiceSessionStore.getState().muted).toBe(false);
  });

  it("draws no phone view and no bar on the desktop layout, where the call is in its message box", () => {
    setPhoneLayoutOnly(false);
    markLive(makeDriver());
    renderChrome();

    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();
  });
});
