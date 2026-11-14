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

/** The one sign-in of a computer that offers sign-ins by itself. */
export const SIGN_IN_TEXT = "Sign in";
export const ADD_PROFILE_DIALOG_TITLE = "Add a profile";
export const SIGN_IN_AGAIN_DIALOG_TITLE = "Sign in again";
export const SIGN_IN_TO_USE_EVERYWHERE_TEXT = "Sign in to use everywhere";
export const AVAILABLE_ON_THIS_COMPUTER_TEXT = "Available on this computer";
export const NOT_ON_THIS_COMPUTER_YET_TEXT = "Not on this computer yet";
export const WAITING_FOR_PROFILE_TEXT =
  "Waiting for Traycer. Your sign-in is complete.";
export const USE_PROFILE_TEXT = "Use";
export const SIGN_IN_WITH_ANOTHER_TEXT = "Sign in with another";
export const ADD_AS_NEW_PROFILE_TEXT = "Add as a new profile";
export const SIGN_IN_UNPROVEN_TEXT =
  "This sign-in can't be matched to the account this profile uses.";

export function signedInAsText(profileLabel: string): string {
  return `Signed in as ${profileLabel}`;
}

export function alreadySignedInAsText(profileLabel: string): string {
  return `Already signed in as ${profileLabel}`;
}

export function differentAccountText(profileLabel: string): string {
  return `That sign-in is a different account. ${profileLabel} was not changed.`;
}

export function profileNotChangedText(profileLabel: string): string {
  return `${profileLabel} was not changed.`;
}
