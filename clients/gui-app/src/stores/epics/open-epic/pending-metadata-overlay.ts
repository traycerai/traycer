/**
 * Optimistic overlay for single-row metadata: rename, epic title, and artifact
 * reparent. Phase 1.1 of the GUI store rework.
 *
 * ## What this replaces, and what it RESTORES
 *
 * The obvious reading is "a stand-in for the optimistic doc write that
 * `epic.subscribe@2` deletes". That is half of it, and the smaller half.
 *
 * `renameArtifactAction` resolves an id through the doc's `artifacts`, `chats`
 * and `tuiAgents` maps and returns `false` when all three miss - which is
 * exactly what a REGISTRY-BACKED row is. Post chats-off-YJS and the terminal
 * agent doc eviction, that is most agent-family rows. So the desktop optimistic
 * path silently stopped working for the majority of rows it appears to cover,
 * and nothing reports it: the rename still lands, one round trip later, which
 * reads as ordinary latency. The narrow viewport (`use-switcher-rename.ts`)
 * never had a local update at all.
 *
 * This overlay covers both planes, so it is a regression fix on desktop and a
 * width-independence fix below 768px - not a mobile nicety.
 *
 * ## Shape: retained beside the slices, unioned at the projection seam
 *
 * Deliberately the same shape as `pending-chat-creations.ts`, which solves the
 * neighbouring problem (rows created but not yet served). Pending state lives
 * BESIDE the authoritative slices and is folded in by a pure, reference-
 * preserving function at the one seam every projection path goes through.
 *
 * The alternative - a `pending` field on `ArtifactProjection` / `ChatProjection`
 * - was rejected on reference stability: the union helpers compare projections
 * by value and preserve references when nothing differs, and a per-row pending
 * flag would churn those references on every mutation, re-rendering every
 * consumer of a slice because one row is in flight.
 *
 * Applied BEFORE `projectTreeSlice`, so a reparent overlay restructures
 * `childrenByParent` / `rootIds` for free rather than needing the tree patched
 * a second time. Two spellings of the same move is the defect class this
 * branch has already paid for three times.
 *
 * ## Rollback is dropping the patch, not writing anything back
 *
 * Because the overlay is a display patch layered OVER the authoritative value,
 * reverting is simply forgetting it - the authoritative value is already
 * underneath. Do not add a write-back path; `tab-strip-item.tsx`'s hand-rolled
 * capture/restore pair is the pre-overlay model and is what this retires.
 *
 * The captured baseline is still load-bearing, for a different reason: it is
 * how "row wins" is detected. See {@link resolvePendingChain}.
 */
import type {
  ArtifactsSlice,
  ChatsSlice,
  EpicHeader,
  TerminalAgentsSlice,
} from "./types";

/**
 * A rename in flight. `nodeId` may name an artifact, a chat or a terminal
 * agent - the overlay does not care which plane the row lives on, which is the
 * point.
 */
export interface PendingRename {
  readonly kind: "rename";
  readonly requestId: string;
  readonly nodeId: string;
  /** The title the user asked for. */
  readonly title: string;
  /**
   * The AUTHORITATIVE title at the moment this mutation was stamped - read
   * from the projection, never from a previous overlay. See
   * {@link resolvePendingChain} for why it is read that way and what it buys.
   */
  readonly baseline: string;
  /**
   * True once this mutation's RPC ACKED. A landed entry is no longer pending
   * - it is PROOF: the host committed this exact value, so (a) an
   * authoritative row equal to it is our own write echoing back, never a peer
   * edit to yield to, and (b) until the row catches up, displaying it is
   * showing the host's real state through a stale slice, which is what
   * prevents the post-ack snap-back. Landed entries are swept by
   * {@link collectDeadPendingMutations} once the row catches up or a peer
   * overwrites.
   */
  readonly landed: boolean;
}

/** An epic-header title change in flight (the tab strip / mobile header). */
export interface PendingEpicTitle {
  readonly kind: "epic-title";
  readonly requestId: string;
  readonly title: string;
  readonly baseline: string;
  /** See {@link PendingRename.landed}. */
  readonly landed: boolean;
}

/**
 * An artifact reparent in flight. Applied to the row's `parentId` before the
 * tree is built, so the sidebar re-parents synchronously.
 */
export interface PendingReparent {
  readonly kind: "reparent";
  readonly requestId: string;
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly baseline: string | null;
  /** See {@link PendingRename.landed}. */
  readonly landed: boolean;
}

export type PendingMetadataMutation =
  | PendingRename
  | PendingEpicTitle
  | PendingReparent;

/**
 * Every mutation this client has stamped and not yet finished with, keyed by
 * client request id. "Finished" is NOT "the RPC settled": a terminally failed
 * mutation is deleted at retire, but an ACKED one is kept (marked `landed`)
 * until the authoritative row catches up to it, because the ack is what the
 * row-wins rule needs to tell our own echo from a peer's write - and what
 * keeps the display from snapping back to a stale slice after a successful
 * ack. {@link collectDeadPendingMutations} is the sweep that finally forgets
 * a landed chain.
 *
 * A `Map` rather than a record because ORDER IS SEMANTIC: two renames of one
 * row must apply in the order the user made them, and `resolvePendingChain`
 * walks them in insertion order.
 */
export type PendingMetadataOverlay = ReadonlyMap<
  string,
  PendingMetadataMutation
>;

/**
 * The shared "nothing in flight" identity. One frozen empty map means the
 * overwhelmingly common case hands every downstream `Object.is` check the same
 * reference, exactly as the empty slices do.
 */
export const EMPTY_PENDING_OVERLAY: PendingMetadataOverlay = new Map<
  string,
  PendingMetadataMutation
>();

/** The node a mutation patches, or `null` for the epic header. */
function mutationNodeId(mutation: PendingMetadataMutation): string | null {
  return mutation.kind === "epic-title" ? null : mutation.nodeId;
}

/**
 * The value a mutation is asking for, in the shape the row carries it. Renames
 * and the epic title patch a `string`; a reparent patches `string | null`.
 */
function mutationTarget(mutation: PendingMetadataMutation): string | null {
  return mutation.kind === "reparent" ? mutation.parentId : mutation.title;
}

interface ResolvedPendingChain {
  readonly value: string | null;
  readonly changed: boolean;
  /**
   * Every entry in this chain is finished business and the whole chain can be
   * forgotten: the row caught up to the last acked value, or the row moved
   * somewhere no anchor explains - a peer superseded us. Supersession is
   * TERMINAL even for a chain with un-landed entries: the entry's RPC may
   * still settle, but its retire will simply find nothing (deliberate - a
   * superseded intent must not resurrect when the row later revisits the old
   * baseline, and must not hold `baselineFor` hostage for the next begin).
   */
  readonly dead: boolean;
}

/**
 * Decide what the display value for one field should be, given the
 * authoritative value and the mutations stamped for it.
 *
 * ## The rule this encodes
 *
 * "Row wins, always" (the design contract's first rule) is easy to state and
 * easy to implement wrongly, in both directions.
 *
 * The naive form - drop the overlay whenever an authoritative row arrives -
 * drops it on EVERY projection, because a projection always produces rows.
 * The rule has to be about the authoritative value MOVING, which is what the
 * captured baseline makes observable.
 *
 * The overcorrection - "if the row's value equals one of our targets, that's
 * our write landing, keep applying the rest" - infers causality from VALUE
 * EQUALITY, and a peer independently writing the same value is
 * indistinguishable from our echo. The first review of this file shipped that
 * inference and it let a stale local patch outrank an authoritative peer
 * write.
 *
 * So the only equality this function trusts is with a LANDED target: our own
 * ack is the causal proof value equality cannot be. And even an ack only
 * proves the host HELD the value at some point - it cannot identify a LATER
 * row bearing that value as our echo rather than a peer's write. Hence the
 * anchor set narrows as the chain drains:
 *
 * - A chain with un-landed entries anchors on the baseline plus EVERY landed
 *   target (an intermediate echo passing through must not drop the still-in-
 *   flight tail), and applies the last pending target while anchored.
 * - A chain with only landed entries anchors on the baseline ALONE: while the
 *   row still shows the pre-chain value the slice is merely stale, so keep
 *   showing the last acked target. The row reaching that last target is the
 *   caught-up echo - dead. The row showing ANYTHING else - an intermediate
 *   target included - is treated as supersession and dies showing the row:
 *   with nothing left in flight, an "intermediate echo" and "a peer wrote
 *   that same value after us" are indistinguishable, and keeping the patch on
 *   a guess is how a stale title survives forever. The cost is a brief
 *   honest flash of the intermediate value between echoes of a fast
 *   double-rename; the alternative cost is unbounded.
 * - NOT anchored, in either state → the host moved on its own: row wins AND
 *   the chain dies (see {@link ResolvedPendingChain.dead} for why death is
 *   terminal even mid-flight).
 */
function resolvePendingChain(
  authoritative: string | null,
  chain: readonly PendingMetadataMutation[],
): ResolvedPendingChain {
  if (chain.length === 0) {
    return { value: authoritative, changed: false, dead: false };
  }
  const baseline = chain[0].baseline;
  const pending = chain.filter((mutation) => !mutation.landed);
  const landedTargets = chain
    .filter((mutation) => mutation.landed)
    .map(mutationTarget);
  if (pending.length > 0) {
    const anchored =
      authoritative === baseline || landedTargets.includes(authoritative);
    if (!anchored) return { value: authoritative, changed: false, dead: true };
    // The LAST-STAMPED target, not the last still-pending one: ACKs settle
    // out of order, and filtering landed entries out of display selection
    // walks the UI backward when the newest intent acks first (rename B
    // then C; C acks; showing B until B settles regresses the newest thing
    // the user asked for). The last stamp is the newest intent whatever its
    // RPC state; when the tail is landed its target is also what the
    // all-landed branch below will keep showing, so display is continuous
    // across the final settle.
    const value = mutationTarget(chain[chain.length - 1]);
    return { value, changed: value !== authoritative, dead: false };
  }
  const lastLanded = landedTargets[landedTargets.length - 1];
  if (authoritative === lastLanded) {
    return { value: authoritative, changed: false, dead: true };
  }
  if (authoritative === baseline) {
    return { value: lastLanded, changed: true, dead: false };
  }
  return { value: authoritative, changed: false, dead: true };
}

/** Mutations of one kind for one node, in the order they were stamped. */
function chainFor(
  overlay: PendingMetadataOverlay,
  kind: PendingMetadataMutation["kind"],
  nodeId: string | null,
): readonly PendingMetadataMutation[] {
  const chain: PendingMetadataMutation[] = [];
  for (const mutation of overlay.values()) {
    if (mutation.kind !== kind) continue;
    if (mutationNodeId(mutation) !== nodeId) continue;
    chain.push(mutation);
  }
  return chain;
}

/** Node ids carrying at least one RETAINED mutation of the given kind -
 * landed or not; "pending" is reserved for un-landed (see
 * `pendingMutationCount`). */
function nodesWithMutations(
  overlay: PendingMetadataOverlay,
  kind: PendingMetadataMutation["kind"],
): readonly string[] {
  const ids: string[] = [];
  for (const mutation of overlay.values()) {
    if (mutation.kind !== kind) continue;
    const id = mutationNodeId(mutation);
    if (id === null || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** The row fields the overlay patches, shared by all three slices. */
interface OverlayPatchableRow {
  readonly title: string;
  readonly parentId: string | null;
}

interface OverlayPatchableSlice<Row extends OverlayPatchableRow> {
  readonly byId: Readonly<Record<string, Row>>;
  readonly allIds: readonly string[];
}

/**
 * One applier for all three slices - artifacts, chats and terminal agents
 * patch the same two fields under the same chain rules, and three
 * hand-copied bodies is how the rules drift apart.
 *
 * Returns the input BY REFERENCE when nothing is pending, or when every
 * pending mutation has been superseded by the authoritative row - so an epic
 * with no mutation in flight keeps the exact slice identity the projector
 * produced and costs no downstream re-render.
 */
function applyPendingOverlayToSlice<Row extends OverlayPatchableRow>(
  slice: OverlayPatchableSlice<Row>,
  overlay: PendingMetadataOverlay,
): OverlayPatchableSlice<Row> {
  if (overlay.size === 0) return slice;
  let byId: Record<string, Row> | null = null;
  const touched = new Set<string>([
    ...nodesWithMutations(overlay, "rename"),
    ...nodesWithMutations(overlay, "reparent"),
  ]);
  for (const id of touched) {
    // `Object.hasOwn`, not an `=== undefined` check on the read: `byId` is a
    // `Record`, so the index signature types the read as always-present and
    // the null check lints as impossible. Same idiom as
    // `pending-chat-creations.ts`.
    if (!Object.hasOwn(slice.byId, id)) continue;
    const row = slice.byId[id];
    const title = resolvePendingChain(
      row.title,
      chainFor(overlay, "rename", id),
    );
    const parent = resolvePendingChain(
      row.parentId,
      chainFor(overlay, "reparent", id),
    );
    if (!title.changed && !parent.changed) continue;
    byId ??= { ...slice.byId };
    // `Object.assign` rather than an object spread: spreading a generic
    // `Row` and overriding two properties types as a fresh object literal,
    // not as `Row`, while the assign form's intersection stays assignable.
    byId[id] = Object.assign({}, row, {
      title: title.changed && title.value !== null ? title.value : row.title,
      parentId: parent.changed ? parent.value : row.parentId,
    });
  }
  if (byId === null) return slice;
  return { byId, allIds: slice.allIds };
}

/** `artifacts` with pending renames and reparents applied. */
export function applyPendingOverlayToArtifacts(
  artifacts: ArtifactsSlice,
  overlay: PendingMetadataOverlay,
): ArtifactsSlice {
  return applyPendingOverlayToSlice(artifacts, overlay);
}

/** `chats` with pending renames and reparents applied. */
export function applyPendingOverlayToChats(
  chats: ChatsSlice,
  overlay: PendingMetadataOverlay,
): ChatsSlice {
  return applyPendingOverlayToSlice(chats, overlay);
}

/** `tuiAgents` with pending renames and reparents applied. */
export function applyPendingOverlayToTuiAgents(
  tuiAgents: TerminalAgentsSlice,
  overlay: PendingMetadataOverlay,
): TerminalAgentsSlice {
  return applyPendingOverlayToSlice(tuiAgents, overlay);
}

/** The epic header with a pending title change applied. */
export function applyPendingOverlayToEpicHeader(
  epic: EpicHeader,
  overlay: PendingMetadataOverlay,
): EpicHeader {
  if (overlay.size === 0) return epic;
  const resolved = resolvePendingChain(
    epic.title,
    chainFor(overlay, "epic-title", null),
  );
  if (!resolved.changed || resolved.value === null) return epic;
  return { ...epic, title: resolved.value };
}

/**
 * How many mutations are genuinely in flight - stamped and not yet acked.
 * LANDED entries are excluded: the host has committed them, so nothing about
 * them is at risk on quit. The dirty/quit surface consumes this in Phase 4.4
 * (`collectUnsyncedRows` re-derived from pending overlay rows); it is here
 * rather than there so both read one definition.
 */
export function pendingMutationCount(overlay: PendingMetadataOverlay): number {
  let count = 0;
  for (const mutation of overlay.values()) {
    if (!mutation.landed) count += 1;
  }
  return count;
}

/** The pre-overlay union slices a chain's authoritative value is read from. */
export interface PendingOverlayAuthoritativeState {
  readonly artifacts: ArtifactsSlice;
  readonly chats: ChatsSlice;
  readonly tuiAgents: TerminalAgentsSlice;
  readonly epicTitle: string | null;
}

/** The row field a chain patches, read from whichever slice holds the node. */
function authoritativeValueFor(
  state: PendingOverlayAuthoritativeState,
  kind: PendingMetadataMutation["kind"],
  nodeId: string | null,
): { readonly found: boolean; readonly value: string | null } {
  if (kind === "epic-title") return { found: true, value: state.epicTitle };
  if (nodeId === null) return { found: false, value: null };
  for (const byId of [
    state.artifacts.byId,
    state.chats.byId,
    state.tuiAgents.byId,
  ]) {
    if (!Object.hasOwn(byId, nodeId)) continue;
    const row = byId[nodeId];
    return {
      found: true,
      value: kind === "reparent" ? row.parentId : row.title,
    };
  }
  return { found: false, value: null };
}

/**
 * Request ids of every chain that is finished business against these
 * authoritative slices: a landed-only chain whose row caught up to the last
 * acked value, ANY chain whose row moved somewhere its anchors don't explain
 * (supersession - terminal even with entries still in flight, so a stale
 * intent can neither resurrect when the row revisits its old value nor hold
 * `baselineFor` hostage for the next begin; the in-flight entry's later
 * retire simply finds nothing), and any chain whose node no longer exists in
 * any slice.
 *
 * Pure. The projector seam calls this with the PRE-overlay slices each full
 * projection and deletes the reported ids from the retained map - no
 * republish needed, because a dead chain by definition displays the
 * authoritative value already.
 *
 * The report is only as good as the slices: this function cannot tell an
 * authoritative deletion from a replica that simply has not been seeded yet
 * (an empty doc between `replaceReplica` and its snapshot reads as every
 * doc-backed node vanishing at once). The CALLER owns that judgment, per
 * PLANE - the store's `onDeadMutations` ignores the report for doc-authority
 * chains while the open cycle has no root snapshot, but honors it for
 * registry-backed chats and terminal agents, whose record tables a root
 * reconnect never touches - so acting on this return value requires knowing
 * which slices actually carry authority.
 */
export function collectDeadPendingMutations(
  overlay: PendingMetadataOverlay,
  state: PendingOverlayAuthoritativeState,
): readonly string[] {
  if (overlay.size === 0) return EMPTY_REQUEST_IDS;
  const seen = new Set<string>();
  const dead: string[] = [];
  for (const mutation of overlay.values()) {
    const nodeId = mutationNodeId(mutation);
    const chainKey = `${mutation.kind}:${nodeId ?? ""}`;
    if (seen.has(chainKey)) continue;
    seen.add(chainKey);
    const chain = chainFor(overlay, mutation.kind, nodeId);
    const authoritative = authoritativeValueFor(state, mutation.kind, nodeId);
    const resolved = authoritative.found
      ? resolvePendingChain(authoritative.value, chain)
      : null;
    // A vanished node is dead the same way a caught-up one is: there is no
    // row left for the patch to apply to, and no RPC outcome still owed.
    if (resolved === null || resolved.dead) {
      for (const entry of chain) dead.push(entry.requestId);
    }
  }
  return dead.length === 0 ? EMPTY_REQUEST_IDS : dead;
}

const EMPTY_REQUEST_IDS: readonly string[] = Object.freeze([]);
