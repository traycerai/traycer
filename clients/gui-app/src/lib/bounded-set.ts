/**
 * Insertion-ordered `Set` with FIFO eviction: drop the oldest entry once
 * `capacity` is reached, then add `value`. Mutates `set` in place. Skip
 * the eviction when `value` is already present (caller is expected to
 * have checked, but the guard keeps the helper safe on its own).
 */
export function addWithFifoEviction<T>(
  set: Set<T>,
  value: T,
  capacity: number,
): void {
  if (set.has(value)) {
    set.add(value);
    return;
  }
  if (set.size >= capacity) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}
