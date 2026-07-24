import { describe, expect, it } from "vitest";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  chunkTaskIds,
  combineTaskPinnedStateResults,
} from "@/hooks/epic/use-epic-task-pinned-states-query";

function listTaskLight(epicId: string | null, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light:
        epicId === null
          ? null
          : {
              id: epicId,
              title: epicId,
              initialUserPrompt: "",
              ticketCount: 0,
              specCount: 0,
              storyCount: 0,
              reviewCount: 0,
              status: "draft",
              createdAt: 0,
              updatedAt: 0,
              createdBy: "user-1",
              version: "1.0.0",
            },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned,
  };
}

function taskContexts(
  tasks: GetTaskContextsResponse["tasks"],
): GetTaskContextsResponse {
  return { tasks };
}

describe("chunkTaskIds", () => {
  it("splits requests that exceed the task-context request limit", () => {
    const taskIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 1 },
      (_value, index) => `epic-${index}`,
    );

    expect(chunkTaskIds(taskIds)).toEqual([
      taskIds.slice(0, GET_TASK_CONTEXTS_MAX_IDS),
      taskIds.slice(GET_TASK_CONTEXTS_MAX_IDS),
    ]);
  });
});

describe("combineTaskPinnedStateResults", () => {
  it("returns the shared empty state when no requests are present", () => {
    const pinnedStates = combineTaskPinnedStateResults([]);

    expect(pinnedStates).toBe(combineTaskPinnedStateResults([]));
    expect([...pinnedStates.entries()]).toEqual([]);
  });

  it("merges batch responses and skips null or incomplete task entries", () => {
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts({
          first: listTaskLight("epic-a", true),
          missing: null,
          incomplete: listTaskLight(null, true),
        }),
      },
      {
        data: taskContexts({
          second: listTaskLight("epic-b", false),
        }),
      },
      { data: undefined },
    ]);

    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", true],
      ["epic-b", false],
    ]);
  });
});
