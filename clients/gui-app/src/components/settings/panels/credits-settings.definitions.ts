/**
 * Page copy for Account ▸ Credits. E4 owns the section id and wraps this
 * with `defineSettingsSection("credits", …)` when it adds the row. Until
 * then this is a plain object so the search-index assembly does not see a
 * collection it cannot list.
 */
export const CREDITS_PAGE = {
  label: "Credits",
  description: "Credits pay for your sandboxes, awake or resting.",
  /** The card's figure: the balance as the card formats it, then "left". */
  remaining: (balance: string): string => `${balance} left`,
  readFailed: "Couldn't read your credits.",
  keywords: [
    "credits",
    "billing",
    "balance",
    "sandbox",
    "add credits",
    "spend",
  ],
} as const;
