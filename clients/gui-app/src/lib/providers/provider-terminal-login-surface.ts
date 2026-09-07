/** Where a provider sign-in terminal started from a model picker lands. */
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
      /** Binds the start page and answers the draft id its panel is keyed by, called once per press. */
      readonly resolveLandingPageId: () => string;
    };
