import { describe, expect, it } from "vitest";
import {
  checkpointArtifactTagSchema,
  checkpointArtifactTagSchemaPreHtml,
  isNoOpCheckpointEntry,
  TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
  turnCheckpointManifestSchema,
  type TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

const MARKDOWN_KINDS = ["spec", "ticket", "story", "review"] as const;
const NEW_KINDS = ["html", "canvas", "file"] as const;
const ALL_KINDS = [...MARKDOWN_KINDS, ...NEW_KINDS] as const;

function entry(
  partial: Partial<TurnCheckpointManifestEntry>,
): TurnCheckpointManifestEntry {
  return {
    filePath: "/repo/file.ts",
    operation: "edit",
    beforeHash: null,
    afterHash: null,
    undoable: true,
    reason: null,
    ...partial,
  };
}

function manifest(entries: TurnCheckpointManifestEntry[]) {
  return {
    schemaVersion: TURN_CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    checkpointId: "checkpoint-1",
    capturingUserId: "user-1",
    capturingHostId: "host-1",
    allowedRoots: ["/repo"],
    workingDirectory: "/repo",
    capturedAt: 1_700_000_000_000,
    entries,
  };
}

describe("isNoOpCheckpointEntry", () => {
  it("flags a net-zero edit (before === after, both non-null)", () => {
    // Edited then reverted, or an idempotent rewrite, within the turn.
    expect(
      isNoOpCheckpointEntry(
        entry({ operation: "edit", beforeHash: "x", afterHash: "x" }),
      ),
    ).toBe(true);
  });

  it("flags a created-then-deleted file (undoable, both hashes null)", () => {
    expect(
      isNoOpCheckpointEntry(
        entry({
          operation: "delete",
          beforeHash: null,
          afterHash: null,
          undoable: true,
        }),
      ),
    ).toBe(true);
  });

  it("does NOT flag a real edit (before !== after)", () => {
    expect(
      isNoOpCheckpointEntry(
        entry({ operation: "edit", beforeHash: "x", afterHash: "y" }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a create (null -> hash)", () => {
    expect(
      isNoOpCheckpointEntry(
        entry({ operation: "create", beforeHash: null, afterHash: "y" }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a delete (hash -> null)", () => {
    expect(
      isNoOpCheckpointEntry(
        entry({ operation: "delete", beforeHash: "x", afterHash: null }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a skipped entry (both hashes null but not undoable)", () => {
    // Denied / binary / not-intercepted edits also carry before === after ===
    // null, but they represent a real change attempt and must stay visible as a
    // "Skipped" row. The `undoable: false` guard is what keeps them in.
    for (const reason of ["denied", "binary", "not_intercepted"]) {
      expect(
        isNoOpCheckpointEntry(
          entry({
            beforeHash: null,
            afterHash: null,
            undoable: false,
            reason,
          }),
        ),
      ).toBe(false);
    }
  });

  it("flags a net-zero artifact entry the same as a file (uniform rule)", () => {
    expect(
      isNoOpCheckpointEntry(
        entry({
          operation: "edit",
          beforeHash: "x",
          afterHash: "x",
          artifact: { artifactId: "a1", kind: "spec", title: "Spec" },
        }),
      ),
    ).toBe(true);
  });
});

describe("turnCheckpointManifestSchema: artifact tag kind", () => {
  it("parses a real manifest whose entry is tagged with each of the seven artifact kinds", () => {
    for (const kind of ALL_KINDS) {
      const parsed = turnCheckpointManifestSchema.safeParse(
        manifest([
          entry({
            artifact: { artifactId: `artifact-${kind}`, kind, title: "Title" },
          }),
        ]),
      );
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.entries[0]?.artifact?.kind).toBe(kind);
      }
    }
  });

  it("parses a manifest entry whose tag has a null kind (id not yet minted)", () => {
    const parsed = turnCheckpointManifestSchema.safeParse(
      manifest([
        entry({ artifact: { artifactId: null, kind: null, title: null } }),
      ]),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries[0]?.artifact).toEqual({
        artifactId: null,
        kind: null,
        title: null,
      });
    }
  });

  it("parses a legacy manifest entry recorded before artifacts entered the checkpoint flow (no `artifact` key at all)", () => {
    const legacyEntry = entry({});
    expect(legacyEntry).not.toHaveProperty("artifact");
    const parsed = turnCheckpointManifestSchema.safeParse(
      manifest([legacyEntry]),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entries[0]?.artifact).toBeUndefined();
    }
  });
});

describe("checkpointArtifactTagSchemaPreHtml: the frozen pre-html tag", () => {
  it("accepts the four markdown kinds and a null kind", () => {
    for (const kind of [...MARKDOWN_KINDS, null]) {
      expect(
        checkpointArtifactTagSchemaPreHtml.safeParse({
          artifactId: "artifact-1",
          kind,
          title: "Title",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects html, canvas and file", () => {
    for (const kind of NEW_KINDS) {
      expect(
        checkpointArtifactTagSchemaPreHtml.safeParse({
          artifactId: "artifact-1",
          kind,
          title: "Title",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts every kind the frozen union rejects on the live schema (the live schema is a superset)", () => {
    for (const kind of ALL_KINDS) {
      expect(
        checkpointArtifactTagSchema.safeParse({
          artifactId: "artifact-1",
          kind,
          title: "Title",
        }).success,
      ).toBe(true);
    }
  });
});
