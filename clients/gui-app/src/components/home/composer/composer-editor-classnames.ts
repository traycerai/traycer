import { cn } from "@/lib/utils";

/**
 * Base editor sizing shared by every composer surface. It intentionally has NO
 * max-height of its own, so the editor element's baked-in
 * `max-h-[min(50vh,15rem)]` (see `composer-prompt-editor.tsx`) governs the grow
 * ceiling: the editor grows with content up to that bound, then scrolls
 * internally. Surfaces that need a tighter, compact editor can compose this with
 * their own `max-h-*` and pass it via `editorClassName`.
 *
 * Kept in its own leaf module (not `composer-body.tsx`) so the component file
 * exports only components - a non-component export there would defeat Fast
 * Refresh's component-state preservation (react-doctor `only-export-components`).
 */
export const COMPOSER_EDITOR_CLASSNAME = cn(
  "text-ui text-foreground placeholder:text-muted-foreground",
  "min-h-[2.5rem] w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent text-ui leading-relaxed text-foreground focus:outline-none",
);

/**
 * The phone cap for a composer that can pull open into a sheet: a bound on
 * what is VISIBLE rather than on the screen. `--spacing-safe-dvh` already
 * has the keyboard taken off it, so with the keyboard up a long draft stays
 * about six lines tall instead of filling the space above the keys; with it
 * down the 15rem ceiling is what binds. Only below `md`. The landing and chat
 * editors take it; the surfaces without the pull gesture (the
 * new-conversation modal, the in-place message edit) keep the ceilings they
 * set. Once the draft outgrows this cap the grabber appears, and pulling the
 * card open into its sheet (`composer-shell.tsx`) lifts the cap.
 */
export const PHONE_COMPOSER_EDITOR_CAP_CLASSNAME =
  "max-md:max-h-[min(calc(var(--spacing-safe-dvh)*0.3),15rem)]";

/** The landing composer's editor: the shared sizing plus the phone cap. */
export const LANDING_COMPOSER_EDITOR_CLASSNAME = cn(
  COMPOSER_EDITOR_CLASSNAME,
  PHONE_COMPOSER_EDITOR_CAP_CLASSNAME,
);
