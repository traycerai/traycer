/**
 * The focus a memory line opens "What Tracy knows" with: the entries it names
 * are marked in either section, the focused section is scrolled into view,
 * and the entries gone since are said so.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotMemory,
  BotMemoryEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  BotMemoryPanel,
  type BotMemoryPanelProps,
} from "@/components/bots/bot-memory-panel";
import type { BotMemoryFocus } from "@/stores/bots/bot-open-thread-store";

const BOT_ID = "bot-1";
const OTHER_BOT_ID = "bot-2";

const mocks = vi.hoisted(() => ({
  memory: null as BotMemory | null,
}));

vi.mock("@/hooks/bots/use-bot-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-memory")>()),
  useBotMemory: () =>
    mocks.memory === null
      ? { kind: "loading" }
      : { kind: "ready", memory: mocks.memory },
}));

function entry(input: {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly botId: string;
}): BotMemoryEntry {
  return {
    id: input.id,
    text: input.text,
    tags: [...input.tags],
    writtenBy: { botId: input.botId, chatId: null, requestId: null },
    at: 1_000,
    confirmedAt: 1_000,
  };
}

const OWN_A = entry({
  id: "own-a",
  text: "The Codex CLI bump is held",
  tags: [BOT_ID],
  botId: BOT_ID,
});
const OWN_B = entry({
  id: "own-b",
  text: "CI flakes on the host shard",
  tags: [BOT_ID],
  botId: BOT_ID,
});
const SHARED_A = entry({
  id: "shared-a",
  text: "main receives development only",
  tags: ["all"],
  botId: OTHER_BOT_ID,
});
const SHARED_B = entry({
  id: "shared-b",
  text: "never pass no-verify",
  tags: ["all"],
  botId: OTHER_BOT_ID,
});

const MEMORY: BotMemory = {
  entries: [OWN_A, OWN_B, SHARED_A, SHARED_B],
  own: { entries: 2, chars: 60, ceiling: 8_000 },
  shared: { entries: 2, chars: 60, ceiling: 8_000 },
  changes: [],
};

const scrollIntoView = vi.fn();

function renderPanel(focus: BotMemoryFocus | null): void {
  const props: BotMemoryPanelProps = {
    botId: BOT_ID,
    hostId: "host-1",
    environmentId: "env-1",
    botTitle: "Tracy",
    channelId: "channel-1",
    trunkChatId: "trunk-1",
    threads: [],
    botNameOf: () => null,
    back: null,
    onBack: null,
    onClose: vi.fn(),
    navigation: { openThread: vi.fn(), showInChannel: vi.fn() },
    focus,
  };
  render(<BotMemoryPanel {...props} />);
}

function entryRow(section: string, text: string): HTMLElement {
  const row = within(screen.getByTestId(section))
    .getAllByTestId("bot-memory-entry")
    .find((candidate) => candidate.textContent.includes(text));
  if (row === undefined) throw new Error(`no entry "${text}" in ${section}`);
  return row;
}

beforeEach(() => {
  mocks.memory = MEMORY;
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
});

describe("BotMemoryPanel focus", () => {
  it("marks the focused entries of its own section, and only them", () => {
    renderPanel({ memory: "own", entryIds: [OWN_A.id] });

    expect(
      entryRow("bot-memory-own", OWN_A.text).getAttribute("data-focused"),
    ).toBe("true");
    expect(
      entryRow("bot-memory-own", OWN_B.text).hasAttribute("data-focused"),
    ).toBe(false);
    expect(
      entryRow("bot-memory-shared", SHARED_A.text).hasAttribute("data-focused"),
    ).toBe(false);
  });

  it("marks the focused entries of the common section", () => {
    renderPanel({ memory: "shared", entryIds: [SHARED_A.id, SHARED_B.id] });

    expect(
      entryRow("bot-memory-shared", SHARED_A.text).getAttribute("data-focused"),
    ).toBe("true");
    expect(
      entryRow("bot-memory-shared", SHARED_B.text).getAttribute("data-focused"),
    ).toBe("true");
    expect(
      entryRow("bot-memory-own", OWN_A.text).hasAttribute("data-focused"),
    ).toBe(false);
  });

  it("scrolls the focused own section into view", () => {
    renderPanel({ memory: "own", entryIds: [OWN_A.id] });

    expect(scrollIntoView.mock.contexts).toContain(
      screen.getByTestId("bot-memory-own"),
    );
    expect(scrollIntoView.mock.contexts).not.toContain(
      screen.getByTestId("bot-memory-shared"),
    );
  });

  it("scrolls the focused common section into view", () => {
    renderPanel({ memory: "shared", entryIds: [SHARED_A.id] });

    expect(scrollIntoView.mock.contexts).toContain(
      screen.getByTestId("bot-memory-shared"),
    );
    expect(scrollIntoView.mock.contexts).not.toContain(
      screen.getByTestId("bot-memory-own"),
    );
  });

  it("says one named entry is gone, in the focused section", () => {
    renderPanel({ memory: "own", entryIds: [OWN_A.id, "own-removed"] });

    expect(
      within(screen.getByTestId("bot-memory-own")).getByTestId(
        "bot-memory-focus-gone",
      ).textContent,
    ).toBe("1 entry this line names was removed and is no longer here.");
  });

  it("says how many named entries are gone, in the plural", () => {
    renderPanel({
      memory: "shared",
      entryIds: [SHARED_A.id, "gone-1", "gone-2"],
    });

    expect(
      within(screen.getByTestId("bot-memory-shared")).getByTestId(
        "bot-memory-focus-gone",
      ).textContent,
    ).toBe("2 entries this line names were removed and are no longer here.");
  });

  it("shows no gone note when every named entry is present", () => {
    renderPanel({ memory: "own", entryIds: [OWN_A.id, OWN_B.id] });

    expect(screen.queryByTestId("bot-memory-focus-gone")).toBeNull();
  });

  it("marks nothing and scrolls nothing without a focus", () => {
    renderPanel(null);

    expect(document.querySelector("[data-focused]")).toBeNull();
    expect(screen.queryByTestId("bot-memory-focus-gone")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("BotMemoryPanel focus over an existing search", () => {
  function panelProps(focus: BotMemoryFocus | null): BotMemoryPanelProps {
    return {
      botId: BOT_ID,
      hostId: "host-1",
      environmentId: "env-1",
      botTitle: "Tracy",
      channelId: "channel-1",
      trunkChatId: "trunk-1",
      threads: [],
      botNameOf: () => null,
      back: null,
      onBack: null,
      onClose: vi.fn(),
      navigation: { openThread: vi.fn(), showInChannel: vi.fn() },
      focus,
    };
  }

  function findInput(): HTMLInputElement {
    const input = screen.getByTestId("bot-memory-find");
    if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
    return input;
  }

  it("clears the search when a different focus arrives, so the focused entries show", () => {
    const view = render(<BotMemoryPanel {...panelProps(null)} />);
    fireEvent.change(findInput(), { target: { value: "no-verify" } });
    expect(screen.queryAllByText(OWN_A.text)).toHaveLength(0);

    view.rerender(
      <BotMemoryPanel
        {...panelProps({ memory: "own", entryIds: [OWN_A.id] })}
      />,
    );

    expect(findInput().value).toBe("");
    expect(
      entryRow("bot-memory-own", OWN_A.text).getAttribute("data-focused"),
    ).toBe("true");
    expect(screen.getByTestId("bot-memory-shared")).toBeTruthy();
  });

  it("keeps a search typed after the focus arrived through new snapshots of the same focus", () => {
    const focus: BotMemoryFocus = { memory: "own", entryIds: [OWN_A.id] };
    const view = render(<BotMemoryPanel {...panelProps(focus)} />);
    fireEvent.change(findInput(), { target: { value: "flakes" } });

    mocks.memory = { ...MEMORY, entries: [...MEMORY.entries] };
    view.rerender(<BotMemoryPanel {...panelProps(focus)} />);

    expect(findInput().value).toBe("flakes");
  });
});
