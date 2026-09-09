import { describe, expect, it } from "vitest";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  chunkTaskIds,
  combineTaskPinnedStateResults,
  overlayLocalHomedPinnedStates,
  type TaskPinnedState,
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
  localHomedTaskIds: GetTaskContextsResponse["localHomedTaskIds"],
): GetTaskContextsResponse {
  return { tasks, localHomedTaskIds };
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

  it("merges found rows and skips unknown or incomplete task entries", () => {
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
            missing: { status: "unknown", reason: "transport" },
            incomplete: { status: "found", task: listTaskLight(null, true) },
          },
          undefined,
        ),
      },
      {
        data: taskContexts(
          {
            second: { status: "found", task: listTaskLight("epic-b", false) },
          },
          undefined,
        ),
      },
      { data: undefined },
    ]);

    // The map holds `TaskPinnedState`, not a bare boolean: `home` rides along
    // so a row can disable its cloud-only pin action without a second lookup.
    // No local-home set is supplied here, so `home` is absent for both.
    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: undefined }],
      ["epic-b", { pinned: false, home: undefined }],
    ]);
  });

  it("marks a row local when the host's localHomedTaskIds names it", () => {
    // The populated arm: `localHomedTaskIds` is a real answer that must flip
    // `home` to `"local"` for exactly the ids it names.
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
          },
          ["epic-a"],
        ),
      },
    ]);

    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: "local" }],
    ]);
  });

  it("treats an EMPTY localHomedTaskIds as a real answer of none, not absence", () => {
    // An absent key means the host did not answer; an empty array means it
    // did, and the answer is "no task here is local-homed". Both must leave
    // `home` at `undefined`, but for different reasons - this pins the
    // second one so it cannot silently start behaving like the first.
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
          },
          [],
        ),
      },
    ]);

    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: undefined }],
    ]);
  });
});

describe("overlayLocalHomedPinnedStates", () => {
  it("returns the SAME map object when there is nothing to overlay", () => {
    // Deliberate identity preservation, not merely equal content: the common
    // case (no locally-homed epics among the open tabs) must not hand
    // consumers a fresh map every render.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-a", { pinned: true, home: undefined }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(queried, new Set());

    expect(overlaid).toBe(queried);
  });

  it("adds an entry for a local-homed epic the queried host never resolved", () => {
    // The wrong-host gap this hook exists to close: the epic id never reached
    // the queried map at all, so `pinned` has no source and must fall back to
    // filler rather than being left absent.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map();

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-local-only"]),
    );

    expect([...overlaid.entries()]).toEqual([
      ["epic-local-only", { pinned: false, home: "local" }],
    ]);
  });

  it("keeps the queried `pinned` value while overriding `home` to local", () => {
    // `pinned` is a cloud-only preference the queried host answers correctly
    // regardless of ownership - only `home` is ever overridden by the
    // session's own answer.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-both", { pinned: true, home: undefined }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-both"]),
    );

    expect(overlaid.get("epic-both")).toEqual({
      pinned: true,
      home: "local",
    });
  });

  it("leaves an epic absent from `localHomedEpicIds` exactly as queried", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-cloud", { pinned: true, home: undefined }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-unrelated"]),
    );

    expect(overlaid.get("epic-cloud")).toEqual({
      pinned: true,
      home: undefined,
    });
  });

  it("does not mutate the queried map it was given", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-a", { pinned: false, home: undefined }],
    ]);

    overlayLocalHomedPinnedStates(queried, new Set(["epic-a"]));

    expect(queried.get("epic-a")).toEqual({ pinned: false, home: undefined });
  });
});
