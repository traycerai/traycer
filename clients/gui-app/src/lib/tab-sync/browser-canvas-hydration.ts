/**
 * Browser canvas persistence is account-scoped and hydrates after auth resolves.
 * The initial anonymous store is not evidence that saved task tabs are absent.
 */
let hydrated = false;
let resolveHydration: (() => void) | null = null;
const listeners = new Set<() => void>();
export const browserCanvasHydration = new Promise<void>((resolve) => {
  resolveHydration = resolve;
});
export function isBrowserCanvasHydrated(): boolean {
  return hydrated;
}
export function subscribeBrowserCanvasHydration(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function markBrowserCanvasHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  resolveHydration?.();
  resolveHydration = null;
  for (const listener of listeners) listener();
}
