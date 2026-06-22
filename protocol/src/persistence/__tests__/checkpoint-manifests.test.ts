import { describe, expect, it } from "vitest";
import {
  isNoOpCheckpointEntry,
  type TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

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
