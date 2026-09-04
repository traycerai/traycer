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
      /**
       * Binds the start page and answers the draft id its panel is keyed by,
       * called once per press.
       *
       * A function rather than an id because an UNBOUND start page has no
       * panel at all: `LandingDraftSurface` renders the pane anchor only for a
       * non-null draft id, and `LandingTerminalHost` portals the panel into an
       * anchor - so a sign-in opened against the unbound sentinel mints a real
       * host PTY, stores its tab, and shows the user nothing. The composer
       * mints the draft on the first substantive edit anyway; this runs the
       * same mint, so pressing the button is that first gesture. It also
       * settles the layout key: the panel reads the layout of the FOCUSED
       * page, so opening under the sentinel and letting the draft appear
       * afterwards would strand the open flag under a key nothing reads again.
       */
      readonly resolveLandingPageId: () => string;
    };
