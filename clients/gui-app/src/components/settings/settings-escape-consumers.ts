/**
 * Escape for a control INSIDE the Settings body, while Settings is the modal.
 *
 * The modal's Radix dialog listens for Escape on the document in the CAPTURE
 * phase, so it closes before any handler inside the body runs, and a
 * `stopPropagation()` there cannot stop it (`provider-rail-controls.tsx`
 * records the same finding). The one seam ahead of that close is the Settings
 * overlay's `consumeEscape` (`stores/tabs/overlays/settings.tsx`), which asks
 * this stack first: a body control that owns Escape while the keyboard is in
 * it registers a consumer, and the newest one to answer `true` keeps the modal
 * open.
 *
 * A consumer decides for itself whether the key is its own - typically "is
 * focus inside me" - and does its own work before answering, because once it
 * answers `true` the dialog marks the key handled and a handler inside the
 * body sees `defaultPrevented`. In the Settings TAB there is no dialog, this
 * stack is never asked, and the control's own `onKeyDown` handles the key.
 *
 * Module state, like `rules-edit-store`'s handoff: there is one Settings
 * surface per window.
 */
type SettingsEscapeConsumer = () => boolean;

const consumers: SettingsEscapeConsumer[] = [];

/** Adds a consumer; the returned function removes it. */
export function registerSettingsEscapeConsumer(
  consumer: SettingsEscapeConsumer,
): () => void {
  consumers.push(consumer);
  return () => {
    const at = consumers.lastIndexOf(consumer);
    if (at !== -1) consumers.splice(at, 1);
  };
}

/** Offers an Escape to the consumers, newest first; `true` when one took it. */
export function consumeSettingsEscape(): boolean {
  for (let at = consumers.length - 1; at >= 0; at -= 1) {
    if (consumers[at]()) return true;
  }
  return false;
}
