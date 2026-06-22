import * as Y from "yjs";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils";
import type { TypedYMap, YCreateInput } from "@traycer/protocol/utils/yjs-utils";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
  type NotificationEvent,
} from "./notification-entry";

export const NOTIFICATION_ROOM_PREFIX = "notifications";
export const NOTIFICATIONS_ARRAY_KEY = "notifications";

type NotificationEventKind = NotificationEvent["kind"];

/** Shared fields for all comment event payloads stored in Yjs. */
interface CommentEventPayloadBase {
  epicId: string;
  artifactType: string;
  artifactId: string;
  threadId: string;
  actorName: string;
}

type NotificationRoomEventPayloadByKind = {
  [NOTIFICATION_EVENT_TYPES.INVITED]: {
    epicId: string;
    actorName: string;
  };
  [NOTIFICATION_EVENT_TYPES.ROLE_CHANGED]: {
    epicId: string;
    actorName: string;
    newRole: string;
  };
  [NOTIFICATION_EVENT_TYPES.REVOKED]: {
    epicId: string;
    actorName: string;
  };
  [NOTIFICATION_EVENT_TYPES.THREAD_CREATED]: CommentEventPayloadBase;
  [NOTIFICATION_EVENT_TYPES.COMMENT_ADDED]: CommentEventPayloadBase;
  [NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED]: CommentEventPayloadBase;
  [NOTIFICATION_EVENT_TYPES.THREAD_DELETED]: CommentEventPayloadBase;
};

export interface NotificationRoomEntryRecord {
  id: string;
  createdAt: number;
  readAt: number | null;
  kind: NotificationEventKind;
  invited?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.INVITED];
  roleChanged?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.ROLE_CHANGED];
  revoked?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.REVOKED];
  threadCreated?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_CREATED];
  commentAdded?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.COMMENT_ADDED];
  threadResolved?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED];
  threadDeleted?: NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_DELETED];
}

export type NotificationRoomEntryMap = TypedYMap<NotificationRoomEntryRecord>;
export type NotificationRoomEntryCreateInput =
  YCreateInput<NotificationRoomEntryRecord>;
export type NotificationRoomEntriesArray = Y.Array<NotificationRoomEntryMap>;

export function getNotificationRoomId(userId: string): string {
  return `${NOTIFICATION_ROOM_PREFIX}:${userId}`;
}

export function createNotificationRoomEntry(
  entry: NotificationEntry,
): NotificationRoomEntryCreateInput {
  switch (entry.event.kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        invited: {
          epicId: entry.event.epicId,
          actorName: entry.event.actorName,
        },
      };
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        roleChanged: {
          epicId: entry.event.epicId,
          actorName: entry.event.actorName,
          newRole: entry.event.newRole,
        },
      };
    case NOTIFICATION_EVENT_TYPES.REVOKED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        revoked: {
          epicId: entry.event.epicId,
          actorName: entry.event.actorName,
        },
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        threadCreated: {
          epicId: entry.event.epicId,
          artifactType: entry.event.artifactType,
          artifactId: entry.event.artifactId,
          threadId: entry.event.threadId,
          actorName: entry.event.actorName,
        },
      };
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        commentAdded: {
          epicId: entry.event.epicId,
          artifactType: entry.event.artifactType,
          artifactId: entry.event.artifactId,
          threadId: entry.event.threadId,
          actorName: entry.event.actorName,
        },
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        threadResolved: {
          epicId: entry.event.epicId,
          artifactType: entry.event.artifactType,
          artifactId: entry.event.artifactId,
          threadId: entry.event.threadId,
          actorName: entry.event.actorName,
        },
      };
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED:
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        readAt: entry.readAt,
        kind: entry.event.kind,
        threadDeleted: {
          epicId: entry.event.epicId,
          artifactType: entry.event.artifactType,
          artifactId: entry.event.artifactId,
          threadId: entry.event.threadId,
          actorName: entry.event.actorName,
        },
      };
  }
}

export function createNotificationRoomEntryMap(
  entry: NotificationEntry,
): NotificationRoomEntryMap {
  return createTypedMap<NotificationRoomEntryRecord>(
    createNotificationRoomEntry(entry),
  );
}

export function parseNotificationRoomEntry(
  entry: Readonly<NotificationRoomEntryMap>,
): NotificationEntry | undefined {
  const id = entry.get("id");
  const createdAt = entry.get("createdAt");
  const readAt = entry.get("readAt");
  const kind: unknown = entry.get("kind");

  if (
    typeof id !== "string" ||
    typeof createdAt !== "number" ||
    !isNullableNumber(readAt) ||
    !isNotificationEventKind(kind)
  ) {
    return undefined;
  }

  switch (kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.INVITED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.INVITED]
        >(eventMap)
      ) {
        return undefined;
      }

      const epicId = eventMap.get("epicId");
      const actorName = eventMap.get("actorName");
      if (typeof epicId !== "string" || typeof actorName !== "string") {
        return undefined;
      }

      return {
        id,
        createdAt,
        readAt,
        event: { kind, epicId, actorName },
      };
    }
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.ROLE_CHANGED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.ROLE_CHANGED]
        >(eventMap)
      ) {
        return undefined;
      }

      const epicId = eventMap.get("epicId");
      const actorName = eventMap.get("actorName");
      const newRole = eventMap.get("newRole");
      if (
        typeof epicId !== "string" ||
        typeof actorName !== "string" ||
        typeof newRole !== "string"
      ) {
        return undefined;
      }

      return {
        id,
        createdAt,
        readAt,
        event: { kind, epicId, actorName, newRole },
      };
    }
    case NOTIFICATION_EVENT_TYPES.REVOKED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.REVOKED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.REVOKED]
        >(eventMap)
      ) {
        return undefined;
      }

      const epicId = eventMap.get("epicId");
      const actorName = eventMap.get("actorName");
      if (typeof epicId !== "string" || typeof actorName !== "string") {
        return undefined;
      }

      return {
        id,
        createdAt,
        readAt,
        event: { kind, epicId, actorName },
      };
    }
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.THREAD_CREATED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_CREATED]
        >(eventMap)
      ) {
        return undefined;
      }
      const base = parseCommentEventBase(eventMap);
      if (!base) return undefined;
      return { id, createdAt, readAt, event: { kind, ...base } };
    }
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.COMMENT_ADDED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.COMMENT_ADDED]
        >(eventMap)
      ) {
        return undefined;
      }
      const base = parseCommentEventBase(eventMap);
      if (!base) return undefined;
      return { id, createdAt, readAt, event: { kind, ...base } };
    }
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED]
        >(eventMap)
      ) {
        return undefined;
      }
      const base = parseCommentEventBase(eventMap);
      if (!base) return undefined;
      return { id, createdAt, readAt, event: { kind, ...base } };
    }
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED: {
      const eventMap = entry.get(NOTIFICATION_EVENT_TYPES.THREAD_DELETED);
      if (
        !isTypedYMap<
          NotificationRoomEventPayloadByKind[typeof NOTIFICATION_EVENT_TYPES.THREAD_DELETED]
        >(eventMap)
      ) {
        return undefined;
      }
      const base = parseCommentEventBase(eventMap);
      if (!base) return undefined;
      return { id, createdAt, readAt, event: { kind, ...base } };
    }
  }
}

function isNotificationEventKind(
  value: unknown,
): value is NotificationEventKind {
  return (
    value === NOTIFICATION_EVENT_TYPES.INVITED ||
    value === NOTIFICATION_EVENT_TYPES.ROLE_CHANGED ||
    value === NOTIFICATION_EVENT_TYPES.REVOKED ||
    value === NOTIFICATION_EVENT_TYPES.THREAD_CREATED ||
    value === NOTIFICATION_EVENT_TYPES.COMMENT_ADDED ||
    value === NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED ||
    value === NOTIFICATION_EVENT_TYPES.THREAD_DELETED
  );
}

function parseCommentEventBase(eventMap: TypedYMap<CommentEventPayloadBase>):
  | {
      epicId: string;
      artifactType: "spec" | "ticket" | "story" | "review";
      artifactId: string;
      threadId: string;
      actorName: string;
    }
  | undefined {
  const epicId = eventMap.get("epicId");
  const artifactType = eventMap.get("artifactType");
  const artifactId = eventMap.get("artifactId");
  const threadId = eventMap.get("threadId");
  const actorName = eventMap.get("actorName");
  if (
    typeof epicId !== "string" ||
    typeof artifactType !== "string" ||
    typeof artifactId !== "string" ||
    typeof threadId !== "string" ||
    typeof actorName !== "string" ||
    (artifactType !== "spec" &&
      artifactType !== "ticket" &&
      artifactType !== "story" &&
      artifactType !== "review")
  ) {
    return undefined;
  }
  return { epicId, artifactType, artifactId, threadId, actorName };
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function isTypedYMap<Schema extends object>(
  value: unknown,
): value is TypedYMap<Schema> {
  return value instanceof Y.Map;
}
