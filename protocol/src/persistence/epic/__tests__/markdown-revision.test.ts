/**
 * Protocol-boundary contract for the markdown revision envelope: the canonical
 * bytes, the content-address hash that covers every part of the envelope, and
 * the refusals that keep a revision id naming exactly one envelope.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  decodeMarkdownRevision,
  encodeMarkdownRevision,
  InvalidMarkdownRevisionError,
  markdownRevisionEnvelopeSchema,
  markdownRevisionHash,
  type MarkdownRevisionEnvelope,
  type MarkdownRevisionManifest,
} from "@traycer/protocol/persistence/epic/markdown-revision";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function paragraphDocument(text: string): MarkdownRevisionEnvelope["document"] {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A non-transient person write with a parent: valid, and a base every
 * single-field variant below departs from by exactly one field. */
function baseManifest(): MarkdownRevisionManifest {
  return {
    artifactId: "artifact-1",
    parent: HASH_A,
    merge: null,
    author: { kind: "person", userId: "user-1" },
    hostId: "host-1",
    editorSessionId: "session-1",
    createdAt: 1_700_000_000_000,
    transient: false,
  };
}

function baseEnvelope(): MarkdownRevisionEnvelope {
  return {
    format: 1,
    document: paragraphDocument("hello"),
    markdown: "hello\n",
    scalars: {
      kind: "ticket",
      title: "Ticket",
      assignee: "alice",
      status: 0,
    },
    manifest: baseManifest(),
  };
}

function withManifest(
  patch: Partial<MarkdownRevisionManifest>,
): MarkdownRevisionEnvelope {
  return { ...baseEnvelope(), manifest: { ...baseManifest(), ...patch } };
}

async function hashOf(envelope: MarkdownRevisionEnvelope): Promise<string> {
  return markdownRevisionHash(encodeMarkdownRevision(envelope));
}

function expectInvalid(run: () => unknown, reason: RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InvalidMarkdownRevisionError);
  expect(thrown instanceof Error ? thrown.message : "").toMatch(reason);
}

describe("encodeMarkdownRevision / decodeMarkdownRevision", () => {
  it("round-trips an envelope, and re-encoding the decoded value is byte-identical", () => {
    const envelope = baseEnvelope();

    const bytes = encodeMarkdownRevision(envelope);
    const decoded = decodeMarkdownRevision(bytes);

    expect(decoded).toEqual(envelope);
    expect(Array.from(encodeMarkdownRevision(decoded))).toEqual(
      Array.from(bytes),
    );
  });

  it("encodes sorted keys at every depth with no whitespace", () => {
    const text = decoder.decode(encodeMarkdownRevision(baseEnvelope()));

    expect(/\s/u.test(text)).toBe(false);
    expect(text.startsWith('{"document":')).toBe(true);
    expect(text.indexOf('"document"')).toBeLessThan(text.indexOf('"format"'));
    expect(text.indexOf('"format"')).toBeLessThan(text.indexOf('"manifest"'));
    expect(text.indexOf('"manifest"')).toBeLessThan(text.indexOf('"markdown"'));
    expect(text.indexOf('"markdown"')).toBeLessThan(text.indexOf('"scalars"'));
    // Manifest keys sorted too: artifactId < author < createdAt < ... < transient.
    const manifestStart = text.indexOf('"manifest"');
    expect(text.indexOf('"artifactId"', manifestStart)).toBeLessThan(
      text.indexOf('"author"', manifestStart),
    );
    expect(text.indexOf('"hostId"', manifestStart)).toBeLessThan(
      text.indexOf('"transient"', manifestStart),
    );
  });

  it("round-trips a manifest with merge fields", () => {
    const merged = withManifest({
      merge: { base: HASH_B, superseded: [HASH_C, HASH_D] },
    });

    const bytes = encodeMarkdownRevision(merged);
    const decoded = decodeMarkdownRevision(bytes);
    expect(decoded).toEqual(merged);
    expect(Array.from(encodeMarkdownRevision(decoded))).toEqual(
      Array.from(bytes),
    );
  });

  it("accepts a merge that dropped nothing (empty superseded set)", () => {
    const envelope = withManifest({ merge: { base: HASH_B, superseded: [] } });

    expect(decodeMarkdownRevision(encodeMarkdownRevision(envelope))).toEqual(
      envelope,
    );
  });

  it("round-trips each author kind and a null parent and null session", () => {
    const manifests: readonly Partial<MarkdownRevisionManifest>[] = [
      { author: { kind: "agent", chatId: "chat-1" }, editorSessionId: null },
      { author: { kind: "system" }, editorSessionId: null },
      { parent: null, editorSessionId: null },
    ];
    for (const patch of manifests) {
      const envelope = withManifest(patch);
      expect(decodeMarkdownRevision(encodeMarkdownRevision(envelope))).toEqual(
        envelope,
      );
    }
  });

  it("round-trips spec and review scalars, which carry only kind and title", () => {
    for (const kind of ["spec", "review"] as const) {
      const envelope: MarkdownRevisionEnvelope = {
        ...baseEnvelope(),
        scalars: { kind, title: "Notes" },
      };
      expect(decodeMarkdownRevision(encodeMarkdownRevision(envelope))).toEqual(
        envelope,
      );
    }
  });

  it("round-trips non-ASCII text through UTF-8 bytes", () => {
    const text = "héllo 日本語 ✓ 𝄞";
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: paragraphDocument(text),
      markdown: `${text}\n`,
    };

    const bytes = encodeMarkdownRevision(envelope);
    const decoded = decodeMarkdownRevision(bytes);

    expect(decoded.markdown).toBe(`${text}\n`);
    expect(decoded.document.content?.[0]?.content?.[0]?.text).toBe(text);
    expect(Array.from(encodeMarkdownRevision(decoded))).toEqual(
      Array.from(bytes),
    );
  });

  it("round-trips anchor marks on a text node", () => {
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "anchored",
                marks: [{ type: "threadAnchor", attrs: { threadId: "t-1" } }],
              },
            ],
          },
        ],
      },
    };

    const decoded = decodeMarkdownRevision(encodeMarkdownRevision(envelope));

    expect(decoded.document.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: "threadAnchor", attrs: { threadId: "t-1" } },
    ]);
  });
});

describe("markdownRevisionHash", () => {
  it("is the lowercase hex sha256 of the bytes", async () => {
    // FIPS 180-2 test vector for "abc".
    expect(await markdownRevisionHash(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("covers every part of the envelope: any single-field change names a different revision", async () => {
    const base = baseEnvelope();
    const variants: readonly [string, MarkdownRevisionEnvelope][] = [
      ["document", { ...base, document: paragraphDocument("hello!") }],
      ["markdown", { ...base, markdown: "hello!\n" }],
      [
        "scalars.kind",
        {
          ...base,
          scalars: {
            kind: "story",
            title: "Ticket",
            assignee: "alice",
            status: 0,
          },
        },
      ],
      [
        "scalars.title",
        {
          ...base,
          scalars: {
            kind: "ticket",
            title: "Other",
            assignee: "alice",
            status: 0,
          },
        },
      ],
      [
        "scalars.assignee",
        {
          ...base,
          scalars: {
            kind: "ticket",
            title: "Ticket",
            assignee: "bob",
            status: 0,
          },
        },
      ],
      [
        "scalars.status",
        {
          ...base,
          scalars: {
            kind: "ticket",
            title: "Ticket",
            assignee: "alice",
            status: 1,
          },
        },
      ],
      ["manifest.artifactId", withManifest({ artifactId: "artifact-2" })],
      ["manifest.parent", withManifest({ parent: HASH_B })],
      ["manifest.parent (null)", withManifest({ parent: null })],
      [
        "manifest.merge",
        withManifest({ merge: { base: HASH_B, superseded: [] } }),
      ],
      [
        "manifest.author (person)",
        withManifest({ author: { kind: "person", userId: "user-2" } }),
      ],
      [
        "manifest.author (kind)",
        withManifest({ author: { kind: "agent", chatId: "chat-1" } }),
      ],
      ["manifest.hostId", withManifest({ hostId: "host-2" })],
      [
        "manifest.editorSessionId",
        withManifest({ editorSessionId: "session-2" }),
      ],
      [
        "manifest.editorSessionId (null)",
        withManifest({ editorSessionId: null }),
      ],
      ["manifest.createdAt", withManifest({ createdAt: 1_700_000_000_001 })],
      ["manifest.transient", withManifest({ transient: true })],
    ];

    const baseHash = await hashOf(base);
    const hashes = await Promise.all(
      variants.map(async ([, envelope]) => hashOf(envelope)),
    );

    hashes.forEach((hash, index) => {
      expect(hash, variants[index]?.[0]).not.toBe(baseHash);
    });
    // Different fields never collide with each other either.
    expect(new Set([baseHash, ...hashes]).size).toBe(variants.length + 1);
  });

  it("covers the merge audit's base and superseded set", async () => {
    const merged = (
      base: string,
      superseded: string[],
    ): MarkdownRevisionEnvelope =>
      withManifest({ merge: { base, superseded } });

    const hashes = await Promise.all([
      hashOf(merged(HASH_B, [])),
      hashOf(merged(HASH_C, [])),
      hashOf(merged(HASH_B, [HASH_C])),
      hashOf(merged(HASH_B, [HASH_C, HASH_D])),
    ]);

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("is not affected by the key order of a node's attrs", async () => {
    const withAttrs = (
      attrs: Record<string, string | number>,
    ): MarkdownRevisionEnvelope => ({
      ...baseEnvelope(),
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs,
            content: [{ type: "text", text: "Title" }],
          },
        ],
      },
    });

    expect(
      await hashOf(withAttrs({ level: 2, id: "h-1", textAlign: "left" })),
    ).toBe(await hashOf(withAttrs({ textAlign: "left", id: "h-1", level: 2 })));
  });
});

describe("manifest refusals", () => {
  it("refuses a merge with a null parent", () => {
    const envelope = withManifest({
      parent: null,
      merge: { base: HASH_B, superseded: [] },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /a merge revision has a parent/u,
    );
  });

  it("refuses a transient merge", () => {
    const envelope = withManifest({
      transient: true,
      merge: { base: HASH_B, superseded: [] },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /a merge revision is never transient/u,
    );
  });

  it("refuses a transient agent write", () => {
    const envelope = withManifest({
      transient: true,
      author: { kind: "agent", chatId: "chat-1" },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /only a person's editor revision is transient/u,
    );
  });

  it("refuses a transient system write", () => {
    const envelope = withManifest({
      transient: true,
      author: { kind: "system" },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /only a person's editor revision is transient/u,
    );
  });

  it("refuses a transient revision with no editor session", () => {
    const envelope = withManifest({ transient: true, editorSessionId: null });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /a transient revision names its editor session/u,
    );
  });

  it("accepts a transient person write that names its editor session", () => {
    const envelope = withManifest({ transient: true });

    expect(decodeMarkdownRevision(encodeMarkdownRevision(envelope))).toEqual(
      envelope,
    );
  });

  it("refuses superseded revisions that are unsorted", () => {
    const envelope = withManifest({
      merge: { base: HASH_B, superseded: [HASH_D, HASH_C] },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /superseded revisions must be sorted and distinct/u,
    );
  });

  it("refuses superseded revisions that repeat", () => {
    const envelope = withManifest({
      merge: { base: HASH_B, superseded: [HASH_C, HASH_C] },
    });

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /superseded revisions must be sorted and distinct/u,
    );
  });

  it("refuses a parent or merge base that is not a lowercase sha256", () => {
    expectInvalid(
      () => encodeMarkdownRevision(withManifest({ parent: "A".repeat(64) })),
      /lowercase hex sha256/u,
    );
    expectInvalid(
      () =>
        encodeMarkdownRevision(
          withManifest({ merge: { base: "short", superseded: [] } }),
        ),
      /lowercase hex sha256/u,
    );
  });

  it("refuses an empty artifact, host, user or session id and a negative or fractional createdAt", () => {
    const bad: readonly Partial<MarkdownRevisionManifest>[] = [
      { artifactId: "" },
      { hostId: "" },
      { author: { kind: "person", userId: "" } },
      { author: { kind: "agent", chatId: "" } },
      { editorSessionId: "" },
      { createdAt: -1 },
      { createdAt: 1.5 },
    ];
    for (const patch of bad) {
      expect(
        markdownRevisionEnvelopeSchema.safeParse(withManifest(patch)).success,
      ).toBe(false);
    }
  });

  it("refuses an extra key on the manifest, the author and the merge", () => {
    const manifest = baseManifest();
    const candidates: readonly unknown[] = [
      { ...baseEnvelope(), manifest: { ...manifest, extra: 1 } },
      {
        ...baseEnvelope(),
        manifest: { ...manifest, author: { kind: "system", extra: 1 } },
      },
      {
        ...baseEnvelope(),
        manifest: {
          ...manifest,
          merge: { base: HASH_B, superseded: [], extra: 1 },
        },
      },
    ];
    for (const candidate of candidates) {
      expect(markdownRevisionEnvelopeSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });
});

describe("envelope refusals", () => {
  it("refuses a document whose root is not a doc node", () => {
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: { type: "paragraph", content: [{ type: "text", text: "x" }] },
    };

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /the document is a doc node/u,
    );
  });

  it("refuses a document with no type", () => {
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: { content: [] },
    };

    expectInvalid(
      () => encodeMarkdownRevision(envelope),
      /the document is a doc node/u,
    );
  });

  it("refuses a format other than 1", () => {
    expect(
      markdownRevisionEnvelopeSchema.safeParse({ ...baseEnvelope(), format: 2 })
        .success,
    ).toBe(false);
  });

  it("refuses scalars that mix the spec and ticket shapes", () => {
    const specWithAssignee = {
      ...baseEnvelope(),
      scalars: { kind: "spec", title: "T", assignee: "alice" },
    };
    const ticketWithoutStatus = {
      ...baseEnvelope(),
      scalars: { kind: "ticket", title: "T", assignee: "alice" },
    };
    const ticketWithBadStatus = {
      ...baseEnvelope(),
      scalars: { kind: "ticket", title: "T", assignee: "alice", status: 3 },
    };

    for (const candidate of [
      specWithAssignee,
      ticketWithoutStatus,
      ticketWithBadStatus,
    ]) {
      expect(markdownRevisionEnvelopeSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });
});

describe("encodeMarkdownRevision refuses anything the schema would drop", () => {
  it("refuses a document node carrying a key the document schema does not keep", () => {
    const paragraph = {
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
      futureField: { at: 1 },
    };
    const lossy = {
      ...baseEnvelope(),
      document: { type: "doc", content: [paragraph] },
    };

    expectInvalid(() => encodeMarkdownRevision(lossy), /does not keep/u);
  });

  it("refuses attrs carrying an own __proto__ key", () => {
    const attrs: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"ordinary":2}',
    );
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: {
        type: "doc",
        content: [
          { type: "paragraph", attrs, content: [{ type: "text", text: "x" }] },
        ],
      },
    };

    expectInvalid(() => encodeMarkdownRevision(envelope), /does not keep/u);
  });

  it("refuses a document array carrying an own property that is not an index", () => {
    // An element walk never sees the extra property and the schema rebuilds
    // the array without it, so the refusal has to come from the array itself.
    const content = [
      { type: "paragraph", content: [{ type: "text", text: "hello" }] },
    ];
    Object.assign(content, { futureField: { at: 1 } });
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: { type: "doc", content },
    };

    expectInvalid(() => encodeMarkdownRevision(envelope), /not a JSON value/u);
  });

  it("refuses attrs holding a sparse array", () => {
    // `JSON.stringify` writes the hole at index 0 as `null`, so the bytes
    // would name an array the caller never held.
    const ids: unknown[] = [];
    ids[1] = "x";
    const envelope: MarkdownRevisionEnvelope = {
      ...baseEnvelope(),
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { ids },
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
    };

    expectInvalid(() => encodeMarkdownRevision(envelope), /not a JSON value/u);
  });
});

describe("decodeMarkdownRevision refusals", () => {
  it("refuses a valid envelope in pretty-printed JSON as not canonically encoded", () => {
    const pretty = encoder.encode(JSON.stringify(baseEnvelope(), null, 2));

    expectInvalid(
      () => decodeMarkdownRevision(pretty),
      /not canonically encoded/u,
    );
  });

  it("refuses a valid envelope with unsorted keys as not canonically encoded", () => {
    const base = baseEnvelope();
    const unsorted = encoder.encode(
      JSON.stringify({
        scalars: base.scalars,
        markdown: base.markdown,
        manifest: base.manifest,
        format: base.format,
        document: base.document,
      }),
    );

    expectInvalid(
      () => decodeMarkdownRevision(unsorted),
      /not canonically encoded/u,
    );
  });

  it("refuses canonical bytes with trailing whitespace", () => {
    const canonical = encodeMarkdownRevision(baseEnvelope());
    const padded = new Uint8Array(canonical.byteLength + 1);
    padded.set(canonical);
    padded[canonical.byteLength] = 0x0a;

    expectInvalid(
      () => decodeMarkdownRevision(padded),
      /not canonically encoded/u,
    );
  });

  it("refuses an envelope carrying an unknown top-level key", () => {
    const canonical = decoder.decode(encodeMarkdownRevision(baseEnvelope()));
    // Valid JSON, keys still sorted, but a field this reader does not know.
    const withExtra = encoder.encode(canonical.replace(/^\{/u, '{"aaa":1,'));

    expectInvalid(() => decodeMarkdownRevision(withExtra), /Unrecognized key/u);
  });

  it("refuses an envelope carrying an unknown manifest key", () => {
    const parsed: unknown = JSON.parse(
      decoder.decode(encodeMarkdownRevision(baseEnvelope())),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("manifest" in parsed)
    ) {
      throw new Error("expected an envelope object");
    }
    const manifest: unknown = parsed.manifest;
    const bytes = encoder.encode(
      JSON.stringify({
        ...parsed,
        manifest: { ...Object(manifest), zzz: true },
      }),
    );

    expectInvalid(() => decodeMarkdownRevision(bytes), /Unrecognized key/u);
  });

  it("refuses an envelope whose document node carries a key the document schema strips", () => {
    // `document` is a non-strict object schema, so a parse strips an unknown
    // node key and the re-encoding would hash to a different id than the bytes.
    const canonical = decoder.decode(encodeMarkdownRevision(baseEnvelope()));
    const bytes = encoder.encode(
      canonical.replace('"type":"paragraph"', '"type":"paragraph","zzz":1'),
    );

    expectInvalid(
      () => decodeMarkdownRevision(bytes),
      /not canonically encoded/u,
    );
  });

  it("refuses a newer format number instead of reading around it", () => {
    const canonical = decoder.decode(encodeMarkdownRevision(baseEnvelope()));
    const bytes = encoder.encode(canonical.replace('"format":1', '"format":2'));

    expectInvalid(() => decodeMarkdownRevision(bytes), /expected 1/u);
  });

  it("refuses bytes that are not JSON", () => {
    expectInvalid(
      () => decodeMarkdownRevision(encoder.encode("not json")),
      /not UTF-8 JSON/u,
    );
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expectInvalid(
      () => decodeMarkdownRevision(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
      /not UTF-8 JSON/u,
    );
  });

  it("refuses a decode whose manifest breaks a refinement", () => {
    // Canonical bytes of a transient merge, produced without the refinement.
    const parsed = baseEnvelope();
    const forged = {
      document: parsed.document,
      format: 1,
      manifest: {
        artifactId: "artifact-1",
        author: { kind: "person", userId: "user-1" },
        createdAt: 1,
        editorSessionId: "session-1",
        hostId: "host-1",
        merge: { base: HASH_B, superseded: [] },
        parent: HASH_A,
        transient: true,
      },
      markdown: parsed.markdown,
      scalars: parsed.scalars,
    };

    expectInvalid(
      () => decodeMarkdownRevision(encoder.encode(JSON.stringify(forged))),
      /a merge revision is never transient/u,
    );
  });
});
