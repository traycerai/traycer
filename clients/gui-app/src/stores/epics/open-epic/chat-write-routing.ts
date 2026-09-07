/**
 * Ask whether this host has a chat record plane, then whether this row lives there.
 * Unaddressable means disable the affordance; never fall back to a local doc write.
 */
import type { EpicDocRecordArms } from "./projection-helpers";
import type { ChatProjection } from "./types";

/** Whether one chat mutation may be sent. Two members, not three. */
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
  // Fact one. No record plane on this host: there is no registry to miss, and the floor-era RPCs
  // resolve a chat through the host's own storage seam.
  if (docArm.chats) return "registry-rpc";
  // Fact two. The record plane exists, so it is the authority on where the row
  // lives - and it is the only thing that ever states `false`.
  if (chat !== undefined && chat.docResident === false) return "registry-rpc";
  // `true` (stated doc-homed), `null` (the delta plane declined to say), and a row missing from the
  // union entirely all mean the same thing to a writer that can only address what the store holds.
  return "unavailable";
}
