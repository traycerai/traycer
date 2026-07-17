/**
 * Pure projection helpers over `PrLightItem[]` for the Pull Requests panel:
 * repo grouping, within-group ordering, staleness, first-open auto-expand
 * pick, and the "fully identified" (persistable / tile-able) test. No React,
 * no store access - keeps the accordion body and the expansion store logic
 * independently testable.
 */
import type {
  PrBaseCoordinates,
  PrLightItem,
  PrRepoIdentifier,
} from "@traycer/protocol/host/pr-schemas";

export interface PrRepoGroup {
  readonly repoIdentifier: PrRepoIdentifier;
  readonly items: readonly PrLightItem[];
}

const STATE_RANK: Record<PrLightItem["state"], number> = {
  open: 0,
  merged: 1,
  closed: 2,
};

function repoGroupKey(repoIdentifier: PrRepoIdentifier): string {
  return `${repoIdentifier.owner}/${repoIdentifier.repo}`;
}

/** Descending by `updatedAt`; items with a `null` timestamp sort last. */
function byMostRecentlyUpdated(left: PrLightItem, right: PrLightItem): number {
  if (left.updatedAt === null && right.updatedAt === null) return 0;
  if (left.updatedAt === null) return 1;
  if (right.updatedAt === null) return -1;
  return right.updatedAt - left.updatedAt;
}

/**
 * Orders a group's rows open → merged → closed (decision #2, #11); ties
 * within a state break by most-recently-updated first.
 */
export function orderPrItemsWithinGroup(
  items: readonly PrLightItem[],
): readonly PrLightItem[] {
  return [...items].sort((left, right) => {
    const stateDelta = STATE_RANK[left.state] - STATE_RANK[right.state];
    if (stateDelta !== 0) return stateDelta;
    return byMostRecentlyUpdated(left, right);
  });
}

/**
 * Groups by `repoIdentifier` in first-seen order (the host enumerates a
 * repo's internal PR immediately followed by its OSS-submodule twin, so
 * first-seen order already keeps paired PRs adjacent - decision #1). Each
 * group's rows are ordered open → merged → closed.
 */
export function groupPrItemsByRepo(
  items: readonly PrLightItem[],
): readonly PrRepoGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PrRepoGroup>();
  for (const item of items) {
    const key = repoGroupKey(item.repoIdentifier);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, { repoIdentifier: item.repoIdentifier, items: [item] });
    } else {
      byKey.set(key, { ...existing, items: [...existing.items, item] });
    }
  }
  return order.map((key) => {
    const group = byKey.get(key);
    if (group === undefined) {
      throw new Error(`pr-list-projection: missing group for key "${key}"`);
    }
    return {
      repoIdentifier: group.repoIdentifier,
      items: orderPrItemsWithinGroup(group.items),
    };
  });
}

/** The newest per-item `observedAt` across a frame, or `null` if none observed yet. */
export function newestObservedAt(items: readonly PrLightItem[]): number | null {
  return items.reduce<number | null>((newest, item) => {
    if (item.observedAt === null) return newest;
    if (newest === null) return item.observedAt;
    return Math.max(newest, item.observedAt);
  }, null);
}

function hasFailingChecks(item: PrLightItem): boolean {
  return item.checksRollup !== null && item.checksRollup.failure > 0;
}

/**
 * First-ever-open auto-expand pick (decision #15): open-with-failing-checks
 * > open > most recently updated overall. `null` for an empty list.
 */
export function pickAutoExpandItem(
  items: readonly PrLightItem[],
): PrLightItem | null {
  if (items.length === 0) return null;
  const openFailing = items.filter(
    (item) => item.state === "open" && hasFailingChecks(item),
  );
  if (openFailing.length > 0) {
    return [...openFailing].sort(byMostRecentlyUpdated)[0];
  }
  const open = items.filter((item) => item.state === "open");
  if (open.length > 0) {
    return [...open].sort(byMostRecentlyUpdated)[0];
  }
  return [...items].sort(byMostRecentlyUpdated)[0];
}

/**
 * Stable identity for a list-only row's TRANSIENT expansion tracking (never
 * persisted - see `fullyIdentifiedPrBase`). Head identity + repo is the best
 * available key: base coordinates don't exist yet by definition.
 */
export function prListOnlyItemKey(item: PrLightItem): string {
  return `${item.repoIdentifier.owner}/${item.repoIdentifier.repo}::${item.headRefName ?? ""}::${item.prUrl ?? ""}`;
}

/**
 * A row is "fully identified" (tile-able, persistable as `expandedPr`) only
 * when BOTH its base coordinates and its `githubHost` are known - the two
 * are derived together from the same parsed `prUrl` (tech plan's unknown-base
 * rule), so a fork PR or absent/unparseable `prUrl` leaves both `null`.
 */
export function fullyIdentifiedPrBase(
  item: PrLightItem,
): { readonly githubHost: string; readonly base: PrBaseCoordinates } | null {
  if (item.base === null || item.githubHost === null) return null;
  return { githubHost: item.githubHost, base: item.base };
}

/**
 * Stable accordion identity for a list row. Fully identified rows use base
 * coordinates (persistable); unknown-base rows use a head/repo key that is
 * never written to the expansion store.
 */
export function prListRowKey(item: PrLightItem, hostId: string): string {
  const identified = fullyIdentifiedPrBase(item);
  if (identified !== null) {
    return [
      "id",
      hostId,
      identified.githubHost,
      identified.base.owner,
      identified.base.repo,
      String(identified.base.prNumber),
    ].join("|");
  }
  return [
    "head",
    hostId,
    item.repoIdentifier.owner,
    item.repoIdentifier.repo,
    item.headRefName ?? "",
    item.state,
  ].join("|");
}

export function expandedPrRowKey(args: {
  readonly hostId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return [
    "id",
    args.hostId,
    args.githubHost,
    args.owner,
    args.repo,
    String(args.prNumber),
  ].join("|");
}

/** Collapsed-row primary label: `#number · title` (or head identity when base is unknown). */
export function formatPrRowTitle(item: PrLightItem): string {
  const title =
    item.title !== null && item.title.length > 0
      ? item.title
      : "Untitled pull request";
  if (item.base !== null) {
    return `#${item.base.prNumber} · ${title}`;
  }
  const head =
    item.headRefName !== null && item.headRefName.length > 0
      ? item.headRefName
      : "unknown head";
  return `${head} · ${title}`;
}

export function formatPrChecksRollup(
  rollup: PrLightItem["checksRollup"],
): string {
  if (rollup === null) return "No checks";
  if (rollup.total === 0) return "No checks";
  const parts: string[] = [];
  if (rollup.success > 0) {
    parts.push(`${rollup.success} passed`);
  }
  if (rollup.failure > 0) {
    parts.push(`${rollup.failure} failed`);
  }
  if (rollup.pending > 0) {
    parts.push(`${rollup.pending} running`);
  }
  return parts.length > 0 ? parts.join(" · ") : `${rollup.total} checks`;
}

export function formatPrReviewDecision(
  decision: PrLightItem["reviewDecision"],
): string {
  if (decision === null) return "No review decision";
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  return "Review required";
}

/**
 * Structural (not `PrLightItem`-specific) so `PrDetailCore` - which carries
 * the same two fields but is not a `PrLightItem` - can share this formatter
 * with the panel row.
 */
export function formatPrBranchSummary(item: {
  readonly headRefName: string | null;
  readonly baseRefName: string | null;
}): string {
  const head =
    item.headRefName !== null && item.headRefName.length > 0
      ? item.headRefName
      : "unknown";
  const base =
    item.baseRefName !== null && item.baseRefName.length > 0
      ? item.baseRefName
      : "unknown";
  return `${head} → ${base}`;
}

export type PrChecksDotTone = "ok" | "fail" | "pending" | "none";

export function prChecksDotTone(
  rollup: PrLightItem["checksRollup"],
): PrChecksDotTone {
  if (rollup === null || rollup.total === 0) return "none";
  if (rollup.failure > 0) return "fail";
  if (rollup.pending > 0) return "pending";
  return "ok";
}

export function formatPrStateLabel(state: PrLightItem["state"]): string {
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

export function formatRepoGroupLabel(repoIdentifier: PrRepoIdentifier): string {
  return `${repoIdentifier.owner}/${repoIdentifier.repo}`;
}
