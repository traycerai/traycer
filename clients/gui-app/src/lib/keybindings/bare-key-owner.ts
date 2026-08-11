/**
 * Single-owner arbitration for bare-letter shortcuts bound at the window.
 *
 * A bare letter is not a chord: nothing about `R` says which surface it belongs
 * to, so two overlays that both bind it at the window BOTH fire. `preventDefault`
 * does not help - it stops the browser's default action, not a sibling listener
 * on the same target. That is not hypothetical here: the folder-mapping picker
 * and the worktree owner hover card can be open in the same pane at once, and a
 * single `R` would refresh both, including one that deliberately does not defer
 * to text fields.
 *
 * The rule is LAST REGISTERED WINS, which for overlays means the most recently
 * opened - the one the user is looking at. Registration order is mount order,
 * and an overlay that opens over another mounts (or re-registers) after it.
 *
 * One window listener per key however many owners there are, installed with the
 * first and removed with the last.
 */

type BareKeyHandler = (event: KeyboardEvent) => void;

const owners = new Map<string, BareKeyHandler[]>();
const listeners = new Map<string, (event: KeyboardEvent) => void>();

/**
 * Claims `key` (a single letter, matched case-insensitively and only without
 * modifiers) until the returned disposer runs. Only the newest claim is called.
 */
export function claimBareKey(key: string, handler: BareKeyHandler): () => void {
  const normalized = key.toLowerCase();
  const stack = owners.get(normalized) ?? [];
  stack.push(handler);
  owners.set(normalized, stack);
  if (!listeners.has(normalized)) {
    const listener = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== normalized) return;
      // Modified presses belong to the app's own chords, never here.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const current = owners.get(normalized);
      const top = current?.[current.length - 1];
      top?.(event);
    };
    listeners.set(normalized, listener);
    window.addEventListener("keydown", listener);
  }
  return () => {
    const current = owners.get(normalized);
    if (current === undefined) return;
    const index = current.lastIndexOf(handler);
    if (index >= 0) current.splice(index, 1);
    if (current.length > 0) return;
    owners.delete(normalized);
    const listener = listeners.get(normalized);
    if (listener === undefined) return;
    listeners.delete(normalized);
    window.removeEventListener("keydown", listener);
  };
}
