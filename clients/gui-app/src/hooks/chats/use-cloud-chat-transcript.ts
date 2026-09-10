import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatPayloadList,
  useCloudChatRead,
} from "@/hooks/chats/use-cloud-chat-queries";
import {
  composeCloudChatTranscriptState,
  type CloudChatTranscriptState,
} from "@/lib/chats/cloud-chat-transcript-state";

/**
 * Read + payload list + presentation + display, composed once.
 *
 * The composition ORDER is the whole reason this exists rather than four calls
 * at a call site, and the rule it enforces lives in
 * `composeCloudChatTranscriptState` as a pure function so it can be asserted
 * without a renderer. This hook is only the wiring: two queries in, one state
 * out.
 */
export function useCloudChatTranscript(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: CloudChatIdentity | null;
  readonly enabled: boolean;
  /**
   * The head digest the epic's RECORD row carries for this chat, or `null`
   * when it carries none. Joins the read's key and drives the payload list's
   * head-edge refetch - see `useCloudChatRead` / `useCloudChatPayloadList`.
   */
  readonly recordHeadSha256: string | null;
}): CloudChatTranscriptState {
  // Both take the record head: the read keys on it, the list re-asks on its
  // edge, so a new publication moves the two together.
  const read = useCloudChatRead(args);
  const payloads = useCloudChatPayloadList(args);
  // Read here rather than inside `composeCloudChatTranscriptState`: that
  // function is pure over the two query results and is asserted without a
  // renderer, and "may this session spend a cloud capability" is not a
  // property of either result. The hook is the wiring, so the wiring answers
  // it - the same split the file's doc already describes.
  const cloudAuthorized = useCloudChatHasCloudAuthorization();

  const readData = read.data;
  const readError = read.error;
  const payloadsOutcome = payloads.data?.outcome;
  // Settled, not successful: a FAILED payload list is a settled answer too.
  const payloadsSettled = payloads.isSuccess || payloads.isError;

  return useMemo(() => {
    const composed = composeCloudChatTranscriptState({
      read: readData,
      readError,
      payloadsOutcome,
      payloadsSettled,
    });
    // ONLY in place of `loading`, which is what makes this honest rather than
    // a blanket gate: a withheld read that still has cached data composes to
    // `ready` (or `refused`, or `failed`) off that data, and none of those is
    // improved by being told the session is unverified. The one state the
    // withholding actually produces is a `loading` that can never settle,
    // because neither query will ever dispatch.
    if (composed.kind === "loading" && !cloudAuthorized) {
      return { kind: "unauthorized" };
    }
    return composed;
  }, [readData, readError, payloadsOutcome, payloadsSettled, cloudAuthorized]);
}

export type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";
