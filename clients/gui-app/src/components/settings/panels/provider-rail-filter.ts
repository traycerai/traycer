/**
 * View state for the Settings ▸ Providers rail: the text query and the
 * enabled/disabled filter behind its search row.
 *
 * The matching rule lives here rather than inside the panel so it is testable
 * without rendering the pane, and so the rows, the empty state and the
 * result-count announcement all derive from ONE definition of "matches".
 */
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerDisplayName } from "@/lib/provider-ordering";

export const PROVIDER_RAIL_STATUS = {
  All: "all",
  Enabled: "enabled",
  Disabled: "disabled",
} as const;

export type ProviderRailStatus =
  (typeof PROVIDER_RAIL_STATUS)[keyof typeof PROVIDER_RAIL_STATUS];

export const PROVIDER_RAIL_STATUS_OPTIONS: ReadonlyArray<{
  readonly value: ProviderRailStatus;
  readonly label: string;
}> = [
  { value: PROVIDER_RAIL_STATUS.All, label: "All" },
  { value: PROVIDER_RAIL_STATUS.Enabled, label: "Enabled" },
  { value: PROVIDER_RAIL_STATUS.Disabled, label: "Disabled" },
];

export interface ProviderRailView {
  readonly query: string;
  readonly status: ProviderRailStatus;
}

export const DEFAULT_PROVIDER_RAIL_VIEW: ProviderRailView = {
  query: "",
  status: PROVIDER_RAIL_STATUS.All,
};

/** Whether the rail is showing a subset - drives the empty state and the badge. */
export function isProviderRailViewActive(view: ProviderRailView): boolean {
  return (
    view.query.trim().length > 0 || view.status !== PROVIDER_RAIL_STATUS.All
  );
}

export function providerRailStatusLabel(status: ProviderRailStatus): string {
  const match = PROVIDER_RAIL_STATUS_OPTIONS.find(
    (option) => option.value === status,
  );
  return match === undefined ? "All" : match.label;
}

/**
 * Matches on the name the rail actually RENDERS plus the wire id, so both
 * "Traycer Inference" and "traycer" find the same row - `providerDisplayName`
 * overrides the protocol's display name for that one provider, and matching the
 * protocol string instead would leave the visible words unsearchable.
 *
 * Descriptions are deliberately not searched: the rail never shows them, and a
 * row surfacing for text you cannot see reads as a bug rather than a match.
 */
function matchesQuery(providerId: ProviderId, needle: string): boolean {
  if (needle.length === 0) return true;
  if (providerDisplayName(providerId).toLowerCase().includes(needle)) {
    return true;
  }
  return providerId.toLowerCase().includes(needle);
}

function matchesStatus(enabled: boolean, status: ProviderRailStatus): boolean {
  if (status === PROVIDER_RAIL_STATUS.All) return true;
  return status === PROVIDER_RAIL_STATUS.Enabled ? enabled : !enabled;
}

/**
 * Providers the rail should show. Returns the input array UNCHANGED (same
 * identity) while no filter is active, so the common case costs nothing and
 * memoized consumers don't churn.
 */
export function filterProviderRail(
  providers: readonly ProviderCliState[],
  view: ProviderRailView,
): readonly ProviderCliState[] {
  if (!isProviderRailViewActive(view)) return providers;
  const needle = view.query.trim().toLowerCase();
  return providers.filter(
    (provider) =>
      matchesQuery(provider.providerId, needle) &&
      matchesStatus(provider.enabled, view.status),
  );
}
