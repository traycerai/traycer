import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import {
  sandboxBalanceMc,
  sandboxRunwayWarning,
  type SandboxRunwayWarning,
} from "@/lib/sandboxes/sandbox-balance";

/**
 * The balance warning for the user's awake sandboxes: the live balance
 * divided by their awake burn, read from the credits query and the cost view.
 * `none` until both have answered.
 */
export function useSandboxRunwayWarning(): SandboxRunwayWarning {
  const user = useAuthUser().data ?? null;
  const costs = useSandboxCosts().data ?? null;
  return sandboxRunwayWarning(
    sandboxBalanceMc(user),
    costs === null ? null : costs.awakeBurnMillicreditsPerHour,
  );
}
