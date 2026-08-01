import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  KNOWN_CHAT_EVENT_TYPES,
  KNOWN_CHAT_MESSAGE_ROLES,
  KNOWN_CONTENT_BLOCK_TYPES,
  chatSyncMessageSchema,
  preserveChatEvent,
  preserveChatMessage,
  preserveContentBlock,
} from "@traycer/protocol/persistence/chat-sync/entries";
import {
  canonicalJsonStringify,
  canonicalizeJsonValue,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  encodeChatShard,
  serializeChatShard,
} from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import { chatEventTypeSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  persistenceRecordRegistry,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Round-trip behavior of the shard's passthrough carrier and residual bags.
 *
 * The contract under test is the one that reclassifies a new content-block type
 * (or message role, or chat-event type) from a breaking persistence change to a
 * minor one: a shipped reader must parse the shard, render what it understands,
 * and re-emit what it does not with its meaning intact.
 *
 * It matters more in v2 than it did for a single-object layout. Shards are
 * CONTENT-ADDRESSED, so a reader that loses a byte on the way through does not
 * merely publish a lossy chat - it mints a different hash for a cohort that
 * never changed, and the diff-by-hash publish re-uploads it.
 */

const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

const textBlock: JsonObject = {
  blockId: "b-text",
  status: "completed",
  timestamp: 10,
  type: "text",
  text: "hello",
  providerNotice: null,
  parentBlockId: null,
};

// Persisted form of an `autonomous_resume` block: wakeup triggers live in the
// additive `wakeTriggers` key, never inline in `triggers`.
const autonomousResumeBlock: JsonObject = {
  blockId: "b-resume",
  status: "completed",
  timestamp: 11,
  type: "autonomous_resume",
  triggers: [],
  wakeTriggers: [
    {
      title: "Scheduled wake",
      status: "completed",
      summary: "woke up",
      blockId: "",
      outputFile: null,
    },
  ],
  parentBlockId: null,
};

// A block type no shipped reader knows, carrying a nested subtree.
const unknownBlock: JsonObject = {
  blockId: "b-future",
  status: "completed",
  timestamp: 12,
  type: "holodeck",
  program: {
    name: "cafe",
    safeties: false,
    characters: ["leah", null, 3],
    nested: { deep: { deeper: [1, { x: "y" }] } },
  },
};

const userMessage: JsonObject = {
  role: "user",
  messageId: "m-user",
  sender: { type: "user", userId: "u-1" },
  message: { kind: "user", content: { type: "doc" } },
  timestamp: 1,
  sessionAnchor: null,
};

const assistantMessage: JsonObject = {
  role: "assistant",
  messageId: "m-assistant",
  sender: {
    type: "agent",
    harnessId: "claude",
    agentId: "agent-1",
    displayName: null,
    reply: { expectsReply: false },
    inReplyTo: null,
  },
  blocks: [textBlock, autonomousResumeBlock, unknownBlock],
  startedAt: null,
  timestamp: 2,
  turnId: null,
  usage: null,
  reasoningEffort: null,
  serviceTier: null,
};

// A message role no shipped reader knows.
const unknownMessage: JsonObject = {
  role: "telemetry",
  messageId: "m-future",
  payload: { samples: [1, 2, 3], nested: { ok: true } },
};

const knownEvent: JsonObject = {
  eventId: "e-1",
  type: "turn.started",
  timestamp: 3,
  clientActionId: null,
  actor: null,
  message: null,
  turnId: null,
  messageId: null,
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "info",
  metadata: null,
};

const unknownEvent: JsonObject = {
  eventId: "e-2",
  type: "warp.engaged",
  timestamp: 4,
  factor: 9.975,
  details: { destination: "risa" },
};

const persistedMessageShard: JsonObject = {
  schemaVersion: { major: 1, minor: 0 },
  chatId: "chat-1",
  section: "messages",
  messages: [userMessage, assistantMessage, unknownMessage],
  events: [],
  hostPrivate: null,
};

const persistedEventShard: JsonObject = {
  schemaVersion: { major: 1, minor: 0 },
  chatId: "chat-1",
  section: "events",
  messages: [],
  events: [knownEvent, unknownEvent],
  hostPrivate: null,
};

function parse(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

describe("chat-shard passthrough", () => {
  it("parses a shard containing variants it does not know", () => {
    const shard = parse(persistedMessageShard);

    expect(shard.messages.map((message) => message.variant)).toEqual([
      "user",
      "assistant",
      "telemetry",
    ]);
    expect(shard.messages[0].value).not.toBeNull();
    expect(shard.messages[1].value).not.toBeNull();
    // Unknown role: preserved, but explicitly not interpreted.
    expect(shard.messages[2].value).toBeNull();

    const events = parse(persistedEventShard).events;
    expect(events.map((event) => event.variant)).toEqual([
      "turn.started",
      "warp.engaged",
    ]);
    expect(events[0].value).not.toBeNull();
    expect(events[1].value).toBeNull();
  });

  it("interprets known blocks and preserves unknown ones inside a known message", () => {
    const assistant = parse(persistedMessageShard).messages[1].value;

    if (assistant === null || assistant.role !== "assistant") {
      throw new Error("expected an interpreted assistant message");
    }

    expect(assistant.blocks.map((block) => block.variant)).toEqual([
      "text",
      "autonomous_resume",
      "holodeck",
    ]);
    expect(assistant.blocks[0].value).not.toBeNull();
    expect(assistant.blocks[2].value).toBeNull();
    // The unknown block's whole subtree survives, at depth.
    expect(assistant.blocks[2].raw).toEqual(canonicalizeJsonValue(unknownBlock));

    // The codec-backed block still decodes to its domain form.
    const resume = assistant.blocks[1].value;
    if (resume === null || resume.type !== "autonomous_resume") {
      throw new Error("expected an interpreted autonomous_resume block");
    }
    expect(resume.triggers).toHaveLength(1);
    expect(resume.triggers[0].kind).toBe("wakeup");
  });

  it("re-emits an unknown block type through decode -> encode byte-identically", () => {
    // The ticket's passthrough-survival case, stated on BYTES rather than on a
    // structural comparison: this is what keeps the cohort's content address
    // stable for a reader that never understood half of it.
    expect(serializeChatShard(parse(persistedMessageShard))).toBe(
      canonicalJsonStringify(persistedMessageShard),
    );
  });

  it("re-emits an unmodeled FIELD through decode -> encode byte-identically", () => {
    // Residual capture's half of the promise: a key a NEWER minor added to a
    // modeled object, at the record level and inside the host-private envelope.
    const withFutureFields: JsonObject = {
      ...persistedEventShard,
      publisherHint: { cohortIndex: 4 },
      hostPrivate: null,
    };

    expect(serializeChatShard(parse(withFutureFields))).toBe(
      canonicalJsonStringify(withFutureFields),
    );

    const graduatedHostPrivate: JsonObject = {
      schemaVersion: { major: 1, minor: 0 },
      chatId: "chat-1",
      section: "host-private",
      messages: [],
      events: [],
      hostPrivate: {
        revision: 2,
        data: { anything: [1, 2] },
        futureEnvelopeField: "kept",
      },
    };

    expect(serializeChatShard(parse(graduatedHostPrivate))).toBe(
      canonicalJsonStringify(graduatedHostPrivate),
    );
  });

  it("survives repeated read/write cycles (the clone path)", () => {
    const once = encodeChatShard(parse(persistedMessageShard));
    const twice = encodeChatShard(parse(once));
    expect(twice).toEqual(once);
  });

  it("rejects a malformed KNOWN variant instead of degrading it to unknown", () => {
    const corrupted: JsonObject = {
      ...persistedMessageShard,
      messages: [{ ...userMessage, sender: { type: "user" } }],
    };

    expect(() => parse(corrupted)).toThrow();
  });

  it("rejects an entry with no string discriminant", () => {
    const corrupted: JsonObject = {
      ...persistedEventShard,
      events: [{ eventId: "e-3" }],
    };

    expect(() => parse(corrupted)).toThrow();
  });
});

describe("chat-shard section coherence", () => {
  it("rejects a shard whose payload contradicts its own section tag", () => {
    // A `"messages"` shard carrying events is a writer bug, and assembling it
    // would silently drop them - so it fails at parse instead.
    expect(() =>
      parse({ ...persistedMessageShard, events: [knownEvent] }),
    ).toThrow();

    expect(() =>
      parse({
        ...persistedEventShard,
        hostPrivate: { revision: 0, data: {} },
      }),
    ).toThrow();
  });

  it("rejects a host-private shard with no envelope", () => {
    expect(() =>
      parse({
        schemaVersion: { major: 1, minor: 0 },
        chatId: "chat-1",
        section: "host-private",
        messages: [],
        events: [],
        hostPrivate: null,
      }),
    ).toThrow();
  });

  it("rejects an empty cohort - a shard IS a cohort", () => {
    // An empty chat is an empty shard list on the HEAD, never an empty shard.
    // The case that forces this: an empty `"events"` shard paired with a head
    // whose `events` are `null` states an impossible graduation - a section
    // that outgrew the head yet holds nothing - and it assembles to
    // `status: "ok"` with an empty log, indistinguishable from a chat that
    // never had events.
    expect(() => parse({ ...persistedMessageShard, messages: [] })).toThrow();
    expect(() => parse({ ...persistedEventShard, events: [] })).toThrow();
  });
});

describe("chat-shard canonical encoding", () => {
  it("is independent of key order", () => {
    const reordered: JsonObject = {
      hostPrivate: persistedMessageShard.hostPrivate,
      events: persistedMessageShard.events,
      messages: persistedMessageShard.messages,
      section: persistedMessageShard.section,
      chatId: persistedMessageShard.chatId,
      schemaVersion: persistedMessageShard.schemaVersion,
    };

    expect(serializeChatShard(parse(reordered))).toBe(
      serializeChatShard(parse(persistedMessageShard)),
    );
  });

  it("emits sorted keys so the bytes are content-addressable", () => {
    const shard = parse(persistedMessageShard);
    const serialized = serializeChatShard(shard);
    expect(serialized).toBe(canonicalJsonStringify(encodeChatShard(shard)));
    expect(serialized.startsWith('{"chatId":')).toBe(true);
  });

  it("stamps the record version this build writes", () => {
    expect(parse(persistedMessageShard).schemaVersion).toEqual(
      CHAT_SYNC_SCHEMA_VERSION,
    );
  });

  /**
   * Canonical form is the schema-NORMALIZED encoding, not in general a byte
   * echo of the input, so the guarantee the contract makes is IDEMPOTENCE -
   * which is what keeps a cohort's sha256 stable across any number of
   * read/write cycles.
   *
   * A shard happens to hit the stronger property too: everything in one is
   * either passthrough-preserved (re-emitted from `raw`, defaults never
   * applied) or has no defaulted modeled field, so a shard's bytes really do
   * survive verbatim. That is a fact about today's shape rather than a promise,
   * which is why it is asserted alongside idempotence and not instead of it -
   * `minReaderVersion` on the head is the counterexample (see the head suite).
   */
  it("is idempotent, so a cohort's content address holds still", () => {
    const withoutDefaults: JsonObject = {
      ...persistedMessageShard,
      messages: [
        {
          ...assistantMessage,
          blocks: [
            {
              blockId: "b-text",
              status: "completed",
              timestamp: 10,
              type: "text",
              text: "hello",
              parentBlockId: null,
              // `providerNotice` is absent - it is `.default(null)` upstream,
              // so this is a valid stored block. It stays absent, because the
              // block rides the passthrough carrier's `raw`.
            },
          ],
        },
      ],
    };

    const once = encodeChatShard(parse(withoutDefaults));
    expect(once).toEqual(canonicalizeJsonValue(withoutDefaults));

    const twice = encodeChatShard(parse(once));
    expect(twice).toEqual(once);
    expect(serializeChatShard(parse(once))).toBe(
      serializeChatShard(parse(twice)),
    );
  });
});

/**
 * `__proto__` is a legal JSON key and `JSON.parse` really does produce it as an
 * OWN property. Zod's record/json schemas rebuild objects from their entries and
 * drop it, and rebuilding with plain assignment invokes the inherited setter
 * instead of creating a key - either one silently punches a hole in the
 * complete-subtree guarantee, and therefore in the content address.
 */
describe("chat-shard __proto__ preservation", () => {
  // Built from a JSON STRING on purpose: an object literal's `__proto__:` key
  // sets the prototype and creates no own property, so a literal could never
  // reproduce what `JSON.parse` hands a real reader off the wire.
  const protoMessage: JsonValue = JSON.parse(
    '{"role":"telemetry","messageId":"m-proto",' +
      '"__proto__":{"polluted":true},' +
      '"payload":{"__proto__":{"nested":"yes"},"ordinary":1}}',
  );

  const withProtoKey: JsonObject = {
    ...persistedMessageShard,
    messages: [userMessage, assistantMessage, protoMessage],
  };

  it("keeps an own __proto__ key through parse", () => {
    const preserved = parse(withProtoKey).messages[2].raw;

    expect(Object.getOwnPropertyNames(preserved)).toContain("__proto__");

    const payload = preserved.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("expected a preserved payload object");
    }
    expect(Object.getOwnPropertyNames(payload)).toContain("__proto__");
  });

  it("re-emits it, at the top level and nested", () => {
    // String equality, not `toEqual`: an own `__proto__` is exactly the key a
    // structural comparison is least likely to look at.
    const serialized = serializeChatShard(parse(withProtoKey));
    expect(serialized).toBe(canonicalJsonStringify(withProtoKey));
    expect(serialized).toContain('"__proto__":{"polluted":true}');
    expect(serialized).toContain('"__proto__":{"nested":"yes"}');
  });

  it("does not pollute Object.prototype on the way through", () => {
    serializeChatShard(parse(withProtoKey));
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(probe.nested).toBeUndefined();
  });
});

describe("chat-shard version pinning", () => {
  it("refuses a payload claiming a version this contract did not write", () => {
    expect(() =>
      parse({ ...persistedMessageShard, schemaVersion: { major: 99, minor: 77 } }),
    ).toThrow();
  });
});

describe("chat-sync writer helpers", () => {
  it("encodes a domain block back to its persisted form", () => {
    const domainBlock = contentBlockSchema.parse(autonomousResumeBlock);
    const preserved = preserveContentBlock(domainBlock);

    expect(preserved.variant).toBe("autonomous_resume");
    expect(preserved.raw.triggers).toEqual([]);
    // The wakeup trigger must go back into `wakeTriggers`, not inline.
    expect(preserved.raw.wakeTriggers).toHaveLength(1);
  });

  it("round-trips an event through the writer helper", () => {
    const domainEvent = parse(persistedEventShard).events[0].value;
    if (domainEvent === null) throw new Error("expected an interpreted event");

    const preserved = preserveChatEvent(domainEvent);
    expect(preserved.variant).toBe("turn.started");
    expect(preserved.raw).toEqual(canonicalizeJsonValue(knownEvent));
  });

  it("encodes a message whose blocks are themselves preserved", () => {
    const domainMessage = parse(persistedMessageShard).messages[1].value;
    if (domainMessage === null) {
      throw new Error("expected an interpreted assistant message");
    }

    // The nested block wrappers must encode back to their `raw`, including the
    // unknown block the message carries.
    const preserved = preserveChatMessage(domainMessage);
    expect(preserved.variant).toBe("assistant");
    expect(preserved.raw).toEqual(canonicalizeJsonValue(assistantMessage));
  });
});

describe("chat-sync known-variant vocabulary", () => {
  // The passthrough lists ARE the reader's declared vocabulary. If a variant is
  // added to the underlying union without being listed, every entry of that
  // variant silently degrades to "unknown" - preserved, but never rendered.
  // Cross-check against the schema so that fails loudly instead.
  function unionDiscriminants(schema: z.ZodType, key: string): string[] {
    const jsonSchema = z.toJSONSchema(schema, { io: "input" });
    const variants = z.parse(
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
      jsonSchema,
    );

    const options = variants.anyOf ?? variants.oneOf ?? [];
    return options.map((option) => option.properties[key].const);
  }

  it("lists every content-block type the union declares", () => {
    expect([...KNOWN_CONTENT_BLOCK_TYPES].sort()).toEqual(
      unionDiscriminants(contentBlockSchema, "type").sort(),
    );
  });

  it("lists every chat message role the union declares", () => {
    expect([...KNOWN_CHAT_MESSAGE_ROLES].sort()).toEqual(
      unionDiscriminants(chatSyncMessageSchema, "role").sort(),
    );
  });

  it("lists every chat-event type the enum declares", () => {
    expect([...KNOWN_CHAT_EVENT_TYPES].sort()).toEqual(
      [...chatEventTypeSchema.options].sort(),
    );
  });
});
