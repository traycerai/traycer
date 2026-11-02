import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HostNotificationsCloudFeedRowV16 } from "@traycer/protocol/host/notifications/contracts";
import type { NotificationShowOutcome } from "@traycer-clients/shared/platform/runner-host";
import { projectNotificationFeedDisplay } from "@traycer-clients/shared/notifications/feed-delivery";
import type { NotificationShowRequest } from "@/hooks/notifications/use-notifications";
import {
  displayCloudSnapshotArrivals,
  displayHostChannelEmission,
  resetNotificationFeedDisplayReceiptsForTests,
} from "@/lib/notifications/notification-display";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
  type HostNotificationFeedEntry,
} from "@/stores/notifications/host-notifications-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  useMergedNotificationRows,
  type NotificationBellState,
  useMergedNotificationUnreadCount,
  useNotificationBellState,
} from "@/stores/notifications/merged-notifications";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-feed-mode")
    >();
  return {
    ...actual,
    useNotificationFeedMode: () => "cloud",
    useNotificationFeedModeSettling: () => false,
  };
});
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => "host-1",
  useNotificationResolveHost: () => ({ hostId: "host-1", client: null }),
}));

interface CapturedToast {
  readonly title: ReactNode;
}
const toastCalls = vi.hoisted((): CapturedToast[] => []);
vi.mock("sonner", () => ({
  toast: (title: ReactNode, options: { readonly id: string }): string => {
    toastCalls.push({ title });
    return options.id;
  },
}));

const AGENT_ID = "agent-failure";
const PRESENTATION = { epicTitle: "Epic", chatTitle: "Chat" } as const;

function cloudRow(
  entry: HostNotificationFeedEntry,
): HostNotificationsCloudFeedRowV16 {
  return {
    entryId: entry.id,
    originHostId: "host-cloud",
    coalesceKey: `${entry.kind}:${entry.id}`,
    entry,
    presentation: PRESENTATION,
  };
}

function agentFailureEntry(id: string): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: 100,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "failure",
    outcome: "errored",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: "Task",
      outcome: "errored",
    },
  };
}

const BASE = {
  updatedAt: 10,
  readAt: null,
  epicId: null,
  chatId: null,
} as const;

/** `host.operation.finished` row of a non-agent producer, told apart by its payload. */
function operationEntry(
  id: string,
  payload: Record<string, unknown>,
): HostNotificationFeedEntry {
  return {
    ...BASE,
    id,
    kind: "host.operation.finished",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    payload,
  };
}

const PACK_PAYLOAD = {
  hostId: "host-1",
  hostLabel: "dev-box",
  title: "Provider pack",
  message: "A provider pack changed.",
} as const;

/** One factory per kind the notification center no longer carries. */
const DROPPED_CASES: ReadonlyArray<{
  readonly name: string;
  readonly make: (id: string) => HostNotificationFeedEntry;
}> = [
  {
    name: "environment.move.stalled",
    make: (id) => ({
      ...BASE,
      id,
      kind: "environment.move.stalled",
      sourceRef: id,
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "environment_move_stalled",
        environmentId: "env-1",
        hostId: "host-1",
        hostName: "studio",
        remaining: 3,
        reason: "offline",
      },
    }),
  },
  {
    name: "team.pods.full",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.pods.full",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_pods_full",
        environmentId: "env-1",
        teamName: "Acme",
        podCount: 4,
      },
    }),
  },
  {
    name: "team.member.removed",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.member.removed",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_member_removed",
        environmentId: "env-1",
        teamName: "Acme",
        memberName: "Sam",
        hosts: [
          {
            hostId: "host-1",
            hostName: "Build host",
            stopped: "done",
            credentialClosed: "done",
            replacementDelivered: "done",
          },
        ],
      },
    }),
  },
  {
    name: "team.member.joined",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.member.joined",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_member_joined",
        environmentId: "env-1",
        teamName: "Acme",
        memberName: "Sam",
        toNewcomer: false,
      },
    }),
  },
  {
    name: "team.policy.unapplied",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.policy.unapplied",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_policy_unapplied",
        environmentId: "env-1",
        teamName: "Acme",
        policyVersion: 3,
      },
    }),
  },
  {
    name: "team.policy.authority_expired",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.policy.authority_expired",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_policy_authority_expired",
        environmentId: "env-1",
        teamName: "Acme",
        hostId: "host-1",
        hostName: "Build host",
      },
    }),
  },
  {
    name: "team.installing_admin.gone",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.installing_admin.gone",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_installing_admin_gone",
        environmentId: "env-1",
        teamName: "Acme",
        adminName: "Sam",
        reason: "left",
      },
    }),
  },
  {
    name: "team.plan.unlinked",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.plan.unlinked",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_plan_unlinked",
        environmentId: "env-1",
        teamName: "Acme",
      },
    }),
  },
  {
    name: "team.host.returned",
    make: (id) => ({
      ...BASE,
      id,
      kind: "team.host.returned",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "team_host_returned",
        environmentId: "env-1",
        teamName: "Acme",
        hostName: "studio",
      },
    }),
  },
  {
    name: "secret.rotated",
    make: (id) => ({
      ...BASE,
      id,
      kind: "secret.rotated",
      sourceRef: id,
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "secret_rotated",
        secretName: "DB_PASSWORD",
        secretId: "secret-1",
        environmentId: "env-1",
        rotationId: "rotation-1",
        state: "enforced",
        evidence: [
          {
            producer: "gateway-1",
            workerClass: "postgres",
            hostId: null,
            hostName: null,
            status: "acknowledged",
            evidence: [{ kind: "session_closed", count: 3 }],
          },
        ],
      },
    }),
  },
  {
    name: "secret.removed",
    make: (id) => ({
      ...BASE,
      id,
      kind: "secret.removed",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "secret_removed",
        environmentId: "env-1",
        secretName: "DB_PASSWORD",
        outcome: "cleanup_requested",
      },
    }),
  },
  {
    name: "secret.export.minted",
    make: (id) => ({
      ...BASE,
      id,
      kind: "secret.export.minted",
      sourceRef: id,
      severity: "info",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "secret_export_minted",
        secretName: "DEPLOY_KEY",
        exportKind: "presigned_url",
        expiresAt: 1_700_000_900_000,
        hostId: "host-1",
        epicId: "epic-1",
        chatId: "chat-1",
      },
    }),
  },
  {
    name: "notification.hooks.removed",
    make: (id) => ({
      ...BASE,
      id,
      kind: "notification.hooks.removed",
      sourceRef: `hook-removal:${id}`,
      severity: "info",
      outcome: "completed",
      payload: {
        kind: "notification_hooks_removed",
        hostId: "host-1",
        hostName: "dev-box",
        count: 2,
      },
    }),
  },
  {
    name: "host.operation.finished / worktree.deletion",
    make: (id) =>
      operationEntry(id, {
        kind: "worktree_deletion",
        operation: "worktree.deletion",
        title: "Worktrees deleted",
        message: "Deleted 2 worktrees.",
        commandId: "command-1",
        source: "manual",
        requestedCount: 2,
        deletedCount: 2,
        failedCount: 0,
      }),
  },
  {
    name: "host.operation.finished / worktree.autoCleanup",
    make: (id) =>
      operationEntry(id, {
        kind: "worktree_auto_cleanup",
        operation: "worktree.autoCleanup",
        title: "Worktrees cleaned up",
        message: "Removed 3 worktrees.",
        runId: "run-1",
        hostId: "host-1",
        deletedCount: 3,
        skippedCount: 0,
        failedCount: 0,
        interruptedCount: 0,
      }),
  },
  {
    name: "host.operation.finished / session.import.outputs",
    make: (id) =>
      operationEntry(id, {
        kind: "session_import_outputs_incomplete",
        operation: "session.import.outputs",
        title: "Import finished with gaps",
        message: "Some outputs could not be imported.",
      }),
  },
  {
    name: "host.operation.finished / provider.pack.update_available",
    make: (id) =>
      operationEntry(id, {
        kind: "provider_pack_update_available",
        operation: "provider.pack.update_available",
        ...PACK_PAYLOAD,
      }),
  },
  {
    name: "host.operation.finished / provider.pack.security_floor",
    make: (id) =>
      operationEntry(id, {
        kind: "provider_pack_security_floor",
        operation: "provider.pack.security_floor",
        ...PACK_PAYLOAD,
      }),
  },
  {
    name: "host.operation.finished / provider.pack.pin_lifecycle",
    make: (id) =>
      operationEntry(id, {
        kind: "provider_pack_pin_lifecycle",
        operation: "provider.pack.pin_lifecycle",
        ...PACK_PAYLOAD,
      }),
  },
];

function droppedEntries(): HostNotificationFeedEntry[] {
  return DROPPED_CASES.map((c, index) => c.make(`dropped-${index}`));
}

/**
 * The one non-agent kind the center still carries: a member is told their own
 * role moved, the way a task's collaborators are told theirs did.
 */
function roleChangedEntry(id: string): HostNotificationFeedEntry {
  return {
    ...BASE,
    id,
    kind: "team.role.changed",
    sourceRef: id,
    severity: "info",
    outcome: "completed",
    payload: {
      kind: "team_role_changed",
      environmentId: "env-1",
      teamName: "Acme",
      from: "editor",
      to: "admin",
    },
  };
}

function applyHost(
  entries: ReadonlyArray<HostNotificationFeedEntry>,
  summary: { readonly unreadCount: number; readonly attentionCount: number },
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries, nextCursor: null },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function readCenter() {
  return renderHook(() => ({
    sourceIds: useMergedNotificationRows().map((row) => row.sourceId),
    bell: useNotificationBellState(),
    unread: useMergedNotificationUnreadCount(),
  })).result.current;
}

function resetStores(): void {
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  __resetNotificationsStoreForTests();
  useCloudNotificationsStore.getState().reset();
  applyHost([], { unreadCount: 0, attentionCount: 0 });
}

/** What a feed summary counts as attention: unread prompts and failures. */
function attentionCount(rows: readonly HostNotificationFeedEntry[]): number {
  return rows.filter(
    (row) => row.severity === "needs_action" || row.severity === "failure",
  ).length;
}

describe("the notification center carries agent states only", () => {
  beforeEach(resetStores);

  afterEach(() => {
    cleanup();
    useCloudNotificationsStore.getState().reset();
  });

  // Each summary counts the dropped rows too, as the feed's own does: the
  // bell and the unread count must come out as the one agent row alone.
  const ONE_AGENT_FAILURE = {
    sourceIds: [AGENT_ID],
    bell: { kind: "attention", count: 1 },
    unread: 1,
  };

  it("drops every non-agent kind and operation from a cloud snapshot", () => {
    const rows = [agentFailureEntry(AGENT_ID), ...droppedEntries()];
    useCloudNotificationsStore.getState().applySnapshot({
      rows: rows.map(cloudRow),
      summary: {
        totalCount: rows.length,
        unreadCount: rows.length,
        attentionCount: attentionCount(rows),
      },
      version: 3,
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  it("drops every non-agent kind and operation from a cloud replica seed", () => {
    const rows = [agentFailureEntry(AGENT_ID), ...droppedEntries()];
    useCloudNotificationsStore.getState().seedFromReplica({
      accountId: "user-a",
      rows: rows.map(cloudRow),
      summary: {
        totalCount: rows.length,
        unreadCount: rows.length,
        attentionCount: attentionCount(rows),
      },
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  it("drops every non-agent kind and operation a host still holds", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 3,
    });
    const rows = [agentFailureEntry(AGENT_ID), ...droppedEntries()];
    applyHost(rows, {
      unreadCount: rows.length,
      attentionCount: attentionCount(rows),
    });

    expect(readCenter()).toEqual(ONE_AGENT_FAILURE);
  });

  // The owner's named exception. A role change is a membership state, so it is
  // read in the center and counted unread like the task-sharing tell it mirrors;
  // what it never does is announce itself (see the live-emission suite below).
  it("keeps a role change, counted unread beside the agent row", () => {
    const rows = [agentFailureEntry(AGENT_ID), roleChangedEntry("role-kept")];
    useCloudNotificationsStore.getState().applySnapshot({
      rows: rows.map(cloudRow),
      summary: {
        totalCount: rows.length,
        unreadCount: rows.length,
        attentionCount: attentionCount(rows),
      },
      version: 3,
    });

    expect(readCenter()).toEqual({
      sourceIds: [AGENT_ID, "role-kept"],
      // `info` is news, not something to act on, so the bell stays on the
      // failure's tier and the role change only raises the unread count.
      bell: { kind: "attention", count: 1 },
      unread: 2,
    });
  });

  it("keeps a role change a host still holds", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 3,
    });
    const rows = [roleChangedEntry("role-held"), ...droppedEntries()];
    applyHost(rows, {
      unreadCount: rows.length,
      attentionCount: attentionCount(rows),
    });

    expect(readCenter()).toEqual({
      sourceIds: ["role-held"],
      // Unread but nothing to act on, so the bell is the quiet dot rather than
      // a count — the same state the task-sharing tell puts it in.
      bell: { kind: "quietDot" },
      unread: 1,
    });
  });
});

describe("live emission shows agent states only", () => {
  beforeEach(() => {
    toastCalls.length = 0;
    resetNotificationFeedDisplayReceiptsForTests();
    // The in-app toast only renders in a focused window.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function displayTarget() {
    return {
      showNotification: vi.fn((input: NotificationShowRequest) =>
        Promise.resolve<NotificationShowOutcome>({
          kind: "feed",
          outcome: "undeliverable",
          display: projectNotificationFeedDisplay(input.feedOccurrences ?? []),
        }),
      ),
      playChime: vi.fn(),
      onToastClick: vi.fn(),
    };
  }

  it.each(DROPPED_CASES)("shows nothing for $name", async ({ make }) => {
    const target = displayTarget();

    await displayHostChannelEmission([make("dropped-live")], target, "host-1");

    expect(target.showNotification).not.toHaveBeenCalled();
    expect(target.playChime).not.toHaveBeenCalled();
    expect(toastCalls).toHaveLength(0);
  });

  // Held and shown in the center, announced on neither live lane. The cloud lane
  // needs its own case: an arrival is a row the store already KEPT, so the read
  // policy cannot be what keeps it quiet.
  it("announces a role change nowhere, whichever lane it arrives on", async () => {
    const fromHost = displayTarget();
    await displayHostChannelEmission(
      [roleChangedEntry("role-live-host")],
      fromHost,
      "host-1",
    );

    const fromCloud = displayTarget();
    await displayCloudSnapshotArrivals(
      [cloudRow(roleChangedEntry("role-live-cloud"))],
      fromCloud,
    );

    for (const target of [fromHost, fromCloud]) {
      expect(target.showNotification).not.toHaveBeenCalled();
      expect(target.playChime).not.toHaveBeenCalled();
    }
    expect(toastCalls).toHaveLength(0);
  });

  it("shows the agent failure and only it from a mixed emission", async () => {
    const target = displayTarget();

    await displayHostChannelEmission(
      [agentFailureEntry(AGENT_ID), ...droppedEntries()],
      target,
      "host-1",
    );

    expect(target.showNotification).toHaveBeenCalledOnce();
    const call = target.showNotification.mock.calls[0][0];
    expect(call.feedOccurrences).toHaveLength(1);
    expect(call.feedOccurrences?.[0]?.replaceKey).toBe("host:chat:chat-1");
    expect(call.payload).toMatchObject({
      feed: { source: "host", id: AGENT_ID },
    });
    expect(toastCalls).toHaveLength(1);
  });
});

/**
 * PIN, green on the base and after the fix: the rows of the AGENT
 * `host.operation.finished` producers keep showing and counting.
 */
describe("agent operation rows still show in the notification center", () => {
  beforeEach(resetStores);

  afterEach(() => {
    cleanup();
    useCloudNotificationsStore.getState().reset();
  });

  function agentOperationEntries(): HostNotificationFeedEntry[] {
    return [
      {
        ...BASE,
        id: "op-managed-command",
        updatedAt: 40,
        kind: "host.operation.finished",
        sourceRef: "command-3",
        severity: "needs_action",
        outcome: "completed",
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "managed_command_delivery_parked",
          operation: "managed-command.delivery",
          title: "Command output is waiting",
          message:
            "A managed command finished but the chat couldn't receive it.",
          commandId: "command-3",
          epicId: "epic-1",
          chatId: "chat-1",
        },
      },
      {
        ...BASE,
        id: "op-fork-resolution",
        updatedAt: 30,
        kind: "host.operation.finished",
        sourceRef: "fork-1",
        severity: "info",
        outcome: "completed",
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "chat_fork_resolution",
          operation: "chat.fork.resolution",
          title: "Fork needs a decision",
          message: "Two forks of this chat diverged.",
        },
      },
      {
        ...BASE,
        id: "op-bot-verdict",
        updatedAt: 20,
        kind: "host.operation.finished",
        sourceRef: "reply-1",
        severity: "done",
        outcome: "completed",
        epicId: "bot-1",
        chatId: "thread-1",
        payload: {
          kind: "bot_thread_verdict",
          operation: "bot.thread.verdict",
          title: "Tracy answered",
          message: "Your question about the release",
          botId: "bot-1",
          threadId: "thread-1",
          replyMessageId: "reply-1",
        },
      },
      agentFailureEntry(AGENT_ID),
    ];
  }

  // Newest first. Attention: the failure, the parked delivery and the bot
  // answer; unread: all four.
  const EXPECTED = {
    rows: [
      { sourceId: AGENT_ID },
      { sourceId: "op-managed-command" },
      { sourceId: "op-fork-resolution" },
      { sourceId: "op-bot-verdict" },
    ],
    titles: {
      "op-managed-command": [
        "Command output is waiting",
        "A managed command finished but the chat couldn't receive it.",
      ],
      "op-fork-resolution": [
        "Fork needs a decision",
        "Two forks of this chat diverged.",
      ],
      "op-bot-verdict": ["Tracy answered", "Your question about the release"],
    },
    bell: { kind: "attention", count: 3 },
    unread: 4,
  } as const;

  interface CenterRows {
    readonly rows: ReadonlyArray<{
      readonly sourceId: string;
      readonly title: string;
      readonly body: string;
    }>;
    readonly bell: NotificationBellState;
    readonly unread: number;
  }

  function readRows(): CenterRows {
    return renderHook(() => ({
      rows: useMergedNotificationRows().map((row) => ({
        sourceId: row.sourceId,
        title: row.title,
        body: row.body,
      })),
      bell: useNotificationBellState(),
      unread: useMergedNotificationUnreadCount(),
    })).result.current;
  }

  function expectAgentRows(center: CenterRows): void {
    expect(center.rows.map((row) => row.sourceId)).toEqual(
      EXPECTED.rows.map((row) => row.sourceId),
    );
    for (const [sourceId, [title, body]] of Object.entries(EXPECTED.titles)) {
      expect(
        center.rows.find((row) => row.sourceId === sourceId),
      ).toMatchObject({ title, body });
    }
    expect(center.bell).toEqual(EXPECTED.bell);
    expect(center.unread).toBe(EXPECTED.unread);
  }

  it("keeps them in a cloud snapshot", () => {
    const rows = agentOperationEntries();
    useCloudNotificationsStore.getState().applySnapshot({
      // No resolved titles, so the rows render the hosts' own copy.
      rows: rows.map((entry) => ({
        ...cloudRow(entry),
        presentation: { epicTitle: null, chatTitle: null },
      })),
      summary: { totalCount: 4, unreadCount: 4, attentionCount: 3 },
      version: 3,
    });

    expectAgentRows(readRows());
  });

  it("keeps them when a host holds them", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 3,
    });
    applyHost(agentOperationEntries(), { unreadCount: 4, attentionCount: 3 });

    expectAgentRows(readRows());
  });
});
