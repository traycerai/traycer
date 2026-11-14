import { REMOVED_PROFILE_PIN_TEXT } from "@/components/providers/profile-sync-copy";

/**
 * The code a chat send or edit is refused with when it names an account a
 * person removed. The computer's reason for it is a sentence the app never
 * shows: every notice that would lead with it says the pin's own words.
 */
const REMOVED_BY_PERSON_CODE = "removed-by-person";

/** Whether a refused frame's code is the removed-account refusal. */
export function isRemovedProfileRefusalCode(code: string | null): boolean {
  return code === REMOVED_BY_PERSON_CODE;
}

/**
 * The words a refused frame's notice leads with: the pin's words for the
 * removed-account code, whatever reason came with it, otherwise the
 * computer's reason, or `fallback` when it gave none.
 */
export function rejectionReasonText(
  code: string | null,
  reason: string | null,
  fallback: string,
): string {
  if (isRemovedProfileRefusalCode(code)) return REMOVED_PROFILE_PIN_TEXT;
  return reason ?? fallback;
}

/**
 * `reason` followed by the app's own words, which begin with a space.
 *
 * When the reason came from the removed-account code and is still the bare
 * pin's words, the app's words start on the next line, so "Was removed"
 * stands on a line of its own. A flagged reason already composed with clauses
 * takes further words after a space, as clauses join each other. An
 * unflagged reason is joined with a space whatever its text.
 */
export function withAppWordsAfterReason(
  reason: string,
  appWords: string,
  reasonIsRemovedProfile: boolean,
): string {
  if (appWords.length === 0) return reason;
  if (!reasonIsRemovedProfile || reason !== REMOVED_PROFILE_PIN_TEXT) {
    return `${reason}${appWords}`;
  }
  return `${reason}\n${appWords.trimStart()}`;
}

const MESSAGE_NOT_ACCEPTED = "A message was not accepted";

/**
 * The sentence for a send refused while another unsent message waits in the
 * composer, as its saved draft says it: the computer's reason inside the
 * parenthesis, or the pin's words for the removed-account code.
 */
export function messageNotAcceptedCircumstance(
  code: string | null,
  reason: string | null,
): string {
  const said = isRemovedProfileRefusalCode(code)
    ? REMOVED_PROFILE_PIN_TEXT
    : (reason ?? "Action rejected.").replace(/\.$/, "");
  return `${MESSAGE_NOT_ACCEPTED} (${said})`;
}

/**
 * The same sentence as its notice opens: for the removed-account code the
 * pin's words stand on their own line above it, with no parenthesis; any
 * other code reads as {@link messageNotAcceptedCircumstance}.
 */
export function messageNotAcceptedNoticeCircumstance(
  code: string | null,
  reason: string | null,
): string {
  if (!isRemovedProfileRefusalCode(code)) {
    return messageNotAcceptedCircumstance(code, reason);
  }
  return `${REMOVED_PROFILE_PIN_TEXT}\n${MESSAGE_NOT_ACCEPTED}`;
}
