import { describe, expect, it } from "vitest";
import {
  EDITORS,
  openPathsRequestSchema,
} from "@traycer/protocol/host/editor/unary-schemas";

describe("EDITORS catalog", () => {
  it("IDs are unique", () => {
    const ids = EDITORS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each editor has a non-empty url scheme", () => {
    for (const editor of EDITORS) {
      expect(editor.urlScheme.length).toBeGreaterThan(0);
    }
  });
});

describe("openPathsRequestSchema", () => {
  it("accepts a valid request", () => {
    const result = openPathsRequestSchema.safeParse({
      editorId: "vscode",
      paths: ["/home/user/project"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty paths", () => {
    const result = openPathsRequestSchema.safeParse({
      editorId: "vscode",
      paths: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects editorId outside catalog", () => {
    const result = openPathsRequestSchema.safeParse({
      editorId: "not-a-real-editor",
      paths: ["/home/user/project"],
    });
    expect(result.success).toBe(false);
  });
});
