import { describe, expect, it } from "vitest";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import {
  buildHistoryItemsFromTasks,
  collectHistoryRepos,
  filterHistoryItems,
  groupHistoryItems,
  type HistoryItem,
} from "@/components/home/data/home-page.data";

function makeItem(
  overrides: Partial<HistoryItem> & { id: string; title: string },
): HistoryItem {
  return {
    id: overrides.id,
    epicId: overrides.epicId ?? overrides.id,
    taskType: overrides.taskType ?? "epic",
    title: overrides.title,
    initialUserPrompt: overrides.initialUserPrompt ?? "",
    updatedAtMs: overrides.updatedAtMs ?? 1,
    updatedLabel: overrides.updatedLabel ?? "x",
    updatedBucket: overrides.updatedBucket ?? "today",
    linkedRepos: overrides.linkedRepos ?? [],
    linkedWorkspaces: overrides.linkedWorkspaces ?? [],
    ownership: overrides.ownership ?? "mine",
    permissionRole: overrides.permissionRole ?? "owner",
  };
}

describe("home-page history helpers", () => {
  it("collects unique repos across items", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", linkedRepos: ["gui-app", "mobile"] }),
      makeItem({ id: "b", title: "B", linkedRepos: ["mobile"] }),
      makeItem({ id: "c", title: "C", linkedRepos: ["host"] }),
    ];
    expect(collectHistoryRepos(items)).toEqual(["gui-app", "host", "mobile"]);
  });

  it("supports repo filtering in any and all modes", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", linkedRepos: ["gui-app", "mobile"] }),
      makeItem({ id: "b", title: "B", linkedRepos: ["mobile"] }),
      makeItem({ id: "c", title: "C", linkedRepos: ["host"] }),
    ];
    expect(
      filterHistoryItems(items, {
        repoNames: ["mobile"],
        repoMatchMode: "any",
        workspaces: [],
        workspaceMatchMode: "any",
        ownershipScopes: [],
      }),
    ).toHaveLength(2);

    expect(
      filterHistoryItems(items, {
        repoNames: ["gui-app", "mobile"],
        repoMatchMode: "all",
        workspaces: [],
        workspaceMatchMode: "any",
        ownershipScopes: [],
      }),
    ).toHaveLength(1);
  });

  it("groups filtered items into recency sections", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", updatedBucket: "today" }),
      makeItem({ id: "c", title: "C", updatedBucket: "earlier" }),
    ];
    const groups = groupHistoryItems(items);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "earlier"]);
  });

  it("builds history items from cloud task lights and extracts real repo identifiers", () => {
    const tasks: ReadonlyArray<TaskLight> = [
      {
        epic: {
          light: {
            id: "epic-real",
            title: "Real epic",
            initialUserPrompt: "Ship it",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "draft",
            createdAt: Date.parse("2026-04-21T09:00:00.000Z"),
            updatedAt: Date.parse("2026-04-22T09:00:00.000Z"),
            createdBy: "user-1",
            version: "1",
          },
          permission: null,
          repos: [
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "gui-app" },
              createdAt: 0,
              createdBy: "user-1",
            },
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "host" },
              createdAt: 0,
              createdBy: "user-1",
            },
          ],
          workspaces: [],
          roomInfo: null,
        },
        phase: null,
      },
      {
        epic: null,
        phase: {
          light: {
            id: "phase-real",
            title: "Real phase",
            userQuery: "Do phase work",
            phaseLength: 2,
            status: "ready",
            createdAt: Date.parse("2026-04-20T09:00:00.000Z"),
            updatedAt: Date.parse("2026-04-22T10:00:00.000Z"),
            createdBy: "user-1",
            version: "1.0.0",
          },
          permission: null,
          repos: [
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "gui-app" },
              createdAt: 0,
              createdBy: "user-1",
            },
          ],
          workspaces: [],
          roomInfo: null,
        },
      },
    ];

    const items = buildHistoryItemsFromTasks(
      tasks,
      Date.parse("2026-04-22T12:00:00.000Z"),
      "user-1",
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      epicId: "epic-real",
      taskType: "epic",
      title: "Real epic",
      // Raw prompt is threaded through so render sites can derive the
      // empty-title fallback from it.
      initialUserPrompt: "Ship it",
      updatedBucket: "today",
      linkedRepos: ["traycerai/gui-app", "traycerai/host"],
      ownership: "mine",
      permissionRole: "owner",
    });
    expect(items[1]).toMatchObject({
      id: "phase-phase-real",
      epicId: "phase-real",
      taskType: "phase",
      title: "Real phase",
      // Phases have no user prompt.
      initialUserPrompt: "",
      updatedBucket: "today",
      linkedRepos: ["traycerai/gui-app"],
    });
  });
});
