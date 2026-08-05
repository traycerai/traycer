import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  CHAT_SYNC_READER_VERSION,
  encodeChatHead,
  gateChatHeadVersion,
  listChatHeadParts,
  serializeChatHeadDocument,
} from "@traycer/protocol/persistence/chat-sync/head";
import {
  canonicalJsonStringify,
  canonicalizeJsonValue,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  persistenceRecordRegistry,
  type ChatHead,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import {
  knownEvent,
  persistedHostPrivate,
  publishChat,
  sha256Hex,
  unknownEvent,
} from "./__fixtures__/published-chat";

/**
 * The head: lineage, graduation, version gating, and the canonical encoding
 * that makes a head's own sha256 - the value the NEXT head carries as its
 * `parentHeadSha256` - worth chaining on.
 */

const chatHeadSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-head",
  "latest",
);

const PART_A = { sha256: "a".repeat(64), byteLength: 120 };
const PART_B = { sha256: "b".repeat(64), byteLength: 240 };
// Distinct from A and B: a head may not name the same part twice, so a
// graduated section in these fixtures needs an address of its own.
const PART_C = { sha256: "c".repeat(64), byteLength: 360 };

const wireHead: JsonObject = {
  schemaVersion: { major: 1, minor: 0 },
  parentHeadSha256: null,
  throughRecordSeq: 7,
  capturedAt: 1_700_000_000_000,
  minReaderVersion: null,
  core: {
    chatId: "chat-1",
    parentChatId: null,
    ownerUserId: "u-1",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    lifecycle: { state: "active", archivedAt: null, deletedAt: null },
    settings: null,
  },
  messageShards: [{ ...PART_A }, { ...PART_B }],
  events: [knownEvent, unknownEvent],
  eventShards: [],
  hostPrivate: persistedHostPrivate,
  hostPrivateShard: null,
};

function parse(value: JsonObject): ChatHead {
  return chatHeadSchema.parse(value);
}

describe("chat-head shape", () => {
  it("names its parts by content address and nothing else", () => {
    const head = parse(wireHead);
    expect(head.messageShards).toEqual([PART_A, PART_B]);
    // No key, no storage generation: the key layout is derived from the hash
    // and readers never parse keys.
    expect(Object.keys(head.messageShards[0]).sort()).toEqual([
      "byteLength",
      "sha256",
    ]);
  });

  it("rejects a part address that is not a lowercase hex sha256", () => {
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "zz", ""]) {
      expect(() =>
        parse({ ...wireHead, messageShards: [{ sha256, byteLength: 1 }] }),
      ).toThrow();
    }
  });

  it("lists every part in the order assembly consumes them", () => {
    const graduated = publishChat({
      graduate: { events: true, hostPrivate: true },
      parentHeadSha256: null,
    });

    expect(listChatHeadParts(graduated.head)).toEqual([
      ...graduated.head.messageShards,
      ...graduated.head.eventShards,
      graduated.head.hostPrivateShard,
    ]);
  });
});

describe("chat-head lineage", () => {
  it("carries a nullable parent head digest", () => {
    expect(parse(wireHead).parentHeadSha256).toBeNull();

    const parent = "c".repeat(64);
    expect(parse({ ...wireHead, parentHeadSha256: parent }).parentHeadSha256).toBe(
      parent,
    );
  });

  it("chains a head to the digest of the head it superseded", () => {
    // Ancestry is proven by IDENTITY, never by sequence ordering: two forked
    // histories both number their turns, so a seq comparison permits exactly
    // the dangerous "local is ahead, overwrite the cloud" case.
    const first = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: null,
    });
    const second = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: first.headSha256,
    });

    expect(second.head.parentHeadSha256).toBe(first.headSha256);
    // The identity a head is chained on is the digest of the bytes that are
    // STORED - the document, envelope and all. Chaining on the payload digest
    // would name bytes nobody has, so the next sync would fail to find the
    // ancestor and report a fork that never happened.
    expect(sha256Hex(serializeChatHeadDocument(first.head))).toBe(
      first.headSha256,
    );
    expect(sha256Hex(first.documentBytes)).toBe(first.headSha256);

    // A fork: same seq, different lineage. Sequence ordering cannot tell these
    // apart; the digest chain can.
    const fork = publishChat({
      graduate: { events: true, hostPrivate: false },
      parentHeadSha256: "d".repeat(64),
    });
    expect(fork.head.throughRecordSeq).toBe(second.head.throughRecordSeq);
    expect(fork.head.parentHeadSha256).not.toBe(second.head.parentHeadSha256);
  });

  it("rejects a malformed parent digest", () => {
    expect(() => parse({ ...wireHead, parentHeadSha256: "nope" })).toThrow();
  });
});

describe("chat-head section graduation", () => {
  it("accepts either layout for a section", () => {
    expect(() =>
      parse({ ...wireHead, events: null, eventShards: [{ ...PART_C }] }),
    ).not.toThrow();

    expect(() =>
      parse({
        ...wireHead,
        hostPrivate: null,
        hostPrivateShard: { ...PART_C },
      }),
    ).not.toThrow();
  });

  it("refuses to state a section twice", () => {
    // Inline AND graduated would let two readers assemble two different chats
    // from the same bytes.
    expect(() =>
      parse({ ...wireHead, eventShards: [{ ...PART_C }] }),
    ).toThrow();

    expect(() =>
      parse({ ...wireHead, hostPrivateShard: { ...PART_C } }),
    ).toThrow();
  });

  it("refuses to state a section nowhere", () => {
    // "Graduated to nothing" would present as a chat that lost its event log.
    expect(() => parse({ ...wireHead, events: null })).toThrow();
    expect(() => parse({ ...wireHead, hostPrivate: null })).toThrow();
  });

  it("keeps an empty inline event list distinct from a graduated one", () => {
    const empty = parse({ ...wireHead, events: [] });
    expect(empty.events).toEqual([]);
    expect(empty.eventShards).toEqual([]);
  });
});

describe("chat-head minReaderVersion coherence", () => {
  it("accepts null - the normal case", () => {
    expect(parse(wireHead).minReaderVersion).toBeNull();
  });

  it("defaults to null when the key is absent", () => {
    const withoutKey: JsonObject = { ...wireHead };
    delete withoutKey.minReaderVersion;
    expect(parse(withoutKey).minReaderVersion).toBeNull();
  });

  it("refuses a minimum on another major - no reader could satisfy both", () => {
    expect(() =>
      parse({ ...wireHead, minReaderVersion: { major: 2, minor: 0 } }),
    ).toThrow();
  });

  it("refuses a minimum ahead of the head it guards", () => {
    // The change that forces a higher minimum is the change that cuts the
    // record's own minor, so a minimum can never run ahead of its payload.
    expect(() =>
      parse({ ...wireHead, minReaderVersion: { major: 1, minor: 4 } }),
    ).toThrow();
  });
});

describe("chat-head version gate", () => {
  const reader = CHAT_SYNC_READER_VERSION;

  it("rejects on a major mismatch, in either direction", () => {
    const older = gateChatHeadVersion(
      { schemaVersion: { major: 0, minor: 9 }, minReaderVersion: null },
      reader,
    );
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.reason).toBe("unsupported-major");

    const newer = gateChatHeadVersion(
      { schemaVersion: { major: 2, minor: 0 }, minReaderVersion: null },
      reader,
    );
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.reason).toBe("unsupported-major");
  });

  it("admits every same-major minor, however far ahead", () => {
    // The whole point of the passthrough: the minor bump that introduces a new
    // block type is exactly the one a strict-minor gate would have bounced,
    // so the tolerant codec would never fire in the field.
    expect(
      gateChatHeadVersion(
        { schemaVersion: { major: 1, minor: 9 }, minReaderVersion: null },
        reader,
      ),
    ).toEqual({ ok: true });
  });

  it("honours minReaderVersion as the escape hatch", () => {
    const refused = gateChatHeadVersion(
      {
        schemaVersion: { major: 1, minor: 4 },
        minReaderVersion: { major: 1, minor: 3 },
      },
      { major: 1, minor: 0 },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("reader-below-minimum");

    expect(
      gateChatHeadVersion(
        {
          schemaVersion: { major: 1, minor: 4 },
          minReaderVersion: { major: 1, minor: 3 },
        },
        { major: 1, minor: 3 },
      ),
    ).toEqual({ ok: true });
  });
});

describe("chat-head canonical encoding", () => {
  it("is independent of key order", () => {
    const reordered: JsonObject = {
      hostPrivateShard: wireHead.hostPrivateShard,
      hostPrivate: wireHead.hostPrivate,
      eventShards: wireHead.eventShards,
      events: wireHead.events,
      messageShards: wireHead.messageShards,
      core: wireHead.core,
      minReaderVersion: wireHead.minReaderVersion,
      capturedAt: wireHead.capturedAt,
      throughRecordSeq: wireHead.throughRecordSeq,
      parentHeadSha256: wireHead.parentHeadSha256,
      schemaVersion: wireHead.schemaVersion,
    };

    expect(canonicalJsonStringify(encodeChatHead(parse(reordered)))).toBe(
      canonicalJsonStringify(encodeChatHead(parse(wireHead))),
    );
  });

  it("re-emits a head losslessly, residual bags included", () => {
    const withFutureFields: JsonObject = {
      ...wireHead,
      publisherHint: { cohortTarget: 65_536 },
      core: {
        ...(wireHead.core as JsonObject),
        futureCoreField: "kept",
        lifecycle: {
          state: "archived",
          archivedAt: 77,
          deletedAt: null,
          futureLifecycleField: 1,
        },
      },
    };

    expect(canonicalJsonStringify(encodeChatHead(parse(withFutureFields)))).toBe(
      canonicalJsonStringify(withFutureFields),
    );
  });

  /**
   * Canonical form is the schema-NORMALIZED encoding: `minReaderVersion` and
   * the run settings' `.default(...)` fields materialize on the way through, so
   * `encode(decode(x))` differs from `canonical(x)` for an input that omitted
   * them. What holds is IDEMPOTENCE, which is what makes a head's digest - and
   * therefore the lineage chain - stable across read/write cycles.
   */
  it("materializes defaulted fields, then holds still", () => {
    const withoutDefaults: JsonObject = {
      ...wireHead,
      core: {
        ...(wireHead.core as JsonObject),
        settings: {
          harnessId: "claude",
          model: "opus",
          permissionMode: "supervised",
          reasoningEffort: null,
          agentMode: "regular",
          // `serviceTier` and `profileId` are absent - both `.default(null)`
          // in the shared run-settings schema, so this is a valid stored value.
        },
      },
    };
    delete withoutDefaults.minReaderVersion;

    const once = encodeChatHead(parse(withoutDefaults));
    expect(once).not.toEqual(canonicalizeJsonValue(withoutDefaults));

    const core = once.core;
    if (typeof core !== "object" || core === null || Array.isArray(core)) {
      throw new Error("expected an encoded core object");
    }
    expect(core.settings).toEqual({
      harnessId: "claude",
      model: "opus",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });
    expect(once.minReaderVersion).toBeNull();

    // Idempotent from there on - so the digest the next head chains to does not
    // move under a reader that merely opened and re-published the chat.
    const twice = encodeChatHead(parse(once));
    expect(twice).toEqual(once);
    expect(sha256Hex(serializeChatHeadDocument(parse(once)))).toBe(
      sha256Hex(serializeChatHeadDocument(parse(twice))),
    );
  });

  it("stamps the record version this build writes", () => {
    expect(parse(wireHead).schemaVersion).toEqual(CHAT_SYNC_SCHEMA_VERSION);
  });

  it("refuses a payload claiming a version this contract did not write", () => {
    expect(() =>
      parse({ ...wireHead, schemaVersion: { major: 99, minor: 77 } }),
    ).toThrow();
  });
});
