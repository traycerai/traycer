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
  /** Every row of the group, open → merged → closed, ignoring stacks. */
  readonly items: readonly PrLightItem[];
  /** The same rows as the panel draws them: stacks gathered, then singles. */
  readonly blocks: readonly PrRepoBlock[];
}

/**
 * One drawable unit of a repo group: a lone PR, or a stack of PRs each
 * targeting the one below it. `size` counts every layer of the stack,
 * including ones this epic's list does not carry, so it may exceed
 * `layers.length`. Layers run bottom (closest to `baseRefName`) to top.
 */
export type PrRepoBlock =
  | { readonly kind: "single"; readonly item: PrLightItem }
  | {
      readonly kind: "stack";
      readonly key: string;
      /** GitHub's stack number; `null` for an inferred stack. */
      readonly number: number | null;
      readonly baseRefName: string | null;
      readonly size: number;
      readonly layers: readonly PrLightItem[];
      /**
       * Positions of a native stack this epic's COMPLETE list does not carry
       * (layers opened elsewhere), fixed when the block is built so a view
       * that later hides a layer cannot turn it into one of these. Always
       * empty for an inferred stack.
       */
      readonly absentPositions: readonly number[];
    };

type PrStackBlock = Extract<PrRepoBlock, { readonly kind: "stack" }>;

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
 * Orders a group's rows open → merged → closed; ties
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
    const ordered = orderPrItemsWithinGroup(groupItems);
    return { repoIdentifier, items: ordered, blocks: buildRepoBlocks(ordered) };
  });
}

/**
 * Gathers a group's rows into stacks. GitHub's native stack membership wins:
 * rows sharing a `stack.number` are one stack, in `position` order. Rows with
 * no native stack fall back to inference - a row whose base branch is another
 * row's head branch sits on it - which covers hand-built stacks and hosts
 * that do not report the native field.
 *
 * Blocks are ordered by their best state (open → merged → closed), then by
 * their most recent update; inside a stack, layer order wins over state.
 * `items` must already be in {@link orderPrItemsWithinGroup} order: it breaks
 * the remaining ties, so a group with no stacks reads exactly as before.
 */
function buildRepoBlocks(
  items: readonly PrLightItem[],
): readonly PrRepoBlock[] {
  const nativeByNumber = new Map<number, PrLightItem[]>();
  const rest: PrLightItem[] = [];
  for (const item of items) {
    const stack = item.stack ?? null;
    // A stack of one is not a stack: GitHub reports none, but a fact that
    // did would still read as a lone row.
    if (stack === null || stack.size <= 1) {
      rest.push(item);
      continue;
    }
    const bucket = nativeByNumber.get(stack.number);
    if (bucket === undefined) nativeByNumber.set(stack.number, [item]);
    else bucket.push(item);
  }
  const blocks: PrRepoBlock[] = [];
  for (const [number, members] of nativeByNumber) {
    const layers = [...members].sort(
      (left, right) => nativePosition(left) - nativePosition(right),
    );
    const first = layers[0].stack ?? null;
    // Rows of one stack were fetched at different times, so a stack that
    // grew can report two sizes, and a stale size can sit below a carried
    // position. The block spans every size and position it was given.
    const size = Math.max(
      layers.length,
      ...layers.map((item) => item.stack?.size ?? 0),
      ...layers.map((item) => nativeStackPosition(item) ?? 0),
    );
    const present = new Set(layers.map((item) => nativeStackPosition(item)));
    const absentPositions: number[] = [];
    for (let position = 1; position <= size; position += 1) {
      if (!present.has(position)) absentPositions.push(position);
    }
    blocks.push({
      kind: "stack",
      key: `native:${number}`,
      number,
      baseRefName: first === null ? null : first.baseRefName,
      size,
      layers,
      absentPositions,
    });
  }
  blocks.push(...inferStackBlocks(rest));
  const firstSeen = new Map(items.map((item, index) => [item, index]));
  const rankOf = (block: PrRepoBlock): number =>
    Math.min(...blockItems(block).map((item) => STATE_RANK[item.state]));
  const updatedOf = (block: PrRepoBlock): number | null => {
    const stamps = blockItems(block)
      .map((item) => item.updatedAt)
      .filter((stamp): stamp is number => stamp !== null);
    return stamps.length === 0 ? null : Math.max(...stamps);
  };
  const firstSeenOf = (block: PrRepoBlock): number =>
    Math.min(...blockItems(block).map((item) => firstSeen.get(item) ?? 0));
  return blocks.sort((left, right) => {
    const rankDelta = rankOf(left) - rankOf(right);
    if (rankDelta !== 0) return rankDelta;
    const leftUpdated = updatedOf(left);
    const rightUpdated = updatedOf(right);
    if (leftUpdated !== rightUpdated) {
      if (leftUpdated === null) return 1;
      if (rightUpdated === null) return -1;
      return rightUpdated - leftUpdated;
    }
    return firstSeenOf(left) - firstSeenOf(right);
  });
}

function nativePosition(item: PrLightItem): number {
  return item.stack?.position ?? Number.MAX_SAFE_INTEGER;
}

function blockItems(block: PrRepoBlock): readonly PrLightItem[] {
  return block.kind === "single" ? [block.item] : block.layers;
}

/**
 * Inferred stacks over rows with no native stack: row A sits on row B when
 * A's base branch is B's head branch, and no other row shares either end of
 * that edge (fan-in or fan-out breaks it). Connected rows form one stack, ordered
 * by how many layers lie beneath each; a component with a cycle in it keeps
 * first-seen order rather than inventing a bottom.
 */
function inferStackBlocks(
  items: readonly PrLightItem[],
): readonly PrRepoBlock[] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  const indicesByHead = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.headRefName === null || item.headRefName.length === 0) return;
    const bucket = indicesByHead.get(item.headRefName);
    if (bucket === undefined) indicesByHead.set(item.headRefName, [index]);
    else bucket.push(index);
  });
  // Each row's candidate supports: the rows whose head is its base.
  const candidatesOf = items.map((item, index) =>
    item.baseRefName === null
      ? []
      : (indicesByHead.get(item.baseRefName) ?? []).filter(
          (other) => other !== index,
        ),
  );
  const dependentCount = items.map(() => 0);
  for (const candidates of candidatesOf) {
    for (const candidate of candidates) dependentCount[candidate] += 1;
  }
  // A stack is a chain, not a tree: an edge counts only when it is the sole
  // way down from its upper row AND the sole way up from its lower one. A
  // promotion PR whose head several feature PRs target stays a lone row, and
  // so does each feature PR.
  const supportsOf = candidatesOf.map((candidates) =>
    candidates.length === 1 && dependentCount[candidates[0]] === 1
      ? candidates
      : [],
  );
  supportsOf.forEach((supports, index) => {
    for (const support of supports) parent[find(index)] = find(support);
  });
  const components = new Map<number, number[]>();
  items.forEach((_, index) => {
    const root = find(index);
    const bucket = components.get(root);
    if (bucket === undefined) components.set(root, [index]);
    else bucket.push(index);
  });

  const blocks: PrRepoBlock[] = [];
  for (const members of components.values()) {
    if (members.length === 1) {
      blocks.push({ kind: "single", item: items[members[0]] });
      continue;
    }
    const depths = layerDepths(members, supportsOf);
    const ordered =
      depths === null
        ? members
        : [...members].sort(
            (left, right) =>
              (depths.get(left) ?? 0) - (depths.get(right) ?? 0) ||
              left - right,
          );
    const layers = ordered.map((index) => items[index]);
    const bottom = layers[0];
    blocks.push({
      kind: "stack",
      key: `inferred:${prListRowKey(bottom, "")}`,
      number: null,
      baseRefName: bottom.baseRefName,
      size: layers.length,
      layers,
      absentPositions: [],
    });
  }
  return blocks;
}

/**
 * Each member's distance from the bottom of its stack, or `null` when the
 * component holds a cycle (no bottom exists to measure from).
 */
function layerDepths(
  members: readonly number[],
  supportsOf: readonly (readonly number[])[],
): ReadonlyMap<number, number> | null {
  const depths = new Map<number, number>();
  const visiting = new Set<number>();
  const walk = { cyclic: false };
  const depthOf = (index: number): number => {
    const known = depths.get(index);
    if (known !== undefined) return known;
    if (visiting.has(index)) {
      walk.cyclic = true;
      return 0;
    }
    visiting.add(index);
    const supports = supportsOf[index];
    const depth =
      supports.length === 0 ? 0 : 1 + Math.max(...supports.map(depthOf));
    visiting.delete(index);
    depths.set(index, depth);
    return depth;
  };
  for (const index of members) depthOf(index);
  return walk.cyclic ? null : depths;
}

/**
 * The groups with only the rows `keep` admits, stacks and repo groups
 * included. Membership is decided on the COMPLETE list first (by
 * {@link groupPrItemsByRepo}) and hidden afterwards: filtering before
 * grouping would let a hidden fan-in row disappear from the inference and
 * turn a promotion PR plus one visible dependent into a stack that is not
 * one. A stack whose every layer is hidden goes; one with some hidden keeps
 * its place, and a group with nothing left to show goes with its header.
 */
export function filterPrRepoGroups(
  groups: readonly PrRepoGroup[],
  keep: (item: PrLightItem) => boolean,
): readonly PrRepoGroup[] {
  const filtered: PrRepoGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter(keep);
    if (items.length === 0) continue;
    const blocks: PrRepoBlock[] = [];
    for (const block of group.blocks) {
      if (block.kind === "single") {
        if (keep(block.item)) blocks.push(block);
        continue;
      }
      const layers = block.layers.filter(keep);
      if (layers.length > 0) blocks.push({ ...block, layers });
    }
    filtered.push({ repoIdentifier: group.repoIdentifier, items, blocks });
  }
  return filtered;
}

/**
 * A stack drawn top layer first, the way GitHub lists one, with the layers
 * this epic's list does not carry marked where they sit. Each entry is a
 * carried row, or a run of absent positions (a native stack with layers
 * opened from elsewhere, read off `absentPositions`, never off which rows
 * the view kept: a layer hidden by a filter just leaves the rail). An
 * inferred stack is never short of layers. The base sits below the last
 * entry.
 */
export type PrStackRailEntry =
  | { readonly kind: "layer"; readonly item: PrLightItem }
  | {
      readonly kind: "absent";
      readonly count: number;
      /** The highest absent position in the run; unique within a stack. */
      readonly topPosition: number;
    };

export function prStackRailEntries(
  block: PrStackBlock,
): readonly PrStackRailEntry[] {
  if (block.number === null) {
    return [...block.layers]
      .reverse()
      .map((item): PrStackRailEntry => ({ kind: "layer", item }));
  }
  const byPosition = new Map(
    block.layers.map((item) => [nativeStackPosition(item), item]),
  );
  const absent = new Set(block.absentPositions);
  const entries: PrStackRailEntry[] = [];
  let run = 0;
  for (let position = block.size; position >= 1; position -= 1) {
    if (absent.has(position)) {
      run += 1;
      continue;
    }
    if (run > 0) {
      entries.push({ kind: "absent", count: run, topPosition: position + run });
      run = 0;
    }
    const item = byPosition.get(position);
    if (item !== undefined) entries.push({ kind: "layer", item });
  }
  if (run > 0) entries.push({ kind: "absent", count: run, topPosition: run });
  return entries;
}

function nativeStackPosition(item: PrLightItem): number | null {
  const stack = item.stack ?? null;
  return stack !== null && stack.size > 1 ? stack.position : null;
}

/**
 * The stack sub-header's count: the whole stack's size, or `n of size` when
 * this list carries only some of its layers.
 */
export function formatPrStackCount(block: PrStackBlock): string {
  return block.layers.length < block.size
    ? `${block.layers.length} of ${block.size}`
    : String(block.size);
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
