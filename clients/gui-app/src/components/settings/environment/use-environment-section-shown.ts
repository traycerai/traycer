import { useCallback, useMemo } from "react";
import { findHostOption } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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
 * Whether Secrets can draw under `pick`, on the road `PersonalPageFrame`
 * sends each page down: a team, and Personal on a window whose host does not
 * run it, read the cloud; Personal on a host that runs it, and a Local row,
 * read that host, whose Secrets page needs `environment.secrets.list`. In a
 * build with a pool that method is the pool's, and the support read answers
 * for it. While the window's host is out, Personal reads the cloud, as its
 * page does. A Local row reads its computer only while the window's host list
 * names it, as `usePersonalHostScope` resolves it for the page: a computer
 * the list has dropped, or not yet listed, draws nothing there.
 */
function secretsServedOn(
  pick: EnvironmentPick,
  windowHostRuns: boolean | null,
  secretsSupported: boolean | null,
): boolean {
  if (pick.kind === "team") return true;
  if (pick.kind === "unresolved") return false;
  if (pick.kind === "personal" && windowHostRuns !== true) {
    return windowHostRuns === false;
  }
  return secretsSupported === true;
}

/**
 * `environmentSectionShown` under the current pick: the one filter the
 * Settings rows, Settings search and the command palette's Settings rows
 * share. `windowScope` is the window's own host scope
 * (`WINDOW_HOST_SELECTION`), which the caller already holds.
 */
export function useEnvironmentSectionShown(
  windowScope: HostScope,
): (section: SettingsSectionId) => boolean {
  const pick = useEnvironmentPick();
  const windowHostRuns = useWindowHostRunsPersonal(windowScope);
  const secretsSupported = useHostMethodSupport(
    pick.kind === "local"
      ? (findHostOption(windowScope.hosts, pick.hostId)?.hostId ?? null)
      : windowScope.hostId,
    "environment.secrets.list",
  );
  const secretsServed = secretsServedOn(pick, windowHostRuns, secretsSupported);
  const facts = useMemo(
    (): EnvironmentPageFacts => ({ secretsServed }),
    [secretsServed],
  );
  return useCallback(
    (section: SettingsSectionId) =>
      environmentSectionShown(pick, section, facts),
    [pick, facts],
  );
}
