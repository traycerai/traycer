/**
 * Stack of Drafts-control openers owned by active composer surfaces. Overlay
 * composers register after the surface beneath them, then hand control back
 * when they close. This avoids the dead-shortcut window a single-slot registry
 * creates when its winning registration unmounts.
 */
type DraftsControlAction = () => void;

const stack: DraftsControlAction[] = [];

export function registerActiveDraftsControl(
  action: DraftsControlAction,
): () => void {
  stack.push(action);
  return () => {
    const index = stack.indexOf(action);
    if (index !== -1) stack.splice(index, 1);
  };
}

export function openActiveDraftsControl(): boolean {
  const action = stack.at(-1);
  if (action === undefined) return false;
  action();
  return true;
}

/** Test-only: prevent registrations leaking between isolated tests. */
export function resetActiveDraftsControlForTests(): void {
  stack.length = 0;
}
