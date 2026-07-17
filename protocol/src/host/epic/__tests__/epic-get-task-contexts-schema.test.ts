import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  getTaskContextsRequestSchema,
  getTaskContextsResponseSchema,
  listTaskLightSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Contract + schema coverage for the optional `epic.getTaskContexts@1.0`
 * unary method (batch task-context resolution for title/owner naming).
 */
describe("epic.getTaskContexts@1.0", () => {
  const contract =
    hostRpcRegistry["epic.getTaskContexts"][1].versions[0].contract;

  it("registers at major 1, minor 0 with optional unsupported degrade", () => {
    expect(contract.method).toBe("epic.getTaskContexts");
    expect(contract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(hostRpcRegistry["epic.getTaskContexts"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("wires the canonical request/response schema instances", () => {
    expect(contract.requestSchema).toBe(getTaskContextsRequestSchema);
    expect(contract.responseSchema).toBe(getTaskContextsResponseSchema);
  });

  it("round-trips a request within the id cap", () => {
    const taskIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS },
      (_, index) => `task-${index}`,
    );
    expect(getTaskContextsRequestSchema.parse({ taskIds })).toEqual({
      taskIds,
    });
  });

  it("rejects more than 50 task ids", () => {
    const taskIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 1 },
      (_, index) => `task-${index}`,
    );
    const result = getTaskContextsRequestSchema.safeParse({ taskIds });
    expect(result.success).toBe(false);
  });

  it("round-trips a response with ListTaskLight rows and null entries", () => {
    const listRow = listTaskLightSchema.parse({
      epic: {
        light: {
          id: "epic-1",
          title: "Owner title",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          createdBy: "user-1",
          version: "1",
        },
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
      pinned: false,
    });

    const parsed = getTaskContextsResponseSchema.parse({
      tasks: {
        "epic-1": listRow,
        // null = deleted or not permitted (indistinguishable by design)
        "epic-missing": null,
      },
    });

    expect(parsed.tasks["epic-1"]).toEqual(listRow);
    expect(parsed.tasks["epic-missing"]).toBeNull();
  });
});
