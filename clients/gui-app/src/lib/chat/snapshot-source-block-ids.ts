export type SnapshotSourceBlockIds = readonly [string, ...string[]];

export function singleSnapshotSourceBlockId(
  blockId: string,
): SnapshotSourceBlockIds {
  return [blockId];
}

export function mergeSnapshotSourceBlockIds(
  first: SnapshotSourceBlockIds,
  second: SnapshotSourceBlockIds,
): SnapshotSourceBlockIds {
  return [first[0], ...first.slice(1), ...second];
}

export function firstSnapshotSourceBlockId(
  ids: SnapshotSourceBlockIds,
): string {
  return ids[0];
}

export function lastSnapshotSourceBlockId(ids: SnapshotSourceBlockIds): string {
  return ids[ids.length - 1] ?? ids[0];
}

export function readSnapshotSourceBlockIds(
  value: unknown,
): SnapshotSourceBlockIds | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((item): item is string => typeof item === "string");
  if (ids.length === 0 || ids.length !== value.length) return null;
  return [ids[0], ...ids.slice(1)];
}
