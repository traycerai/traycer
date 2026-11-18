export function cappedByUpdatedAt<T extends { updatedAt: number }>(
  entries: Record<string, T>,
  cap: number,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, cap),
  );
}
