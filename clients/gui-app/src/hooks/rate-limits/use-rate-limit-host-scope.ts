import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

/**
 * Which host the header's usage glyph and popover are READING — the same host
 * model Settings administers through, over this surface's own persisted pick.
 *
 * Mounted at the header (not inside `PopoverContent`) because the glyph is the
 * popover's trigger: two bars summarizing host A above a panel reporting host
 * B would make the control lie about what clicking it shows. Both therefore
 * hang off one resolution.
 *
 * The queries behind it (`useHostDirectoryList`, `useRegisteredHosts`) are the
 * shared, already-cached ones every other host surface reads, so the header
 * joins their subscribers rather than opening a second source of host truth.
 */
export interface RateLimitHostScope {
  readonly scope: HostScope;
  /**
   * A host was EXPLICITLY picked, as opposed to following the active one.
   *
   * This is the difference between "I cannot show you the machine you chose"
   * and "the machine this window runs on is having a moment", and only the
   * first is worth replacing usage numbers with a notice. Following the active
   * host, an `unreachable` scope is routine - a directory entry blips
   * `unavailable`, and the rate-limit envelope's whole `lastGood`/`degraded`
   * design exists to keep showing the last real reading through exactly that.
   * Trading that for a notice would make a single-host user strictly worse off
   * for a picker they never used.
   *
   * `HostScope` alone cannot answer it: `unreachable` and `connecting` look
   * identical whether they came from a pick or from the active host.
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
