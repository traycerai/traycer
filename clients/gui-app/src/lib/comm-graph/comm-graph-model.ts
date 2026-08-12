/**
 * Display-layer projection of the raw comm-graph event array.
 *
 * Everything here is DERIVED and disposable: the merged event array stays raw
 * and uncollapsed (it is also what the timeline consumes, unaggregated), and
 * these helpers fold it into what a canvas can actually draw. Aggregation lives
 * on this side of the line deliberately - the canvas would be unreadable with
 * one edge per message, but the record must not be rewritten to achieve that.
 *
 * Every function takes the event array as an argument, so a future time cursor
 * only has to pass a prefix (`events.filter(e => e.timestamp <= t)`) to get the
 * graph as of `t`; nothing here reads "now".
 */
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";

export type CommGraphAgentKind = "chat" | "terminal-agent";

export interface CommGraphAgentNode {
  readonly id: string;
  readonly kind: CommGraphAgentKind;
  readonly name: string;
  /**
   * Host the agent lives on; decides which subscription covers its edges.
   *
   * `null` for a LEGACY chat record written before chats carried `hostId`.
   * That stays unresolved on purpose: the only "live" answer available is the
   * app's currently-active host, which is reactive global state - reading it
   * here would move the node (and tear down / re-open that host's
   * subscription, discarding its events and cursor) every time the user
   * switches hosts elsewhere in the app. An unattributed node rendered as
   * "host unknown" is honest; a node that flaps with a global selection is
   * not.
   */
  readonly hostId: string | null;
  /**
   * Creator, when known. A LAYOUT CONSTRAINT ONLY - lineage is never drawn as
   * an edge: it is mutable via reparent and already visualized by the sidebar,
   * so drawing it would duplicate the tree and imply a message that never
   * happened.
   */
  readonly parentId: string | null;
  /** TUI harness brand, for the node icon. `null` for GUI chats. */
  readonly harnessId: TuiHarnessId | null;
  /** Archived agents are ALWAYS shown, styled muted - the graph is historical. */
  readonly archived: boolean;
  readonly createdAt: number;
}

/**
 * One edge per UNORDERED pair {A, B}.
 *
 * Two directed edges between the same agents draw as two curves that cross and
 * fight each other; at three or four conversing agents the canvas becomes
 * unreadable spaghetti and the shape of the conversation - who is talking to
 * whom at all - is lost. Direction is not lost with it: it moves to the
 * click-through, which lists both directions interleaved and labels every row.
 */
export interface CommGraphAggregatedEdge {
  /** Order-independent pair id - see `commGraphPairId`. */
  readonly id: string;
  /** The endpoints in the pair id's canonical (sorted) order. */
  readonly agentAId: string;
  readonly agentBId: string;
  /**
   * True when EITHER direction has an unanswered `expectReply` send. Derived
   * purely from the log - the live broker is never consulted.
   */
  readonly hasOpenThread: boolean;
  /**
   * The contributing rows across BOTH directions, in the merged array's order,
   * for the click-through. Interleaved chronologically by construction: the
   * input array is already sorted, so one pass preserves it.
   */
  readonly events: ReadonlyArray<CommGraphEvent>;
}

/**
 * The canvas edge id: order-independent, so a row in either direction lands on
 * the same edge. Sorted rather than "first seen wins" so the id is a pure
 * function of the pair and cannot depend on which message happened to arrive
 * first.
 */
export function commGraphPairId(
  agentOneId: string,
  agentTwoId: string,
): string {
  return agentOneId < agentTwoId
    ? `${agentOneId}<->${agentTwoId}`
    : `${agentTwoId}<->${agentOneId}`;
}

/**
 * Thread key: `responseId` scoped to its HOST.
 *
 * Response ids are host-local, so two hosts can hand out the same one for
 * unrelated threads. Scoping the key here is also what makes the row-id
 * ordering below sound: ids are monotonic PER HOST and meaningless across
 * hosts, so they may only ever be compared inside one of these buckets.
 */
function threadKey(hostId: string, responseId: string): string {
  return `${hostId} ${responseId}`;
}

/**
 * Thread key to the latest reply seen on it.
 *
 * Host-local rows use their monotonic row id as causal order. Cloud rows use
 * their canonical `(ingestVersion, eventId)` cursor instead: a restored host
 * can reuse an origin row id, while cloud ingestion remains append-only. The
 * wall clock is never causal order: a request, its reply and a re-opening
 * request routinely land in the same millisecond, and clocks can step backward.
 *
 * The merged array's DISPLAY sort is a separate concern and stays
 * `(timestamp, hostId, id)`: it orders unrelated events across hosts, where ids
 * genuinely are not comparable.
 *
 * A `responseId` is reused across a directed pair, so a thread can be answered,
 * reopened, and answered again; tracking the LATEST reply rather than mere
 * existence is what keeps a re-opened thread showing as open.
 */
function compareThreadCausalOrder(
  left: CommGraphEvent,
  right: CommGraphEvent,
): number {
  if (
    left.ingestVersion !== undefined &&
    left.eventId !== undefined &&
    right.ingestVersion !== undefined &&
    right.eventId !== undefined
  ) {
    if (left.ingestVersion !== right.ingestVersion) {
      return left.ingestVersion - right.ingestVersion;
    }
    return left.eventId.localeCompare(right.eventId);
  }
  return left.id - right.id;
}

function latestReplyByThread(
  events: ReadonlyArray<CommGraphEvent>,
): ReadonlyMap<string, CommGraphEvent> {
  const latest = new Map<string, CommGraphEvent>();
  for (const event of events) {
    if (event.inReplyTo === null) continue;
    const key = threadKey(event.hostId, event.inReplyTo);
    const current = latest.get(key);
    if (current === undefined || compareThreadCausalOrder(current, event) < 0) {
      latest.set(key, event);
    }
  }
  return latest;
}

function isOpenRequest(
  event: CommGraphEvent,
  latestReply: ReadonlyMap<string, CommGraphEvent>,
): boolean {
  if (event.kind !== "a2a_message") return false;
  if (event.expectReply !== true) return false;
  if (event.responseId === null) return false;
  const reply = latestReply.get(threadKey(event.hostId, event.responseId));
  if (reply === undefined) return true;
  return compareThreadCausalOrder(reply, event) < 0;
}

interface MutablePairEntry {
  readonly agentAId: string;
  readonly agentBId: string;
  hasOpenThread: boolean;
  readonly events: CommGraphEvent[];
}

/**
 * Fold A2A rows into one edge per UNORDERED pair.
 *
 * Rows whose endpoints are not both in `agentIds` are skipped: the canvas draws
 * agents from the epic's projection, so an edge to an id with no node has
 * nothing to attach to. That is a rendering limit, not a filter on the record -
 * the event array itself keeps every row.
 */
export function aggregateCommGraphEdges(
  events: ReadonlyArray<CommGraphEvent>,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<CommGraphAggregatedEdge> {
  const latestReply = latestReplyByThread(events);
  const byPair = new Map<string, MutablePairEntry>();
  for (const event of events) {
    const sender = event.senderAgentId;
    const receiver = event.receiverAgentId;
    if (sender === null || receiver === null) continue;
    if (!agentIds.has(sender) || !agentIds.has(receiver)) continue;
    const id = commGraphPairId(sender, receiver);
    const existing = byPair.get(id);
    const entry: MutablePairEntry = existing ?? {
      // Canonical order, matching the id, so the endpoints a consumer reads
      // do not depend on which direction spoke first.
      agentAId: sender < receiver ? sender : receiver,
      agentBId: sender < receiver ? receiver : sender,
      hasOpenThread: false,
      events: [],
    };
    if (existing === undefined) byPair.set(id, entry);
    // The canvas dashes the pair when EITHER direction is waiting - the edge
    // says "this conversation has an unanswered ask", and which way it points is
    // the detail view's job (it labels every row).
    if (isOpenRequest(event, latestReply)) entry.hasOpenThread = true;
    entry.events.push(event);
  }
  return Array.from(byPair.entries(), ([id, entry]) => ({
    id,
    agentAId: entry.agentAId,
    agentBId: entry.agentBId,
    hasOpenThread: entry.hasOpenThread,
    events: entry.events,
  }));
}
