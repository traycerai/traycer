import {
  areNestedFocusTargetsEqual,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";

interface PendingPrimaryEditorFocus {
  readonly epicId: string;
  readonly tabId: string;
  readonly target: NestedFocusTarget;
}

let pendingPrimaryEditorFocus: PendingPrimaryEditorFocus | null = null;

export function requestNestedRoutePrimaryEditorFocus(
  epicId: string,
  tabId: string,
  target: NestedFocusTarget,
): void {
  pendingPrimaryEditorFocus = { epicId, tabId, target };
}

export function consumeNestedRoutePrimaryEditorFocus(
  epicId: string,
  tabId: string,
  target: NestedFocusTarget,
): boolean {
  const pending = pendingPrimaryEditorFocus;
  if (pending === null) return false;
  if (pending.epicId !== epicId || pending.tabId !== tabId) return false;
  pendingPrimaryEditorFocus = null;
  return areNestedFocusTargetsEqual(pending.target, target);
}

export function resetNestedRouteDomFocusForTests(): void {
  pendingPrimaryEditorFocus = null;
}
