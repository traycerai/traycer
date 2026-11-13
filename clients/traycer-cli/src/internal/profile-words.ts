import type { ProviderProfilePersonNotice } from "@traycer/protocol/host/provider-schemas";

/**
 * The words `traycer profile list` prints for an account's person state and
 * its Terminal login: the app's words, so the CLI and the app tell one story.
 */

/** Printed in place of the raw sign-in word when the computer sets a notice. */
export const PERSON_NOTICE_WORDS: Record<ProviderProfilePersonNotice, string> =
  {
    "needs-sign-in": "Needs a sign-in",
    waiting: "Waiting for Traycer",
  };

/**
 * Under a row whose account is also this computer's Terminal login. The CLI
 * only ever reaches the host on its own computer.
 */
export const TERMINAL_ACCOUNT_LINE = "Terminal account on this computer";
