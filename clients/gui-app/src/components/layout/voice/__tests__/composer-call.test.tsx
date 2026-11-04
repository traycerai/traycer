/**
 * Call Tracy from a bot's message box, through the REAL `BotMessageComposer`:
 * the send mutation and the tab's host client are the only stand-ins. The
 * driver is the controller's seam; its `start` takes the store transition the
 * controller takes (`sessionConnecting`), so a click reaches the bar the way a
 * call placed from the box does. What the controller then sends for a target is
 * `call-controller.test.tsx`'s subject.
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { KeyboardOwnerContext } from "@/hooks/use-primary-action-shortcut";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  useVoiceSessionStore,
  type CallTarget,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";

const BOT_ID = "bot-1";
const OTHER_BOT_ID = "bot-2";
const HOST_ID = "host-a";
const CHANNEL_TARGET: CallTarget = { botId: BOT_ID, threadId: null };
const THREAD_TARGET: CallTarget = { botId: BOT_ID, threadId: "thread-1" };

const CHORD = { code: "KeyM", ctrlKey: true, shiftKey: true } as const;

interface BoxKind {
  readonly threadId: string | null;
  readonly announcementId: string | null;
  readonly testId: string;
  readonly label: string;
}

const CHANNEL_BOX: BoxKind = {
  threadId: null,
  announcementId: null,
  testId: "bot-channel-composer",
  label: "Message Tracy",
};
const THREAD_BOX: BoxKind = {
  threadId: "thread-1",
  announcementId: null,
  testId: "bot-thread-composer",
  label: "Reply in the thread",
};
const ANNOUNCEMENT_BOX: BoxKind = {
  threadId: null,
  announcementId: "announcement-1",
  testId: "bot-thread-composer",
  label: "Reply to the announcement",
};

const mocks = vi.hoisted(() => ({
  runnerHost: {
    openMicrophoneSettings: vi.fn(),
    signInUrl: "https://platform.test/sign-in",
  },
  openLink:
    vi.fn<(url: string, kind: string, event: unknown) => Promise<void>>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutateAsync: () => Promise.reject(new Error("no send in this suite")),
    isPending: false,
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => mocks.runnerHost,
}));
// The OS handoff is the external boundary; the billing URL is the real one.
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

const FAILURE: BotSendFailure = {
  failed: false,
  fail: () => undefined,
  clear: () => undefined,
};

interface FakeDriver {
  start: Mock<VoiceSessionDriver["start"]>;
  end: Mock<VoiceSessionDriver["end"]>;
  setMuted: Mock<VoiceSessionDriver["setMuted"]>;
}

function makeDriver(): FakeDriver {
  return {
    start: vi.fn<VoiceSessionDriver["start"]>((target) => {
      useVoiceSessionStore
        .getState()
        .sessionConnecting(
          { botId: target.botId, hostId: HOST_ID, threadId: target.threadId },
          "Tracy",
        );
    }),
    end: vi.fn<VoiceSessionDriver["end"]>(),
    setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
  };
}

/** Voice offered, and the call owner mounted. */
function offer(driver: FakeDriver): FakeDriver {
  act(() => {
    useVoiceSessionStore.setState({ availability: "live", driver });
  });
  return driver;
}

/** A call placed from `target`, as the controller's `start` begins one. */
function placeCall(
  target: CallTarget,
  botTitle: string,
  phase: "connecting" | "live" | "ending",
): void {
  act(() => {
    useVoiceSessionStore
      .getState()
      .sessionConnecting(
        { botId: target.botId, hostId: HOST_ID, threadId: target.threadId },
        botTitle,
      );
    useVoiceSessionStore.setState({ phase });
  });
}

function box(kind: BoxKind): ReactNode {
  return (
    <BotMessageComposer
      key={kind.testId}
      botId={BOT_ID}
      botTitle="Tracy"
      conversationId="conversation-channel"
      threadId={kind.threadId}
      announcementId={kind.announcementId}
      sendable
      placeholder="Message"
      label={kind.label}
      testId={kind.testId}
      failure={FAILURE}
      edit={null}
      onEditEnd={() => undefined}
      seed={null}
      keptDraft={null}
      quote={null}
      onSent={() => false}
    />
  );
}

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <WithTestQueryClient>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </WithTestQueryClient>
  );
}

function mount(...kinds: ReadonlyArray<BoxKind>) {
  return render(<>{kinds.map(box)}</>, { wrapper: Providers });
}

function callButton(kind: BoxKind): HTMLElement {
  return screen.getByTestId(`${kind.testId}-call`);
}

function bar(kind: BoxKind): HTMLElement {
  return screen.getByTestId(`${kind.testId}-call-bar`);
}

function barOf(kind: BoxKind): HTMLElement | null {
  return screen.queryByTestId(`${kind.testId}-call-bar`);
}

function field(kind: BoxKind): HTMLTextAreaElement {
  const element = screen.getByRole("textbox", { name: kind.label });
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("no field");
  return element;
}

function stateWord(kind: BoxKind): string | null {
  return screen.getByTestId(`${kind.testId}-call-state`).textContent;
}

function tap(): void {
  fireEvent.keyDown(window, CHORD);
  fireEvent.keyUp(window, CHORD);
}

beforeEach(() => {
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  mocks.runnerHost.openMicrophoneSettings.mockReset();
  mocks.openLink.mockReset();
  mocks.openLink.mockResolvedValue(undefined);
  setPhoneLayoutOnly(false);
});

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
});

describe("Call in the message box", () => {
  it("sits before Send in the box's actions, named for the bot", () => {
    offer(makeDriver());
    mount(CHANNEL_BOX);

    const call = callButton(CHANNEL_BOX);
    const send = screen.getByTestId(`${CHANNEL_BOX.testId}-send`);
    expect(call.getAttribute("aria-label")).toBe("Call Tracy");
    expect(call.parentElement).toBe(send.parentElement);
    expect(
      call.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId(CHANNEL_BOX.testId).contains(call)).toBe(true);
  });

  it("is on a thread's box as well as the channel's", () => {
    offer(makeDriver());
    mount(CHANNEL_BOX, THREAD_BOX);

    expect(callButton(CHANNEL_BOX)).toBeTruthy();
    expect(callButton(THREAD_BOX)).toBeTruthy();
  });

  it("says what it costs on a tooltip", async () => {
    offer(makeDriver());
    mount(CHANNEL_BOX);

    act(() => callButton(CHANNEL_BOX).focus());

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Call Tracy. Costs credits while on.",
    );
  });

  it.each([
    {
      why: "the server has not said whether voice is offered",
      state: { availability: "unknown" as const },
    },
    {
      why: "the server offers no voice",
      state: { availability: "dormant" as const },
    },
    {
      why: "no call owner is mounted",
      state: { availability: "live" as const, driver: null },
    },
  ])("is not drawn when $why, and Send still is", ({ state }) => {
    useVoiceSessionStore.setState({ driver: makeDriver(), ...state });
    mount(CHANNEL_BOX);

    expect(screen.queryByTestId(`${CHANNEL_BOX.testId}-call`)).toBeNull();
    expect(screen.getByTestId(`${CHANNEL_BOX.testId}-send`)).toBeTruthy();
  });

  it("is not drawn on a box replying under an announcement, which has no thread to call into", () => {
    offer(makeDriver());
    mount(ANNOUNCEMENT_BOX);

    expect(screen.queryByTestId(`${ANNOUNCEMENT_BOX.testId}-call`)).toBeNull();
    expect(screen.getByTestId(`${ANNOUNCEMENT_BOX.testId}-send`)).toBeTruthy();
  });
});

describe("placing a call from the box on the desktop", () => {
  it("calls the thread the box is in, placing it at once", async () => {
    const driver = offer(makeDriver());
    mount(THREAD_BOX);

    await userEvent.click(callButton(THREAD_BOX));

    expect(driver.start.mock.calls).toEqual([[THREAD_TARGET]]);
    expect(useVoiceSessionStore.getState().dial).toBeNull();
  });

  it("calls the channel, which opens a new thread with the first thing said", async () => {
    const driver = offer(makeDriver());
    mount(CHANNEL_BOX);

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(driver.start.mock.calls).toEqual([[CHANNEL_TARGET]]);
  });

  it("ends a call running with another bot first, then places the new one", async () => {
    const driver = offer(makeDriver());
    placeCall({ botId: OTHER_BOT_ID, threadId: null }, "Scout", "live");
    mount(CHANNEL_BOX);

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(driver.start.mock.calls).toEqual([[CHANNEL_TARGET]]);
    expect(driver.end.mock.invocationCallOrder[0]).toBeLessThan(
      driver.start.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("takes no press while another bot's call is ending", () => {
    offer(makeDriver());
    placeCall({ botId: OTHER_BOT_ID, threadId: null }, "Scout", "ending");
    mount(CHANNEL_BOX);

    expect(callButton(CHANNEL_BOX)).toHaveProperty("disabled", true);
  });
});

describe("the call bar", () => {
  it("replaces the field and its actions once Call places the call, and the draft is back when the line is dismissed", async () => {
    const driver = offer(makeDriver());
    mount(CHANNEL_BOX);
    await userEvent.type(field(CHANNEL_BOX), "Is CI green?");

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(bar(CHANNEL_BOX).getAttribute("data-state")).toBe("connecting");
    expect(
      screen.queryByRole("textbox", { name: CHANNEL_BOX.label }),
    ).toBeNull();
    expect(screen.queryByTestId(`${CHANNEL_BOX.testId}-send`)).toBeNull();
    expect(screen.queryByTestId(`${CHANNEL_BOX.testId}-call`)).toBeNull();

    act(() => useVoiceSessionStore.getState().sessionEnded("ended"));
    expect(
      screen.queryByRole("textbox", { name: CHANNEL_BOX.label }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(field(CHANNEL_BOX).value).toBe("Is CI green?");
    expect(screen.getByTestId(`${CHANNEL_BOX.testId}-send`)).toBeTruthy();
    expect(barOf(CHANNEL_BOX)).toBeNull();
    expect(driver.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      state: "connecting",
      word: "Calling…",
      setup: () => placeCall(CHANNEL_TARGET, "Tracy", "connecting"),
    },
    {
      state: "live",
      word: "Listening",
      setup: () => placeCall(CHANNEL_TARGET, "Tracy", "live"),
    },
    {
      state: "muted",
      word: "Muted",
      setup: () => {
        placeCall(CHANNEL_TARGET, "Tracy", "live");
        act(() => useVoiceSessionStore.setState({ muted: true }));
      },
    },
    {
      state: "ending",
      word: "Ending…",
      setup: () => placeCall(CHANNEL_TARGET, "Tracy", "ending"),
    },
  ])(
    "says $word while the call is $state, with the bot's name",
    ({ setup, word }) => {
      offer(makeDriver());
      setup();
      mount(CHANNEL_BOX);

      expect(stateWord(CHANNEL_BOX)).toBe(word);
      expect(bar(CHANNEL_BOX).textContent).toContain("Tracy");
      // The state word alone is the live region; the controls sit around it.
      expect(screen.getByRole("status").textContent).toBe(word);
    },
  );

  it("keeps Mute unavailable and End ready while connecting, and takes no second End once ending", async () => {
    const driver = offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "connecting");
    mount(CHANNEL_BOX);
    expect(
      screen.getByTestId(`${CHANNEL_BOX.testId}-call-mute`),
    ).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByTestId(`${CHANNEL_BOX.testId}-call-end`));
    expect(driver.end).toHaveBeenCalledTimes(1);

    act(() => useVoiceSessionStore.setState({ phase: "ending" }));
    expect(screen.getByTestId(`${CHANNEL_BOX.testId}-call-end`)).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("ends the call through the driver", async () => {
    const driver = offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX);

    await userEvent.click(screen.getByTestId(`${CHANNEL_BOX.testId}-call-end`));

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("mutes through the driver, then reads Muted and Unmute, which unmutes through the driver", async () => {
    const driver = offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX);

    await userEvent.click(
      screen.getByTestId(`${CHANNEL_BOX.testId}-call-mute`),
    );
    expect(driver.setMuted).toHaveBeenCalledWith(true);

    act(() => useVoiceSessionStore.setState({ muted: true }));
    expect(stateWord(CHANNEL_BOX)).toBe("Muted");
    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(unmute);
    expect(driver.setMuted).toHaveBeenLastCalledWith(false);
  });

  it("reads Call paused for dictation with Resume, which waits for dictation to end and is never automatic", async () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX);
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(stateWord(CHANNEL_BOX)).toBe("Call paused for dictation");
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveProperty("disabled", true);

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    expect(stateWord(CHANNEL_BOX)).toBe("Call paused for dictation");
    expect(resume).toHaveProperty("disabled", false);

    await userEvent.click(resume);
    expect(stateWord(CHANNEL_BOX)).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});

describe("the call's captions", () => {
  it("draw nothing until turned on, then the empty line, then each speaker's words by name above the box", async () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX);
    act(() =>
      useVoiceSessionStore
        .getState()
        .pushCaptionLine({ direction: "input", text: "never kept" }),
    );
    expect(
      screen.queryByTestId(`${CHANNEL_BOX.testId}-call-captions-lines`),
    ).toBeNull();

    await userEvent.click(
      screen.getByTestId(`${CHANNEL_BOX.testId}-call-captions`),
    );
    expect(useVoiceSessionStore.getState().captions).toBe(true);
    const lines = screen.getByTestId(
      `${CHANNEL_BOX.testId}-call-captions-lines`,
    );
    expect(lines.textContent).toBe("Nothing said yet.");

    act(() => {
      const store = useVoiceSessionStore.getState();
      store.pushCaptionLine({ direction: "input", text: "hello" });
      store.pushCaptionLine({ direction: "output", text: "hi there" });
    });
    expect(lines.textContent).toContain("You: hello");
    expect(lines.textContent).toContain("Tracy: hi there");
    expect(lines.textContent).not.toContain("never kept");
    // Above the box, outside the live region and the bar.
    expect(screen.getByTestId(CHANNEL_BOX.testId).firstElementChild).toBe(
      lines,
    );
    expect(bar(CHANNEL_BOX).contains(lines)).toBe(false);
    expect(screen.getByRole("status").contains(lines)).toBe(false);
  });

  it("go with the call: none once it has ended, though they stay turned on", () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    act(() => useVoiceSessionStore.getState().setCaptions(true));
    mount(CHANNEL_BOX);
    expect(
      screen.getByTestId(`${CHANNEL_BOX.testId}-call-captions-lines`),
    ).toBeTruthy();

    act(() => useVoiceSessionStore.getState().sessionEnded("ended"));

    expect(
      screen.queryByTestId(`${CHANNEL_BOX.testId}-call-captions-lines`),
    ).toBeNull();
  });
});

describe("which box holds the bar", () => {
  it("is the channel's alone for a call placed from the channel, and stays there once the first thing said opens a thread", () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX, THREAD_BOX);

    expect(bar(CHANNEL_BOX)).toBeTruthy();
    expect(barOf(THREAD_BOX)).toBeNull();
    expect(field(THREAD_BOX)).toBeTruthy();
    expect(callButton(THREAD_BOX)).toBeTruthy();

    act(() => useVoiceSessionStore.getState().bindThread("thread-1"));

    expect(bar(CHANNEL_BOX)).toBeTruthy();
    expect(barOf(THREAD_BOX)).toBeNull();
  });

  it("is the thread's alone for a call placed from the thread", () => {
    offer(makeDriver());
    placeCall(THREAD_TARGET, "Tracy", "live");
    mount(CHANNEL_BOX, THREAD_BOX);

    expect(bar(THREAD_BOX)).toBeTruthy();
    expect(barOf(CHANNEL_BOX)).toBeNull();
    expect(field(CHANNEL_BOX)).toBeTruthy();
    expect(callButton(CHANNEL_BOX)).toBeTruthy();
  });

  it("is no box of a bot the call is not with", () => {
    offer(makeDriver());
    placeCall({ botId: OTHER_BOT_ID, threadId: null }, "Scout", "live");
    mount(CHANNEL_BOX, THREAD_BOX);

    expect(barOf(CHANNEL_BOX)).toBeNull();
    expect(barOf(THREAD_BOX)).toBeNull();
  });

  it("is not an announcement's reply box, which cannot place a call", () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(ANNOUNCEMENT_BOX);

    expect(barOf(ANNOUNCEMENT_BOX)).toBeNull();
    expect(field(ANNOUNCEMENT_BOX)).toBeTruthy();
  });
});

describe("the line about a call that did not run", () => {
  function placeThenFinish(finish: () => void): FakeDriver {
    const driver = offer(makeDriver());
    placeCall(THREAD_TARGET, "Tracy", "live");
    act(finish);
    return driver;
  }

  it("shows in the box the call was placed from until dismissed, then gives the field back", async () => {
    placeThenFinish(() =>
      useVoiceSessionStore.getState().sessionEnded("credits"),
    );
    mount(CHANNEL_BOX, THREAD_BOX);

    const line = within(screen.getByTestId(THREAD_BOX.testId));
    expect(line.getByTestId("voice-outcome").getAttribute("data-state")).toBe(
      "ended",
    );
    expect(line.getByTestId("voice-outcome-line").textContent).toBe(
      "Call ended: out of credits.",
    );
    expect(screen.getAllByTestId("voice-outcome")).toHaveLength(1);
    expect(
      screen.queryByRole("textbox", { name: THREAD_BOX.label }),
    ).toBeNull();
    expect(field(CHANNEL_BOX)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().endReason).toBeNull();
    expect(screen.queryByTestId("voice-outcome")).toBeNull();
    expect(field(THREAD_BOX)).toBeTruthy();
  });

  it("offers Get credits for an end for credits, which opens the billing page", async () => {
    placeThenFinish(() =>
      useVoiceSessionStore.getState().sessionEnded("credits"),
    );
    mount(THREAD_BOX);

    await userEvent.click(screen.getByTestId("voice-outcome-get-credits"));

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.test/billing",
      "account",
      expect.objectContaining({ type: "click" }),
    );
  });

  it.each([
    {
      why: "a bot that cannot be reached",
      finish: () => useVoiceSessionStore.getState().sessionEnded("unreachable"),
      line: "Call ended: Tracy can't be reached right now.",
    },
    {
      why: "a lost connection",
      finish: () => useVoiceSessionStore.getState().sessionEnded("connection"),
      line: "Call ended: connection lost.",
    },
    {
      why: "a switch of accounts",
      finish: () => useVoiceSessionStore.getState().sessionEnded("account"),
      line: "Call ended when you switched accounts.",
    },
    {
      why: "a start that failed for another reason",
      finish: () =>
        useVoiceSessionStore.getState().sessionRefused("unavailable", null),
      line: "Call did not start. Try again in a moment.",
    },
    {
      why: "a host that needs an update",
      finish: () =>
        useVoiceSessionStore.getState().sessionRefused("update", null),
      line: "Calls need an update on Tracy's host.",
    },
    {
      why: "a paused bot",
      finish: () =>
        useVoiceSessionStore
          .getState()
          .sessionRefused("paused", "Tracy is paused until Friday."),
      line: "Tracy is paused until Friday.",
    },
  ])("says $why, with no Get credits", ({ finish, line }) => {
    placeThenFinish(finish);
    mount(THREAD_BOX);

    expect(screen.getByTestId("voice-outcome-line").textContent).toBe(line);
    expect(screen.queryByTestId("voice-outcome-get-credits")).toBeNull();
  });

  it("says a refused start needs credits, offers Get credits, and is not an ending", async () => {
    placeThenFinish(() =>
      useVoiceSessionStore.getState().sessionRefused("credits", null),
    );
    mount(THREAD_BOX);

    expect(screen.getByTestId("voice-outcome").getAttribute("data-state")).toBe(
      "refused",
    );
    expect(screen.getByTestId("voice-outcome-line").textContent).toBe(
      "Calls need credits.",
    );
    expect(useVoiceSessionStore.getState().endReason).toBeNull();
    expect(screen.getByRole("button", { name: "Get credits" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().refusal).toBeNull();
    expect(screen.queryByTestId("voice-outcome")).toBeNull();
  });

  it("forgets a paused bot's own line when dismissed", async () => {
    placeThenFinish(() =>
      useVoiceSessionStore
        .getState()
        .sessionRefused("paused", "Tracy is paused until Friday."),
    );
    mount(THREAD_BOX);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useVoiceSessionStore.getState().pausedCopy).toBeNull();
  });

  it("is not in another box, and gives way to a new call placed from that box", async () => {
    const driver = placeThenFinish(() =>
      useVoiceSessionStore.getState().sessionEnded("credits"),
    );
    mount(CHANNEL_BOX);
    expect(screen.queryByTestId("voice-outcome")).toBeNull();

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(driver.start.mock.calls).toEqual([[CHANNEL_TARGET]]);
    expect(screen.queryByTestId("voice-outcome")).toBeNull();
    expect(bar(CHANNEL_BOX).getAttribute("data-state")).toBe("connecting");
  });
});

describe("the phone layout", () => {
  beforeEach(() => {
    setPhoneLayoutOnly(true);
  });

  it("opens the call view's dial for the box's bot instead of placing the call", async () => {
    const driver = offer(makeDriver());
    mount(THREAD_BOX);

    await userEvent.click(callButton(THREAD_BOX));

    expect(driver.start).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      dial: THREAD_TARGET,
      callTitle: "Tracy",
      phoneViewOpen: true,
    });
  });

  it("ends a call running with another bot as it opens the dial", async () => {
    const driver = offer(makeDriver());
    placeCall({ botId: OTHER_BOT_ID, threadId: null }, "Scout", "live");
    mount(CHANNEL_BOX);

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState().dial).toEqual(CHANNEL_TARGET);
  });

  it("draws no bar and keeps the field, whatever the call placed from the box is doing", () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    act(() => useVoiceSessionStore.getState().setCaptions(true));
    mount(CHANNEL_BOX);

    expect(barOf(CHANNEL_BOX)).toBeNull();
    expect(
      screen.queryByTestId(`${CHANNEL_BOX.testId}-call-captions-lines`),
    ).toBeNull();
    expect(field(CHANNEL_BOX)).toBeTruthy();
    expect(screen.getByTestId(`${CHANNEL_BOX.testId}-send`)).toBeTruthy();
  });

  it("draws no line about the end either: the call view carries it", () => {
    offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    act(() => useVoiceSessionStore.getState().sessionEnded("credits"));
    mount(CHANNEL_BOX);

    expect(screen.queryByTestId("voice-outcome")).toBeNull();
    expect(field(CHANNEL_BOX)).toBeTruthy();
  });

  it("brings the call view back, ending and placing nothing, when the call placed from the box runs", async () => {
    const driver = offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    act(() => useVoiceSessionStore.getState().setPhoneViewOpen(false));
    mount(CHANNEL_BOX);

    await userEvent.click(callButton(CHANNEL_BOX));

    expect(useVoiceSessionStore.getState().phoneViewOpen).toBe(true);
    expect(driver.end).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().dial).toBeNull();
  });

  it("dials afresh from another box of the bot while a call placed from the channel runs", async () => {
    const driver = offer(makeDriver());
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    mount(THREAD_BOX);

    await userEvent.click(callButton(THREAD_BOX));

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState().dial).toEqual(THREAD_TARGET);
  });
});

describe("the composer microphone's chord", () => {
  it.each([
    { kind: CHANNEL_BOX, target: CHANNEL_TARGET, where: "the channel's" },
    { kind: THREAD_BOX, target: THREAD_TARGET, where: "a thread's" },
  ])("starts a call for $where box's target", ({ kind, target }) => {
    const driver = offer(makeDriver());
    mount(kind);

    tap();

    expect(driver.start.mock.calls).toEqual([[target]]);
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("calls the thread's target when both boxes are mounted", () => {
    const driver = offer(makeDriver());
    mount(THREAD_BOX, CHANNEL_BOX);

    tap();

    expect(driver.start.mock.calls).toEqual([[THREAD_TARGET]]);
  });

  it("ends the call from the bar, and starts none", () => {
    const driver = offer(makeDriver());
    mount(CHANNEL_BOX);
    placeCall(CHANNEL_TARGET, "Tracy", "live");
    expect(bar(CHANNEL_BOX)).toBeTruthy();

    tap();

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("is not bound by a box replying under an announcement", () => {
    const driver = offer(makeDriver());
    mount(ANNOUNCEMENT_BOX);

    tap();

    expect(driver.start).not.toHaveBeenCalled();
  });

  it("starts no call before voice is offered", () => {
    const driver = makeDriver();
    useVoiceSessionStore.setState({ availability: "dormant", driver });
    mount(CHANNEL_BOX);

    tap();

    expect(driver.start).not.toHaveBeenCalled();
  });

  it("is left alone while the box's surface does not own the keyboard", () => {
    const driver = offer(makeDriver());
    render(
      <KeyboardOwnerContext value={false}>
        {box(CHANNEL_BOX)}
      </KeyboardOwnerContext>,
      { wrapper: Providers },
    );

    tap();

    expect(driver.start).not.toHaveBeenCalled();
  });
});
