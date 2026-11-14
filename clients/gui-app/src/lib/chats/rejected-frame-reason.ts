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

/**
 * The sentence for a send refused while another unsent message waits in the
 * composer: the computer's reason inside the parenthesis, or the pin's words
 * for the removed-account code. Kept in this one place so the sentence's
 * other form, the owner's to choose, is a change here and nowhere else.
 */
export function messageNotAcceptedCircumstance(
  code: string | null,
  reason: string | null,
): string {
  const said = isRemovedProfileRefusalCode(code)
    ? REMOVED_PROFILE_PIN_TEXT
    : (reason ?? "Action rejected.").replace(/\.$/, "");
  return `A message was not accepted (${said})`;
}
