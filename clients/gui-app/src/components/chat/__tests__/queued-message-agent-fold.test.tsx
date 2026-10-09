import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  OpenChatQueuedItem,
  OpenChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: () => [],
  useSensor: () => null,
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  sortableKeyboardCoordinates: () => null,
  verticalListSortingStrategy: () => [],
  useSortable: () => ({
    setNodeRef: () => null,
    setActivatorNodeRef: () => null,
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
  }),
}));

const openLinkSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkSpy,
}));

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const THREE_LINE_CLASS = "max-h-[calc(3lh+--spacing(1))]";

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function userItem(queueItemId: string, text: string): OpenChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: { kind: "user", content: content(text), browserAnnotations: [] },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function agentItem(
  queueItemId: string,
  text: string,
): OpenChatQueuedPromptItem {
  return {
    ...userItem(queueItemId, text),
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    delivery: "same_turn",
  };
}

/** An agent reply whose text carries a Markdown link ("see the PR for details"). */
function linkedAgentItem(queueItemId: string): OpenChatQueuedPromptItem {
  const linkedContent: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          {
            type: "text",
            text: "the PR",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }],
          },
          { type: "text", text: " for details" },
        ],
      },
    ],
  };
  return {
    ...agentItem(queueItemId, queueItemId),
    message: { kind: "user", content: linkedContent, browserAnnotations: [] },
  };
}

function renderPanel(items: ReadonlyArray<OpenChatQueuedItem>) {
  return render(
    <TooltipProvider delayDuration={0}>
      <QueuedMessagePanel
        queue={{ status: "running", items: [...items] }}
        activeTurnStatus="running"
        canAct
        resumeRequested={false}
        keepPausedRequested={false}
        readOnly={false}
        editingQueueItemId={null}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        open
        onOpenChange={vi.fn()}
        onPause={() => null}
        onResume={() => null}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onAbortSteer={vi.fn()}
        onReorder={vi.fn()}
        onSteerNow={vi.fn()}
      />
    </TooltipProvider>,
  );
}

function rowFor(queueItemId: string): HTMLElement {
  const row = screen
    .getAllByTestId("queued-message-row")
    .find((candidate) => candidate.textContent.includes(queueItemId));
  if (row === undefined) throw new Error(`no row carries ${queueItemId}`);
  return row;
}

function scrollOf(row: HTMLElement): HTMLElement {
  return within(row).getByTestId("queued-message-content-scroll");
}

function classesOf(element: HTMLElement): ReadonlyArray<string> {
  return element.className.split(" ");
}

function previewOf(row: HTMLElement): HTMLElement {
  return within(row).getByTestId("queued-message-content-preview");
}

/** Folded: the box is unclipped (its chrome floats in it) and the PROSE is one line. */
function expectCompact(row: HTMLElement): void {
  const scroll = scrollOf(row);
  expect(scroll.getAttribute("data-compact")).toBe("true");
  expect(classesOf(scroll)).toContain("flow-root");
  expect(scroll.className).not.toContain(THREE_LINE_CLASS);
  expect(classesOf(scroll)).not.toContain("overflow-hidden");
  expect(classesOf(scroll)).not.toContain("overflow-y-auto");
  expect(classesOf(previewOf(row))).toEqual(
    expect.arrayContaining([
      "line-clamp-1",
      "max-h-[1lh]",
      "min-w-[min(6rem,100%)]",
    ]),
  );
}

/** Unfolded (or never foldable): the usual three-line scroll, no clamp. */
function expectThreeLine(row: HTMLElement): void {
  const scroll = scrollOf(row);
  expect(scroll.getAttribute("data-compact")).toBe("false");
  expect(classesOf(scroll)).toContain("overflow-y-auto");
  expect(scroll.className).toContain(THREE_LINE_CLASS);
  expect(classesOf(scroll)).not.toContain("flow-root");
  const preview = classesOf(previewOf(row));
  for (const clamp of [
    "line-clamp-1",
    "max-h-[1lh]",
    "min-w-[min(6rem,100%)]",
  ]) {
    expect(preview).not.toContain(clamp);
  }
}

afterEach(() => {
  cleanup();
  openLinkSpy.mockClear();
});

describe("a received agent row in the queue panel (#2441)", () => {
  it("renders one line until its text is clicked, then folds back", () => {
    renderPanel([agentItem("q-agent", "agent reply q-agent")]);
    const row = rowFor("q-agent");
    const fold = within(row).getByTestId("queued-message-agent-fold");

    expectCompact(row);
    expect(fold.getAttribute("role")).toBe("button");
    expect(fold.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expectThreeLine(row);

    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expectCompact(row);
  });

  it("toggles from the keyboard with Enter and Space, and ignores other keys", () => {
    renderPanel([agentItem("q-agent", "agent reply q-agent")]);
    const row = rowFor("q-agent");
    const fold = within(row).getByTestId("queued-message-agent-fold");

    fireEvent.keyDown(fold, { key: "a" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(fold, { key: "Enter" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(fold, { key: " " });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });

  it("unfolds only the clicked row", () => {
    renderPanel([
      agentItem("q-one", "agent reply q-one"),
      agentItem("q-two", "agent reply q-two"),
    ]);
    fireEvent.click(
      within(rowFor("q-one")).getByTestId("queued-message-agent-fold"),
    );

    expect(scrollOf(rowFor("q-one")).getAttribute("data-compact")).toBe(
      "false",
    );
    expect(scrollOf(rowFor("q-two")).getAttribute("data-compact")).toBe("true");
  });

  it("leaves a user-typed row in the same queue three lines with no fold", () => {
    renderPanel([
      userItem("q-user", "typed by the user q-user"),
      agentItem("q-agent", "agent reply q-agent"),
    ]);
    const userRow = rowFor("q-user");

    expect(
      within(userRow).queryByTestId("queued-message-agent-fold"),
    ).toBeNull();
    expectThreeLine(userRow);
    expect(
      within(rowFor("q-agent")).getByTestId("queued-message-agent-fold"),
    ).not.toBeNull();
  });
});

describe("the agent fold's nested controls and key repeat (#2441)", () => {
  function linkOf(row: HTMLElement): HTMLElement {
    return within(row).getByRole("link", { name: "the PR" });
  }

  it("renders a folded row as plain text with no anchor to focus or activate", () => {
    renderPanel([linkedAgentItem("q-link")]);
    const row = screen.getByTestId("queued-message-row");
    const fold = within(row).getByTestId("queued-message-agent-fold");

    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("see the PR for details");
  });

  it("brings the anchor back once unfolded, and a click on it opens the link without folding", () => {
    renderPanel([linkedAgentItem("q-link")]);
    const row = screen.getByTestId("queued-message-row");
    const fold = within(row).getByTestId("queued-message-agent-fold");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(linkOf(row));

    expect(openLinkSpy).toHaveBeenCalledTimes(1);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(scrollOf(row).getAttribute("data-compact")).toBe("false");
  });

  it("does not fold, or swallow the key, when Enter is pressed on the unfolded link", () => {
    renderPanel([linkedAgentItem("q-link")]);
    const row = screen.getByTestId("queued-message-row");
    const fold = within(row).getByTestId("queued-message-agent-fold");
    fireEvent.click(fold);

    const notPrevented = fireEvent.keyDown(linkOf(row), { key: "Enter" });

    expect(notPrevented).toBe(true);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(scrollOf(row).getAttribute("data-compact")).toBe("false");
  });

  it("still unfolds when the message's plain text is clicked", () => {
    renderPanel([linkedAgentItem("q-link")]);
    const row = screen.getByTestId("queued-message-row");
    const fold = within(row).getByTestId("queued-message-agent-fold");

    fireEvent.click(within(row).getByText("see", { exact: false }));

    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(scrollOf(row).getAttribute("data-compact")).toBe("false");
    expect(openLinkSpy).not.toHaveBeenCalled();
  });

  it("ignores an auto-repeated Enter or Space and toggles on the first press", () => {
    renderPanel([agentItem("q-agent", "agent reply q-agent")]);
    const fold = within(rowFor("q-agent")).getByTestId(
      "queued-message-agent-fold",
    );

    fireEvent.keyDown(fold, { key: "Enter", repeat: true });
    fireEvent.keyDown(fold, { key: " ", repeat: true });
    expect(fold.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(fold, { key: "Enter", repeat: false });
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(fold, { key: "Enter", repeat: true });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("a folded agent row's retained reason (#2441)", () => {
  const REASON = "Retained after the turn ended before it could steer.";

  it("shows no reason while folded and shows it once unfolded", () => {
    renderPanel([
      {
        ...agentItem("q-agent", "agent reply q-agent"),
        fallbackReason: REASON,
      },
    ]);
    const row = rowFor("q-agent");
    const fold = within(row).getByTestId("queued-message-agent-fold");

    expect(within(row).queryByText(REASON)).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(fold);
    expect(within(row).getByText(REASON)).not.toBeNull();

    fireEvent.click(fold);
    expect(within(row).queryByText(REASON)).toBeNull();
  });

  it("still shows a user row's reason", () => {
    renderPanel([
      {
        ...userItem("q-user", "typed by the user q-user"),
        fallbackReason: REASON,
      },
    ]);

    expect(within(rowFor("q-user")).getByText(REASON)).not.toBeNull();
  });
});

describe("the queue header summary (#2441)", () => {
  function summary(): string {
    return screen.getByTestId("queued-message-header").textContent;
  }

  it("says 'N messages' / '1 message' when no agent is queued", () => {
    renderPanel([userItem("a", "a"), userItem("b", "b")]);
    expect(summary()).toContain("2 messages");
    expect(summary()).not.toContain("from");
    cleanup();
    renderPanel([userItem("a", "a")]);
    expect(summary()).toContain("1 message");
    expect(summary()).not.toContain("1 messages");
  });

  it("splits a mixed queue: '2 messages · 12 from agents'", () => {
    const agents = Array.from({ length: 12 }, (_unused, index) =>
      agentItem(`agent-${String(index)}`, `reply ${String(index)}`),
    );
    renderPanel([userItem("u1", "one"), userItem("u2", "two"), ...agents]);
    expect(summary()).toContain("2 messages · 12 from agents");
  });

  it("uses the singular for one agent in a mixed queue", () => {
    renderPanel([userItem("u1", "one"), agentItem("agent-1", "reply")]);
    expect(summary()).toContain("1 message · 1 from an agent");
  });

  it("says '12 messages from agents' when every row is an agent's", () => {
    renderPanel(
      Array.from({ length: 12 }, (_unused, index) =>
        agentItem(`agent-${String(index)}`, `reply ${String(index)}`),
      ),
    );
    expect(summary()).toContain("12 messages from agents");
  });

  it("says '1 message from an agent' for a lone agent row", () => {
    renderPanel([agentItem("agent-1", "reply")]);
    expect(summary()).toContain("1 message from an agent");
  });
});
