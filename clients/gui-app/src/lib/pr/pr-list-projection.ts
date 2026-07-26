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

/**
 * One top-level row plus the owned-submodule PRs that shipped with it. The
 * host marks both sides of a worktree binding entry with a shared
 * `linkGroupKey` (see `prLinkGroupKeySchema`); a paired internal+OSS change
 * then reads as ONE piece of work instead of two unrelated repo groups.
 */
export interface PrListNode {
  readonly item: PrLightItem;
  readonly linked: readonly PrLightItem[];
}

export interface PrRepoGroup {
  readonly repoIdentifier: PrRepoIdentifier;
  readonly nodes: readonly PrListNode[];
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
 * Attaches each owned-submodule PR to the superproject PR it shares a
 * `linkGroupKey` with, and returns the rows that stay top-level.
 *
 * A submodule row is only nested when its parent is actually present in the
 * frame - an orphan (parent PR not opened yet, or its repo filtered out)
 * stays a top-level row under its own repo group rather than disappearing.
 */
export function linkPrItems(
  items: readonly PrLightItem[],
): readonly PrListNode[] {
  const parentIndexByLinkKey = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.repoRole !== "superproject" || item.linkGroupKey === null) return;
    if (parentIndexByLinkKey.has(item.linkGroupKey)) return;
    parentIndexByLinkKey.set(item.linkGroupKey, index);
  });
  const nodes = items.map((item): PrListNode => ({ item, linked: [] }));
  const nested = new Set<number>();
  const linkedByParentIndex = new Map<number, PrLightItem[]>();
  items.forEach((item, index) => {
    if (item.repoRole !== "submodule" || item.linkGroupKey === null) return;
    const parentIndex = parentIndexByLinkKey.get(item.linkGroupKey);
    if (parentIndex === undefined) return;
    nested.add(index);
    linkedByParentIndex.set(parentIndex, [
      ...(linkedByParentIndex.get(parentIndex) ?? []),
      item,
    ]);
  });
  return nodes
    .map((node, index) => {
      const linked = linkedByParentIndex.get(index);
      if (linked === undefined) return node;
      return { item: node.item, linked: orderPrItemsWithinGroup(linked) };
    })
    .filter((_node, index) => !nested.has(index));
}

/**
 * Groups by `repoIdentifier` in first-seen order (the host enumerates a
 * repo's internal PR immediately followed by its OSS-submodule twin, so
 * first-seen order already keeps paired PRs adjacent - decision #1). Each
 * group's rows are ordered open → merged → closed.
 *
 * Operates on LINKED nodes, so a nested submodule PR never also lists as its
 * own top-level row, and a repo whose every PR nested elsewhere contributes no
 * group at all.
 */
export function groupPrItemsByRepo(
  items: readonly PrLightItem[],
): readonly PrRepoGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PrListNode[]>();
  const identifierByKey = new Map<string, PrRepoIdentifier>();
  for (const node of linkPrItems(items)) {
    const key = repoGroupKey(node.item.repoIdentifier);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      identifierByKey.set(key, node.item.repoIdentifier);
      byKey.set(key, [node]);
    } else {
      byKey.set(key, [...existing, node]);
    }
  }
  return order.map((key) => {
    const nodes = byKey.get(key);
    const repoIdentifier = identifierByKey.get(key);
    if (nodes === undefined || repoIdentifier === undefined) {
      throw new Error(`pr-list-projection: missing group for key "${key}"`);
    }
    return { repoIdentifier, nodes: orderPrNodesWithinGroup(nodes) };
  });
}

function orderPrNodesWithinGroup(
  nodes: readonly PrListNode[],
): readonly PrListNode[] {
  return [...nodes].sort((left, right) => {
    const stateDelta =
      STATE_RANK[left.item.state] - STATE_RANK[right.item.state];
    if (stateDelta !== 0) return stateDelta;
    return byMostRecentlyUpdated(left.item, right.item);
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

/**
 * A nested submodule row's identity: `traycer #675`. The repo name leads
 * because the whole point of the nested row is that it is in a DIFFERENT repo
 * from the parent it sits under - the same vocabulary the worktrees panel's
 * submodule PR chip uses.
 */
export function prLinkedRowIdentityLabel(item: PrLightItem): string {
  return `${item.repoIdentifier.repo} ${prRowIdentity(item)}`;
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
 * Structural (not `PrLightItem`-specific) so `PrDetailCore` - which carries
 * the same two fields but is not a `PrLightItem` - can share this formatter
 * with the panel row.
 */
/**
 * The panel row's branch line, read as a merge target: `base ← head`, the
 * direction GitHub's own compare control uses. The detail view keeps the
 * forward `head → base` reading of {@link formatPrBranchSummary}, where the
 * PR's own branch is the subject rather than the destination.
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

export function formatPrStateLabel(state: PrLightItem["state"]): string {
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

export function formatRepoGroupLabel(repoIdentifier: PrRepoIdentifier): string {
  return `${repoIdentifier.owner}/${repoIdentifier.repo}`;
}
