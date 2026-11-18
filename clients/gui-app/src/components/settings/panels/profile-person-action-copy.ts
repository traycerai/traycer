export type ProfilePersonAction = "sign-out" | "remove";

interface ProfilePersonActionCopy {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
}

export function profilePersonActionLabel(action: ProfilePersonAction): string {
  return action === "remove" ? "Remove" : "Sign out";
}

export function profilePersonActionCopy(
  action: ProfilePersonAction,
  profileName: string,
  environmentName: string | null,
): ProfilePersonActionCopy {
  const environment = environmentName ?? "this environment";
  const actionLabel = profilePersonActionLabel(action);
  if (action === "remove") {
    return {
      title: `Remove ${profileName}?`,
      description: `Remove ${profileName} from every list in ${environment}. Running work finishes first. You can add this account again later by signing in.`,
      actionLabel,
    };
  }
  return {
    title: `Sign out of ${profileName} in ${environment}?`,
    description:
      "Running work finishes first. The account stays in the list and needs a sign-in. This does not reach a computer that already left or has not updated, or a separate Terminal login.",
    actionLabel,
  };
}
