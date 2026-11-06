/**
 * Protocol-boundary contract for the head a markdown index entry carries once
 * its body is stored as revision objects: the one `revision.json` file with
 * the revision's `seq` and frontmatter `scalars`, kept by the live entry
 * schemas and dropped by the frozen pre-html readers older releases use.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  epicArtifactSchema,
  epicArtifactSchemaPreHtml,
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
