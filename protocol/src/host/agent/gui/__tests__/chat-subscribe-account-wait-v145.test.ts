import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toCanonicalJsonSchema } from "@traycer/protocol/framework/json-schema-fingerprint";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeV144,
  chatSubscribeV145,
  readChatAccountWait,
  type ChatAccountWait,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

const V145: SchemaVersion = { major: 1, minor: 45 };
const V145_CONTRACT =
  hostStreamRpcRegistry["chat.subscribe"][1].versions[45].contract;
const V144_CONTRACT =
  hostStreamRpcRegistry["chat.subscribe"][1].versions[44].contract;
const recordSchema = z.record(z.string(), z.unknown());
const projectedServerFrameSchema = z
  .object({
    kind: z.string(),
    hasBinaryPayload: z.literal(false),
  })
  .passthrough();
const SOURCE = { providerId: "provider-a", profileId: "profile-a" };

function asRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}

function wait(
  reason: ChatAccountWait["reason"],
  source: ChatAccountWait["source"],
): ChatAccountWait {
  return { reason, source };
}

function windowedSnapshotFrame(accountWait: unknown): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
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
      queue: { status: "idle", items: [] },
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
      accountWait,
    },
  };
}

function turnStateChangedFrame(accountWait: unknown): Record<string, unknown> {
  return {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    runStatus: "running",
    activeTurn: null,
    accountWait,
  };
}

function bodyOf(frame: unknown): unknown {
  const record = asRecord(frame);
  return record.kind === "snapshot" ? record.snapshot : frame;
}

function withoutAccountWait(frame: unknown): Record<string, unknown> {
  const record = asRecord(frame);
  if (record.kind === "snapshot") {
    const snapshot = asRecord(record.snapshot);
    const { accountWait: _removed, ...rest } = snapshot;
    return { ...record, snapshot: rest };
  }
  const { accountWait: _removed, ...rest } = record;
  return rest;
}

function projectedFrame(
  frame: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  const parsed = V145_CONTRACT.serverFrameSchema.parse(frame);
  return projectedServerFrameSchema.parse(parsed);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function schemaDigest(schema: z.ZodType, io: "input" | "output"): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(toCanonicalJsonSchema(schema, { io }))))
    .digest("hex");
}

const FRAME_BUILDERS = [
  ["windowed snapshot", windowedSnapshotFrame],
  ["turnStateChanged", turnStateChangedFrame],
] as const;
const OLD_VERSIONS: Array<SchemaVersion | null> = [
  ...Array.from({ length: 45 }, (_, minor) => ({ major: 1, minor })),
  null,
  { major: 2, minor: 0 },
];
const ALL_VERSIONS: Array<SchemaVersion | null> = [
  ...Array.from({ length: 46 }, (_, minor) => ({ major: 1, minor })),
  null,
  { major: 2, minor: 0 },
];

describe("chat.subscribe@1.45 account wait", () => {
  describe.each(FRAME_BUILDERS)("%s", (_name, frameOf) => {
    it.each(["needs-sign-in", "removed", "waiting-for-traycer"] as const)(
      "reads %s with a named source",
      (reason) => {
        const parsed = V145_CONTRACT.serverFrameSchema.parse(
          frameOf(wait(reason, SOURCE)),
        );

        expect(readChatAccountWait(bodyOf(parsed))).toEqual({
          reason,
          source: SOURCE,
        });
      },
    );

    it.each(["needs-sign-in", "removed", "waiting-for-traycer"] as const)(
      "reads %s with an unresolved source",
      (reason) => {
        const parsed = V145_CONTRACT.serverFrameSchema.parse(
          frameOf(wait(reason, null)),
        );

        expect(readChatAccountWait(bodyOf(parsed))).toEqual({
          reason,
          source: null,
        });
      },
    );

    it("keeps the frame and treats an unknown reason as no wait", () => {
      const frame = frameOf({ reason: "not-a-reason", source: SOURCE });
      const parsed = V145_CONTRACT.serverFrameSchema.parse(frame);

      expect(readChatAccountWait(bodyOf(frame))).toBeNull();
      expect(readChatAccountWait(bodyOf(parsed))).toBeNull();
    });

    it("keeps the frame and treats a malformed value as no wait", () => {
      const frame = frameOf({ reason: "removed" });
      const parsed = V145_CONTRACT.serverFrameSchema.parse(frame);

      expect(readChatAccountWait(bodyOf(frame))).toBeNull();
      expect(readChatAccountWait(bodyOf(parsed))).toBeNull();
    });

    it.each([
      ["providerId", { providerId: "", profileId: "profile-a" }],
      ["profileId", { providerId: "provider-a", profileId: "" }],
    ] as const)("keeps the frame when source.%s is empty", (_field, source) => {
      const frame = frameOf(wait("removed", source));
      const parsed = V145_CONTRACT.serverFrameSchema.parse(frame);

      expect(readChatAccountWait(bodyOf(frame))).toBeNull();
      expect(readChatAccountWait(bodyOf(parsed))).toBeNull();
    });

    it("accepts explicit null as no wait", () => {
      const frame = frameOf(null);
      const parsed = V145_CONTRACT.serverFrameSchema.parse(frame);

      expect(readChatAccountWait(bodyOf(frame))).toBeNull();
      expect(readChatAccountWait(bodyOf(parsed))).toBeNull();
    });

    it("clears the wait when the next body omits the key", () => {
      const keyedFrame = frameOf(wait("needs-sign-in", SOURCE));
      const withoutKeyFrame = withoutAccountWait(
        frameOf(wait("needs-sign-in", SOURCE)),
      );
      const keyed = V145_CONTRACT.serverFrameSchema.parse(keyedFrame);
      const withoutKey = V145_CONTRACT.serverFrameSchema.parse(withoutKeyFrame);

      expect(readChatAccountWait(bodyOf(keyed))).toEqual({
        reason: "needs-sign-in",
        source: SOURCE,
      });
      expect(readChatAccountWait(bodyOf(withoutKey))).toBeNull();
    });
  });

  it("keeps the 1.44 server-frame schema fingerprints from base 9f996844f", () => {
    expect(schemaDigest(chatSubscribeV144.serverFrameSchema, "input")).toBe(
      "7d53f0c4df986f8be88431976868668536e95678414ccac11c2c7274c6c8d03d",
    );
    expect(schemaDigest(chatSubscribeV144.serverFrameSchema, "output")).toBe(
      "debfa0f22ae45fb0695de0d543d9bc7714973487dce2674f9fc1938b7611dccf",
    );
  });

  it("registers 1.45 as latest with the 1.44 open request and client frames", () => {
    const stream = hostStreamRpcRegistry["chat.subscribe"][1];

    expect(stream.latestMinor).toBe(45);
    expect(stream.versions[45].contract).toBe(chatSubscribeV145);
    expect(chatSubscribeV145.openRequestSchema).toBe(
      chatSubscribeV144.openRequestSchema,
    );
    expect(chatSubscribeV145.clientFrameSchema).toBe(
      chatSubscribeV144.clientFrameSchema,
    );
    expect(chatSubscribeV145.schemaVersion).toEqual(V145);
  });

  it.each(FRAME_BUILDERS)(
    "1.44 parses %s while omitting accountWait from the body",
    (_name, frameOf) => {
      const frame = frameOf(wait("needs-sign-in", SOURCE));
      const parsed = V144_CONTRACT.serverFrameSchema.parse(frame);

      expect(
        Object.prototype.hasOwnProperty.call(bodyOf(parsed), "accountWait"),
      ).toBe(false);
    },
  );

  it.each(FRAME_BUILDERS)(
    "strips accountWait from %s for old versions without changing other keys",
    (_name, frameOf) => {
      const original = projectedFrame(frameOf(wait("removed", SOURCE)));
      const expected = withoutAccountWait(original);

      for (const negotiated of OLD_VERSIONS) {
        expect(projectChatServerFrameForVersion(original, negotiated)).toEqual(
          expected,
        );
      }
      expect(projectChatServerFrameForVersion(original, V145)).toEqual(
        original,
      );
    },
  );

  it.each(FRAME_BUILDERS)(
    "leaves %s without accountWait unchanged for every version",
    (_name, frameOf) => {
      const frame = projectedFrame(
        withoutAccountWait(frameOf(wait("removed", SOURCE))),
      );

      for (const negotiated of ALL_VERSIONS) {
        expect(projectChatServerFrameForVersion(frame, negotiated)).toEqual(
          frame,
        );
      }
    },
  );
});
