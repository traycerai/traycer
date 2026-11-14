import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/** Resolves Personal from the authorized list; a team pick never falls back. */
export function useDetailsEnvironmentId(): string | null {
  const pick = useEnvironmentPick();
  const personal = usePersonalEnvironment(pick.kind !== "team");
  return pick.kind === "team" ? pick.environmentId : personal.environmentId;
}
