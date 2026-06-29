import { describe, expect, it } from "vitest";
import type {
  EpicLight,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";

import { buildEpicMentionSuggestionsFromTasks } from "../local-epic-suggestions";

function epic(fields: {
  readonly id: string;
  readonly title: string;
  readonly initialUserPrompt: string;
  readonly updatedAt: number;
}): EpicLight {
  return {
    id: fields.id,
    title: fields.title,
    initialUserPrompt: fields.initialUserPrompt,
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "active",
    createdAt: 0,
    updatedAt: fields.updatedAt,
    createdBy: "user-1",
    version: "1.0.0",
  };
}

function task(light: EpicLight): TaskLight {
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

describe("buildEpicMentionSuggestionsFromTasks", () => {
  it("matches the new task label and the legacy epic label", () => {
    const tasks = [
      task(
        epic({
          id: "task-1",
          title: "Auth flow",
          initialUserPrompt: "",
          updatedAt: 10,
        }),
      ),
    ];

    expect(
      buildEpicMentionSuggestionsFromTasks(tasks, "task", 25).map(
        (entry) => entry.id,
      ),
    ).toEqual(["epic:task-1"]);
    expect(
      buildEpicMentionSuggestionsFromTasks(tasks, "epic", 25).map(
        (entry) => entry.id,
      ),
    ).toEqual(["epic:task-1"]);
  });

  it("keeps alias query ranking neutral instead of promoting title matches", () => {
    const tasks = [
      task(
        epic({
          id: "older-title-match",
          title: "Task cleanup",
          initialUserPrompt: "",
          updatedAt: 10,
        }),
      ),
      task(
        epic({
          id: "newer-neutral",
          title: "Billing flow",
          initialUserPrompt: "",
          updatedAt: 30,
        }),
      ),
    ];

    expect(
      ["task", "epic"].map((alias) =>
        buildEpicMentionSuggestionsFromTasks(tasks, alias, 25).map(
          (entry) => entry.id,
        ),
      ),
    ).toEqual([
      ["epic:newer-neutral", "epic:older-title-match"],
      ["epic:newer-neutral", "epic:older-title-match"],
    ]);
  });

  it("uses task copy for empty titles while preserving epic tokens", () => {
    const [entry] = buildEpicMentionSuggestionsFromTasks(
      [
        task(
          epic({
            id: "task-1",
            title: "",
            initialUserPrompt: "",
            updatedAt: 10,
          }),
        ),
      ],
      "",
      25,
    );

    expect(entry).toMatchObject({
      id: "epic:task-1",
      token: "epic:task-1",
      label: "Untitled task",
    });
  });

  it("keeps a literal Untitled epic title unchanged", () => {
    const [entry] = buildEpicMentionSuggestionsFromTasks(
      [
        task(
          epic({
            id: "task-1",
            title: "Untitled epic",
            initialUserPrompt: "",
            updatedAt: 10,
          }),
        ),
      ],
      "",
      25,
    );

    expect(entry).toMatchObject({
      id: "epic:task-1",
      token: "epic:task-1",
      label: "Untitled epic",
    });
  });
});
