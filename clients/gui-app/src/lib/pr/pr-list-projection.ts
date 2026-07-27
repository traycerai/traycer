/**
 * Pure projection helpers over `PrLightItem[]` for the Pull Requests panel:
 * repo grouping, within-group ordering, staleness, and the "fully
 * identified" (tile-able) test. No React, no store access - keeps the card
 * list independently testable.
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
 * Group order: an owned submodule's repo lands directly beneath the
 * superproject repo it shipped with, everything else in first-seen order.
 *
 * The pairing comes from the shared `linkGroupKey` the host stamps on both
 * sides of one worktree binding entry (see `prLinkGroupKeySchema`). It moves
 * WHERE a group sits and nothing else - a submodule PR keeps its own repo
 * dropdown and its own full-size row, because it is its own review with its
 * own checks and its own conversation. Adjacency is enough to say "these
 * shipped together"; nesting said "this one is a detail of that one", which
 * is not what a submodule PR is.
 *
 * A submodule whose superproject PR is not in the frame (not opened yet, or
 * its repo filtered out) simply keeps its first-seen position.
 */
function orderRepoGroupKeys(
  items: readonly PrLightItem[],
  groupKeyOf: (item: PrLightItem) => string,
): readonly string[] {
  const firstSeen: string[] = [];
  for (const item of items) {
    const key = groupKeyOf(item);
    if (!firstSeen.includes(key)) firstSeen.push(key);
  }
  const superprojectGroupByLinkKey = new Map<string, string>();
  for (const item of items) {
    if (item.repoRole !== "superproject" || item.linkGroupKey === null)
      continue;
    if (superprojectGroupByLinkKey.has(item.linkGroupKey)) continue;
    superprojectGroupByLinkKey.set(item.linkGroupKey, groupKeyOf(item));
  }
  // Each submodule group is pulled to just after its parent's group. Keyed by
  // group rather than by item so a repo contributing several submodule PRs
  // moves once, as a unit.
  const followersByGroupKey = new Map<string, string[]>();
  const pulled = new Set<string>();
  for (const item of items) {
    if (item.repoRole !== "submodule" || item.linkGroupKey === null) continue;
    const groupKey = groupKeyOf(item);
    if (pulled.has(groupKey)) continue;
    const parentGroupKey = superprojectGroupByLinkKey.get(item.linkGroupKey);
    if (parentGroupKey === undefined || parentGroupKey === groupKey) continue;
    pulled.add(groupKey);
    followersByGroupKey.set(parentGroupKey, [
      ...(followersByGroupKey.get(parentGroupKey) ?? []),
      groupKey,
    ]);
  }
  // Expansion is recursive because one repo can hold BOTH roles across two
  // bindings: a submodule under one superproject and the superproject of
  // another group. Expanding a single level would emit that repo as a
  // follower while silently dropping the group that follows IT - its own
  // `pulled` entry keeps it out of the first-seen pass, and
  // `groupPrItemsByRepo` cannot catch it because its throw fires on a MISSING
  // key, never on a dropped one.
  const emitted = new Set<string>();
  const expand = (key: string): readonly string[] => {
    if (emitted.has(key)) return [];
    emitted.add(key);
    return [key, ...(followersByGroupKey.get(key) ?? []).flatMap(expand)];
  };
  return [
    ...firstSeen.flatMap((key) => (pulled.has(key) ? [] : expand(key))),
    // Two groups can pull each other, leaving a cycle with no root to expand
    // from. Whatever the first pass did not reach keeps its first-seen place
    // rather than vanishing from the list.
    ...firstSeen.flatMap(expand),
  ];
}

/**
 * Groups by `repoIdentifier`. Every PR is a top-level row in its own repo
 * group - see {@link orderRepoGroupKeys} for how a submodule's group is
 * placed. Each group's rows are ordered open → merged → closed.
 */
export function groupPrItemsByRepo(
  items: readonly PrLightItem[],
): readonly PrRepoGroup[] {
  const byKey = new Map<string, PrLightItem[]>();
  const identifierByKey = new Map<string, PrRepoIdentifier>();
  for (const item of items) {
    const key = repoGroupKey(item.repoIdentifier);
    identifierByKey.set(key, item.repoIdentifier);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return orderRepoGroupKeys(items, (item) =>
    repoGroupKey(item.repoIdentifier),
  ).map((key) => {
    const groupItems = byKey.get(key);
    const repoIdentifier = identifierByKey.get(key);
    if (groupItems === undefined || repoIdentifier === undefined) {
      throw new Error(`pr-list-projection: missing group for key "${key}"`);
    }
    return { repoIdentifier, items: orderPrItemsWithinGroup(groupItems) };
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

/**
 * A row is "fully identified" (tile-able) only when BOTH its base
 * coordinates and its `githubHost` are known - the two are derived together
 * from the same parsed `prUrl` (tech plan's unknown-base rule), so a fork PR
 * or absent/unparseable `prUrl` leaves both `null`.
 */
export function fullyIdentifiedPrBase(
  item: PrLightItem,
): { readonly githubHost: string; readonly base: PrBaseCoordinates } | null {
  if (item.base === null || item.githubHost === null) return null;
  return { githubHost: item.githubHost, base: item.base };
}

/**
 * Stable list identity for a card. Fully identified rows key on base
 * coordinates; unknown-base rows fall back to a head/repo key.
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

/**
 * Card primary label: `#number · title` (or head identity when base is
 * unknown). A never-swept row has a `null` title; rather than assert a
 * definitive "Untitled pull request" for something we simply haven't observed
 * yet, fall back to the bare identity (`#number` or head ref).
 */
export function formatPrRowTitle(item: PrLightItem): string {
  const identity = prRowIdentity(item);
  const title = prRowTitleText(item);
  return title !== null ? `${identity} · ${title}` : identity;
}

/**
 * The identity token alone (`#4226`, or the head ref when the base is
 * unknown). The card renders it as its own muted element beside the title
 * rather than as a prefix inside it, so the title gets the full remaining
 * width before truncating.
 */
export function prRowIdentityLabel(item: PrLightItem): string {
  return prRowIdentity(item);
}

/**
 * The PR's own title, or `null` for a never-swept row. Callers pair this with
 * {@link prRowIdentityLabel}; a `null` title means the identity token is the
 * whole label, NOT that the PR is untitled.
 */
export function prRowTitleText(item: PrLightItem): string | null {
  if (item.title === null || item.title.length === 0) return null;
  return item.title;
}

function prRowIdentity(item: PrLightItem): string {
  if (item.base !== null) return `#${item.base.prNumber}`;
  if (item.headRefName !== null && item.headRefName.length > 0) {
    return item.headRefName;
  }
  return "unknown head";
}

/**
 * Shared check-tone vocabulary, spoken by the panel row's rolled-up chip
 * ({@link prChecksSummary}) and by the detail view's per-context tone
 * (`prCheckContextDotTone`).
 */
export type PrChecksDotTone = "ok" | "fail" | "pending" | "none";

export interface PrChecksSummary {
  readonly tone: PrChecksDotTone;
  /** The headline: the worst bucket that has anything in it. */
  readonly label: string;
  /** Every non-zero bucket, for the chip's tooltip. */
  readonly detail: string;
}

/**
 * CI rolled up the way GitHub rolls it up: ONE worst-wins chip, with the full
 * breakdown behind it.
 *
 * Three bare counters side by side (`✕1 ◷3 ✓10`) forced the reader to decode
 * three glyphs to answer one question - and sat at the same weight as the
 * review decision beside them, whose `✕` meant something else entirely. A
 * single "1 failing" answers it at a glance; the counts are still one hover
 * away for anyone who wants them.
 */
export function prChecksSummary(
  rollup: PrLightItem["checksRollup"],
): PrChecksSummary | null {
  if (rollup === null || rollup.total === 0) return null;
  const parts: string[] = [];
  if (rollup.failure > 0) parts.push(`${rollup.failure} failing`);
  if (rollup.pending > 0) parts.push(`${rollup.pending} running`);
  if (rollup.success > 0) parts.push(`${rollup.success} passed`);
  // `total` counts contexts the three buckets don't (skipped, neutral,
  // cancelled), so it is reported rather than assumed equal to their sum.
  const detail = [...parts, `${rollup.total} total`].join(" · ");
  if (rollup.failure > 0) {
    return { tone: "fail", label: `${rollup.failure} failing`, detail };
  }
  if (rollup.pending > 0) {
    return { tone: "pending", label: `${rollup.pending} running`, detail };
  }
  if (rollup.success > 0) {
    return { tone: "ok", label: `${rollup.success} passed`, detail };
  }
  // Every context settled to something the buckets don't name. Claiming "ok"
  // here would report a green run that nothing actually passed.
  return {
    tone: "none",
    label: `${rollup.total} check${rollup.total === 1 ? "" : "s"}`,
    detail,
  };
}

/**
 * The panel row's branch line, read as a merge target: `base ← head`, the
 * direction GitHub's own compare control uses. The detail view keeps the
 * forward `head → base` reading of {@link formatPrBranchSummary}, where the
 * PR's own branch is the subject rather than the destination.
 *
 * Structural (not `PrLightItem`-specific) so `PrDetailCore` - which carries
 * the same two fields but is not a `PrLightItem` - can share this formatter
 * with the panel row.
 */
export function formatPrBaseFromHead(item: {
  readonly headRefName: string | null;
  readonly baseRefName: string | null;
}): string {
  return `${branchOrUnknown(item.baseRefName)} ← ${branchOrUnknown(item.headRefName)}`;
}

function branchOrUnknown(branch: string | null): string {
  return branch !== null && branch.length > 0 ? branch : "unknown";
}

export function formatPrBranchSummary(item: {
  readonly headRefName: string | null;
  readonly baseRefName: string | null;
}): string {
  return `${branchOrUnknown(item.headRefName)} → ${branchOrUnknown(item.baseRefName)}`;
}

export function formatPrStateLabel(state: PrLightItem["state"]): string {
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

export function formatRepoGroupLabel(repoIdentifier: PrRepoIdentifier): string {
  return `${repoIdentifier.owner}/${repoIdentifier.repo}`;
}
