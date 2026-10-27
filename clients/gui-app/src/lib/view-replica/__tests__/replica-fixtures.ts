import { IDBFactory } from "fake-indexeddb";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  HostNotificationsCloudFeedRowV15,
  HostNotificationsCloudFeedSummary,
} from "@traycer/protocol/host/notifications/contracts";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { ViewReplicaStore } from "@traycer-clients/shared/view-replica/store";

export const ACCOUNT = "user-a";
export const OTHER_ACCOUNT = "user-b";
export const HOST = "host-1";
export const TEAM = "team-1";

/** A store over its own fake IndexedDB, plus a way to open a second one on it. */
export interface ReplicaRig {
  readonly factory: IDBFactory;
  readonly store: ViewReplicaStore;
  readonly reopen: () => ViewReplicaStore;
}

export function createReplicaRig(): ReplicaRig {
  const factory = new IDBFactory();
  const open = (): ViewReplicaStore =>
    new ViewReplicaStore(
      createIndexedDbViewReplicaBackend(() => factory, "replica-test"),
    );
  return { factory, store: open(), reopen: open };
}

/** A History row; `teamId` makes it a row the viewer sees through that team. */
export function taskLight(id: string, teamId: string | null): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: id,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: ACCOUNT,
        version: "1.0.0",
      },
      permission:
        teamId === null
          ? null
          : {
              role: "owner",
              accessType: "organization",
              organizationId: teamId,
              grantedBy: ACCOUNT,
              grantedAt: 0,
            },
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned: false,
  };
}

export function taskIds(page: ListTasksResponse): readonly string[] {
  return page.tasks.flatMap((task) => {
    const id = task.epic?.light?.id;
    return id === undefined ? [] : [id];
  });
}

export function historyPage(
  tasks: readonly ListTaskLight[],
): ListTasksResponse {
  return {
    tasks: [...tasks],
    hasMore: true,
    nextCursor: "cursor-1",
    completeness: {
      cloudPage: "settled",
      facets: "server",
      localRows: "present",
      sort: "server",
    },
  };
}

export const FEED_SUMMARY: HostNotificationsCloudFeedSummary = {
  totalCount: 2,
  unreadCount: 2,
  attentionCount: 0,
};

export function feedRow(entryId: string): HostNotificationsCloudFeedRowV15 {
  return {
    entryId,
    originHostId: HOST,
    coalesceKey: `agent.stopped:${entryId}`,
    entry: {
      id: entryId,
      updatedAt: 1,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: entryId,
      severity: "info",
      outcome: "errored",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Build agent",
        outcome: "errored",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}
