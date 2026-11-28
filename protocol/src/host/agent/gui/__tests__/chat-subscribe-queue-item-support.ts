import { createHash } from "node:crypto";
import type { z } from "zod";
import { toCanonicalJsonSchema } from "@traycer/protocol/framework/json-schema-fingerprint";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { ProjectedChatSubscribeServerFrame } from "../chat-frame-compat";

export const line = hostStreamRpcRegistry["chat.subscribe"][1];

export const WORKTREE_INTENT = {
  entries: [
    {
      kind: "worktree",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "polite-turtle",
        source: "main",
        carryUncommittedChanges: false,
        collision: "random",
        retryIdentity: "retry-1",
      },
      scripts: null,
    },
  ],
};

export const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
} as const;

export function promptItem(
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "message-1",
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
    },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5.4",
      permissionMode: "supervised",
      reasoningEffort: "high",
      agentMode: "epic",
    },
    accountContext: { type: "PERSONAL" },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function queueOf(item: Record<string, unknown>): Record<string, unknown> {
  return { status: "idle", items: [item] };
}

export function queueChangedFrame(item: Record<string, unknown>) {
  return { kind: "queueChanged", ...envelope, queue: queueOf(item) };
}

export function snapshotFrame(item: Record<string, unknown>) {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
        settings: null,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: queueOf(item),
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

export const CARRIERS = [
  ["queueChanged", queueChangedFrame],
  ["windowed snapshot", snapshotFrame],
] as const;

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** The first queue item of a server frame, on whichever carrier holds it. */
export function firstItem(frame: unknown): Record<string, unknown> {
  const [item] = itemsOf(frame);
  if (item === undefined) throw new Error("expected a queue item");
  return item;
}

/** Every queue item of a server frame, on whichever carrier holds it. */
export function itemsOf(frame: unknown): Array<Record<string, unknown>> {
  const record = asRecord(frame);
  const queue = asRecord(
    record.kind === "snapshot" ? asRecord(record.snapshot).queue : record.queue,
  );
  if (!Array.isArray(queue.items)) throw new Error("expected queue items");
  return queue.items.map(asRecord);
}

/** The same carrier frame with its queue holding `items` instead. */
export function withQueueItems(
  frame: unknown,
  items: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const record = asRecord(frame);
  if (record.kind === "snapshot") {
    const snapshot = asRecord(record.snapshot);
    return {
      ...record,
      snapshot: { ...snapshot, queue: { ...asRecord(snapshot.queue), items } },
    };
  }
  return { ...record, queue: { ...asRecord(record.queue), items } };
}

/** An item without the named keys. */
export function itemWithout(
  item: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !keys.includes(key)),
  );
}

export function parseOn(
  minor: number,
  frame: unknown,
): Record<string, unknown> {
  const result =
    line.versions[minor].contract.serverFrameSchema.safeParse(frame);
  if (!result.success) throw new Error(`1.${minor} refused the frame`);
  return asRecord(result.data);
}

export function parsesOn(minor: number, frame: unknown): boolean {
  return line.versions[minor].contract.serverFrameSchema.safeParse(frame)
    .success;
}

export function projected(frame: unknown): ProjectedChatSubscribeServerFrame {
  const record = asRecord(frame);
  if (typeof record.kind !== "string") throw new Error("expected a kind");
  return { ...record, kind: record.kind, hasBinaryPayload: false };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function schemaDigest(
  schema: z.ZodType,
  io: "input" | "output",
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(toCanonicalJsonSchema(schema, { io }))))
    .digest("hex");
}

export function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

/** Every negotiated state below `boundary`, and a peer that has not negotiated. */
export function versionsBelow(boundary: number): Array<SchemaVersion | null> {
  return [
    ...Array.from({ length: boundary }, (_, minor) => version(minor)),
    null,
  ];
}

/** Every registered minor from `boundary` through the head. */
export function versionsFrom(boundary: number): SchemaVersion[] {
  return Array.from({ length: line.latestMinor - boundary + 1 }, (_, offset) =>
    version(boundary + offset),
  );
}
