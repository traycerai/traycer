export function pruneActivationHistory(
  activationHistory: ReadonlyArray<string>,
  tabInstanceIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const live = new Set(tabInstanceIds);
  const seen = new Set<string>();
  return activationHistory.flatMap((instanceId) => {
    if (!live.has(instanceId)) return [];
    if (seen.has(instanceId)) return [];
    seen.add(instanceId);
    return [instanceId];
  });
}

export function activationHistoryEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((instanceId, index) => instanceId === right[index])
  );
}
