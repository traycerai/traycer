import {
  useWatchHostScope,
  type WatchHostScope,
} from "@/hooks/host-scope/use-watch-host-scope";

/**
 * The header's name for the shared watch pick — the same host model Settings
 * administers through, resolved by the same hook every other watching surface
 * uses (`useWatchHostScope`, which owns the rule and the doc for it).
 *
 * The name earns its keep by saying WHERE the resolution is mounted: at the
 * header, not inside `PopoverContent`, because the glyph is the popover's
 * trigger. Two bars summarizing host A above a panel reporting host B would
 * make the control lie about what clicking it shows, so both hang off one
 * resolution — and now off one hook, shared with the bottom strip that takes
 * over both when the placement moves there.
 */
export function useRateLimitResolveHostScope(): WatchHostScope {
  return useWatchHostScope();
}
