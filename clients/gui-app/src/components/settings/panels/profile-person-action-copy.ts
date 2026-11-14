export type ProfilePersonAction = "sign-out" | "remove";
export type ProfilePersonActionScope = "record" | "legacy";

interface ProfilePersonActionCopy {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
}

export function profilePersonActionLabel(
  action: ProfilePersonAction,
  scope: ProfilePersonActionScope,
): string {
  if (action === "remove") return "Remove";
  return scope === "record" ? "Sign out" : "Sign out on every host";
}

export function profilePersonActionCopy(
  action: ProfilePersonAction,
  scope: ProfilePersonActionScope,
  profileName: string,
  environmentName: string | null,
): ProfilePersonActionCopy {
  const environment = environmentName ?? "this environment";
  const actionLabel = profilePersonActionLabel(action, scope);
  if (action === "remove") {
    return {
      title: `Remove ${profileName}?`,
      description:
        scope === "record"
          ? `Remove ${profileName} from every list in ${environment}. Running work finishes first. You can add this account again later by signing in.`
          : `Agents that ran on ${profileName} will show it as removed. Running sessions on this profile must be stopped first.`,
      actionLabel,
    };
  }
  if (scope === "legacy") {
    return {
      title: "Sign this account out on every host?",
      description:
        "You’ll need to sign in again to use this account on any host.",
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
