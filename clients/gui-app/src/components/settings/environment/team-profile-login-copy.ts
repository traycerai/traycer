import type { ProviderLoginTargetRefusal } from "@traycer/protocol/host/provider-schemas";

export function teamSignInRefusalText(
  reason: ProviderLoginTargetRefusal | "offer-refused",
  teamName: string,
): string {
  switch (reason) {
    case "not-authorized":
      return `Only admins and editors of ${teamName} can sign in for it.`;
    case "target-unavailable":
      return `${teamName} can't take this sign-in right now. Nothing was changed.`;
    case "target-removed":
      return "Was removed";
    case "offer-refused":
      return `This account couldn't be added to ${teamName}. Nothing was changed.`;
    default:
      return `This computer can't sign in for ${teamName}. Use another computer.`;
  }
}
