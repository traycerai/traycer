import type {
  HarnessOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";

/**
 * The providers the rail renders, in order. Disabled/unavailable providers that
 * are not recoverable from the picker stay hidden. Recoverable degraded
 * providers (signed out or missing an API key) stay visible, move below the
 * ready providers, and show the model-list CTA when selected. Shared by
 * `ProviderRail` and the picker's ⌘-digit shortcut so the digits line up with
 * the badges on the SAME ordered list.
 */
export function visibleRailHarnesses(
  harnesses: ReadonlyArray<HarnessOption>,
  fallbackHarnesses: ReadonlyArray<HarnessOption>,
  degradedProviderIds: ReadonlySet<ProviderId>,
): ReadonlyArray<HarnessOption> {
  const source = harnesses.length > 0 ? harnesses : fallbackHarnesses;
  const visible = source.filter((harness) =>
    railHarnessVisible(harness, degradedProviderIds),
  );
  return sortGuiHarnessesByProviderOrder(visible).toSorted(
    (left, right) =>
      Number(railHarnessDegraded(left, degradedProviderIds)) -
      Number(railHarnessDegraded(right, degradedProviderIds)),
  );
}

export function railHarnessDegraded(
  harness: HarnessOption,
  degradedProviderIds: ReadonlySet<ProviderId>,
): boolean {
  return (
    !harness.available &&
    (harness.requiresApiKey || degradedProviderIds.has(harness.id))
  );
}

function railHarnessVisible(
  harness: HarnessOption,
  degradedProviderIds: ReadonlySet<ProviderId>,
): boolean {
  return harness.available || railHarnessDegraded(harness, degradedProviderIds);
}
