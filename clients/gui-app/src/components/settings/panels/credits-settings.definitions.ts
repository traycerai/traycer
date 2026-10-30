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
  offersTitle: "Credit offers",
  offersAbout: "About credit offers",
  offersTerms:
    "Separate from your total credits, and only for each offer's models. Unused credit expires when the offer ends.",
  /** Under an offer's figure: what it started at. */
  offerGrant: (grant: string): string => `of ${grant}`,
  offerTimeLeft: (distance: string): string => `${distance} left`,
  offerEnds: (at: string): string => `Ends ${at}`,
  offerClaim: "Claim",
  offerSoldOut: "Sold out",
  claimFailed: "Couldn't claim this offer.",
  claimSoldOut: "These credits have all been claimed.",
  claimNotRunning: "This offer is not running right now.",
  claimIneligible: "Your current plan can't claim these credits.",
  claimSignIn: "Sign in again to claim these credits.",
  claimUnreachable: "Couldn't reach Traycer. Try again.",
  keywords: [
    "credits",
    "billing",
    "balance",
    "sandbox",
    "add credits",
    "spend",
  ],
} as const;
