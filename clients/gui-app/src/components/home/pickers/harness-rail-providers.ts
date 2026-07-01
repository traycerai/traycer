import type { HarnessOption } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): ReadonlyArray<HarnessOption> {
  const source = harnesses.length > 0 ? harnesses : fallbackHarnesses;
  const visible = source.filter((harness) =>
    railHarnessVisible(harness, degradedHarnessIds),
  );
  return sortGuiHarnessesByProviderOrder(visible).toSorted(
    (left, right) =>
      Number(railHarnessDegraded(left, degradedHarnessIds)) -
      Number(railHarnessDegraded(right, degradedHarnessIds)),
  );
}

export function railHarnessDegraded(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): boolean {
  return (
    !harness.available &&
    (harness.requiresApiKey || degradedHarnessIds.has(harness.id))
  );
}

function railHarnessVisible(
  harness: HarnessOption,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): boolean {
  return (
    harness.available ||
    harness.availabilityPending ||
    railHarnessDegraded(harness, degradedHarnessIds)
  );
}
