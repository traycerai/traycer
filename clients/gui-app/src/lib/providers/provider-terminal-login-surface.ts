/**
 * Where a provider sign-in terminal started from a model picker lands.
 *
 * The host mints the PTY under a `TerminalScope`, and each scope has exactly
 * one surface that lists it: an epic scope is shown by that epic's Terminals
 * surface, an independent scope by the landing page's terminal panel. So the
 * picker has to know which surface it is drawn on - the same session id is
 * invisible to the other one - and this is that fact, passed explicitly by
 * the composer that owns the picker rather than inferred from ambient
 * context (the in-epic new-conversation modal is an epic surface with no tab
 * host provider around it, so "am I inside a tab" would answer wrong there).
 *
 * `null` means the picker sits on a surface with no terminal to open into (a
 * fork dialog, the canvas add-node menu): the setup guidance still renders,
 * without the button.
 */
export type ProviderTerminalLoginSurface =
  | {
      readonly kind: "epic";
      readonly epicId: string;
      /** The view the terminal tile opens in - in a split view each pane's
       *  composer names its own. */
      readonly viewTabId: string;
    }
  | {
      readonly kind: "landing";
      /** The start page whose panel layout opens - the draft id, or the
       *  panel's own unbound sentinel while the draft has no id yet. */
      readonly landingPageId: string;
    };
