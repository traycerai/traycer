import type {
  EpicLight,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";

export class EpicCatalog {
  readonly #tasks = new Map<string, TaskLight>();

  insert(epic: EpicLight): TaskLight {
    const task: TaskLight = {
      epic: {
        light: {
          id: epic.id,
          title: epic.title,
          initialUserPrompt: epic.initialUserPrompt,
          ticketCount: epic.ticketCount,
          specCount: epic.specCount,
          storyCount: epic.storyCount,
          reviewCount: epic.reviewCount,
          status: epic.status,
          createdAt: epic.createdAt,
          updatedAt: epic.updatedAt,
          createdBy: epic.createdBy,
          version: epic.version,
        },
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
    };
    this.#tasks.set(epic.id, task);
    return task;
  }

  list(): TaskLight[] {
    return [...this.#tasks.values()];
  }
}
