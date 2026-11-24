import type { QueryClient } from "@tanstack/react-query";
import { act } from "@testing-library/react";

// Events the kept-variable action tests wait on. Each resolves from the
// client's own cache notification, so no case polls, sleeps or sets a deadline.

function queriesFor(client: QueryClient, method: string) {
  const marker = JSON.stringify(method);
  return client.getQueryCache().findAll({
    predicate: (query) => JSON.stringify(query.queryKey).includes(marker),
  });
}

/** How many times a method's query has stored data; take it before an action. */
function queryUpdateCount(client: QueryClient, method: string): number {
  return queriesFor(client, method).reduce(
    (most, query) => Math.max(most, query.state.dataUpdateCount),
    0,
  );
}

/** Resolves once the method's query has stored data more than `after` times. */
export function queryUpdatedBeyond(
  client: QueryClient,
  method: string,
  after: number,
): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (queryUpdateCount(client, method) <= after) return false;
      unsubscribe();
      resolve();
      return true;
    };
    const unsubscribe = client.getQueryCache().subscribe(check);
    check();
  });
}

/**
 * Resolves when a mutation has ended and none is left running: an outer
 * mutation that awaits an inner one ends last, and a refused or failed run
 * ends the same way, so a negative case asserts only after its terminal state.
 * Arm it before the action that starts the mutation.
 */
export function mutationsSettled(client: QueryClient): Promise<void> {
  return new Promise((resolve) => {
    let ended = false;
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const status = event.mutation.state.status;
      if (status === "success" || status === "error") ended = true;
      if (!ended || client.isMutating() !== 0) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Lets React commit the cache update the caller just awaited. */
export async function commitRender(): Promise<void> {
  await act(() => Promise.resolve());
}
