import { getRecordSchema } from "@traycer/protocol/framework/index";
import { chatSyncAssistantMessageSchema } from "@traycer/protocol/persistence/chat-sync/entries";
import { encodeChatHead } from "@traycer/protocol/persistence/chat-sync/head";
import {
  canonicalizeJsonValue,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  snapshotChatEventSchema,
  snapshotContentBlockSchema,
  snapshotProviderNoticeMetadataSchema,
  snapshotUserMessageSchema,
} from "@traycer/protocol/persistence/chat-sync/open-harness";
import { encodeChatShard } from "@traycer/protocol/persistence/chat-sync/shard";
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import {
  contentBlockSchema,
  providerNoticeMetadataSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  assistantMessageSchema,
  userMessageSchema,
} from "@traycer/protocol/persistence/epic/messages";
import {
  persistenceRecordRegistry,
  type ChatHead,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Harness ids in this contract are open strings.
 *
 * The epic tree spells them as a closed enum, which is right for a record read
 * by the host that wrote it. Here it would mean that shipping a new harness
 * makes every chat on it unreadable to every already-shipped cloud renderer and
 * clone target: the message `role` is known, so the passthrough carrier hands
 * the message to the known schema, which then rejects on the enum and takes the
 * whole shard with it.
 *
 * These tests pin both halves of the fix - that an unrecognized id parses and
 * round-trips, and that no closed harness-id leaf sneaks back in.
 */

const chatHeadSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-head",
  "latest",
);
const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

// A harness that does not exist in any shipped enum.
const FUTURE_HARNESS = "warpcore";

const futureSender: JsonObject = {
  type: "agent",
  harnessId: FUTURE_HARNESS,
  agentId: "agent-future",
  displayName: "Warp Core",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const noticeTextBlock: JsonObject = {
  blockId: "b-notice",
  status: "completed",
  timestamp: 20,
  type: "text",
  text: "model rerouted",
  parentBlockId: null,
  providerNotice: {
    harnessId: FUTURE_HARNESS,
    noticeKind: "model_rerouted",
    tone: "info",
    title: "Rerouted",
    message: null,
    details: [],
    metadata: {
      type: "model_rerouted",
      fromModel: "a",
      toModel: "b",
      reason: "capacity",
    },
  },
};

const planBlock: JsonObject = {
  blockId: "b-plan",
  status: "completed",
  timestamp: 21,
  type: "plan",
  parentBlockId: null,
  planStatus: "ready",
  planId: "plan-1",
  harnessId: FUTURE_HARNESS,
  source: {
    harnessId: FUTURE_HARNESS,
    sessionId: null,
    turnId: null,
    kind: "native",
  },
  title: null,
  summary: null,
  markdownPreview: "",
  fullContentRef: null,
  steps: [],
  actions: [],
  approvalId: null,
  supersededByPlanId: null,
  metadata: null,
};

const steerBlock: JsonObject = {
  blockId: "b-steer",
  status: "completed",
  timestamp: 22,
  type: "steer",
  parentBlockId: null,
  queueItemId: "q-1",
  messageId: "m-steer",
  content: { type: "doc" },
  mode: "safe_point",
  sender: futureSender,
};

const futureSettings: JsonObject = {
  harnessId: FUTURE_HARNESS,
  model: "wc-1",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const futureEvent: JsonObject = {
  eventId: "e-1",
  type: "turn.started",
  timestamp: 3,
  clientActionId: null,
  actor: futureSender,
  message: null,
  turnId: null,
  messageId: null,
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "info",
  metadata: null,
};

const futureHarnessShard: JsonObject = {
  schemaVersion: { major: 1, minor: 2 },
  chatId: "chat-future",
  section: "messages",
  messages: [
    {
      role: "user",
      messageId: "m-user",
      sender: futureSender,
      message: {
        kind: "agent",
        content: { type: "doc" },
        fromAgentId: "agent-future",
        senderTitle: null,
        senderHarnessId: FUTURE_HARNESS,
        reply: { expectsReply: false },
      },
      timestamp: 1,
      sessionAnchor: null,
    },
    {
      role: "assistant",
      messageId: "m-assistant",
      sender: futureSender,
      blocks: [noticeTextBlock, planBlock, steerBlock],
      startedAt: null,
      timestamp: 2,
      turnId: null,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
    },
  ],
  events: [],
  hostPrivate: null,
};

const futureHarnessHead: JsonObject = {
  schemaVersion: { major: 1, minor: 2 },
  parentHeadSha256: null,
  throughRecordSeq: 7,
  capturedAt: 1_700_000_000_000,
  minReaderVersion: { major: 1, minor: 2 },
  cdc: {
    algorithm: "fastcdc-gear-v1",
    mask: 65_535,
    target: 65_536,
    min: 16_384,
    max: 262_144,
  },
  core: {
    chatId: "chat-future",
    parentChatId: null,
    ownerUserId: "u-1",
    originHostId: "host-1",
    title: "On a harness you have never heard of",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    lifecycle: { state: "active", archivedAt: null, deletedAt: null },
    settings: futureSettings,
  },
  messageShards: [],
  events: [futureEvent],
  eventShards: [],
  hostPrivate: { revision: 0, data: {} },
  hostPrivateShard: null,
};

function parseShard(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

function parseHead(value: JsonObject): ChatHead {
  return chatHeadSchema.parse(value);
}

describe("chat-sync open harness ids", () => {
  it("parses a chat running on a harness this build has never heard of", () => {
    const shard = parseShard(futureHarnessShard);
    const head = parseHead(futureHarnessHead);

    expect(head.core.settings?.harnessId).toBe(FUTURE_HARNESS);
    // Every entry is interpreted - not degraded to unknown-variant passthrough,
    // which would lose the rendering entirely.
    expect(shard.messages.every((message) => message.value !== null)).toBe(true);
    expect(head.events?.every((event) => event.value !== null)).toBe(true);
  });

  it("exposes the raw id on the value side so a renderer can label it", () => {
    const shard = parseShard(futureHarnessShard);

    const assistant = shard.messages[1].value;
    if (assistant === null || assistant.role !== "assistant") {
      throw new Error("expected an interpreted assistant message");
    }
    expect(assistant.sender.harnessId).toBe(FUTURE_HARNESS);

    const user = shard.messages[0].value;
    if (user === null || user.role !== "user") {
      throw new Error("expected an interpreted user message");
    }
    expect(user.sender.type).toBe("agent");
    if (user.sender.type !== "agent") return;
    expect(user.sender.harnessId).toBe(FUTURE_HARNESS);

    const notice = assistant.blocks[0].value;
    if (notice === null || notice.type !== "text") {
      throw new Error("expected an interpreted text block");
    }
    expect(notice.providerNotice?.harnessId).toBe(FUTURE_HARNESS);

    const plan = assistant.blocks[1].value;
    if (plan === null || plan.type !== "plan") {
      throw new Error("expected an interpreted plan block");
    }
    expect(plan.harnessId).toBe(FUTURE_HARNESS);
    expect(plan.source.harnessId).toBe(FUTURE_HARNESS);

    const steer = assistant.blocks[2].value;
    if (steer === null || steer.type !== "steer") {
      throw new Error("expected an interpreted steer block");
    }
    expect(steer.sender?.type).toBe("agent");
    if (steer.sender?.type !== "agent") return;
    expect(steer.sender.harnessId).toBe(FUTURE_HARNESS);

    const actor = parseHead(futureHarnessHead).events?.[0].value?.actor;
    expect(actor?.type).toBe("agent");
    if (actor?.type !== "agent") return;
    expect(actor.harnessId).toBe(FUTURE_HARNESS);
  });

  it("re-emits an unknown-harness publication losslessly", () => {
    expect(encodeChatShard(parseShard(futureHarnessShard))).toEqual(
      canonicalizeJsonValue(futureHarnessShard),
    );
    expect(encodeChatHead(parseHead(futureHarnessHead))).toEqual(
      canonicalizeJsonValue(futureHarnessHead),
    );
  });

  it("still rejects an empty harness id", () => {
    expect(() =>
      parseHead({
        ...futureHarnessHead,
        core: {
          ...(futureHarnessHead.core as JsonObject),
          settings: { ...futureSettings, harnessId: "" },
        },
      }),
    ).toThrow();
  });
});

/**
 * Session anchors are session-chain state, so the partition puts them in the
 * opaque `hostPrivate` section rather than the presentation core.
 *
 * The anchor union discriminates on `harnessId` with a per-variant literal, so
 * it could not be reopened without forking every variant - and while it sat on
 * the core user message, a NON-NULL anchor from a newly added harness rejected
 * the whole record: `role: "user"` is known, so the passthrough hands the
 * message to the known schema, which fails on the discriminator.
 */
describe("chat-sync session anchors", () => {
  const futureAnchor: JsonObject = {
    harnessId: FUTURE_HARNESS,
    hostId: "host-1",
    sessionId: "s-future",
    sessionWorkspaceSnapshot: { workspaceFolders: [] },
    createdAt: 5,
    coveredUntilMessageId: null,
    profileId: null,
    labelSnapshot: null,
    accountUuid: null,
    accentColor: null,
  };

  const anchoredShard: JsonObject = {
    ...futureHarnessShard,
    messages: [
      {
        role: "user",
        messageId: "m-anchored",
        sender: { type: "user", userId: "u-1" },
        message: { kind: "user", content: { type: "doc" } },
        timestamp: 1,
        // A writer that leaves an anchor on the message: unmodeled, so it rides
        // the preserved `raw` instead of reaching a schema that could reject it.
        sessionAnchor: futureAnchor,
      },
    ],
  };

  it("does not reject a shard whose message carries a future-harness anchor", () => {
    // Interpreted, not degraded to unknown-variant passthrough.
    expect(parseShard(anchoredShard).messages[0].value).not.toBeNull();
  });

  it("round-trips that anchor losslessly, on the message and in hostPrivate", () => {
    expect(encodeChatShard(parseShard(anchoredShard))).toEqual(
      canonicalizeJsonValue(anchoredShard),
    );

    const anchoredHostPrivate: JsonObject = {
      ...futureHarnessHead,
      hostPrivate: {
        revision: 1,
        data: { sessionAnchorsByMessageId: { "m-anchored": futureAnchor } },
      },
    };
    expect(encodeChatHead(parseHead(anchoredHostPrivate))).toEqual(
      canonicalizeJsonValue(anchoredHostPrivate),
    );
  });

  it("keeps sessionAnchor out of the interpreted core message", () => {
    const message = parseShard(anchoredShard).messages[0].value;
    if (message === null || message.role !== "user") {
      throw new Error("expected an interpreted user message");
    }
    expect("sessionAnchor" in message).toBe(false);
  });
});

describe("chat-sync harness-id leaf sweep", () => {
  // Round-tripped through JSON so the walker below sees plain data: Zod's
  // emitted schema can carry `undefined`-valued keys, which are not JSON.
  const surfaces: readonly JsonValue[] = [chatHeadSchema, chatShardSchema].map(
    (schema) =>
      jsonValueSchema.parse(
        JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "output" }))),
      ),
  );

  function walkJsonSchema(
    visit: (node: JsonObject, path: string, key: string) => void,
  ): void {
    const walk = (node: JsonValue, path: string, key: string): void => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) =>
          walk(entry, `${path}/${index}`, String(index)),
        );
        return;
      }
      if (typeof node !== "object" || node === null) return;

      visit(node, path, key);
      for (const [childKey, child] of Object.entries(node)) {
        walk(child, `${path}/${childKey}`, childKey);
      }
    };

    for (const [index, surface] of surfaces.entries()) {
      walk(surface, `#${index}`, "");
    }
  }

  /**
   * Structural check: any property NAMED for a harness must be an open string.
   * Deliberately value-blind - an earlier version keyed off the literal
   * `"claude"`, so a future closed subset (or a bare `z.literal("codex")`)
   * would have walked straight past it.
   */
  it("spells every harness-named property as an open string", () => {
    const closed: string[] = [];
    const inspected: string[] = [];

    walkJsonSchema((node, path, key) => {
      if (!/harness/i.test(key)) return;
      // `properties` is the only place a schema hangs under its own name;
      // anything else (a `required` entry, say) is not a schema node.
      if (!path.includes("/properties/")) return;
      inspected.push(path);
      const serialized = JSON.stringify(node);
      if (serialized.includes('"enum"') || serialized.includes('"const"')) {
        closed.push(path);
      }
    });

    expect(closed).toEqual([]);
    // Non-vacuity: a rename or a restructure that stopped the walker finding
    // any harness property at all would otherwise leave this guard green while
    // guarding nothing.
    expect(inspected.length).toBeGreaterThan(4);
  });

  /**
   * Value-based backstop for a harness enum hiding at a property NOT named for
   * a harness. Expects zero: with session anchors in `hostPrivate`, neither
   * record has any closed harness vocabulary left.
   */
  it("carries no closed harness vocabulary anywhere in either record", () => {
    const leaves: string[] = [];

    walkJsonSchema((node, path) => {
      const values = node.enum;
      if (Array.isArray(values) && values.includes("claude")) leaves.push(path);
      if (node.const === "claude") leaves.push(path);
    });

    expect(leaves).toEqual([]);
  });
});

describe("chat-sync derived schema forks", () => {
  // Two bases carry `superRefine` checks, which blocks Zod's own derivation
  // helpers for a WIDENING replacement, so both spread the base's live shape
  // into a fresh object and re-apply the check. These assertions pin that the
  // spread really is from the live shape - names AND schemas - so an upstream
  // field type change cannot leave a same-named fork stale.

  /**
   * Asserts a fork carries exactly the base's fields minus `dropped`, and that
   * every field outside `replaced` is the SAME schema object as the base's -
   * which is the property a name-only comparison misses.
   */
  function expectDerivedFrom(
    fork: object,
    base: object,
    replaced: readonly string[],
    dropped: readonly string[],
  ): void {
    const forkFields = new Map(Object.entries(fork));
    const baseFields = new Map(Object.entries(base));

    expect([...forkFields.keys()].sort()).toEqual(
      [...baseFields.keys()].filter((field) => !dropped.includes(field)).sort(),
    );

    for (const [field, schema] of baseFields) {
      if (replaced.includes(field) || dropped.includes(field)) continue;
      expect(forkFields.get(field)).toBe(schema);
    }
  }

  it("keeps the user message bound to the epic schema's live fields", () => {
    // `sessionAnchor` is dropped on purpose: it moved to `hostPrivate`.
    expectDerivedFrom(
      snapshotUserMessageSchema.shape,
      userMessageSchema.shape,
      ["sender"],
      ["sessionAnchor"],
    );
  });

  it("still enforces sender.type === message.kind", () => {
    const mismatched = {
      role: "user",
      messageId: "m-1",
      sender: { type: "user", userId: "u-1" },
      message: {
        kind: "agent",
        content: { type: "doc" },
        fromAgentId: "a-1",
        senderTitle: null,
        senderHarnessId: null,
        reply: { expectsReply: false },
      },
      timestamp: 1,
    };

    expect(() => snapshotUserMessageSchema.parse(mismatched)).toThrow();
  });

  it("keeps the provider notice bound to the epic schema's live fields", () => {
    expectDerivedFrom(
      snapshotProviderNoticeMetadataSchema.shape,
      providerNoticeMetadataSchema.shape,
      ["harnessId"],
      [],
    );
  });

  it("keeps the assistant message bound to the epic schema's live fields", () => {
    expectDerivedFrom(
      chatSyncAssistantMessageSchema.shape,
      assistantMessageSchema.shape,
      ["sender", "blocks"],
      [],
    );
  });

  it("still enforces noticeKind === metadata.type", () => {
    const mismatched: JsonObject = {
      ...noticeTextBlock,
      providerNotice: {
        harnessId: FUTURE_HARNESS,
        noticeKind: "safety_buffering",
        tone: "info",
        title: "Rerouted",
        message: null,
        details: [],
        metadata: {
          type: "model_rerouted",
          fromModel: "a",
          toModel: "b",
          reason: "capacity",
        },
      },
    };

    expect(() => snapshotContentBlockSchema.parse(mismatched)).toThrow();
  });

  it("keeps the chat event bound to the epic schema's live fields", () => {
    expectDerivedFrom(
      snapshotChatEventSchema.shape,
      chatEventSchema.shape,
      ["actor"],
      [],
    );
  });
});

describe("chat-sync content-block union parity", () => {
  function unionDiscriminants(schema: z.ZodType, key: string): string[] {
    const jsonSchema = z.parse(
      z.object({
        anyOf: z
          .array(
            z.object({
              properties: z.object({ [key]: z.object({ const: z.string() }) }),
            }),
          )
          .optional(),
        oneOf: z
          .array(
            z.object({
              properties: z.object({ [key]: z.object({ const: z.string() }) }),
            }),
          )
          .optional(),
      }),
      z.toJSONSchema(schema, { io: "input" }),
    );
    const options = jsonSchema.anyOf ?? jsonSchema.oneOf ?? [];
    return options.map((option) => option.properties[key].const).sort();
  }

  it("mirrors every member of the epic content-block union", () => {
    // The chat-sync union re-lists members so three of them can be reopened. A
    // new epic block type must be added to that list too, or it silently
    // degrades to unknown-variant passthrough here.
    expect(unionDiscriminants(snapshotContentBlockSchema, "type")).toEqual(
      unionDiscriminants(contentBlockSchema, "type"),
    );
  });
});
