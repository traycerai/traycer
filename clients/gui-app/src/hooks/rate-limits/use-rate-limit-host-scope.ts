import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

/**
 * Host the header glyph and popover both read, resolved at the header so the trigger cannot summarize host A above a panel for host B.
 */
export interface RateLimitHostScope {
  readonly scope: HostScope;
  /**
   * True when a host was explicitly picked. `HostScope` cannot tell pick from active; only a pick's unreachability should replace usage numbers with a notice.
   */
  readonly hasExplicitPick: boolean;
}

export function useRateLimitResolveHostScope(): RateLimitHostScope {
  const scopedHostId = useRateLimitPopoverStore((state) => state.scopedHostId);
  const setScopedHostId = useRateLimitPopoverStore(
    (state) => state.setScopedHostId,
  );
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  return { scope, hasExplicitPick: scopedHostId !== null };
}
