import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallTarget,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { CallControl, type CallControlForm } from "../call-control";

const BOT_ID = "bot-1";
const TARGET: CallTarget = { botId: BOT_ID, threadId: null };

// The reads the dial's directory is made from, at their own boundary. The
// directory itself is the real one: it is what drops the archived bot and the
// bot of an environment the person is not in.
const reads = vi.hoisted(() => ({
  environments: [
    { environmentId: "env-1", label: "Personal" },
    { environmentId: "env-2", label: "Acme" },
  ],
  bots: [
    {
      botId: "bot-1",
      title: "Tracy",
      environmentId: "env-1",
      archivedAt: null,
    },
    {
      botId: "bot-2",
      title: "Scout",
      environmentId: "env-2",
      archivedAt: null,
    },
    {
      botId: "bot-archived",
      title: "Retired",
      environmentId: "env-1",
      archivedAt: 1,
    },
    {
      botId: "bot-stranger",
      title: "Stranger",
      environmentId: "env-3",
      archivedAt: null,
    },
  ],
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: reads.environments },
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({ data: { bots: reads.bots } }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const initial = useVoiceSessionStore.getState();

function makeDriver() {
  return {
    start: vi.fn<VoiceSessionDriver["start"]>(),
    end: vi.fn<VoiceSessionDriver["end"]>(),
    setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
  };
}

/** Voice offered, and the call owner mounted: the control is drawn. */
function offer(driver: VoiceSessionDriver): void {
  act(() => {
    useVoiceSessionStore.setState({ availability: "live", driver });
  });
}

function mount(form: CallControlForm, target: CallTarget) {
  return render(
    <TooltipProvider>
      <CallControl target={target} botTitle="Tracy" form={form} />
    </TooltipProvider>,
  );
}

function control(): HTMLElement {
  return screen.getByTestId("call-control");
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useTracySurfaceStore.getState().openSurface("host-a");
});

afterEach(cleanup);

describe("CallControl availability", () => {
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
  ])("is not drawn when $why", ({ state }) => {
    useVoiceSessionStore.setState({ driver: makeDriver(), ...state });
    mount("label", TARGET);

    expect(screen.queryByTestId("call-control")).toBeNull();
  });

  it("is drawn once voice is offered and the call owner is mounted", () => {
    offer(makeDriver());
    mount("label", TARGET);

    expect(control().textContent).toBe("Call");
    expect(control().getAttribute("aria-label")).toBe("Call");
  });

  it("draws the glyph alone on the touch form", () => {
    offer(makeDriver());
    mount("touch", TARGET);

    expect(control().textContent).toBe("");
    expect(control().getAttribute("aria-label")).toBe("Call");
  });
});

describe("CallControl on desktop", () => {
  it("opens the dial beside it without placing a call, listing the bots the person can call with this surface's bot selected", async () => {
    const driver = makeDriver();
    offer(driver);
    mount("label", TARGET);

    await userEvent.click(control());

    expect(driver.start).not.toHaveBeenCalled();
    // The archived bot and the bot of an environment the person is not in
    // are not callable; each listed bot carries its environment's label.
    const popover = within(screen.getByTestId("call-dial-popover"));
    expect(
      popover
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["TracyPersonal", "ScoutAcme"]);
    expect(
      popover
        .getByRole("radio", { name: /Tracy/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      popover
        .getByRole("radio", { name: /Scout/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(popover.queryByText("Retired")).toBeNull();
    expect(popover.queryByText("Stranger")).toBeNull();
  });

  it("calls the surface's bot into the thread it continues, and closes the dial", async () => {
    const driver = makeDriver();
    offer(driver);
    mount("label", { botId: BOT_ID, threadId: "thread-1" });

    await userEvent.click(control());
    await userEvent.click(screen.getByTestId("call-dial-call"));

    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.start).toHaveBeenCalledWith({
      botId: BOT_ID,
      threadId: "thread-1",
    });
    expect(screen.queryByTestId("call-dial-popover")).toBeNull();
  });

  it("calls another bot picked in the dial into a new thread", async () => {
    const driver = makeDriver();
    offer(driver);
    mount("label", { botId: BOT_ID, threadId: "thread-1" });

    await userEvent.click(control());
    await userEvent.click(screen.getByRole("radio", { name: /Scout/ }));
    await userEvent.click(screen.getByTestId("call-dial-call"));

    expect(driver.start).toHaveBeenCalledWith({
      botId: "bot-2",
      threadId: null,
    });
  });

  it("ends a call running with another bot first when Call is pressed, and places the new one once that call is over", async () => {
    const driver = makeDriver();
    offer(driver);
    act(() => {
      useVoiceSessionStore
        .getState()
        .sessionConnecting(
          { botId: "bot-2", hostId: "host-a", threadId: null },
          "Scout",
        );
      useVoiceSessionStore.setState({ phase: "live" });
    });
    mount("label", TARGET);
    // Another bot's call is not this control's to end: it still offers Call.
    expect(control().getAttribute("aria-label")).toBe("Call");

    await userEvent.click(control());

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
    // One bot per call: the dial waits for the end.
    expect(screen.getByTestId("call-dial-call")).toHaveProperty(
      "disabled",
      true,
    );

    act(() => useVoiceSessionStore.getState().sessionEnded("ended"));
    await userEvent.click(screen.getByTestId("call-dial-call"));

    expect(driver.start).toHaveBeenCalledWith(TARGET);
  });
});

describe("CallControl on the phone", () => {
  it("opens the phone's dial for this bot instead of placing the call", async () => {
    const driver = makeDriver();
    offer(driver);
    mount("touch", { botId: BOT_ID, threadId: "thread-1" });

    await userEvent.click(control());

    expect(driver.start).not.toHaveBeenCalled();
    expect(screen.queryByTestId("call-dial-popover")).toBeNull();
    expect(useVoiceSessionStore.getState()).toMatchObject({
      dial: { botId: BOT_ID, threadId: "thread-1" },
      callTitle: "Tracy",
      phoneViewOpen: true,
    });
  });

  it("ends a call running with another bot as it opens the dial", async () => {
    const driver = makeDriver();
    offer(driver);
    act(() => {
      useVoiceSessionStore
        .getState()
        .sessionConnecting(
          { botId: "bot-2", hostId: "host-a", threadId: null },
          "Scout",
        );
      useVoiceSessionStore.setState({ phase: "live" });
    });
    mount("touch", TARGET);

    await userEvent.click(control());

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionStore.getState().dial).toEqual(TARGET);
  });
});

describe("CallControl while this bot's call runs", () => {
  function callWith(
    botId: string,
    threadId: string | null,
    phase: "connecting" | "live",
  ): void {
    act(() => {
      useVoiceSessionStore
        .getState()
        .sessionConnecting({ botId, hostId: "host-a", threadId }, "Tracy");
      useVoiceSessionStore.setState({ phase });
    });
  }

  it.each(["label", "touch"] as const)(
    "is End the call on the %s form, and ends through the driver without opening a dial",
    async (form) => {
      const driver = makeDriver();
      offer(driver);
      callWith(BOT_ID, null, "live");
      mount(form, TARGET);

      expect(control().getAttribute("aria-label")).toBe("End the call");
      expect(control().getAttribute("aria-pressed")).toBe("true");

      await userEvent.click(control());

      expect(driver.end).toHaveBeenCalledTimes(1);
      expect(driver.start).not.toHaveBeenCalled();
      expect(screen.queryByTestId("call-dial-popover")).toBeNull();
      expect(useVoiceSessionStore.getState().dial).toBeNull();
    },
  );

  it("ends a call still connecting as well", async () => {
    const driver = makeDriver();
    offer(driver);
    callWith(BOT_ID, null, "connecting");
    mount("label", TARGET);

    await userEvent.click(control());

    expect(driver.end).toHaveBeenCalledTimes(1);
  });

  it("is End the call on the thread the call is in, and Call on another thread of the bot", () => {
    offer(makeDriver());
    callWith(BOT_ID, "thread-1", "live");
    const view = mount("label", { botId: BOT_ID, threadId: "thread-1" });
    expect(control().getAttribute("aria-label")).toBe("End the call");

    view.rerender(
      <TooltipProvider>
        <CallControl
          target={{ botId: BOT_ID, threadId: "thread-2" }}
          botTitle="Tracy"
          form="label"
        />
      </TooltipProvider>,
    );
    expect(control().getAttribute("aria-label")).toBe("Call");
  });

  it("is End the call on the bot's channel for a call in any of its threads", () => {
    offer(makeDriver());
    callWith(BOT_ID, "thread-1", "live");
    mount("label", TARGET);

    expect(control().getAttribute("aria-label")).toBe("End the call");
  });

  it("takes no press while the call is ending", () => {
    offer(makeDriver());
    callWith(BOT_ID, null, "live");
    act(() => useVoiceSessionStore.setState({ phase: "ending" }));
    mount("label", TARGET);

    expect(control()).toHaveProperty("disabled", true);
  });
});
