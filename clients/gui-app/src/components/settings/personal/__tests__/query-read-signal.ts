import type { QueryClient } from "@tanstack/react-query";
import { isRecord } from "@/lib/editor/prosemirror-json";

export interface QueryReadSignalTarget {
  readonly method: string;
  readonly hostId?: string;
  readonly environmentId?: string;
}

interface QueryReadSignalEvent {
  readonly query: {
    readonly queryKey: readonly unknown[];
    readonly state: {
      readonly fetchStatus: string;
      readonly status: string;
    };
  };
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isQueryReadSignalEvent(value: unknown): value is QueryReadSignalEvent {
  if (!isRecord(value) || !isRecord(value.query)) return false;
  const { query } = value;
  if (!isUnknownArray(query.queryKey) || !isRecord(query.state)) return false;
  return (
    typeof query.state.fetchStatus === "string" &&
    typeof query.state.status === "string"
  );
}

function matchesTarget(
  queryKey: readonly unknown[],
  target: QueryReadSignalTarget,
): boolean {
  if (!queryKey.includes(target.method)) return false;
  if (target.hostId !== undefined && !queryKey.includes(target.hostId)) {
    return false;
  }
  if (
    target.environmentId !== undefined &&
    !queryKey.some(
      (part) => isRecord(part) && part.environmentId === target.environmentId,
    )
  ) {
    return false;
  }
  return true;
}

export function queryReadSignal(
  queryClient: QueryClient,
  target: QueryReadSignalTarget,
  waitForFetch: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const matchingQueries = queryClient
      .getQueryCache()
      .findAll()
      .filter((query) => matchesTarget(query.queryKey, target));
    if (
      !waitForFetch &&
      matchingQueries.some(
        (query) =>
          query.state.fetchStatus === "idle" &&
          query.state.status === "success",
      )
    ) {
      resolve();
      return;
    }
    let started = matchingQueries.some(
      (query) => query.state.fetchStatus === "fetching",
    );
    let unsubscribe = (): void => undefined;
    unsubscribe = queryClient.getQueryCache().subscribe((event: unknown) => {
      if (!isQueryReadSignalEvent(event)) return;
      const { query } = event;
      if (!matchesTarget(query.queryKey, target)) return;
      if (query.state.fetchStatus === "fetching") started = true;
      if (
        started &&
        query.state.fetchStatus === "idle" &&
        query.state.status === "success"
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
}
