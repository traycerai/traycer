import type { HarnessOption } from "@/components/home/data/landing-options";

/**
 * The providers the rail renders, in order. Disabled/unavailable providers are
 * hidden (the host reports `available: false`), except an enabled API-key
 * provider missing its key (`requiresApiKey`), which stays so its "add key" CTA
 * is reachable. Shared by `ProviderRail` and the picker's ⌘-digit shortcut so
 * the digits line up with the badges on the SAME ordered list.
 */
export function visibleRailHarnesses(
  harnesses: ReadonlyArray<HarnessOption>,
  fallbackHarnesses: ReadonlyArray<HarnessOption>,
): ReadonlyArray<HarnessOption> {
  const source = harnesses.length > 0 ? harnesses : fallbackHarnesses;
  return source.filter(
    (harness) => harness.available || harness.requiresApiKey,
  );
}
