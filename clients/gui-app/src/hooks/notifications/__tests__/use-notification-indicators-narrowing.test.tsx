/**
 * Pins notification narrowing: an unrelated entity's cloud row must not
 * re-render a consumer, disabled/local paths must never read the cloud
 * projection, and two entities under one provider must narrow independently.
 * Full mixed/local-mode semantics stay owned by `use-notification-indicators-query.test.tsx`.
 */
import { memo, useLayoutEffect, useState, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationsCloudFeedRow } from "@traycer/protocol/host/notifications/contracts";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import type {
  NotificationIndicatorState,
  SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

const feedMode = vi.hoisted<{ value: "local" | "cloud" }>(() => ({
  value: "cloud",
}));

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-feed-mode")
    >();
  return {
    ...actual,
    useNotificationFeedMode: () => feedMode.value,
    useNotificationFeedModeSettling: () => false,
  };
});

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    hostId: "host-a",
  }),
}));

import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";

function approvalRow(input: {
  readonly entryId: string;
  readonly chatId: string;
  readonly originHostId: string;
}): HostNotificationsCloudFeedRow {
  return {
    entryId: input.entryId,
    originHostId: input.originHostId,
    coalesceKey: `approval.requested:${input.chatId}`,
    entry: {
      id: input.entryId,
      updatedAt: 1_000,
      readAt: null,
      kind: "approval.requested",
      sourceRef: input.entryId,
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      epicId: EPIC_ID,
      chatId: input.chatId,
      payload: {
        kind: "approval",
        epicId: EPIC_ID,
        chatId: input.chatId,
        approvalId: input.entryId,
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function applyCloudSnapshot(
  rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
  version: number,
): void {
  act(() => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows,
      version,
      summary: {
        totalCount: rows.length,
        unreadCount: rows.length,
        attentionCount: rows.length,
      },
    });
  });
}

let renders = 0;

// `chats` is filtered to ids the host has actually answered for, so a
// pending first response leaves this id absent - the record's index
// signature does not carry `| undefined`, but the runtime does. Routed
// through a function so the read's type is this declared return type,
// not the record's (wrong) non-optional value type re-derived at the
// call site.
function readChatIndicator(
  chats: SurfaceNotificationIndicators["chats"],
  chatId: string,
): NotificationIndicatorState | undefined {
  return chats[chatId];
}

function IndicatorProbe(props: {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}): ReactNode {
  // Counts committed renders, not render attempts: a mutation during the
  // render body itself is an impure side effect, and this test's counts are
  // specifically about what actually reached the DOM.
  useLayoutEffect(() => {
    renders += 1;
  });
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds: props.epicIds,
    chatIds: props.chatIds,
    enabled: props.enabled,
  });
  const chat = readChatIndicator(indicators.chats, CHAT_ID);
  return (
    <span data-testid="chat-flag">
      {chat?.pendingApproval ? "approval" : "none"}
    </span>
  );
}

afterEach(() => {
  cleanup();
  renders = 0;
  feedMode.value = "cloud";
  useCloudNotificationsStore.setState(
    useCloudNotificationsStore.getInitialState(),
    true,
  );
});

describe("useNotificationIndicators render isolation", () => {
  it("does not re-render for an unrelated entity's row, and lights only the requested one", () => {
    render(<IndicatorProbe epicIds={[]} chatIds={[CHAT_ID]} enabled />);
    expect(screen.getByTestId("chat-flag").textContent).toBe("none");
    const afterMount = renders;

    // Unrequested chat - stays quiet.
    applyCloudSnapshot(
      [
        approvalRow({
          entryId: "entry-other",
          chatId: "chat-other",
          originHostId: "host-a",
        }),
      ],
      1,
    );
    expect(renders).toBe(afterMount);
    expect(screen.getByTestId("chat-flag").textContent).toBe("none");

    // Requested chat lighting - re-renders and reads off the projection.
    applyCloudSnapshot(
      [
        approvalRow({
          entryId: "entry-other",
          chatId: "chat-other",
          originHostId: "host-a",
        }),
        approvalRow({
          entryId: "entry-mine",
          chatId: CHAT_ID,
          originHostId: "host-a",
        }),
      ],
      2,
    );
    expect(renders).toBeGreaterThan(afterMount);
    expect(screen.getByTestId("chat-flag").textContent).toBe("approval");
  });

  it("never reads the cloud projection when disabled or in local mode", () => {
    // Local mode.
    feedMode.value = "local";
    render(<IndicatorProbe epicIds={[]} chatIds={[CHAT_ID]} enabled />);
    const afterLocalMount = renders;
    applyCloudSnapshot(
      [approvalRow({ entryId: "e1", chatId: CHAT_ID, originHostId: "host-a" })],
      1,
    );
    expect(renders).toBe(afterLocalMount);
    expect(screen.getByTestId("chat-flag").textContent).toBe("none");
    cleanup();
    renders = 0;

    // Disabled in cloud mode.
    feedMode.value = "cloud";
    render(<IndicatorProbe epicIds={[]} chatIds={[CHAT_ID]} enabled={false} />);
    const afterDisabledMount = renders;
    applyCloudSnapshot(
      [approvalRow({ entryId: "e2", chatId: CHAT_ID, originHostId: "host-a" })],
      2,
    );
    expect(renders).toBe(afterDisabledMount);
    expect(screen.getByTestId("chat-flag").textContent).toBe("none");
  });
});

const providerRenders: Record<string, number> = {};

// Memoized so a sibling's update can't be masked by the parent's own re-render.
const EntityProbe = memo(function EntityProbe(props: {
  readonly chatId: string;
}): ReactNode {
  // Counts committed renders, not render attempts - same reasoning as
  // `IndicatorProbe` above.
  useLayoutEffect(() => {
    providerRenders[props.chatId] = (providerRenders[props.chatId] ?? 0) + 1;
  });
  const state = useSurfaceNotificationIndicatorState(
    { epicId: EPIC_ID, chatId: props.chatId },
    null,
  );
  return (
    <span data-testid={`flag-${props.chatId}`}>
      {state.pendingApproval ? "approval" : "none"}
    </span>
  );
});

function emptyIndicators(): SurfaceNotificationIndicators {
  return { epics: {}, chats: {} };
}

describe("NotificationIndicatorsProvider per-entity narrowing", () => {
  it("re-renders only the entity whose flags actually changed", () => {
    providerRenders["chat-1"] = 0;
    providerRenders["chat-2"] = 0;
    const initial = emptyIndicators();
    const view = render(
      <NotificationIndicatorsProvider indicators={initial}>
        <EntityProbe chatId="chat-1" />
        <EntityProbe chatId="chat-2" />
      </NotificationIndicatorsProvider>,
    );
    const afterMountOne = providerRenders["chat-1"];
    const afterMountTwo = providerRenders["chat-2"];

    const chat2Lit: SurfaceNotificationIndicators = {
      epics: {},
      chats: {
        "chat-2": {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: false,
          unreadDone: false,
        },
      },
    };
    view.rerender(
      <NotificationIndicatorsProvider indicators={chat2Lit}>
        <EntityProbe chatId="chat-1" />
        <EntityProbe chatId="chat-2" />
      </NotificationIndicatorsProvider>,
    );

    expect(screen.getByTestId("flag-chat-2").textContent).toBe("approval");
    expect(providerRenders["chat-2"]).toBeGreaterThan(afterMountTwo);
    // chat-1's own flags never changed - must not fan out to it.
    expect(screen.getByTestId("flag-chat-1").textContent).toBe("none");
    expect(providerRenders["chat-1"]).toBe(afterMountOne);
  });

  it("hands a consumer that mounts in the commit of a change the new state at its first render", () => {
    const firstReads: string[] = [];
    const Late = (): ReactNode => {
      const state = useSurfaceNotificationIndicatorState(
        { epicId: EPIC_ID, chatId: "chat-late" },
        null,
      );
      // What the first render saw, whatever it sees later.
      const [first] = useState(state.pendingApproval ? "approval" : "none");
      useLayoutEffect(() => {
        firstReads.push(first);
      }, [first]);
      return null;
    };
    const lit: SurfaceNotificationIndicators = {
      epics: {},
      chats: {
        "chat-late": {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: false,
          unreadDone: false,
        },
      },
    };
    const view = render(
      <NotificationIndicatorsProvider indicators={emptyIndicators()}>
        {null}
      </NotificationIndicatorsProvider>,
    );
    // A task that moves section remounts its row in the commit that changes
    // its state: the row's waiting pulse is keyed on seeing the state CHANGE
    // after mount, so it must not see the old state first.
    view.rerender(
      <NotificationIndicatorsProvider indicators={lit}>
        <Late />
      </NotificationIndicatorsProvider>,
    );

    expect(firstReads).toEqual(["approval"]);
  });
});
