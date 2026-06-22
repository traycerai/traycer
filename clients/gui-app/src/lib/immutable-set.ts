/**
 * Copy-on-write Set helpers. Each returns the original reference when the
 * operation would be a no-op, so callers relying on `Object.is` equality
 * (React state, Zustand bailouts, TreeView's `onItemsChange`) skip updates
 * cleanly.
 */

export function withMemberAdded<T>(
  set: ReadonlySet<T>,
  value: T,
): ReadonlySet<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

export function withMemberRemoved<T>(
  set: ReadonlySet<T>,
  value: T,
): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

export function withMemberToggled<T>(
  set: ReadonlySet<T>,
  value: T,
): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function withMembersAdded<T>(
  set: ReadonlySet<T>,
  values: Iterable<T>,
): ReadonlySet<T> {
  let next: Set<T> | null = null;
  for (const v of values) {
    if (set.has(v)) continue;
    if (next === null) next = new Set(set);
    next.add(v);
  }
  return next ?? set;
}
