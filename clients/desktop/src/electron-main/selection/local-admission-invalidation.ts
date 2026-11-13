const listeners = new Set<(hostId: string) => void>();

export function invalidateMainLocalAdmission(hostId: string): void {
  for (const listener of Array.from(listeners)) listener(hostId);
}

export function onMainLocalAdmissionInvalidated(
  listener: (hostId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
