import { useClaimedComputerNotice } from "@/hooks/teams/use-claimed-computer-notice";

/** Mounts the teammates' claimed-computer notice app-wide. */
export function ClaimedComputerNotifier(): null {
  useClaimedComputerNotice();
  return null;
}
