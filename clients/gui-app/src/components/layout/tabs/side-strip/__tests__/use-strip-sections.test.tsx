/**
 * `useStripSections` reads the REAL cloud notification feed (prompts and
 * unread outcomes), the real activity store and the strip's indicator context
 * the way `strip-task-agents.test.tsx` does, and hands back the entries the
 * Activity view draws. The strip's items are plain data: the hook reads five
 * controller fields and nothing else.
 */
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HostNotificationsCloudFeedRowV11,
  HostNotificationsIndicatorState,
} from "@traycer/protocol/host/notifications/contracts";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import {
  createChatSessionStore,
  type ChatSessionState,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
} from "@/stores/notifications/needs-you-items";
import {
  tabItemId,
  tabRefKey,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import type { TabGroups } from "@/stores/tabs/tab-groups";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { StripNeedsYouContext } from "../strip-needs-you-context";
import type { StripSectionEntry } from "../strip-sections";
import { useStripSections } from "../use-strip-sections";
import { chatProjection, coolAllEpics, warmEpic } from "./warm-epic-fixture";

const NO_FLAGS: HostNotificationsIndicatorState = {
  pendingApproval: false,
  pendingInterview: false,
  pendingFork: false,
  unreadFailure: false,
  unreadDone: false,
};

function epicTab(epicId: string): HeaderTab {
  return {
    kind: "epic",
    id: `tab-${epicId}`,
    epicId,
    hostId: null,
    route: `/epics/${epicId}`,
    name: epicId,
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
  };
}

function refOf(tab: HeaderTab): TabRef {
  return { kind: tab.kind, id: tab.id };
}

function tabItem(tab: HeaderTab): StripItem {
  const ref = refOf(tab);
  return { kind: "tab", id: tabItemId(ref), ref };
}

function splitItem(left: HeaderTab, right: HeaderTab): SplitStripItem {
  return {
    kind: "split",
    id: "split-1",
    left: { kind: "tab", ref: refOf(left) },
    right: { kind: "tab", ref: refOf(right) },
    focusedSide: "left",
    routeBackingSide: "left",
    leftRatio: 0.5,
  };
}

function cloudRow(input: {
  readonly entryId: string;
  readonly at: number;
  readonly epicId: string;
  readonly entry:
    | {
        readonly kind: "approval.requested" | "interview.requested";
        readonly agentTitle: string;
      }
    | { readonly kind: "agent.stopped"; readonly failed: boolean };
}): HostNotificationsCloudFeedRowV11 {
  const { entryId, at, epicId, entry } = input;
  const chatId = `chat-${entryId}`;
  const base = {
    id: entryId,
    updatedAt: at,
    readAt: null,
    sourceRef: entryId,
    epicId,
    chatId,
  };
  const presentation = { epicTitle: epicId, chatTitle: null };
  if (entry.kind === "agent.stopped") {
    return {
      entryId,
      originHostId: "host-a",
      coalesceKey: `agent.stopped:${chatId}`,
      entry: {
        ...base,
        kind: "agent.stopped",
        severity: entry.failed ? "failure" : "done",
        outcome: entry.failed ? "errored" : "completed",
        payload: {
          kind: "chat",
          epicId,
          chatId,
          agentName: `Agent ${entryId}`,
          taskTitle: epicId,
          outcome: entry.failed ? "errored" : "completed",
        },
      },
      presentation,
    };
  }
  return {
    entryId,
    originHostId: "host-a",
    coalesceKey: `${entry.kind}:${chatId}`,
    entry: {
      ...base,
      kind: entry.kind,
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload:
        entry.kind === "approval.requested"
          ? {
              kind: "approval",
              epicId,
              chatId,
              chatTitle: entry.agentTitle,
              taskTitle: epicId,
              approvalId: entryId,
            }
          : {
              kind: "interview",
              epicId,
              chatId,
              chatTitle: entry.agentTitle,
              taskTitle: epicId,
              interviewBlockId: "block-1",
            },
    },
    presentation: { epicTitle: epicId, chatTitle: entry.agentTitle },
  };
}

/**
 * The strip's one needs-you read, as `StripNeedsYouScope` splits it (which the
 * strip-boundary suite drives for real): the prompts by task, and `rowless`,
 * the prompts of tasks outside `withRow`, which the hook files as Needs you
 * entries of their own.
 */
function NeedsYouReads(props: {
  readonly withRow: ReadonlySet<string>;
  readonly children: ReactNode;
}): ReactNode {
  const items = useNeedsYouItems();
  const byEpic = groupNeedsYouByEpic(items);
  const nested = [...props.withRow].flatMap(
    (epicId) => byEpic.get(epicId) ?? [],
  );
  return (
    <StripNeedsYouContext.Provider
      value={{
        byEpic,
        rowless: items.filter((item) => !nested.includes(item)),
      }}
    >
      {props.children}
    </StripNeedsYouContext.Provider>
  );
}

function wrapperOf(
  epics: Readonly<Record<string, HostNotificationsIndicatorState>>,
  withRow: ReadonlySet<string>,
) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return createElement(
      NotificationFeedModeContext.Provider,
      { value: "cloud" },
      <NotificationIndicatorsProvider indicators={{ epics, chats: {} }}>
        <NeedsYouReads withRow={withRow}>{props.children}</NeedsYouReads>
      </NotificationIndicatorsProvider>,
    );
  };
}

/** The entry's key: a strip item's id, or the feed row of a task without one. */
function keyOf(entry: StripSectionEntry): string {
  return entry.kind === "tabs"
    ? entry.itemId
    : `prompt:${entry.item.row.feedId}`;
}

const COMMAND_APPROVAL: ChatSessionState["pendingApprovals"][number] = {
  kind: "tool",
  approvalId: "approval-1",
  toolName: "bash",
  description: "Run a command",
  input: null,
  planId: null,
  actions: [],
  requestedAt: 1,
  reason: null,
  reviewing: null,
};

/** A warm chat session of `epicId`, waiting on an approval or, with `null`, on nothing. */
function setChatApproval(
  epicId: string,
  chatId: string,
  approval: ChatSessionState["pendingApprovals"][number] | null,
): void {
  const registry = __getChatSessionRegistryForTests();
  const key = { epicId, chatId, hostId: "host-a", scopeKey: "strip-sections" };
  const handle = registry.acquire(key, () =>
    createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: "host-a",
      epicId,
      chatId,
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    }),
  );
  handle.store.setState({
    pendingApprovals: approval === null ? [] : [approval],
  });
}

beforeEach(() => {
  useCloudNotificationsStore.getState().reset();
});

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
  coolAllEpics();
  __resetAgentActivityStoreForTests();
  useCloudNotificationsStore.getState().reset();
});

describe("useStripSections", () => {
  it("sorts the strip into its four sections, keeps tab order within each and files a task without a row at the end of Needs you", () => {
    const idle = epicTab("epic-idle");
    const working = epicTab("epic-working");
    const needsApproval = epicTab("epic-approval");
    const background = epicTab("epic-background");
    const doneInGroup = epicTab("epic-done");
    const needsReply = epicTab("epic-reply");
    const splitIdle = epicTab("epic-split-idle");
    const splitFailed = epicTab("epic-split-failed");
    const tabs = [
      idle,
      working,
      needsApproval,
      background,
      doneInGroup,
      needsReply,
      splitIdle,
      splitFailed,
    ];
    const layoutItems = [
      tabItem(idle),
      tabItem(working),
      tabItem(needsApproval),
      tabItem(background),
      tabItem(doneInGroup),
      tabItem(needsReply),
      splitItem(splitIdle, splitFailed),
    ];
    const groups: TabGroups = {
      "group-1": { name: "Later", color: "#8ab4f8", collapsed: true },
    };
    __setAgentActivityStateForTests(
      {
        "epic-working": { working: ["agent-1"], turn: ["agent-1"] },
        "epic-background": { working: ["agent-2"], turn: [] },
      },
      "local",
      "connected",
    );
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [
          // The newer request is the later tab: order follows the strip, not the clock.
          cloudRow({
            entryId: "approval",
            at: 2_000,
            epicId: "epic-approval",
            entry: { kind: "approval.requested", agentTitle: "Deploy agent" },
          }),
          cloudRow({
            entryId: "reply",
            at: 3_000,
            epicId: "epic-reply",
            entry: { kind: "interview.requested", agentTitle: "Design agent" },
          }),
          cloudRow({
            entryId: "orphan",
            at: 100,
            epicId: "epic-orphan",
            entry: { kind: "approval.requested", agentTitle: "Orphan agent" },
          }),
          cloudRow({
            entryId: "done",
            at: 5_000,
            epicId: "epic-done",
            entry: { kind: "agent.stopped", failed: false },
          }),
          cloudRow({
            entryId: "failed",
            at: 6_000,
            epicId: "epic-split-failed",
            entry: { kind: "agent.stopped", failed: true },
          }),
        ],
        summary: { totalCount: 5, unreadCount: 5, attentionCount: 3 },
        version: 1,
      });
    });

    const { result } = renderHook(
      () =>
        useStripSections({
          headerItemIds: layoutItems.map((item) => item.id),
          layoutItems,
          groups,
          customizations: {
            [tabRefKey(refOf(doneInGroup))]: {
              color: null,
              icon: null,
              groupId: "group-1",
            },
          },
          tabs,
        }),
      {
        wrapper: wrapperOf(
          {
            "epic-approval": { ...NO_FLAGS, pendingApproval: true },
            "epic-reply": { ...NO_FLAGS, pendingInterview: true },
            "epic-done": { ...NO_FLAGS, unreadDone: true },
            "epic-split-failed": { ...NO_FLAGS, unreadFailure: true },
          },
          new Set(
            tabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
          ),
        ),
      },
    );

    expect(
      result.current.map(({ section, entries }) => ({
        section,
        keys: entries.map(keyOf),
      })),
    ).toEqual([
      {
        section: "needs-you",
        keys: [
          tabItemId(refOf(needsApproval)),
          tabItemId(refOf(needsReply)),
          "prompt:cloud:orphan",
        ],
      },
      {
        section: "to-review",
        keys: [tabItemId(refOf(doneInGroup)), "split-1"],
      },
      {
        section: "working",
        keys: [tabItemId(refOf(working)), tabItemId(refOf(background))],
      },
      { section: "idle", keys: [tabItemId(refOf(idle))] },
    ]);

    const entryOf = (key: string): StripSectionEntry => {
      const found = result.current
        .flatMap(({ entries }) => entries)
        .find((entry) => keyOf(entry) === key);
      if (found === undefined) throw new Error(`no entry ${key}`);
      return found;
    };
    const rowsOf = (key: string) => {
      const entry = entryOf(key);
      return entry.kind === "tabs"
        ? entry.members.map((member) => member.row)
        : [entry.row];
    };
    expect(rowsOf(tabItemId(refOf(needsApproval)))).toEqual([
      {
        section: "needs-you",
        reason: "approval",
        agentTitle: "Deploy agent",
        count: 1,
        createdAt: 2_000,
      },
    ]);
    expect(rowsOf("prompt:cloud:orphan")).toEqual([
      {
        section: "needs-you",
        reason: "approval",
        agentTitle: "Orphan agent",
        count: 1,
        createdAt: 100,
      },
    ]);
    // A collapsed group's member is listed, carrying its group.
    expect(entryOf(tabItemId(refOf(doneInGroup)))).toMatchObject({
      kind: "tabs",
      group: { id: "group-1", name: "Later", color: "#8ab4f8", taskCount: 1 },
    });
    expect(entryOf(tabItemId(refOf(idle)))).toMatchObject({ group: null });
    expect(rowsOf(tabItemId(refOf(doneInGroup)))).toEqual([
      { section: "to-review", outcome: "done", at: 5_000 },
    ]);
    // A split pair is one entry, in the section of its more urgent half.
    const pair = entryOf("split-1");
    expect(pair.section).toBe("to-review");
    expect(rowsOf("split-1").map((row) => row.section)).toEqual([
      "idle",
      "to-review",
    ]);
    expect(rowsOf(tabItemId(refOf(working)))).toEqual([
      {
        section: "working",
        agents: { turn: 1, background: 0, coverage: "indeterminate" },
      },
    ]);
  });

  it("puts a task whose warm session is waiting on an approval in Needs you, with no prompt notification behind it", () => {
    const tab = epicTab("epic-gated");
    const layoutItems = [tabItem(tab)];
    warmEpic("epic-gated", [chatProjection("chat-gated", {})]);
    act(() => {
      setChatApproval("epic-gated", "chat-gated", COMMAND_APPROVAL);
    });

    const { result } = renderHook(
      () =>
        useStripSections({
          headerItemIds: layoutItems.map((item) => item.id),
          layoutItems,
          groups: undefined,
          customizations: undefined,
          tabs: [tab],
        }),
      { wrapper: wrapperOf({}, new Set(["epic-gated"])) },
    );

    expect(
      result.current.map(({ section, entries }) => ({
        section,
        keys: entries.map(keyOf),
      })),
    ).toEqual([{ section: "needs-you", keys: [tabItemId(refOf(tab))] }]);
    const [needsYou] = result.current;
    expect(needsYou.entries[0]).toMatchObject({
      members: [
        {
          row: {
            section: "needs-you",
            reason: "approval",
            agentTitle: null,
            count: 0,
            createdAt: null,
          },
        },
      ],
    });

    // The gate resolves: the task leaves Needs you without any notification change.
    act(() => {
      setChatApproval("epic-gated", "chat-gated", null);
    });
    expect(result.current.map(({ section }) => section)).toEqual(["idle"]);
  });
});
