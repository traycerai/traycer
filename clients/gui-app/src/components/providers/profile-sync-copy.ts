import type { ProviderProfilePersonNotice } from "@traycer/protocol/host/provider-schemas";

/** Every phrase the profile-sync list puts in front of a person, in one place. */

/** A pin whose account a person removed. */
export const REMOVED_PROFILE_PIN_TEXT = "Was removed";

export const PERSON_NOTICE_TEXT: Readonly<
  Record<ProviderProfilePersonNotice, string>
> = {
  "needs-sign-in": "Needs a sign-in",
  waiting: "Waiting for Traycer",
};

/** `null` when the app does not know the computer's name. */
export function terminalAccountLineText(computerName: string | null): string {
  return computerName === null
    ? "Terminal account"
    : `Terminal account on ${computerName}`;
}

/** The other names an account had, for a screen reader beside the chips. */
export function otherNamesAccessibleText(
  otherNames: readonly string[],
): string {
  return `Also named ${otherNames.join(", ")}`;
}

/** `nameCount` counts the current name with the other names. */
export function otherNamesPromptText(nameCount: number): string {
  const names = nameCount === 2 ? "two names" : "more than one name";
  return `This account had ${names}. Pick the one to use on every computer.`;
}

export function keepNameAndHideText(name: string): string {
  return `Keep "${name}" and hide this`;
}
