/**
 * Protocol-boundary contract for the html, canvas and file artifact kinds:
 * the new live and tombstone variants, the frozen pre-html unions, the
 * manifest leaves (path, object ref, status) and the tombstone builder.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  artifactManifestPathSchema,
  artifactObjectRefSchema,
  artifactObjectStatusSchema,
  buildDeletedEpicArtifact,
  canvasArtifactSchema,
  deletedEpicArtifactSchema,
  deletedEpicArtifactSchemaPreHtml,
  epicArtifactSchema,
  epicArtifactSchemaPreHtml,
  fileArtifactSchema,
  htmlArtifactSchema,
  specArtifactSchema,
  ticketArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";

const SHA256 = "a".repeat(64);
const DELETED_AT = "2026-10-18T00:00:00.000Z";

const COMMON_FIELDS = {
  id: "art-1",
  folderName: "art-1",
  title: "Title",
  createdAt: 1000,
  updatedAt: 1000,
  createdManually: false,
  parentId: null as string | null,
};

const OBJECT_REF = {
  sha256: SHA256,
  byteLength: 12,
  mediaType: "text/html",
  status: "published",
};

const HEAD = {
  files: { "index.html": OBJECT_REF },
  capturedAt: 1700000000000,
};

function htmlEntry() {
  return { kind: "html", ...COMMON_FIELDS, head: HEAD };
}

function canvasEntry() {
  return {
    kind: "canvas",
    ...COMMON_FIELDS,
    artifactRoomId: "artifact-room-0",
    head: HEAD,
  };
}

function fileEntry() {
  return { kind: "file", ...COMMON_FIELDS, object: OBJECT_REF };
}

function specEntry() {
  return { kind: "spec", ...COMMON_FIELDS, artifactRoomId: "artifact-room-0" };
}

function ticketEntry() {
  return {
    kind: "ticket",
    ...COMMON_FIELDS,
    artifactRoomId: "artifact-room-0",
    assignee: "user-1",
    status: 2,
  };
}

function storyEntry() {
  return { ...ticketEntry(), kind: "story" };
}

function reviewEntry() {
  return {
    kind: "review",
    ...COMMON_FIELDS,
    artifactRoomId: "artifact-room-0",
  };
}

function slimTombstone(kind: string) {
  return {
    id: `deleted-${kind}`,
    kind,
    title: `Deleted ${kind}`,
    artifactRoomId: null,
    deletedAt: DELETED_AT,
  };
}

const MARKDOWN_ENTRIES = [
  specEntry(),
  ticketEntry(),
  storyEntry(),
  reviewEntry(),
];
const NEW_ENTRIES = [htmlEntry(), canvasEntry(), fileEntry()];
const MARKDOWN_KINDS = ["spec", "ticket", "story", "review"];
const NEW_KINDS = ["html", "canvas", "file"];

describe("new artifact kinds parse from minimal entries", () => {
  it("htmlArtifactSchema retains an explicitly allocated artifactRoomId", () => {
    const parsed = htmlArtifactSchema.safeParse({
      ...htmlEntry(),
      artifactRoomId: "artifact-room-0",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.artifactRoomId).toBe("artifact-room-0");
      expect(parsed.data.head.files["index.html"]?.status).toBe("published");
    }
  });

  it("htmlArtifactSchema defaults a missing artifactRoomId to the empty string", () => {
    // Older HTML entries have no room until the room heal pass allocates
    // one - see htmlArtifactSchema's own docblock.
    const parsed = htmlArtifactSchema.safeParse(htmlEntry());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.artifactRoomId).toBe("");
    }
  });

  it("htmlArtifactSchema requires a head", () => {
    const { head: _head, ...withoutHead } = htmlEntry();
    expect(htmlArtifactSchema.safeParse(withoutHead).success).toBe(false);
  });

  it("canvasArtifactSchema parses a minimal entry and requires artifactRoomId", () => {
    const parsed = canvasArtifactSchema.safeParse(canvasEntry());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.artifactRoomId).toBe("artifact-room-0");
    }

    const { artifactRoomId: _room, ...withoutRoom } = canvasEntry();
    expect(canvasArtifactSchema.safeParse(withoutRoom).success).toBe(false);
  });

  it("canvasArtifactSchema requires a head", () => {
    const { head: _head, ...withoutHead } = canvasEntry();
    expect(canvasArtifactSchema.safeParse(withoutHead).success).toBe(false);
  });

  it("fileArtifactSchema parses a minimal entry and carries no artifactRoomId", () => {
    const parsed = fileArtifactSchema.safeParse({
      ...fileEntry(),
      artifactRoomId: "artifact-room-0",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("artifactRoomId");
      expect(parsed.data.object.sha256).toBe(SHA256);
      expect(parsed.data.object.byteLength).toBe(12);
      expect(parsed.data.object.mediaType).toBe("text/html");
      expect(parsed.data.object.status).toBe("published");
    }
  });

  it("fileArtifactSchema requires every nested object field", () => {
    for (const field of ["sha256", "byteLength", "mediaType", "status"]) {
      const object: Record<string, unknown> = { ...OBJECT_REF };
      delete object[field];
      const entry = { ...fileEntry(), object };
      expect(fileArtifactSchema.safeParse(entry).success).toBe(false);
    }
  });
});

describe("epic artifact unions", () => {
  it("epicArtifactSchema accepts all seven kinds", () => {
    const entries = [...MARKDOWN_ENTRIES, ...NEW_ENTRIES];
    expect(entries.map((entry) => entry.kind)).toEqual([
      ...MARKDOWN_KINDS,
      ...NEW_KINDS,
    ]);
    for (const entry of entries) {
      const parsed = epicArtifactSchema.safeParse(entry);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.kind).toBe(entry.kind);
      }
    }
  });

  it("frozen pre-html union rejects html, canvas and file and accepts the four", () => {
    for (const entry of NEW_ENTRIES) {
      expect(epicArtifactSchemaPreHtml.safeParse(entry).success).toBe(false);
    }
    for (const entry of MARKDOWN_ENTRIES) {
      expect(epicArtifactSchemaPreHtml.safeParse(entry).success).toBe(true);
    }
  });

  it("deletedEpicArtifactSchema accepts slim tombstones of all seven kinds", () => {
    for (const kind of [...MARKDOWN_KINDS, ...NEW_KINDS]) {
      const parsed = deletedEpicArtifactSchema.safeParse(slimTombstone(kind));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.kind).toBe(kind);
      }
    }
  });

  it("frozen deleted pre-html union rejects the new kinds and accepts the four", () => {
    for (const kind of NEW_KINDS) {
      expect(
        deletedEpicArtifactSchemaPreHtml.safeParse(slimTombstone(kind)).success,
      ).toBe(false);
    }
    for (const kind of MARKDOWN_KINDS) {
      expect(
        deletedEpicArtifactSchemaPreHtml.safeParse(slimTombstone(kind)).success,
      ).toBe(true);
    }
  });
});

describe("layout and relativePath", () => {
  it("defaults layout to folder on a live markdown entry", () => {
    const parsed = epicArtifactSchema.parse(specEntry());
    expect(parsed).toHaveProperty("layout", "folder");
  });

  it("defaults layout to file on a file entry", () => {
    const parsed = epicArtifactSchema.parse(fileEntry());
    expect(parsed).toHaveProperty("layout", "file");
  });

  it("keeps an explicit layout on a markdown entry", () => {
    const parsed = specArtifactSchema.parse({ ...specEntry(), layout: "file" });
    expect(parsed.layout).toBe("file");
  });

  it("treats relativePath as optional and validates it as a manifest path", () => {
    expect(specArtifactSchema.parse(specEntry()).relativePath).toBeUndefined();
    expect(
      specArtifactSchema.parse({ ...specEntry(), relativePath: "docs/a.md" })
        .relativePath,
    ).toBe("docs/a.md");
    expect(
      specArtifactSchema.safeParse({ ...specEntry(), relativePath: "../a.md" })
        .success,
    ).toBe(false);
  });

  it("frozen pre-html union output carries no layout or relativePath key", () => {
    for (const entry of MARKDOWN_ENTRIES) {
      const parsed = epicArtifactSchemaPreHtml.parse({
        ...entry,
        layout: "file",
        relativePath: "a/b.md",
      });
      expect(parsed).not.toHaveProperty("layout");
      expect(parsed).not.toHaveProperty("relativePath");
    }
  });
});

describe("artifactManifestPathSchema", () => {
  it.each(["index.html", "assets/app.js", "a/b/c.png"])(
    "accepts %s",
    (path) => {
      expect(artifactManifestPathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    ["leading ./", "./x"],
    ["leading slash", "/x"],
    ["parent segment", "a/../b"],
    ["empty segment", "a//b"],
    ["leading dot segment", ".hidden/x"],
    ["nested .git segment", "a/.git/x"],
    ["empty string", ""],
    ["trailing slash", "a/"],
  ])("rejects %s", (_label, path) => {
    expect(artifactManifestPathSchema.safeParse(path).success).toBe(false);
  });

  // These two depend on the path rule being tightened by the schema agent.
  it("rejects a backslash", () => {
    expect(artifactManifestPathSchema.safeParse("a\\b").success).toBe(false);
  });

  it("rejects a NUL control character", () => {
    expect(artifactManifestPathSchema.safeParse("a\u0000b").success).toBe(
      false,
    );
  });

  it.each([
    ["C1 NEL", "a\u0085b"],
    ["C1 CSI", "a\u009bb"],
    ["embedded newline", "a\nb"],
    ["trailing newline", "a\n"],
    ["trailing newline after an extension", "index.html\n"],
  ])("rejects %s", (_label, path) => {
    expect(artifactManifestPathSchema.safeParse(path).success).toBe(false);
  });

  it.each([
    ["root", "__proto__"],
    ["nested", "a/__proto__"],
    ["middle", "a/__proto__/b"],
    ["leading with a child", "__proto__/b"],
  ])(
    "rejects a complete __proto__ segment at the %s position",
    (_label, path) => {
      expect(artifactManifestPathSchema.safeParse(path).success).toBe(false);
    },
  );

  it.each([
    "__proto__.html",
    "a/__proto__.html",
    "x__proto__",
    "a/__proto__x/b",
  ])("accepts %s because __proto__ is not a complete segment", (path) => {
    expect(artifactManifestPathSchema.safeParse(path).success).toBe(true);
  });
});

describe("artifact head parsed from JSON text", () => {
  it("refuses a head whose files object carries an own __proto__ key", () => {
    // JSON.parse makes __proto__ an own property; a record parser that
    // dropped it would silently lose a file from the manifest.
    const text = JSON.stringify({
      files: { "index.html": OBJECT_REF },
      capturedAt: 1,
    }).replace(
      '"files":{',
      '"files":{"__proto__":' + JSON.stringify(OBJECT_REF) + ",",
    );
    const parsedText: unknown = JSON.parse(text);
    expect(text).toContain('"__proto__"');
    expect(
      htmlArtifactSchema.safeParse({ ...htmlEntry(), head: parsedText })
        .success,
    ).toBe(false);
  });

  it("still accepts a head whose files object has ordinary keys", () => {
    const parsedText: unknown = JSON.parse(JSON.stringify(HEAD));
    expect(
      htmlArtifactSchema.safeParse({ ...htmlEntry(), head: parsedText })
        .success,
    ).toBe(true);
  });
});

describe("artifactObjectRefSchema", () => {
  it("accepts a valid ref", () => {
    expect(artifactObjectRefSchema.safeParse(OBJECT_REF).success).toBe(true);
  });

  it("requires sha256 to be 64 lowercase hex characters", () => {
    expect(
      artifactObjectRefSchema.safeParse({
        ...OBJECT_REF,
        sha256: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      artifactObjectRefSchema.safeParse({
        ...OBJECT_REF,
        sha256: "a".repeat(63),
      }).success,
    ).toBe(false);
  });

  it("rejects a negative or non-integer byteLength and accepts zero", () => {
    expect(
      artifactObjectRefSchema.safeParse({ ...OBJECT_REF, byteLength: -1 })
        .success,
    ).toBe(false);
    expect(
      artifactObjectRefSchema.safeParse({ ...OBJECT_REF, byteLength: 1.5 })
        .success,
    ).toBe(false);
    expect(
      artifactObjectRefSchema.safeParse({ ...OBJECT_REF, byteLength: 0 })
        .success,
    ).toBe(true);
  });

  it("accepts lowercase type/subtype media types", () => {
    for (const mediaType of ["text/html", "application/octet-stream"]) {
      expect(
        artifactObjectRefSchema.safeParse({ ...OBJECT_REF, mediaType }).success,
      ).toBe(true);
    }
  });

  it("rejects uppercase, slashless, parameterised and over-long media types", () => {
    const overLong = "a/" + "b".repeat(126);
    expect(overLong).toHaveLength(128);
    for (const mediaType of [
      "TEXT/HTML",
      "html",
      "text/html; charset=utf-8",
      overLong,
    ]) {
      expect(
        artifactObjectRefSchema.safeParse({ ...OBJECT_REF, mediaType }).success,
      ).toBe(false);
    }
  });

  it("accepts a media type of exactly 127 characters", () => {
    const mediaType = "a/" + "b".repeat(125);
    expect(mediaType).toHaveLength(127);
    expect(
      artifactObjectRefSchema.safeParse({ ...OBJECT_REF, mediaType }).success,
    ).toBe(true);
  });
});

describe("artifactObjectStatusSchema", () => {
  it.each(["queued", "uploading", "published", "local-only", "failed"])(
    "accepts %s",
    (status) => {
      expect(artifactObjectStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it("rejects an unknown status", () => {
    expect(artifactObjectStatusSchema.safeParse("done").success).toBe(false);
  });
});

describe("buildDeletedEpicArtifact", () => {
  it("builds an html tombstone with a null room and null assignee and status", () => {
    const html = htmlArtifactSchema.parse(htmlEntry());
    const tombstone = buildDeletedEpicArtifact(html, DELETED_AT);
    expect(tombstone).toEqual({
      id: "art-1",
      kind: "html",
      title: "Title",
      artifactRoomId: null,
      deletedAt: DELETED_AT,
      folderName: "art-1",
      parentId: null,
      createdAt: 1000,
      createdManually: false,
      assignee: null,
      status: null,
    });
    expect(deletedEpicArtifactSchema.safeParse(tombstone).success).toBe(true);
  });

  it.each<[string, string | undefined]>([
    ["absent", undefined],
    ["explicitly empty", ""],
  ])(
    "keeps an html tombstone's room null when the source room is %s",
    (_label, artifactRoomId) => {
      const entry =
        artifactRoomId === undefined
          ? htmlEntry()
          : { ...htmlEntry(), artifactRoomId };
      const html = htmlArtifactSchema.parse(entry);
      const tombstone = buildDeletedEpicArtifact(html, DELETED_AT);
      expect(tombstone.artifactRoomId).toBeNull();
    },
  );

  it("carries the room id on an html tombstone once one is allocated", () => {
    const html = htmlArtifactSchema.parse({
      ...htmlEntry(),
      artifactRoomId: "artifact-room-0",
    });
    const tombstone = buildDeletedEpicArtifact(html, DELETED_AT);
    expect(tombstone).toMatchObject({
      kind: "html",
      artifactRoomId: "artifact-room-0",
      assignee: null,
      status: null,
    });
    expect(deletedEpicArtifactSchema.safeParse(tombstone).success).toBe(true);
  });

  it("builds a file tombstone with a null room", () => {
    const file = fileArtifactSchema.parse(fileEntry());
    const tombstone = buildDeletedEpicArtifact(file, DELETED_AT);
    expect(tombstone).toMatchObject({
      kind: "file",
      artifactRoomId: null,
      assignee: null,
      status: null,
    });
    expect(deletedEpicArtifactSchema.safeParse(tombstone).success).toBe(true);
  });

  it("carries the room id on a canvas tombstone", () => {
    const canvas = canvasArtifactSchema.parse(canvasEntry());
    const tombstone = buildDeletedEpicArtifact(canvas, DELETED_AT);
    expect(tombstone).toMatchObject({
      kind: "canvas",
      artifactRoomId: "artifact-room-0",
      assignee: null,
      status: null,
    });
    expect(deletedEpicArtifactSchema.safeParse(tombstone).success).toBe(true);
  });

  it("still carries assignee and status on a ticket tombstone", () => {
    const ticket = ticketArtifactSchema.parse(ticketEntry());
    const tombstone = buildDeletedEpicArtifact(ticket, DELETED_AT);
    expect(tombstone).toMatchObject({
      kind: "ticket",
      artifactRoomId: "artifact-room-0",
      assignee: "user-1",
      status: 2,
    });
  });
});
