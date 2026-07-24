import { describe, expect, it } from "vitest";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  workspaceSearchPathsRequestSchema,
  workspaceSearchPathsResponseSchema,
  workspaceSearchTextRequestSchema,
  workspaceSearchTextResponseSchema,
} from "../unary-schemas";

describe("workspace shared search sources", () => {
  it("preserves attached-root request and response wire shapes", () => {
    const request = {
      epicId: "epic-1",
      reference: { root: "/attached/workspace" },
      query: "needle",
      limit: 10,
      kinds: "files" as const,
    };
    expect(workspaceSearchPathsRequestSchema.parse(request)).toEqual(request);

    const response = {
      epicId: "epic-1",
      root: "/attached/workspace",
      outcome: "ready" as const,
      results: [{ kind: "file" as const, relPath: "src/a.ts", name: "a.ts" }],
      truncated: false,
    };
    expect(workspaceSearchPathsResponseSchema.parse(response)).toEqual(response);

    const textRequest = {
      epicId: "epic-1",
      reference: { root: "/attached/workspace" },
      query: "needle",
      options: {
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        includeGlobs: [],
        excludeGlobs: [],
      },
      limit: 10,
    };
    expect(workspaceSearchTextRequestSchema.parse(textRequest)).toEqual(textRequest);

    const textResponse = {
      epicId: "epic-1",
      root: "/attached/workspace",
      outcome: "ready" as const,
      results: [
        {
          relPath: "src/a.ts",
          lineNumber: 1,
          column: 1,
          preview: { text: "needle", ranges: [{ startByte: 0, endByte: 6 }] },
        },
      ],
      truncated: false,
    };
    expect(workspaceSearchTextResponseSchema.parse(textResponse)).toEqual(textResponse);
  });

  it("adds opaque Epic-artifact source variants without a mirror path", () => {
    const request = {
      epicId: "epic-1",
      reference: { kind: "epic-artifacts" as const },
      query: "needle",
      options: {
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        includeGlobs: [],
        excludeGlobs: [],
      },
      limit: 10,
    };
    expect(workspaceSearchTextRequestSchema.parse(request)).toEqual(request);

    const response = {
      epicId: "epic-1",
      source: { kind: "epic-artifacts" as const },
      outcome: "ready" as const,
      results: [
        {
          relPath: "tickets/one",
          lineNumber: 7,
          column: 1,
          preview: { text: "needle", ranges: [{ startByte: 0, endByte: 6 }] },
        },
      ],
      truncated: false,
    };
    expect(workspaceSearchTextResponseSchema.parse(response)).toEqual(response);
    expect(JSON.stringify(response)).not.toContain("/epics/");
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("workspace.searchPaths");
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("workspace.searchText");
  });

  it("gives an artifact discriminant precedence over an accidental root", () => {
    const pathRequest = workspaceSearchPathsRequestSchema.parse({
      epicId: "epic-1",
      reference: {
        kind: "epic-artifacts",
        root: "/tmp/attached",
        epicId: "other-epic",
      },
      query: "needle",
      limit: 10,
      kinds: "files",
    });
    expect(pathRequest.reference).toEqual({ kind: "epic-artifacts" });

    const textRequest = workspaceSearchTextRequestSchema.parse({
      epicId: "epic-1",
      reference: { kind: "epic-artifacts", root: "/tmp/attached" },
      query: "needle",
      options: {
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        includeGlobs: [],
        excludeGlobs: [],
      },
      limit: 10,
    });
    expect(textRequest.reference).toEqual({ kind: "epic-artifacts" });
  });
});
