import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  NO_QUEUED_MESSAGE_STAGES,
  QueuedMessageStagesContext,
  type QueuedMessageStages,
} from "@/components/chat/queued-message-stages";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QUEUE_PAUSED_AFTER_ERROR_TOOLTIP } from "@/components/chat/fallback/fallback-copy";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { optimisticQueuedItemId } from "@/stores/chats/optimistic-queue";
import type { QueueItemInFlight } from "@/stores/chats/queue-edit-custody";

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

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function queuedItem(
  queueItemId: string,
  text: string,
  status: ChatQueuedItem["status"],
): ChatQueuedPromptItem {
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
    status,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function steerRequestedItem(queueItemId: string): ChatQueuedPromptItem {
  return {
    ...queuedItem(queueItemId, `${queueItemId} text`, "steer_requested"),
    delivery: "same_turn",
    targetTurnId: "turn-1",
    steerRequest: {
      mode: "safe_point",
      targetTurnId: "turn-1",
      requestedAt: 1,
    },
  };
}

function stages(overrides: Partial<QueuedMessageStages>): QueuedMessageStages {
  return { ...NO_QUEUED_MESSAGE_STAGES, ...overrides };
}

function renderPanel(
  items: ReadonlyArray<ChatQueuedItem>,
  provided: QueuedMessageStages | null,
) {
  return renderPanelWithQueue(
    { status: "running", items: [...items] },
    provided,
  );
}

function renderPanelWithQueue(
  queue: ChatSessionState["queue"],
  provided: QueuedMessageStages | null,
) {
  const panel = (
    <TooltipProvider delayDuration={0}>
      <QueuedMessagePanel
        queue={queue}
        activeTurnStatus="running"
        canAct
        resumeRequested={false}
        keepPausedRequested={false}
        readOnly={false}
        editingQueueItemId={null}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        onPause={() => null}
        onResume={() => null}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onAbortSteer={vi.fn()}
        onReorder={vi.fn()}
        onSteerNow={vi.fn()}
      />
    </TooltipProvider>
  );
  return render(
    provided === null ? (
      panel
    ) : (
      <QueuedMessageStagesContext value={provided}>
        {panel}
      </QueuedMessageStagesContext>
    ),
  );
}

function rowWithText(text: string): HTMLElement {
  const row = screen
    .getAllByTestId("queued-message-row")
    .find((candidate) => within(candidate).queryByText(text) !== null);
  if (row === undefined) throw new Error(`Expected a row with "${text}"`);
  return row;
}

const CONTROL_NAMES = [
  "Edit queued message",
  "Delete queued message",
  "Steer queued message now",
] as const;

afterEach(() => {
  cleanup();
});

describe("queued rows name the stage the row is actually in", () => {
  it("says Queued for next turn for a host-confirmed pending prompt and Waiting for provider for a requested safe-point steer", () => {
    renderPanel(
      [
        queuedItem("pending-row", "Pending text", "pending"),
        steerRequestedItem("steer-row"),
      ],
      stages({}),
    );

    expect(
      within(rowWithText("Pending text")).getByText("Queued for next turn"),
    ).not.toBeNull();
    expect(
      within(rowWithText("steer-row text")).getByText("Waiting for provider"),
    ).not.toBeNull();
    // Each pill belongs to its own row.
    expect(
      within(rowWithText("Pending text")).queryByText("Waiting for provider"),
    ).toBeNull();
  });

  it("says Sending to host for an optimistic row and Delivery not confirmed once its action id is unconfirmed", () => {
    const optimisticId = optimisticQueuedItemId("action-1");
    const item = queuedItem(optimisticId, "Optimistic text", "pending");

    const { unmount } = renderPanel([item], stages({}));
    expect(
      within(rowWithText("Optimistic text")).getByText("Sending to host"),
    ).not.toBeNull();
    expect(screen.queryByText("Delivery not confirmed")).toBeNull();
    unmount();

    renderPanel(
      [item],
      stages({ unconfirmedSendActionIds: new Set(["action-1"]) }),
    );
    expect(
      within(rowWithText("Optimistic text")).getByText(
        "Delivery not confirmed",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Sending to host")).toBeNull();
  });
});

describe("a row with its own mutation in flight withholds its repeat controls", () => {
  function inFlightStages(
    entries: ReadonlyArray<readonly [string, QueueItemInFlight]>,
  ): QueuedMessageStages {
    return stages({ inFlight: new Map(entries) });
  }

  it("shows Requesting steer with no controls on the in-flight row, while a sibling keeps all three", () => {
    renderPanel(
      [
        queuedItem("busy-row", "Busy text", "pending"),
        queuedItem("idle-row", "Idle text", "pending"),
      ],
      inFlightStages([["busy-row", "requesting_steer"]]),
    );

    const busy = rowWithText("Busy text");
    expect(within(busy).getByText("Requesting steer")).not.toBeNull();
    for (const name of CONTROL_NAMES) {
      expect(within(busy).queryByRole("button", { name })).toBeNull();
    }

    const idle = rowWithText("Idle text");
    expect(within(idle).getByText("Queued for next turn")).not.toBeNull();
    for (const name of CONTROL_NAMES) {
      expect(within(idle).getByRole("button", { name })).not.toBeNull();
    }
  });

  it("shows Saving for a row whose edit or settings frame is unanswered", () => {
    renderPanel(
      [queuedItem("saving-row", "Saving text", "pending")],
      inFlightStages([["saving-row", "saving"]]),
    );
    const row = rowWithText("Saving text");
    expect(within(row).getByText("Saving")).not.toBeNull();
    expect(within(row).queryByText("Queued for next turn")).toBeNull();
    for (const name of CONTROL_NAMES) {
      expect(within(row).queryByRole("button", { name })).toBeNull();
    }
  });

  it("shows Cancelling, and no Cancel steer button, for a steer_requested row whose abort is in flight", () => {
    // The control: the same row not in flight DOES offer Cancel steer.
    const { unmount } = renderPanel(
      [steerRequestedItem("steer-row")],
      stages({}),
    );
    expect(
      within(rowWithText("steer-row text")).getByRole("button", {
        name: "Cancel steer",
      }),
    ).not.toBeNull();
    unmount();

    renderPanel(
      [steerRequestedItem("steer-row")],
      inFlightStages([["steer-row", "cancelling"]]),
    );
    const row = rowWithText("steer-row text");
    expect(within(row).getByText("Cancelling")).not.toBeNull();
    expect(
      within(row).queryByRole("button", { name: "Cancel steer" }),
    ).toBeNull();
  });

  it("renders the buttons and no in-flight pill with the default context", () => {
    renderPanel([queuedItem("plain-row", "Plain text", "pending")], null);

    const row = rowWithText("Plain text");
    for (const name of CONTROL_NAMES) {
      expect(within(row).getByRole("button", { name })).not.toBeNull();
    }
    expect(within(row).getByText("Queued for next turn")).not.toBeNull();
    for (const label of ["Saving", "Requesting steer", "Cancelling"]) {
      expect(within(row).queryByText(label)).toBeNull();
    }
  });
});

describe("a held queue and an in-flight save (finding 9)", () => {
  it("gives a paused row with an in-flight save the in-flight tooltip, not the paused reason", () => {
    const pausedRow = queuedItem("paused-row", "Paused text", "paused");
    const heldQueue: ChatSessionState["queue"] = {
      status: "paused",
      pausedReason: "turn_error",
      items: [pausedRow],
    };

    // The control: not in flight, the pill carries the paused reason.
    const { unmount } = renderPanelWithQueue(heldQueue, stages({}));
    const pausedPill = within(rowWithText("Paused text")).getByText(
      "Paused after an error",
    );
    expect(tooltipTextNear(pausedPill)).toBe(QUEUE_PAUSED_AFTER_ERROR_TOOLTIP);
    unmount();

    renderPanelWithQueue(
      heldQueue,
      stages({ inFlight: new Map([["paused-row", "saving"]]) }),
    );
    const savingPill = within(rowWithText("Paused text")).getByText("Saving");
    expect(tooltipTextNear(savingPill)).toBe(
      "Sent from this device. Waiting for the host to answer.",
    );
  });

  it("shows no Queued for next turn pill on a pending row while the queue is paused, and shows it when idle or running", () => {
    const pendingRow = queuedItem("pending-row", "Pending text", "pending");

    const paused = renderPanelWithQueue(
      { status: "paused", pausedReason: "turn_error", items: [pendingRow] },
      stages({}),
    );
    // The row rendered (the path ran) ...
    expect(rowWithText("Pending text")).not.toBeNull();
    // ... and makes no next-turn promise.
    expect(screen.queryByText("Queued for next turn")).toBeNull();
    paused.unmount();

    const idle = renderPanelWithQueue(
      { status: "idle", items: [pendingRow] },
      stages({}),
    );
    expect(screen.getByText("Queued for next turn")).not.toBeNull();
    idle.unmount();

    renderPanelWithQueue(
      { status: "running", items: [pendingRow] },
      stages({}),
    );
    expect(screen.getByText("Queued for next turn")).not.toBeNull();
  });
});
