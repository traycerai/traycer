import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  CHAT_SYNC_1_1_READER_FLOOR,
  CHAT_SYNC_READER_VERSION,
  chatHeadReaderSchema,
  decodeChatHeadDocument,
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
  FIXTURE_CDC,
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

const PART_A = {
  sha256: "a".repeat(64),
  byteLength: 120,
  firstSeq: 1,
  lastSeq: 3,
  recordCount: 2,
  firstRecordId: "m-a",
  lastRecordId: "m-c",
};
const PART_B = {
  sha256: "b".repeat(64),
  byteLength: 240,
  firstSeq: 4,
  lastSeq: 7,
  recordCount: 2,
  firstRecordId: "m-d",
  lastRecordId: "m-g",
};
// Distinct from A and B: a head may not name the same part twice, so a
// graduated section in these fixtures needs an address of its own.
const PART_C = {
  sha256: "c".repeat(64),
  byteLength: 360,
  firstSeq: 8,
  lastSeq: 8,
  recordCount: 1,
  firstRecordId: "m-h",
  lastRecordId: "m-h",
};

const wireHead: JsonObject = {
  schemaVersion: {
    major: CHAT_SYNC_SCHEMA_VERSION.major,
    minor: CHAT_SYNC_SCHEMA_VERSION.minor,
  },
  parentHeadSha256: null,
  throughRecordSeq: 7,
  capturedAt: 1_700_000_000_000,
  minReaderVersion: {
    major: CHAT_SYNC_SCHEMA_VERSION.major,
    minor: CHAT_SYNC_SCHEMA_VERSION.minor,
  },
  cdc: { ...FIXTURE_CDC },
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
  it("names its payload cohorts by address plus the seq range they cover", () => {
    const head = parse(wireHead);
    expect(head.messageShards).toEqual([PART_A, PART_B]);
    // The payload cut plan is chat-domain data. The tenant envelope stays
    // address-only (see chat-sync-head-document.test.ts).
    expect(Object.keys(head.messageShards[0]).sort()).toEqual([
      "byteLength",
      "firstRecordId",
      "firstSeq",
      "lastRecordId",
      "lastSeq",
      "recordCount",
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
  it("accepts this contract's own version - the 1.1 v2-head stamp", () => {
    expect(parse(wireHead).minReaderVersion).toEqual(CHAT_SYNC_SCHEMA_VERSION);
  });

  it("READER defaults to null when the key is absent", () => {
    // Reader tolerance for heads written before the field existed. The writer
    // inherits the same default deliberately - see "the writer publishes a null
    // reader floor" below.
    const withoutKey: JsonObject = { ...wireHead };
    delete withoutKey.minReaderVersion;
    expect(chatHeadReaderSchema.parse(withoutKey).minReaderVersion).toBeNull();
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
      cdc: wireHead.cdc,
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
    // This fixture states a deliberate floor, so it survives the round trip
    // verbatim; the DEFAULT (absent -> null, on the writer as on the reader) is
    // pinned in the coherence and null-floor describes.
    expect(once.minReaderVersion).toEqual(CHAT_SYNC_SCHEMA_VERSION);

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

  it("refuses a 1.1 writer head that omits cdc or cohort cut-plan fields", () => {
    const { cdc: _cdc, ...withoutCdc } = wireHead;
    expect(() => parse(withoutCdc)).toThrow();

    expect(() =>
      parse({
        ...wireHead,
        messageShards: [{ sha256: "a".repeat(64), byteLength: 1 }],
      }),
    ).toThrow();
  });
});

describe("chat-head 1.0 reader compatibility", () => {
  it("parses a 1.0 head that has no cdc and no seq ranges", () => {
    const v10: JsonObject = {
      ...wireHead,
      schemaVersion: { major: 1, minor: 0 },
      minReaderVersion: null,
      messageShards: [
        { sha256: "a".repeat(64), byteLength: 120 },
        { sha256: "b".repeat(64), byteLength: 240 },
      ],
    };
    delete v10.cdc;

    const parsed = chatHeadReaderSchema.parse(v10);
    expect(parsed.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(parsed.cdc).toBeUndefined();
    expect(parsed.messageShards[0].firstSeq).toBeUndefined();
  });

  it("lets a 1.0 reader refuse a 1.1 head that stamps minReaderVersion {1,1}", () => {
    const refused = gateChatHeadVersion(
      {
        schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
        minReaderVersion: CHAT_SYNC_SCHEMA_VERSION,
      },
      { major: 1, minor: 0 },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("reader-below-minimum");
  });
});

describe("a claimed 1.1 head must carry its cut plan", () => {
  // The reader keeps cdc and membership optional FOR 1.0 heads. A payload
  // whose own schemaVersion says 1.1+ while omitting them is a head no 1.1
  // writer produced, and admitting it would hand downstream a nominal-1.1
  // head whose cuts cannot be reproduced.
  it("reader rejects a claimed-1.1 head that omits cdc", () => {
    const missingCdc: JsonObject = { ...wireHead };
    delete missingCdc.cdc;
    expect(chatHeadReaderSchema.safeParse(missingCdc).success).toBe(false);
  });

  it("reader rejects a claimed-1.1 head whose cohorts omit membership", () => {
    const bareParts: JsonObject = {
      ...wireHead,
      messageShards: [
        { sha256: "a".repeat(64), byteLength: 120 },
        { sha256: "b".repeat(64), byteLength: 240 },
      ],
    };
    expect(chatHeadReaderSchema.safeParse(bareParts).success).toBe(false);
  });

  it("such a head DECODES as schema-rejected, not ok", () => {
    const payload: JsonObject = { ...wireHead };
    delete payload.cdc;
    // Envelope derived by hand to MATCH the payload, so the refusal below is
    // the schema's and not the envelope cross-check's.
    const document = canonicalJsonStringify(
      canonicalizeJsonValue({
        ...payload,
        parts: [
          { sha256: PART_A.sha256, byteLength: PART_A.byteLength },
          { sha256: PART_B.sha256, byteLength: PART_B.byteLength },
        ],
      }) as JsonObject,
    );

    const decoded = decodeChatHeadDocument(document);
    expect(decoded.status).toBe("corrupt");
    if (decoded.status === "corrupt") {
      expect(decoded.reason).toBe("schema-rejected");
    }
  });
});

describe("the writer publishes a null reader floor", () => {
  // The floor is reserved for a change an older reader cannot safely
  // INTERPRET; the 1.1 reshape is additive and read-safe, so `null` is what a
  // correct publisher stamps. The writer must therefore ACCEPT null - and it
  // must not pin the floor to this build's own version, or the next additive
  // minor would make a publisher's own stamp unparseable.
  it("accepts a null minReaderVersion - the ordinary case", () => {
    const published = chatHeadSchema.parse({
      ...wireHead,
      minReaderVersion: null,
    });
    expect(published.minReaderVersion).toBeNull();
  });

  it("accepts an absent minReaderVersion, defaulting it to null", () => {
    const absent: JsonObject = { ...wireHead };
    delete absent.minReaderVersion;
    expect(chatHeadSchema.parse(absent).minReaderVersion).toBeNull();
  });

  it("still admits a DELIBERATE floor, including one below its own minor", () => {
    // `CHAT_SYNC_1_1_READER_FLOOR` stays the documented mechanism for a future
    // deliberate raise, and a floor from an earlier minor is coherent too - a
    // 1.2 head may legitimately gate readers below 1.1. Only incoherent
    // minimums are refused (see the coherence describe above).
    expect(
      chatHeadSchema.parse({
        ...wireHead,
        minReaderVersion: { ...CHAT_SYNC_1_1_READER_FLOOR },
      }).minReaderVersion,
    ).toEqual(CHAT_SYNC_1_1_READER_FLOOR);
    expect(
      chatHeadSchema.parse({
        ...wireHead,
        minReaderVersion: { major: 1, minor: 0 },
      }).minReaderVersion,
    ).toEqual({ major: 1, minor: 0 });
  });

  it("a freshly published null-floor head opens for a 1.0-shaped reader", () => {
    // The regression this pins: stamping the floor from
    // `CHAT_SYNC_SCHEMA_VERSION` made every minor bump lock out every older
    // reader, which is the refusal a dev host actually hit.
    const published = chatHeadSchema.parse({
      ...wireHead,
      minReaderVersion: null,
    });
    expect(gateChatHeadVersion(published, { major: 1, minor: 0 })).toEqual({
      ok: true,
    });
  });
});
