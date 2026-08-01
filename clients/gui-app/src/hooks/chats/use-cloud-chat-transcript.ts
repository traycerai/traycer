import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
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
}): CloudChatTranscriptState {
  const read = useCloudChatRead(args);
  const payloads = useCloudChatPayloadList(args);

  const readData = read.data;
  const readError = read.error;
  const payloadsOutcome = payloads.data?.outcome;
  // Settled, not successful: a FAILED payload list is a settled answer too.
  const payloadsSettled = payloads.isSuccess || payloads.isError;

  return useMemo(
    () =>
      composeCloudChatTranscriptState({
        read: readData,
        readError,
        payloadsOutcome,
        payloadsSettled,
      }),
    [readData, readError, payloadsOutcome, payloadsSettled],
  );
}

export type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";
