import {
  CHAT_HEAD_PARTS_KEY,
  decodeChatHeadDocument,
  encodeChatHeadDocument,
  encodeChatHead,
  listChatHeadPartAddresses,
  listChatHeadParts,
  serializeChatHeadDocument,
  type ChatHeadRecord,
} from "@traycer/protocol/persistence/chat-sync/head";
import {
  canonicalJsonStringify,
  isJsonObject,
  readJsonProperty,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import { describe, expect, it } from "vitest";
import { publishChat, sha256Hex } from "./__fixtures__/published-chat";

/**
 * The head DOCUMENT: the tenant envelope plus the opaque payload.
 *
 * A head is stored as `parts` (the one thing the sync layer reads, so it can
 * tell what a swap displaces) wrapped around the record (which the sync layer
 * never interprets). These bytes are the identity: the CAS witness, the digest
 * the chat row holds, and the value the next head chains to as its
 * `parentHeadSha256` are all the same sha256 over this string.
 *
 * The failure this suite exists to prevent is the one that made the seam worth
 * writing down: a record-serialized head that the server cannot commit, or an
 * envelope that disagrees with the payload it wraps and so drives a swap that
 * strands a live object or deletes one still in use.
 */

const inline = publishChat({
  graduate: { events: false, hostPrivate: false },
  parentHeadSha256: null,
});

const graduated = publishChat({
  graduate: { events: true, hostPrivate: true },
  parentHeadSha256: "f".repeat(64),
});

/** The envelope as a caller reads it back off document bytes. */
function readEnvelope(documentBytes: string): JsonValue | undefined {
  const parsed: unknown = JSON.parse(documentBytes);
  if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
  return readJsonProperty(parsed, CHAT_HEAD_PARTS_KEY);
}

/** Rebuilds document bytes with the envelope replaced. */
function withEnvelope(record: ChatHeadRecord, envelope: JsonValue): string {
  const document = encodeChatHeadDocument(record);
  // Through the reserved-key constant, like `readEnvelope` above. A literal
  // here would keep writing `parts` if the key were ever renamed, so the five
  // negative tests below would pass on an unrelated extra field instead of on
  // the tampering they describe.
  const tampered: JsonObject = {
    ...document,
    [CHAT_HEAD_PARTS_KEY]: envelope,
  };
  return canonicalJsonStringify(tampered);
}

describe("chat-head document envelope", () => {
  it("carries a top-level parts array - the one tenant obligation", () => {
    // The server refuses a head without this and cannot compute what a swap
    // displaces, so a record-serialized head that lacked it would be
    // uncommittable.
    expect(readEnvelope(serializeChatHeadDocument(graduated.head))).toEqual([
      ...listChatHeadPartAddresses(graduated.head),
    ]);
  });

  it("derives the envelope as the three shard lists in head order", () => {
    const head = graduated.head;
    expect(readEnvelope(serializeChatHeadDocument(head))).toEqual([
      ...listChatHeadPartAddresses(head),
    ]);
  });

  it("keeps the envelope address-only even when payload cohorts carry seq ranges", () => {
    const envelope = readEnvelope(serializeChatHeadDocument(graduated.head));
    expect(Array.isArray(envelope)).toBe(true);
    if (!Array.isArray(envelope)) return;
    expect(envelope.length).toBeGreaterThan(0);
    for (const entry of envelope) {
      expect(Object.keys(entry as object).sort()).toEqual([
        "byteLength",
        "sha256",
      ]);
    }
    expect(graduated.head.messageShards[0].firstSeq).toBeDefined();
  });

  it("names an empty envelope for a head with no parts at all", () => {
    // Inline sections and no message cohorts: legal, and the envelope has to
    // say so explicitly rather than be absent.
    const empty: ChatHeadRecord = { ...inline.head, messageShards: [] };
    expect(readEnvelope(serializeChatHeadDocument(empty))).toEqual([]);
  });

  it("keeps the payload byte-identical to the record's own encoding", () => {
    // The envelope is additive: strip it and what is left is exactly the
    // record's own canonical encoding, so nothing about the payload's form is
    // disturbed by wrapping it. Composed explicitly - there is deliberately no
    // payload serializer to reach for.
    const document: unknown = JSON.parse(
      serializeChatHeadDocument(graduated.head),
    );
    if (!isJsonObject(document)) throw new Error("expected a JSON object");

    const payload: JsonObject = { ...document };
    delete payload[CHAT_HEAD_PARTS_KEY];
    expect(canonicalJsonStringify(payload)).toBe(
      canonicalJsonStringify(encodeChatHead(graduated.head)),
    );
  });
});

describe("chat-head document identity", () => {
  it("is idempotent, so the digest a chain is built on holds still", () => {
    const once = serializeChatHeadDocument(graduated.head);
    const decoded = decodeChatHeadDocument(once);
    expect(decoded.status).toBe("ok");
    if (decoded.status !== "ok") return;

    const twice = serializeChatHeadDocument(decoded.record);
    expect(twice).toBe(once);
    expect(sha256Hex(twice)).toBe(sha256Hex(once));

    // And once more, so a re-publication by a reader that merely opened the
    // chat cannot move the address its successor names.
    const third = decodeChatHeadDocument(twice);
    if (third.status !== "ok") throw new Error("expected a decodable document");
    expect(serializeChatHeadDocument(third.record)).toBe(once);
  });

  it("differs from the payload digest, so the two cannot be confused", () => {
    // Worth pinning: chaining on the payload digest would name bytes nobody
    // stores, and the mistake is invisible until a lineage check fails.
    expect(sha256Hex(serializeChatHeadDocument(graduated.head))).not.toBe(
      sha256Hex(canonicalJsonStringify(encodeChatHead(graduated.head))),
    );
  });

  it("round-trips both layouts through decode", () => {
    for (const published of [inline, graduated]) {
      const result = decodeChatHeadDocument(
        serializeChatHeadDocument(published.head),
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.record).toEqual(published.head);
    }
  });
});

/**
 * The envelope must never reach the record. It is derived state, so a copy
 * carried through a decode would be re-emitted beside a freshly derived one on
 * the next publish - a stale index in the bytes the sync layer reads.
 */
describe("chat-head document strips the envelope before parsing", () => {
  it("never lands parts in the record's residual bag", () => {
    const result = decodeChatHeadDocument(
      serializeChatHeadDocument(graduated.head),
    );
    if (result.status !== "ok") throw new Error("expected a decodable document");

    expect(Object.keys(result.record.residual)).not.toContain(
      CHAT_HEAD_PARTS_KEY,
    );
    expect(result.record.residual).toEqual({});
  });

  it("keeps a genuine residual key while dropping the envelope", () => {
    // Non-vacuity: the strip must be surgical, not "the bag is always empty".
    const document: unknown = JSON.parse(
      serializeChatHeadDocument(graduated.head),
    );
    if (!isJsonObject(document)) throw new Error("expected a JSON object");

    const withFutureField = canonicalJsonStringify({
      ...document,
      futureTopLevel: { added: "by a newer minor" },
    });

    const result = decodeChatHeadDocument(withFutureField);
    if (result.status !== "ok") throw new Error("expected a decodable document");

    expect(result.record.residual).toEqual({
      futureTopLevel: { added: "by a newer minor" },
    });
    expect(Object.keys(result.record.residual)).not.toContain(
      CHAT_HEAD_PARTS_KEY,
    );

    // And a re-publication derives its envelope afresh rather than re-emitting
    // whatever the document happened to carry.
    expect(readEnvelope(serializeChatHeadDocument(result.record))).toEqual([
      ...listChatHeadPartAddresses(graduated.head),
    ]);
  });
});

describe("chat-head document fails closed", () => {
  it("refuses bytes that are not a JSON object", () => {
    for (const bytes of ["not json", "[]", "null", '"a string"']) {
      const result = decodeChatHeadDocument(bytes);
      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") continue;
      expect(result.reason).toBe("malformed-json");
    }
  });

  it("refuses a document with no envelope", () => {
    // Exactly what the server refuses at the door, refused here too so a
    // publisher sees it before the swap rather than after.
    const result = decodeChatHeadDocument(
      canonicalJsonStringify(encodeChatHead(graduated.head)),
    );
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("parts-envelope-missing");
  });

  it("refuses a malformed envelope entry", () => {
    for (const envelope of [
      [{ sha256: "not-hex", byteLength: 1 }],
      [{ sha256: "a".repeat(64) }],
      [{ sha256: "a".repeat(64), byteLength: -1 }],
      ["a".repeat(64)],
    ]) {
      const result = decodeChatHeadDocument(
        withEnvelope(graduated.head, envelope),
      );
      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") continue;
      expect(result.reason).toBe("parts-envelope-missing");
    }
  });

  it("refuses an envelope missing an entry - a swap that strands an object", () => {
    const derived = [...listChatHeadParts(graduated.head)];
    const result = decodeChatHeadDocument(
      withEnvelope(graduated.head, derived.slice(1)),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("parts-envelope-mismatch");
  });

  it("refuses an envelope with an extra entry - a swap that deletes a live object", () => {
    const derived = [...listChatHeadParts(graduated.head)];
    const result = decodeChatHeadDocument(
      withEnvelope(graduated.head, [
        ...derived,
        { sha256: "e".repeat(64), byteLength: 9 },
      ]),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("parts-envelope-mismatch");
  });

  it("refuses a reordered envelope", () => {
    const derived = [...listChatHeadParts(graduated.head)];
    const result = decodeChatHeadDocument(
      withEnvelope(graduated.head, [derived[1], derived[0], ...derived.slice(2)]),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("parts-envelope-mismatch");
  });

  it("refuses an envelope whose entry declares the wrong length", () => {
    const derived = [...listChatHeadParts(graduated.head)];
    const result = decodeChatHeadDocument(
      withEnvelope(graduated.head, [
        { ...derived[0], byteLength: derived[0].byteLength + 1 },
        ...derived.slice(1),
      ]),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("parts-envelope-mismatch");
    expect(result.diagnostic).toContain("bytes");
  });

  it("refuses a payload the reader schema rejects", () => {
    const document: unknown = JSON.parse(
      serializeChatHeadDocument(graduated.head),
    );
    if (!isJsonObject(document)) throw new Error("expected a JSON object");

    const result = decodeChatHeadDocument(
      canonicalJsonStringify({
        ...document,
        schemaVersion: { major: 99, minor: 0 },
      }),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("schema-rejected");
  });

  it("keeps corruption messages free of object coordinates", () => {
    const derived = [...listChatHeadParts(graduated.head)];
    const result = decodeChatHeadDocument(
      withEnvelope(graduated.head, derived.slice(1)),
    );
    if (result.status !== "corrupt") throw new Error("expected corruption");

    expect(result.message).not.toContain(derived[0].sha256);
  });
});

/**
 * A head may not name the same part twice. The sync server refuses one, because
 * "displaced = previous minus current" stops being well-defined exactly where
 * that set drives deletion - so such a head is uncommittable, and catching it
 * at parse puts the failure where the publisher can see it.
 */
describe("chat-head part uniqueness", () => {
  it("refuses a head that names one part in two lists", () => {
    const duplicated: ChatHeadRecord = {
      ...graduated.head,
      eventShards: [graduated.head.messageShards[0]],
    };

    const result = decodeChatHeadDocument(
      serializeChatHeadDocument(duplicated),
    );
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("schema-rejected");
  });

  it("refuses a head that names one part twice in the same list", () => {
    const duplicated: ChatHeadRecord = {
      ...inline.head,
      messageShards: [
        inline.head.messageShards[0],
        inline.head.messageShards[0],
      ],
    };

    const result = decodeChatHeadDocument(
      serializeChatHeadDocument(duplicated),
    );
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("schema-rejected");
  });
});
