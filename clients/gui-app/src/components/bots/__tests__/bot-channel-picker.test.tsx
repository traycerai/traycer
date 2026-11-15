/**
 * Where the installed app draws no bots column, a channel's title is the
 * picker: a bottom sheet holding the real bots list, closed by a pick or by
 * dismissing it. The real drawer, the real title and the real unselected pane
 * run here; only the bots list is stood in for (its own suite covers its
 * rows), by a list that calls back exactly as the real one does - a channel
 * row reports `onChannelOpened`, the Threads row calls `threadsView.onShow`.
 * What this file asks is what the picker does with those calls and what it
 * leaves alone: the conversation beside it must not remount.
 */
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import {
  BotChannelTitle,
  BotUnselectedLevel2Pane,
} from "@/components/bots/bot-channel-level2";
import type { BotThreadsViewState } from "@/components/bots/bot-channel-sidebar";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";

vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: (props: {
    readonly activeBotId: string | null;
    readonly threadsView: {
      readonly onShow: () => void;
    } | null;
    readonly onChannelOpened: () => void;
  }) => (
    <nav aria-label="Channels" data-testid="bot-channel-sidebar">
      {["bot-a", "bot-b"].map((botId) => (
        <button
          key={botId}
          type="button"
          data-testid="bot-channel-row"
          aria-current={botId === props.activeBotId ? "page" : undefined}
          onClick={props.onChannelOpened}
        >
          {botId}
        </button>
      ))}
      {props.threadsView === null ? null : (
        <button
          type="button"
          data-testid="bot-channel-threads-row"
          onClick={props.threadsView.onShow}
        >
          Threads
        </button>
      )}
    </nav>
  ),
}));

const THEME = { resolvedTheme: "dark", themePreset: "neutral" } as const;

function Conversation() {
  return (
    <div data-testid="conversation">
      <input aria-label="Draft" />
    </div>
  );
}

function Surface(props: {
  readonly level2: MobileLevel2Form | null;
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  return (
    <ResolvedThemeContext.Provider value={THEME}>
      <div>
        <BotChannelTitle
          level2={props.level2}
          title="Tracy"
          activeBotId="bot-a"
          hostId="host-1"
          threadsView={props.threadsView}
        />
        <Conversation />
      </div>
    </ResolvedThemeContext.Provider>
  );
}

function makeThreadsView(onShow: () => void): BotThreadsViewState {
  return { shown: false, onShow, onLeave: () => {} };
}

async function openPicker(user: UserEvent) {
  await user.click(screen.getByTestId("bot-channel-picker-trigger"));
  return screen.findByTestId("bot-channel-picker");
}

async function expectPickerClosed(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
  });
}

afterEach(() => {
  cleanup();
});

describe("the channel title as a picker", () => {
  it("opens the bots list in a sheet named Channels from the title", async () => {
    const user = userEvent.setup();
    render(<Surface level2="menu" threadsView={null} />);

    expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
    const sheet = await openPicker(user);

    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(within(sheet).getAllByTestId("bot-channel-row")).toHaveLength(2);
    expect(
      screen.getByTestId("bot-channel-picker-trigger").textContent,
    ).toContain("Tracy");
  });

  it("closes on a channel pick and leaves the conversation mounted", async () => {
    const user = userEvent.setup();
    render(<Surface level2="bar" threadsView={null} />);
    const conversation = screen.getByTestId("conversation");
    await user.type(screen.getByLabelText("Draft"), "half a thought");

    const sheet = await openPicker(user);
    await user.click(within(sheet).getByText("bot-b"));

    await expectPickerClosed();
    expect(screen.getByTestId("conversation")).toBe(conversation);
    expect(screen.getByLabelText<HTMLInputElement>("Draft").value).toBe(
      "half a thought",
    );
  });

  it("closes on the Threads row after showing Threads once", async () => {
    const user = userEvent.setup();
    const onShow = vi.fn();
    render(<Surface level2="menu" threadsView={makeThreadsView(onShow)} />);

    const sheet = await openPicker(user);
    await user.click(within(sheet).getByTestId("bot-channel-threads-row"));

    await expectPickerClosed();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape, leaves the conversation mounted, and opens again", async () => {
    const user = userEvent.setup();
    render(<Surface level2="menu" threadsView={null} />);
    const conversation = screen.getByTestId("conversation");

    await openPicker(user);
    await user.keyboard("{Escape}");
    await expectPickerClosed();
    expect(screen.getByTestId("conversation")).toBe(conversation);

    await openPicker(user);
    expect(screen.getByTestId("bot-channel-picker")).not.toBeNull();
  });

  it("offers no Threads row where the surface has no Threads view", async () => {
    const user = userEvent.setup();
    render(<Surface level2="menu" threadsView={null} />);

    const sheet = await openPicker(user);

    expect(within(sheet).queryByTestId("bot-channel-threads-row")).toBeNull();
  });

  it("is plain text beside a column, with no picker to open", () => {
    render(<Surface level2={{ column: 256 }} threadsView={null} />);

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Tracy");
    expect(screen.queryByTestId("bot-channel-picker-trigger")).toBeNull();
  });
});

describe("the unselected pane's title", () => {
  function Unselected(props: { readonly level2: MobileLevel2Form | null }) {
    const [shown, setShown] = useState(false);
    return (
      <ResolvedThemeContext.Provider value={THEME}>
        <BotUnselectedLevel2Pane
          level2={props.level2}
          title="Tracy"
          hostId="host-1"
          threadsView={{
            shown,
            onShow: () => setShown(true),
            onLeave: () => setShown(false),
          }}
        >
          <div data-testid="unselected-body">{shown ? "Threads" : "Home"}</div>
        </BotUnselectedLevel2Pane>
      </ResolvedThemeContext.Provider>
    );
  }

  it("keeps Threads reachable through the picker and shows it under the closed sheet", async () => {
    const user = userEvent.setup();
    render(<Unselected level2="menu" />);

    const sheet = await openPicker(user);
    await user.click(within(sheet).getByTestId("bot-channel-threads-row"));

    await expectPickerClosed();
    expect(screen.getByTestId("unselected-body").textContent).toBe("Threads");
  });

  it("adds no header where a column is drawn or the form is a column-less browser one", () => {
    render(<Unselected level2={null} />);

    expect(screen.getByTestId("unselected-body")).not.toBeNull();
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
  });
});
