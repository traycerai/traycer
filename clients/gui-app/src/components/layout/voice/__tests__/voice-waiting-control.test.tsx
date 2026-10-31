import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { itemLineOf } from "@/lib/voice/briefing";
import {
  useVoiceSessionStore,
  type QueueItem,
  type VoiceQueueDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceWaitingControl } from "../voice-waiting-control";

const initial = useVoiceSessionStore.getState();

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  const item: QueueItem = {
    id: "i-1",
    kind: "reply",
    botId: "bot-2",
    hostId: "host-a",
    threadId: "thread-x",
    chatId: "thread-x",
    messageId: "i-1",
    surfaceId: null,
    title: "A title",
    line: "",
    at: Date.now(),
    state: "queued",
    ...overrides,
  };
  return { ...item, line: itemLineOf(item, "Release bot") };
}

const QUEUE: ReadonlyArray<QueueItem> = [
  queueItem({ id: "reply", title: "Safari fix landed", at: 3_000 }),
  queueItem({
    id: "question",
    kind: "question",
    title: "Ship or hold",
    at: 2_000,
    state: "offered",
  }),
  queueItem({
    id: "surface",
    kind: "surface",
    title: "Deploy approval",
    at: 1_000,
  }),
  queueItem({ id: "heard", title: "Already heard", state: "heard" }),
  queueItem({ id: "later", title: "Set aside", state: "dismissed" }),
  queueItem({ id: "ann", kind: "announcement", title: "Nightly build" }),
];

let run: Mock<VoiceQueueDriver["run"]>;

function goLive(queue: ReadonlyArray<QueueItem>): void {
  run = vi.fn<VoiceQueueDriver["run"]>(() => "appended");
  act(() => {
    useVoiceSessionStore.setState({
      phase: "live",
      queue,
      queueDriver: { run },
    });
  });
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
});

afterEach(() => {
  cleanup();
});

describe("VoiceWaitingControl", () => {
  it("counts only what still waits, and draws nothing when nothing does", () => {
    goLive(QUEUE);
    render(<VoiceWaitingControl />);
    expect(screen.getByTestId("voice-strip-waiting").textContent).toBe(
      "Waiting · 3",
    );

    act(() => {
      useVoiceSessionStore.setState({
        queue: QUEUE.filter(
          (item) => item.state === "heard" || item.kind === "announcement",
        ),
      });
    });
    expect(screen.queryByTestId("voice-strip-waiting")).toBeNull();
  });

  it("lists each waiting item's line, newest first", async () => {
    goLive(QUEUE);
    render(<VoiceWaitingControl />);

    await userEvent.click(screen.getByTestId("voice-strip-waiting"));

    const rows = screen.getAllByTestId("voice-waiting-item");
    expect(rows.map((row) => row.getAttribute("data-item-id"))).toEqual([
      "reply",
      "question",
      "surface",
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(
        'Release bot answered in a thread: "Safari fix landed"',
      ),
      expect.stringContaining(
        'Release bot has a question for you in a thread: "Ship or hold"',
      ),
      expect.stringContaining(
        'Release bot says a task is waiting on you: "Deploy approval"',
      ),
    ]);
  });

  it("runs Read, Switch and Later for the item they sit on, through the driver", async () => {
    goLive(QUEUE);
    render(<VoiceWaitingControl />);
    await userEvent.click(screen.getByTestId("voice-strip-waiting"));
    const row = screen
      .getAllByTestId("voice-waiting-item")
      .find((candidate) => candidate.getAttribute("data-item-id") === "question");
    if (row === undefined) throw new Error("the question row is not listed");

    await userEvent.click(within(row).getByRole("button", { name: "Read" }));
    await userEvent.click(within(row).getByRole("button", { name: "Switch" }));
    await userEvent.click(within(row).getByRole("button", { name: "Later" }));

    expect(run.mock.calls).toEqual([
      [{ kind: "read", itemId: "question", delegationId: null }],
      [{ kind: "switch", target: { kind: "item", itemId: "question" } }],
      [{ kind: "later", itemId: "question" }],
    ]);
  });
});
