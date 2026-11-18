/**
 * The account-deletion request form, and the one place its URL is built.
 *
 * App Store review guideline 5.1.1(v) requires an app that creates accounts to
 * offer account deletion from inside the app. Traycer has no deletion RPC: the
 * request goes to a Google Form that notifies support, and the team performs
 * the deletion by hand. So "in-app deletion" here means the app makes the
 * option easy to find, says what will happen and how long it takes, and hands
 * the form a request that is already filled in - see
 * `delete-account-settings-panel.tsx`.
 *
 * Kept a pure module, apart from the panel, so the URL is unit-testable
 * without mounting anything: this is the part a typo makes useless in a way no
 * render test would notice, since a wrong `entry.*` id still produces a
 * perfectly valid URL that silently drops the answer.
 */

const FORM_BASE_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLScT3D5fygNGY-sg3ZJh682itv_YBXGUSsacBG3_RXocL5wG4g/viewform";

/**
 * The two email questions on the form. Google Forms names each by an opaque
 * `entry.<id>`, so these are named constants with the question they answer
 * written down, checkable against the live form. The form's first question -
 * "how do you sign in, Email, GitHub or Apple?" - is left for the user, since
 * only they know it and a wrong answer routes the request to the wrong
 * branch; the account address is the same on every branch, so prefilling both
 * addresses covers whichever the user picks.
 *
 * Apple is on that list because Sign in with Apple is a supported provider.
 * An Apple account whose owner chose Hide My Email carries the relay address
 * on the account, and that is exactly the address the prefill uses, so the
 * request still names the right account.
 */
const ACCOUNT_EMAIL_ENTRY = "entry.833738174";
const CONTACT_EMAIL_ENTRY = "entry.671973110";

/**
 * The deletion form, pre-filled for `email`.
 *
 * Built through `URL` / `URLSearchParams` rather than by concatenation: an
 * address is user-controlled text, and `+`, `&` and `#` are all legal in the
 * local part of one. Concatenating would let any of them truncate the query or
 * turn into a space, so the user would arrive at a form quietly pre-filled
 * with an address that is not theirs - and would most likely submit it.
 *
 * A `null` (or blank) email means the account's address has not resolved. The
 * form still opens with the address questions left blank, because sending the
 * user to a form they can fill in themselves beats refusing the only deletion
 * route the app has.
 */
export function buildAccountDeletionFormUrl(email: string | null): string {
  const url = new URL(FORM_BASE_URL);
  const trimmed = email === null ? "" : email.trim();
  if (trimmed.length > 0) {
    url.searchParams.set(ACCOUNT_EMAIL_ENTRY, trimmed);
    url.searchParams.set(CONTACT_EMAIL_ENTRY, trimmed);
  }
  return url.toString();
}
