import { useClaimedComputerNotice } from "@/hooks/teams/use-claimed-computer-notice";

export function ClaimedComputerNotifier(): null {
  useClaimedComputerNotice();
  return null;
}
