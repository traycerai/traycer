import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";

type FetchEpicListPage = (
  cursor: string | undefined,
) => Promise<ListTasksResponse>;

export async function fetchExistingEpicIdsFromPages(
  fetchPage: FetchEpicListPage,
): Promise<ReadonlySet<string>> {
  const epicIds = new Set<string>();
  let cursor: string | undefined = undefined;

  for (;;) {
    const page = await fetchPage(cursor);

    for (const task of page.tasks) {
      const epic = task.epic?.light ?? null;
      if (epic !== null) {
        epicIds.add(epic.id);
      }
    }

    if (
      !page.hasMore ||
      typeof page.nextCursor !== "string" ||
      page.nextCursor.length === 0
    ) {
      return epicIds;
    }
    cursor = page.nextCursor;
  }
}

export function missingEpicIds(
  openEpicIds: ReadonlyArray<string>,
  existingEpicIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  return openEpicIds.filter((epicId) => !existingEpicIds.has(epicId));
}
