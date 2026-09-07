import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { resolverFromPayloadRefs } from "@traycer-clients/shared/cloud-chat/payloads";
import {
  presentChat,
  NO_PAYLOADS_RESOLVABLE,
  type PresentedChat,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import type { ListCloudChatPayloadsOutcome } from "@traycer/protocol/host/epic/cloud-chat";
import { isCloudChatsUnsupported } from "@/lib/chats/cloud-chat-read-port";
import {
  buildCloudChatTranscript,
  describeTranscriptFidelity,
  type CloudChatTranscript,
} from "@/lib/chats/cloud-chat-transcript-display";

/** Two queries and their outcomes -> the one state a reader surface renders. */

export type CloudChatTranscriptState =
  /** Still resolving, downloading, or waiting on the payload list. */
  | { readonly kind: "loading" }
  /** The host predates the cloud-chat surface. Not an error - a capability gap. */
  | { readonly kind: "unsupported" }
  /** A genuine transport failure. The only arm a retry could change. */
  | { readonly kind: "failed"; readonly error: HostRpcError }
  /**
   * The read completed and did NOT produce a chat.
   * Each arm has its own remedy, which is why they are not collapsed into one "error" state - see `describeCloudChatRefusal`.
   */
  | { readonly kind: "refused"; readonly read: CloudChatRead }
  | {
      readonly kind: "ready";
      readonly read: CloudChatRead;
      readonly presented: PresentedChat;
      readonly transcript: CloudChatTranscript;
      /** One line for what this build could not fully render, or `null`. */
      readonly fidelityNotice: string | null;
    };

export type CloudChatTranscriptInputs = {
  readonly read: CloudChatRead | undefined;
  readonly readError: HostRpcError | null;
  /** `undefined` while the list has not answered - success OR failure. */
  readonly payloadsOutcome: ListCloudChatPayloadsOutcome | undefined;
  readonly payloadsSettled: boolean;
};

export function composeCloudChatTranscriptState(
  inputs: CloudChatTranscriptInputs,
): CloudChatTranscriptState {
  if (inputs.readError !== null) {
    return isCloudChatsUnsupported(inputs.readError)
      ? { kind: "unsupported" }
      : { kind: "failed", error: inputs.readError };
  }
  if (inputs.read === undefined) {
    return { kind: "loading" };
  }
  // A REFUSAL needs no payload list.
  // The settle rule below exists so a presented transcript's fidelity count cannot disagree with itself a moment later, and a refused read presents no transcript to count: its remedy is already known, and the list can only describe attachments for a chat this.
  if (inputs.read.outcome.kind !== "ok") {
    return { kind: "refused", read: inputs.read };
  }
  if (!inputs.payloadsSettled) {
    return { kind: "loading" };
  }

  // An `ambiguous-identity` list describes a DIFFERENT owner's chat, so it is treated as no list at all rather than as an empty one - an empty list would render "no attachments" for a chat that has them.
  const outcome = inputs.payloadsOutcome;
  const resolvePayload =
    outcome !== undefined && outcome.status === "ok"
      ? resolverFromPayloadRefs(outcome.refs)
      : NO_PAYLOADS_RESOLVABLE;

  const presented = presentChat(inputs.read.outcome.chat, { resolvePayload });
  return {
    kind: "ready",
    read: inputs.read,
    presented,
    transcript: buildCloudChatTranscript(presented),
    fidelityNotice: describeTranscriptFidelity(presented),
  };
}
