/**
 * Protocol-boundary contract for the head a markdown index entry carries once
 * its body is stored as revision objects: the one `revision.json` file with
 * the revision's `seq` and frontmatter `scalars`, kept by the live entry
 * schemas and dropped by the frozen pre-html readers older releases use. Also
 * the born-object marker (`markdownBody: "object"`) that names an object
 * without a head, the predicate over both, and the marker on a deleted
 * artifact's tombstone.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  buildDeletedEpicArtifact,
  deletedCanvasArtifactSchema,
  deletedEpicArtifactSchema,
  deletedEpicArtifactSchemaPreHtml,
  deletedFileArtifactSchema,
  deletedHtmlArtifactSchema,
  deletedReviewArtifactSchema,
  deletedSpecArtifactSchema,
  deletedStoryArtifactSchema,
  deletedTicketArtifactSchema,
  epicArtifactSchema,
  epicArtifactSchemaPreHtml,
  isMarkdownObjectEntry,
  markdownBodyEpochSchema,
  reviewArtifactSchema,
  reviewArtifactSchemaPreHtml,
  specArtifactSchema,
  specArtifactSchemaPreHtml,
  storyArtifactSchema,
  storyArtifactSchemaPreHtml,
  ticketArtifactSchema,
  ticketArtifactSchemaPreHtml,
} from "@traycer/protocol/persistence/epic/artifacts";

const TITLE = "Title";
const DELETED_AT = "2026-10-18T00:00:00.000Z";

const OBJECT_REF = {
  sha256: "a".repeat(64),
  byteLength: 412,
  mediaType: "application/json",
  status: "published",
};

const COMMON_FIELDS = {
  id: "art-1",
  folderName: "art-1",
  title: TITLE,
  createdAt: 1000,
  updatedAt: 1000,
  createdManually: false,
  parentId: null as string | null,
  layout: "folder",
  relativePath: "docs/art-1",
  artifactRoomId: "artifact-room-0",
};

/** The `revision.json` generation: the object ref plus seq and scalars. */
function revisionFile(scalars: Record<string, unknown>) {
  return { ...OBJECT_REF, seq: 7, scalars };
}

function headOf(file: Record<string, unknown>) {
  return {
    files: { "revision.json": file },
    capturedAt: 1700000000000,
  };
}

function headWithScalars(scalars: Record<string, unknown>) {
  return headOf(revisionFile(scalars));
}

function specEntry(head: unknown) {
  return { kind: "spec", ...COMMON_FIELDS, head };
}

function ticketEntry(kind: "ticket" | "story", head: unknown) {
  return { kind, ...COMMON_FIELDS, assignee: "user-1", status: 2, head };
}

function reviewEntry(head: unknown) {
  return { kind: "review", ...COMMON_FIELDS, head };
}

function plainScalars(kind: "spec" | "review") {
  return { kind, title: TITLE };
}

function ticketScalars(kind: "ticket" | "story") {
  return { kind, title: TITLE, assignee: "user-1", status: 2 };
}

const MARKDOWN_CASES = [
  {
    kind: "spec",
    schema: specArtifactSchema,
    preHtmlSchema: specArtifactSchemaPreHtml,
    entry: specEntry(headWithScalars(plainScalars("spec"))),
  },
  {
    kind: "ticket",
    schema: ticketArtifactSchema,
    preHtmlSchema: ticketArtifactSchemaPreHtml,
    entry: ticketEntry("ticket", headWithScalars(ticketScalars("ticket"))),
  },
  {
    kind: "story",
    schema: storyArtifactSchema,
    preHtmlSchema: storyArtifactSchemaPreHtml,
    entry: ticketEntry("story", headWithScalars(ticketScalars("story"))),
  },
  {
    kind: "review",
    schema: reviewArtifactSchema,
    preHtmlSchema: reviewArtifactSchemaPreHtml,
    entry: reviewEntry(headWithScalars(plainScalars("review"))),
  },
];

describe("a markdown entry's head keeps the revision's seq and scalars", () => {
  it.each(MARKDOWN_CASES)(
    "$kind parses through its schema and the union with the head intact",
    ({ schema, entry }) => {
      expect(schema.parse(entry)).toEqual(entry);
      expect(epicArtifactSchema.parse(entry)).toEqual(entry);
    },
  );

  it("refuses a head whose revision.json carries no seq", () => {
    const { seq: _seq, ...withoutSeq } = revisionFile(plainScalars("spec"));
    expect(
      specArtifactSchema.safeParse(specEntry(headOf(withoutSeq))).success,
    ).toBe(false);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("refuses a %s seq", (_label, seq) => {
    const file = { ...revisionFile(plainScalars("spec")), seq };
    expect(specArtifactSchema.safeParse(specEntry(headOf(file))).success).toBe(
      false,
    );
  });

  it("refuses a head whose revision.json carries no scalars", () => {
    const { scalars: _scalars, ...withoutScalars } = revisionFile(
      plainScalars("spec"),
    );
    expect(
      specArtifactSchema.safeParse(specEntry(headOf(withoutScalars))).success,
    ).toBe(false);
  });

  it.each([
    {
      label: "a ticket's scalars missing assignee",
      schema: ticketArtifactSchema,
      entry: ticketEntry(
        "ticket",
        headWithScalars({ kind: "ticket", title: TITLE, status: 2 }),
      ),
    },
    {
      label: "a ticket's scalars with an extra key",
      schema: ticketArtifactSchema,
      entry: ticketEntry(
        "ticket",
        headWithScalars({ ...ticketScalars("ticket"), extra: true }),
      ),
    },
    {
      label: "a spec's scalars with an extra key",
      schema: specArtifactSchema,
      entry: specEntry(
        headWithScalars({ ...plainScalars("spec"), extra: true }),
      ),
    },
  ])("refuses $label", ({ schema, entry }) => {
    expect(schema.safeParse(entry).success).toBe(false);
  });
});

describe("the frozen pre-html readers ignore the head", () => {
  it.each(MARKDOWN_CASES)(
    "$kind pre-html reader parses an entry carrying the head and drops it",
    ({ preHtmlSchema, entry }) => {
      const {
        head: _head,
        layout: _layout,
        relativePath: _relativePath,
        ...unchanged
      } = entry;
      const parsed = preHtmlSchema.parse(entry);
      expect(parsed).toEqual(unchanged);
      expect(parsed).not.toHaveProperty("head");
    },
  );

  it.each(MARKDOWN_CASES)(
    "pre-html union parses a $kind entry carrying the head and drops it",
    ({ entry }) => {
      const {
        head: _head,
        layout: _layout,
        relativePath: _relativePath,
        ...unchanged
      } = entry;
      const parsed = epicArtifactSchemaPreHtml.parse(entry);
      expect(parsed).toEqual(unchanged);
      expect(parsed).not.toHaveProperty("head");
    },
  );
});

describe("isMarkdownObjectEntry", () => {
  const markdownHead = headWithScalars(plainScalars("spec"));

  it.each<[string, unknown, unknown]>([
    ["a markdown head alone", markdownHead, undefined],
    ["the born marker alone", undefined, "object"],
    ["a head and the marker", markdownHead, "object"],
  ])("is true for %s", (_label, head, markdownBody) => {
    expect(isMarkdownObjectEntry(head, markdownBody)).toBe(true);
  });

  it.each<[string, unknown, unknown]>([
    ["neither", undefined, undefined],
    ["a null head and a null marker", null, null],
    [
      "an html-shaped head, which names no markdown revision",
      headOf(OBJECT_REF),
      undefined,
    ],
  ])("is false for %s", (_label, head, markdownBody) => {
    expect(isMarkdownObjectEntry(head, markdownBody)).toBe(false);
  });

  it.each<[string, unknown]>([
    ["another word", "inline"],
    ["the right word in another case", "Object"],
    ["the empty string", ""],
    ["a boolean", true],
    ["null", null],
  ])(
    "is false for a head-less entry whose marker is %s",
    (_label, markdownBody) => {
      expect(isMarkdownObjectEntry(undefined, markdownBody)).toBe(false);
    },
  );
});

describe("the born-object marker on a live markdown entry", () => {
  const bornOf = (entry: (typeof MARKDOWN_CASES)[number]["entry"]) => {
    const { head: _head, ...headless } = entry;
    return { ...headless, markdownBody: "object" };
  };

  it.each(MARKDOWN_CASES)(
    "$kind keeps a head-less marked entry through its schema and the union",
    ({ schema, entry }) => {
      const born = bornOf(entry);
      expect(schema.parse(born)).toEqual(born);
      expect(epicArtifactSchema.parse(born)).toEqual(born);
    },
  );

  it.each(MARKDOWN_CASES)(
    "$kind refuses a marker other than object",
    ({ schema, entry }) => {
      expect(
        schema.safeParse({ ...bornOf(entry), markdownBody: "inline" }).success,
      ).toBe(false);
    },
  );

  it.each(MARKDOWN_CASES)(
    "$kind pre-html reader drops the marker",
    ({ preHtmlSchema, entry }) => {
      const born = bornOf(entry);
      const {
        markdownBody: _markdownBody,
        layout: _layout,
        relativePath: _relativePath,
        ...unchanged
      } = born;
      const parsed = preHtmlSchema.parse(born);
      expect(parsed).toEqual(unchanged);
      expect(Object.keys(epicArtifactSchemaPreHtml.parse(born))).not.toContain(
        "markdownBody",
      );
    },
  );
});

describe("a deleted markdown artifact's born-object marker", () => {
  const DELETED_MARKDOWN = [
    { kind: "spec", schema: deletedSpecArtifactSchema },
    { kind: "ticket", schema: deletedTicketArtifactSchema },
    { kind: "story", schema: deletedStoryArtifactSchema },
    { kind: "review", schema: deletedReviewArtifactSchema },
  ];

  function slimTombstone(kind: string) {
    return {
      id: `deleted-${kind}`,
      kind,
      title: `Deleted ${kind}`,
      artifactRoomId: null,
      deletedAt: DELETED_AT,
    };
  }

  it.each(DELETED_MARKDOWN)(
    "$kind keeps the marker through its schema and the union",
    ({ kind, schema }) => {
      const tombstone = { ...slimTombstone(kind), markdownBody: "object" };
      expect(schema.parse(tombstone)).toEqual(tombstone);
      expect(deletedEpicArtifactSchema.parse(tombstone)).toEqual(tombstone);
    },
  );

  it.each(DELETED_MARKDOWN)(
    "$kind parses a tombstone without it and does not invent one",
    ({ kind, schema }) => {
      const tombstone = slimTombstone(kind);
      expect(schema.parse(tombstone)).toEqual(tombstone);
      expect(
        Object.keys(deletedEpicArtifactSchema.parse(tombstone)),
      ).not.toContain("markdownBody");
    },
  );

  it.each(DELETED_MARKDOWN)(
    "$kind refuses a marker other than object",
    ({ kind, schema }) => {
      const tombstone = { ...slimTombstone(kind), markdownBody: "inline" };
      expect(schema.safeParse(tombstone).success).toBe(false);
      expect(deletedEpicArtifactSchema.safeParse(tombstone).success).toBe(
        false,
      );
    },
  );

  it.each([
    { kind: "html", schema: deletedHtmlArtifactSchema },
    { kind: "canvas", schema: deletedCanvasArtifactSchema },
    { kind: "file", schema: deletedFileArtifactSchema },
  ])(
    "$kind tombstone strips the marker instead of keeping or refusing it",
    ({ kind, schema }) => {
      const tombstone = { ...slimTombstone(kind), markdownBody: "object" };
      expect(Object.keys(schema.parse(tombstone))).not.toContain(
        "markdownBody",
      );
      expect(
        Object.keys(deletedEpicArtifactSchema.parse(tombstone)),
      ).not.toContain("markdownBody");
    },
  );

  it.each(DELETED_MARKDOWN)(
    "the frozen pre-html union strips the marker from a $kind tombstone",
    ({ kind }) => {
      const parsed = deletedEpicArtifactSchemaPreHtml.parse({
        ...slimTombstone(kind),
        markdownBody: "object",
      });
      expect(parsed).toEqual(slimTombstone(kind));
    },
  );
});

describe("buildDeletedEpicArtifact on a markdown entry", () => {
  /** The same entry with its head taken off. */
  function headless(entry: (typeof MARKDOWN_CASES)[number]["entry"]) {
    const { head: _head, ...rest } = entry;
    return rest;
  }

  it.each(MARKDOWN_CASES)(
    "$kind with a head carries the marker, which the deleted union keeps",
    ({ entry }) => {
      const tombstone = buildDeletedEpicArtifact(
        epicArtifactSchema.parse(entry),
        DELETED_AT,
      );
      expect(tombstone).toHaveProperty("markdownBody", "object");
      expect(deletedEpicArtifactSchema.parse(tombstone)).toEqual(tombstone);
    },
  );

  it.each(MARKDOWN_CASES)(
    "$kind born as an object (the marker, no head yet) carries the marker",
    ({ entry }) => {
      const tombstone = buildDeletedEpicArtifact(
        epicArtifactSchema.parse({
          ...headless(entry),
          markdownBody: "object",
        }),
        DELETED_AT,
      );
      expect(tombstone).toHaveProperty("markdownBody", "object");
      expect(deletedEpicArtifactSchema.parse(tombstone)).toEqual(tombstone);
    },
  );

  it.each(MARKDOWN_CASES)(
    "$kind still in its room (no head, no marker) has no marker key at all",
    ({ entry }) => {
      const tombstone = buildDeletedEpicArtifact(
        epicArtifactSchema.parse(headless(entry)),
        DELETED_AT,
      );
      expect(Object.keys(tombstone)).not.toContain("markdownBody");
    },
  );
});

describe("the markdown body epoch", () => {
  it.each([0, 1])("accepts %s", (epoch) => {
    expect(markdownBodyEpochSchema.safeParse(epoch).success).toBe(true);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "1"],
  ])("refuses %s", (_label, epoch) => {
    expect(markdownBodyEpochSchema.safeParse(epoch).success).toBe(false);
  });
});
