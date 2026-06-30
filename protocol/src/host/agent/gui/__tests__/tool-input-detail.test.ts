import { describe, expect, it } from "vitest";
import {
  deriveToolInputDetail,
  resolveToolInputDetail,
} from "../tool-input-detail";

describe("deriveToolInputDetail", () => {
  it("reconstructs a grep CLI from the Claude Grep shape (omitting non-flag params)", () => {
    expect(
      deriveToolInputDetail("Grep", {
        pattern: "overflow-anchor",
        output_mode: "content",
        "-n": true,
        "-C": 3,
      }),
    ).toEqual({ kind: "command", command: 'grep -n -C 3 "overflow-anchor"' });
  });

  it("uses the literal command for shell tools", () => {
    expect(
      deriveToolInputDetail("shell", { command: "npm run build" }),
    ).toEqual({ kind: "command", command: "npm run build" });
  });

  it("uses nested metadata command for OpenCode shell approvals", () => {
    expect(
      deriveToolInputDetail("bash", {
        type: "bash",
        metadata: { command: "find . -name '*.sentry' | head -50" },
        pattern: ["find . -name '*.sentry'", "head -50"],
      }),
    ).toEqual({
      kind: "command",
      command: "find . -name '*.sentry' | head -50",
    });
  });

  it("humanizes an arbitrary object into label/value fields (no JSON braces)", () => {
    expect(
      deriveToolInputDetail("create_issue", {
        title: "Fix overflow",
        output_mode: "content",
        labels: ["bug", "ui"],
      }),
    ).toEqual({
      kind: "fields",
      entries: [
        { key: "title", label: "Title", value: "Fix overflow" },
        { key: "output_mode", label: "Output mode", value: "content" },
        { key: "labels", label: "Labels", value: '["bug","ui"]' },
      ],
    });
  });

  it("returns null for empty/unusable input", () => {
    expect(deriveToolInputDetail("noop", {})).toBeNull();
    expect(deriveToolInputDetail("noop", null)).toBeNull();
  });

  it("drops never-displayed bulk fields (file bodies) so they can't bloat the doc", () => {
    const body = "x".repeat(5000);
    const detail = deriveToolInputDetail("Edit", {
      file_path: "src/foo.ts",
      old_string: body,
      new_string: body,
    });
    if (detail?.kind !== "fields") throw new Error("expected fields detail");
    // old_string/new_string carry the file body and are never displayed (the
    // file_change card shows the diff) — dropped entirely, not truncated.
    expect(detail.entries.find((e) => e.key === "old_string")).toBeUndefined();
    expect(detail.entries.find((e) => e.key === "new_string")).toBeUndefined();
    // the small file_path field is preserved in full.
    expect(detail.entries.find((e) => e.key === "file_path")?.value).toBe(
      "src/foo.ts",
    );
  });

  it("drops the other inline-source bulk fields (content / patch / edits / new_source)", () => {
    const detail = deriveToolInputDetail("Write", {
      file_path: "src/foo.ts",
      content: "y".repeat(5000),
    });
    if (detail?.kind !== "fields") throw new Error("expected fields detail");
    expect(detail.entries.map((e) => e.key)).toEqual(["file_path"]);
  });

  it("persists a displayed field/command in full (no length cap)", () => {
    const command = `echo ${"a".repeat(5000)}`;
    const detail = deriveToolInputDetail("shell", { command });
    if (detail?.kind !== "command") throw new Error("expected command detail");
    expect(detail.command).toBe(command);
  });
});

describe("resolveToolInputDetail (hybrid rule)", () => {
  it("returns null when the header summary already captures the whole input", () => {
    // glob with only a pattern: header shows the pattern, nothing more to expand.
    expect(
      resolveToolInputDetail(
        deriveToolInputDetail("glob", { pattern: "**/*.tsx" }),
        "**/*.tsx",
      ),
    ).toBeNull();
    // a short shell command equal to its header summary.
    expect(
      resolveToolInputDetail(
        deriveToolInputDetail("shell", { command: "npm run build" }),
        "npm run build",
      ),
    ).toBeNull();
  });

  it("returns the detail when the input carries more than the header (grep flags)", () => {
    expect(
      resolveToolInputDetail(
        deriveToolInputDetail("Grep", {
          pattern: "overflow-anchor",
          "-n": true,
          "-C": 3,
        }),
        "overflow-anchor",
      ),
    ).toEqual({ kind: "command", command: 'grep -n -C 3 "overflow-anchor"' });
  });

  it("returns the detail when there are multiple fields beyond the header", () => {
    const body = resolveToolInputDetail(
      deriveToolInputDetail("create_issue", {
        title: "Fix overflow",
        labels: ["bug"],
      }),
      "Fix overflow",
    );
    expect(body?.kind).toBe("fields");
  });

  it("returns null for a null detail", () => {
    expect(resolveToolInputDetail(null, "anything")).toBeNull();
  });
});
