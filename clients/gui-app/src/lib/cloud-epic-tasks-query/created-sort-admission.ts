import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HistorySortOption } from "@/components/home/data/home-page.data";

/** The `epic.listTasks` minor that first accepts the `created-desc` sort. */
const LIST_TASKS_CREATED_SORT_MINOR = 10;

/**
 * Whether a host's negotiated `epic.listTasks` can order by creation date.
 *
 * An older minor's request schema rejects `created-desc`, so the client
 * refuses to project it onto that host (`DOWNGRADE_UNSUPPORTED`) and the list
 * would fail instead of loading. Fails closed on `false` and on `null` (no
 * handshake yet): the manifest arriving re-renders every reader.
 */
export function negotiatedListTasksSortsByCreated(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return version.major === 1 && version.minor >= LIST_TASKS_CREATED_SORT_MINOR;
}

/**
 * The sort History requests from, and presents for, one host. A saved
 * `created-desc` reads as Most recent on a host that cannot order by
 * creation, so the list still loads; the saved choice is kept and applies
 * again on a host that can.
 */
export function historySortForHost(
  sort: HistorySortOption,
  sortsByCreated: boolean,
): HistorySortOption {
  return sort === "created-desc" && !sortsByCreated ? "recent" : sort;
}

/** The `organization.history` minor that first accepts `created-desc`. */
const ORGANIZATION_HISTORY_CREATED_SORT_MINOR = 2;

/**
 * The same question for `organization.history`, which serves History while a
 * label or group filter is on and may be answered by a different tier.
 */
export function negotiatedOrganizationHistorySortsByCreated(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return (
    version.major === 1 &&
    version.minor >= ORGANIZATION_HISTORY_CREATED_SORT_MINOR
  );
}
