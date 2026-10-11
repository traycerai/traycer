/** Producer-only provenance; structured clone sends the row delta, not this link. */
const changesKey = Symbol("projection-table-changes");
interface TableChanges {
  readonly before: WeakRef<object>;
  readonly ids: readonly string[];
}

function changesOf(table: object): TableChanges | null {
  if (!(changesKey in table)) return null;
  return table[changesKey] as TableChanges;
}

export function markTableChanges<T extends object>(
  before: object,
  next: T,
  ids: readonly string[],
): T {
  Object.defineProperty(next, changesKey, {
    value: { before: new WeakRef(before), ids } satisfies TableChanges,
  });
  return next;
}

/** Unknown/collected history is a full diff, never a guessed delta. */
export function changedTableIds(
  before: object,
  next: object,
): ReadonlySet<string> | null {
  const ids = new Set<string>();
  let cursor: object | undefined = next;
  while (cursor !== before) {
    if (cursor === undefined) return null;
    const changes = changesOf(cursor);
    if (changes === null) return null;
    for (const id of changes.ids) ids.add(id);
    cursor = changes.before.deref();
  }
  return ids;
}

export function replaceSliceRows<T>(
  previous: {
    readonly byId: Readonly<Record<string, T>>;
    readonly allIds: readonly string[];
  },
  changed: {
    readonly byId: Readonly<Record<string, T>>;
    readonly allIds: readonly string[];
  },
  equal: (a: T, b: T) => boolean,
): typeof previous | null {
  const ids: string[] = [];
  for (const id of changed.allIds) {
    if (!Object.hasOwn(previous.byId, id)) return null;
    if (!equal(previous.byId[id], changed.byId[id])) ids.push(id);
  }
  if (ids.length === 0) return previous;
  // ponytail: immutable table shells still copy O(n); change the store shape only if profiling warrants it.
  const byId = { ...previous.byId };
  for (const id of ids) byId[id] = changed.byId[id];
  return {
    byId: markTableChanges(previous.byId, byId, ids),
    allIds: previous.allIds,
  };
}
