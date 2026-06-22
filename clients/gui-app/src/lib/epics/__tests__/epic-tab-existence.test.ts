import { describe, expect, it, vi } from "vitest";
import type {
  EpicLight,
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  fetchExistingEpicIdsFromPages,
  missingEpicIds,
} from "@/lib/epics/epic-tab-existence";

function task(epicId: string): TaskLight {
  const light: EpicLight = {
    id: epicId,
    title: epicId,
    initialUserPrompt: "",
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    createdBy: "test",
    version: "2.0.0",
  };
  return {
    epic: {
      light,
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

describe("epic tab existence reconciliation", () => {
  it("fetches every page before deciding which persisted epic tabs are stale", async () => {
    const pages: ReadonlyArray<ListTasksResponse> = [
      { tasks: [task("epic-a")], hasMore: true, nextCursor: "page-2" },
      { tasks: [task("epic-b")], hasMore: false },
    ];
    const fetchPage = vi.fn((cursor: string | undefined) => {
      const page = cursor === undefined ? pages[0] : pages[1];
      return Promise.resolve(page);
    });

    const existingEpicIds = await fetchExistingEpicIdsFromPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "page-2");
    expect(Array.from(existingEpicIds).sort()).toEqual(["epic-a", "epic-b"]);
    expect(
      missingEpicIds(["epic-a", "epic-b", "epic-deleted"], existingEpicIds),
    ).toEqual(["epic-deleted"]);
  });

  it("does not treat malformed epic rows as existing epics", async () => {
    const existingEpicIds = await fetchExistingEpicIdsFromPages(() =>
      Promise.resolve({
        tasks: [
          {
            epic: {
              light: null,
              permission: null,
              repos: [],
              workspaces: [],
              roomInfo: null,
            },
          },
        ],
        hasMore: false,
      }),
    );

    expect(missingEpicIds(["epic-missing"], existingEpicIds)).toEqual([
      "epic-missing",
    ]);
  });
});
