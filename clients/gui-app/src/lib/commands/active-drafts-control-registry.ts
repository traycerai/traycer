/**
 * Stack of Drafts-control openers owned by active composer surfaces. Overlay
 * composers register after the surface beneath them, then hand control back
 * when they close. This avoids the dead-shortcut window a single-slot registry
 * creates when its winning registration unmounts.
 */
import type { AnalyticsDraftEntryPoint } from "@/lib/analytics";

export type DraftsControlEntryPoint = Extract<
  AnalyticsDraftEntryPoint,
  "shortcut" | "palette"
>;
type DraftsControlAction = (entryPoint: DraftsControlEntryPoint) => void;

const stack: DraftsControlAction[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerActiveDraftsControl(
  action: DraftsControlAction,
): () => void {
  stack.push(action);
  notify();
  return () => {
    const index = stack.indexOf(action);
    if (index === -1) return;
    stack.splice(index, 1);
    notify();
  };
}

export function hasActiveDraftsControl(): boolean {
  return stack.length > 0;
}

export function subscribeActiveDraftsControl(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openActiveDraftsControl(
  entryPoint: DraftsControlEntryPoint,
): boolean {
  const action = stack.at(-1);
  if (action === undefined) return false;
  action(entryPoint);
  return true;
}

/** Test-only: prevent registrations leaking between isolated tests. */
export function resetActiveDraftsControlForTests(): void {
  stack.length = 0;
  listeners.clear();
}
