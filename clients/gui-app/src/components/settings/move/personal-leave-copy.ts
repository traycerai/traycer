export const PERSONAL_LEAVE_ACCOUNTS = "Accounts that stay on this computer";
export const PERSONAL_LEAVE_SIGNED_IN = "Signed in";
export const PERSONAL_LEAVE_NOT_NEEDED = "Keeps working. No sign-in needed.";
export const PERSONAL_LEAVE_UNAVAILABLE =
  "This account can't be signed in from here any more. It is kept as it is.";

export const PERSONAL_LEAVE_GUIDANCE =
  "Sign in to each account you want to keep using on this computer, or skip it.";
export const PERSONAL_LEAVE_SKIPPED_SHARED =
  "Skipped. Not kept on this computer.";

export function personalLeaveSkipped(provider: string): string {
  return `Skipped. Works until ${provider} asks for a new sign-in.`;
}

export function personalLeaveSameAccount(profile: string): string {
  return `Same account as ${profile}`;
}

export function personalLeaveSignInNotKept(
  profile: string,
  provider: string,
  shared: boolean,
): string {
  const notKept = `The sign-in for ${profile} wasn't kept.`;
  return shared
    ? notKept
    : `${notKept} It works until ${provider} asks for a new sign-in.`;
}
