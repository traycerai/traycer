import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { epicGetTaskContextsUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  getTaskContextsRequestSchema,
  getTaskContextsResponseSchema,
  getTaskContextsResponseSchemaV10,
  type ListTaskLight,
  listTaskLightSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

function createListTaskLight(): ListTaskLight {
  return listTaskLightSchema.parse({
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
}

/**
 * Contract + schema coverage for the optional `epic.getTaskContexts` unary
 * method (batch task-context resolution for title/owner naming).
 */
describe("epic.getTaskContexts", () => {
  const v10Contract =
    hostRpcRegistry["epic.getTaskContexts"][1].versions[0].contract;
  const v11Contract =
    hostRpcRegistry["epic.getTaskContexts"][1].versions[1].contract;

  it("keeps v1.0 frozen and registers the v1.1 explicit-resolution minor", () => {
    expect(v10Contract.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(v11Contract.method).toBe("epic.getTaskContexts");
    expect(v11Contract.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(hostRpcRegistry["epic.getTaskContexts"][1].latestMinor).toBe(1);
    expect(hostRpcRegistry["epic.getTaskContexts"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("wires version-specific response schema instances", () => {
    expect(v10Contract.requestSchema).toBe(getTaskContextsRequestSchema);
    expect(v10Contract.responseSchema).toBe(getTaskContextsResponseSchemaV10);
    expect(v11Contract.requestSchema).toBe(getTaskContextsRequestSchema);
    expect(v11Contract.responseSchema).toBe(getTaskContextsResponseSchema);
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

  it("round-trips all explicit v1.1 resolution arms", () => {
    const listRow = createListTaskLight();

    const parsed = getTaskContextsResponseSchema.parse({
      tasks: {
        "epic-1": { status: "found", task: listRow },
        "epic-deleted": { status: "confirmed-absent" },
        "epic-unknown": { status: "unknown", reason: "transport" },
      },
    });

    expect(parsed.tasks["epic-1"]).toEqual({
      status: "found",
      task: listRow,
    });
    expect(parsed.tasks["epic-deleted"]).toEqual({
      status: "confirmed-absent",
    });
    expect(parsed.tasks["epic-unknown"]).toEqual({
      status: "unknown",
      reason: "transport",
    });
  });

  it("rejects raw v1.0 rows from the canonical v1.1 schema", () => {
    expect(
      getTaskContextsResponseSchema.safeParse({
        tasks: { "epic-legacy-null": null },
      }).success,
    ).toBe(false);
    expect(
      getTaskContextsResponseSchema.safeParse({
        tasks: { "epic-legacy-found": createListTaskLight() },
      }).success,
    ).toBe(false);
  });

  it("upgrades an old host's nullable rows to safe unknown outcomes", () => {
    const legacyFound = createListTaskLight();
    const upgraded = epicGetTaskContextsUpgradeV10ToV11.upgradeResponse({
      tasks: {
        "epic-found": legacyFound,
        "epic-legacy-null": null,
      },
    });

    expect(upgraded.tasks).toEqual({
      "epic-found": { status: "found", task: legacyFound },
      "epic-legacy-null": { status: "unknown", reason: "legacy" },
    });
  });
});
