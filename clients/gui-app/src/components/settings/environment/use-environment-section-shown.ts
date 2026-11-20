import { useCallback, useMemo } from "react";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useWindowHostRunsPersonal } from "@/components/settings/personal/use-window-host-runs-personal";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  environmentSectionShown,
  type EnvironmentPageFacts,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * The facts `environmentSectionShown` needs under the current pick, read on
 * the road `PersonalPageFrame` sends each page down: a team, and Personal on
 * a window whose host does not run it, read the cloud; Personal on a host
 * that runs it, and a Local row, read that host, whose Secrets page needs
 * `environment.secrets.list`. In a build with a pool that method is the
 * pool's, and the support read answers for it.
 */
function useEnvironmentPageFacts(): EnvironmentPageFacts {
  const pick = useEnvironmentPick();
  const scope = usePersonalHostScope();
  const runsPersonal = useWindowHostRunsPersonal();
  const secretsSupported = useHostMethodSupport(
    scope.hostId,
    "environment.secrets.list",
  );
  const secretsServed = secretsServedOn(pick, runsPersonal, secretsSupported);
  return useMemo(() => ({ secretsServed }), [secretsServed]);
}

function secretsServedOn(
  pick: EnvironmentPick,
  runsPersonal: boolean | null,
  secretsSupported: boolean | null,
): boolean {
  if (pick.kind === "team") return true;
  if (pick.kind === "unresolved") return false;
  if (pick.kind === "personal" && runsPersonal !== true) {
    return runsPersonal === false;
  }
  return secretsSupported === true;
}

/** `environmentSectionShown` under the current pick, for the rows and search. */
export function useEnvironmentSectionShown(): (
  section: SettingsSectionId,
) => boolean {
  const pick = useEnvironmentPick();
  const facts = useEnvironmentPageFacts();
  return useCallback(
    (section: SettingsSectionId) =>
      environmentSectionShown(pick, section, facts),
    [pick, facts],
  );
}
