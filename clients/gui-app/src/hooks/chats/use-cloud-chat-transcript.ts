import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { resolverFromPayloadRefs } from "@traycer-clients/shared/cloud-chat/payloads";
import {
  presentChat,
  NO_PAYLOADS_RESOLVABLE,
  type PresentedChat,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  useCloudChatPayloadList,
  useCloudChatRead,
} from "@/hooks/chats/use-cloud-chat-queries";
import { isCloudChatsUnsupported } from "@/lib/chats/cloud-chat-read-port";
import {
  buildCloudChatTranscript,
  describeTranscriptFidelity,
  type CloudChatTranscript,
} from "@/lib/chats/cloud-chat-transcript-display";

/**
 * Read + payload list + presentation + display, composed once.
 *
 * The composition order is the whole reason this is a hook rather than four
 * calls at a call site: the payload list has to be RESOLVED before `presentChat`
 * runs, because the presenter's resolver is synchronous and the fidelity count
 * it produces has to be complete by the time a transcript exists. Doing this
 * inline in a component would let one surface present before the list settled
 * and report "0 attachments unavailable" for a chat full of them.
 */

export type CloudChatTranscriptState =
  /** Still resolving, downloading, or waiting on the payload list. */
  | { readonly kind: "loading" }
  /** The host predates the cloud-chat surface. Not an error - a capability gap. */
  | { readonly kind: "unsupported" }
  /** A genuine transport failure. Retryable, and the only arm that is. */
  | { readonly kind: "failed"; readonly error: HostRpcError }
  /**
   * The read completed and did NOT produce a chat. Each arm has its own remedy,
   * which is why they are not collapsed into one "error" state.
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

export function useCloudChatTranscript(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: CloudChatIdentity | null;
  readonly enabled: boolean;
}): CloudChatTranscriptState {
  const read = useCloudChatRead(args);
  const payloads = useCloudChatPayloadList(args);

  const readData = read.data;
  const payloadsOutcome = payloads.data?.outcome;
  // Settled, not successful: a FAILED payload list is a settled answer too, and
  // the transcript degrades to the markers it rendered before the channel
  // existed rather than waiting forever for a call that is not coming back.
  const payloadsSettled = payloads.isSuccess || payloads.isError;

  return useMemo<CloudChatTranscriptState>(() => {
    if (read.error !== null) {
      return isCloudChatsUnsupported(read.error)
        ? { kind: "unsupported" }
        : { kind: "failed", error: read.error };
    }
    if (readData === undefined || !payloadsSettled) return { kind: "loading" };
    if (readData.outcome.kind !== "ok") {
      return { kind: "refused", read: readData };
    }

    // An `ambiguous-identity` payload list describes a DIFFERENT owner's chat,
    // so it is treated as no list at all rather than as an empty one - an empty
    // list would render "no attachments" for a chat that has them.
    const resolvePayload =
      payloadsOutcome !== undefined && payloadsOutcome.status === "ok"
        ? resolverFromPayloadRefs(payloadsOutcome.refs)
        : NO_PAYLOADS_RESOLVABLE;

    const presented = presentChat(readData.outcome.chat, { resolvePayload });
    return {
      kind: "ready",
      read: readData,
      presented,
      transcript: buildCloudChatTranscript(presented),
      fidelityNotice: describeTranscriptFidelity(presented),
    };
  }, [read.error, readData, payloadsOutcome, payloadsSettled]);
}
