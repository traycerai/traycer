import { REMOVED_PROFILE_PIN_TEXT } from "@/components/providers/profile-sync-copy";

/** The computer's reason for it is a sentence the app never shows. */
const REMOVED_BY_PERSON_CODE = "removed-by-person";

export function isRemovedProfileRefusalCode(code: string | null): boolean {
  return code === REMOVED_BY_PERSON_CODE;
}

export function rejectionReasonText(
  code: string | null,
  reason: string | null,
  fallback: string,
): string {
  if (isRemovedProfileRefusalCode(code)) return REMOVED_PROFILE_PIN_TEXT;
  return reason ?? fallback;
}

/** After the bare pin's words the app's words start on the next line, so "Was removed" stands alone. */
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

export function messageNotAcceptedCircumstance(
  code: string | null,
  reason: string | null,
): string {
  const said = isRemovedProfileRefusalCode(code)
    ? REMOVED_PROFILE_PIN_TEXT
    : (reason ?? "Action rejected.").replace(/\.$/, "");
  return `${MESSAGE_NOT_ACCEPTED} (${said})`;
}

export function messageNotAcceptedNoticeCircumstance(
  code: string | null,
  reason: string | null,
): string {
  if (!isRemovedProfileRefusalCode(code)) {
    return messageNotAcceptedCircumstance(code, reason);
  }
  return `${REMOVED_PROFILE_PIN_TEXT}\n${MESSAGE_NOT_ACCEPTED}`;
}
