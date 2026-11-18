export const PERSONAL_LEAVE_ACCOUNTS = "Accounts that stay on this computer";
export const PERSONAL_LEAVE_SIGNED_IN = "Signed in";
export const PERSONAL_LEAVE_NOT_NEEDED = "Keeps working. No sign-in needed.";
export const PERSONAL_LEAVE_UNAVAILABLE =
  "This account can't be signed in from here any more. It is kept as it is.";

export function personalLeaveGuidance(provider: string): string {
  return `Sign in to each account you want to keep using on this computer, or skip it. A skipped account keeps working until ${provider} asks for a new sign-in.`;
}

export function personalLeaveSkipped(provider: string): string {
  return `Skipped. Works until ${provider} asks for a new sign-in.`;
}

export function personalLeaveSameAccount(profile: string): string {
  return `Same account as ${profile}`;
}

export function personalLeaveSignInNotKept(
  profile: string,
  provider: string,
): string {
  return `The sign-in for ${profile} wasn't kept. It works until ${provider} asks for a new sign-in.`;
}
