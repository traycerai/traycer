import type { QueryKey } from "@tanstack/react-query";

const instanceIds = new WeakMap<object, number>();
let nextInstanceId = 1;

function instanceId(value: object): number {
  const existing = instanceIds.get(value);
  if (existing !== undefined) return existing;
  const id = nextInstanceId;
  nextInstanceId += 1;
  instanceIds.set(value, id);
  return id;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The app's `queryKeyHashFn`. Keys put live services in a segment on purpose
 * (`authQueryKeys.registeredHosts(authService, …)`, the runner bridges) to
 * scope a query to that instance, but TanStack's default hash serializes them
 * STRUCTURALLY: it walks every enumerable field, so a service reaching a cyclic
 * value (a field holding `window`) throws "cyclic structures" from every query
 * that keys on it, and a mutable field (a bearer) silently re-keys the query
 * when it changes. Here a class instance hashes as a per-instance id instead,
 * which is the identity those keys mean. Plain objects and arrays hash as
 * TanStack's do (object keys sorted).
 */
export function hashAppQueryKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    if (!isPlainObject(value)) return { $instance: instanceId(value) };
    // A "$" prefix is escaped to "$$", so no plain object can spell `$instance`.
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]): [string, unknown] => [
          k.startsWith("$") ? `$${k}` : k,
          v,
        ])
        .sort(([a], [b]) => compareKeys(a, b)),
    );
  });
}
