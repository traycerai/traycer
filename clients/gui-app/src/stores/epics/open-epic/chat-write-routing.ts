/**
 * Whether a chat's registry-backed mutation may be sent on THIS connection.
 *
 * `epic.renameChat` / `epic.reparentChat` / `epic.setChatArchived` /
 * `epic.deleteChat` reach `ChatRegistryWriter` and through it the host's chat
 * store. A chat the store does not hold is not addressable there, and the
 * protocol says so in as many words on `chatRecordSummaryV11Schema`: "a
 * doc-resident chat is NOT addressable through the registry-backed mutations,
 * so a client that could not tell the two apart would send
 * `epic.renameChat` / `epic.reparentChat` an id naming no registry row" - the
 * worse of the two bugs it names, "because it fails on WRITE instead of on
 * render".
 *
 * ## Two facts, in this order
 *
 * T9 ruled a doc-homed row's registry mutations must be gated.
 * `root-dnd-commits.ts` documented the opposite for chats - "`epic.reparentChat`
 * has routed chats since chats-off-YJS, and the host resolves a pre-migration
 * chat through the same storage seam". Both are right, about different hosts,
 * and the fact that separates them is not on either row:
 *
 *  1. **Does this host serve a chat record plane at all?** `epic.renameChat`,
 *     `epic.reparentChat` and `epic.deleteChat` are on
 *     `RELEASED_FLOOR_METHOD_NAMES`, so they exist and work on a floor-era host
 *     that has no chat registry - and on that host every chat projects from the
 *     doc. Gating on the row's home alone would disable every chat affordance
 *     there, on a host where the RPC handles doc chats itself.
 *  2. **Only then, what did the record plane say about THIS row?** On a host
 *     that has one, the plane is the authority on where the row lives, and a
 *     row whose home is `true` (stated doc-homed) or `null` (the delta plane
 *     declined to say) is not addressable through the writer.
 *
 * ## The unaddressable outcome is DISABLED, never a doc write
 *
 * Falling back to mutating the client's `Y.Doc` would be worse than the misroute
 * it avoids: on a host with a record plane the doc is no longer the authority,
 * so record-wins snaps the edit back on the next answer and the affordance reads
 * as working while changing nothing. The hand-off's rule stands - a client must
 * not send record-plane mutations for these rows until the binding host seeds
 * the store - and "not yet" is a thing the UI can say.
 */
import type { EpicDocRecordArms } from "./projection-helpers";
import type { ChatProjection } from "./types";

/**
 * Whether one chat mutation may be sent.
 *
 * Two members, not three. There is deliberately no "write it to the doc" arm -
 * see the module doc for why that would be the worse failure.
 */
export type ChatWriteRoute =
  /** Addressable: send the registry-backed RPC. */
  | "registry-rpc"
  /**
   * Not addressable on this host yet. The affordance is DISABLED with copy that
   * says so; nothing is sent and nothing is written locally.
   */
  | "unavailable";

/**
 * Product copy for the disabled arm. Here rather than at four call sites so the
 * four cannot drift into four different explanations of one state.
 */
export const CHAT_NOT_ADOPTED_COPY =
  "This agent isn't adopted by its host yet, so it can't be changed from here.";

export interface ChatWriteRoutingInputs {
  /** The row from the UNION components read, or `undefined` if it holds none. */
  readonly chat: ChatProjection | undefined;
  /** Whether the doc is still a record source on this host, per population. */
  readonly docArm: EpicDocRecordArms;
}

export function routeChatWrite(inputs: ChatWriteRoutingInputs): ChatWriteRoute {
  const { chat, docArm } = inputs;
  // Fact one. No record plane on this host: there is no registry to miss, and
  // the floor-era RPCs resolve a chat through the host's own storage seam. The
  // row's own claim about its home says nothing about addressability here.
  if (docArm.chats) return "registry-rpc";
  // Fact two. The record plane exists, so it is the authority on where the row
  // lives - and it is the only thing that ever states `false`.
  if (chat !== undefined && chat.docResident === false) return "registry-rpc";
  // `true` (stated doc-homed), `null` (the delta plane declined to say), and a
  // row missing from the union entirely all mean the same thing to a writer
  // that can only address what the store holds.
  return "unavailable";
}
