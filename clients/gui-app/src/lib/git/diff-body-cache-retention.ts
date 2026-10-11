import type { Query, QueryClient } from "@tanstack/react-query";

const MAX_DIFF_BODY_BYTES = 32 * 1024 * 1024;

interface RetainedDiff {
  readonly identity: string;
  readonly revision: string;
  readonly bytes: number;
  superseded: boolean;
}

/**
 * One budget for unary and batched diff bodies. Observed bodies are protected;
 * if they alone exceed the budget, their last observer leaving pays it down.
 * Map insertion order tracks writes and observer attaches without clock ties.
 */
export function installDiffBodyCacheRetention(client: QueryClient): void {
  const cache = client.getQueryCache();
  const retained = new Map<Query<unknown, unknown>, RetainedDiff>();
  let retainedBytes = 0;

  const trim = (): void => {
    for (const [query, body] of retained) {
      if (query.getObserversCount() > 0) continue;
      if (body.superseded || query.state.isInvalidated) {
        cache.remove(query);
      }
    }
    for (const query of retained.keys()) {
      if (retainedBytes <= MAX_DIFF_BODY_BYTES) break;
      if (query.getObserversCount() === 0) cache.remove(query);
    }
  };

  const supersede = (
    query: Query<unknown, unknown>,
    body: RetainedDiff,
  ): void => {
    for (const [other, candidate] of retained) {
      if (
        other !== query &&
        candidate.identity === body.identity &&
        candidate.revision !== body.revision
      ) {
        candidate.superseded = true;
      }
    }
  };

  cache.subscribe((event) => {
    const query = event.query as Query<unknown, unknown>;
    const previous = retained.get(query);
    if (event.type === "removed") {
      if (previous === undefined) return;
      retainedBytes -= previous.bytes;
      retained.delete(query);
      return;
    }

    if (event.type === "updated" && event.action.type === "success") {
      const body = diffBody(query);
      if (body === null) return;
      retainedBytes += body.bytes - (previous?.bytes ?? 0);
      retained.delete(query);
      retained.set(query, body);
      supersede(query, body);
      trim();
      return;
    }

    if (previous === undefined) return;
    if (event.type === "observerAdded") {
      retained.delete(query);
      retained.set(query, previous);
    } else if (
      event.type === "observerRemoved" ||
      (event.type === "updated" && event.action.type === "invalidate")
    ) {
      trim();
    }
  });
}

function diffBody(query: Query<unknown, unknown>): RetainedDiff | null {
  const key = query.queryKey;
  // hostQueryKeys.scope(null) omits the host-id slot.
  const diffIndex = key.length - 10;
  if (
    (diffIndex !== 2 && diffIndex !== 3) ||
    key[0] !== "host" ||
    key[diffIndex - 1] !== "git" ||
    key[diffIndex] !== "fileDiff"
  ) {
    return null;
  }
  const data: unknown = query.state.data;
  if (
    data === null ||
    typeof data !== "object" ||
    !("patch" in data) ||
    typeof data.patch !== "string"
  ) {
    return null;
  }
  return {
    // Host, root, path, previous path and stage are distinct diff identities.
    identity: JSON.stringify(key.slice(0, diffIndex + 5)),
    revision: JSON.stringify(key.slice(diffIndex + 5, diffIndex + 8)),
    // Conservative UTF-16 storage accounting, without allocating encoded copies.
    bytes: data.patch.length * 2,
    superseded: false,
  };
}
