import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import {
  readCloudChat,
  type CloudChatRead,
} from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import {
  DEFAULT_PUBLISH,
  IDENTITY,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
  UNPUBLISHED_SUMMARY,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import { composeCloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";

/**
 * The composition rule, asserted directly.
 *
 * Every case here is about ORDER rather than content, which is exactly why the
 * rule was extracted out of the hook: a `renderHook` version would have to
 * drive two queries into a specific interleaving to say the same thing, and
 * would then be testing TanStack's scheduling as much as this decision.
 */

async function readFixture(): Promise<CloudChatRead> {
  const published = await publishCloudChat(DEFAULT_PUBLISH);
  return readCloudChat({
    identity: IDENTITY,
    port: recordingPort(servingBehaviour(published)),
    cache: new InMemoryChatPartCache(),
    sha256Hex: webCryptoSha256Hex,
  });
}

// The CONCRETE union, not `string`: the helper builds a real `HostRpcError`,
// and widening its code here is what made the OSS compile gate red while the
// per-package `tsc --noEmit` stayed quiet.
function rpcError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "boom",
    requestId: "r",
    method: "epic.resolveCloudChatHead",
    fatalDetails: null,
  });
}

describe("the payload list gates presentation", () => {
  it("stays LOADING while the payload list is in flight, even with the chat in hand", async () => {
    const read = await readFixture();

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      payloadsOutcome: undefined,
      payloadsSettled: false,
    });

    // Presenting here would build a transcript claiming zero unavailable
    // attachments and then silently disagree with itself a moment later.
    expect(state.kind).toBe("loading");
  });

  it("presents once the list has SETTLED, even if it failed", async () => {
    const read = await readFixture();

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      // A failed list answers nothing, and that is a settled answer.
      payloadsOutcome: undefined,
      payloadsSettled: true,
    });

    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    // Degrades to exactly the markers this surface drew before the payload
    // channel existed - both of the fixture's file-snapshot refs.
    expect(state.presented.fidelity.missingPayloads).toBe(2);
  });

  it("treats an ambiguous-identity list as NO list, not an empty one", async () => {
    const read = await readFixture();

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      payloadsOutcome: { status: "ambiguous-identity" },
      payloadsSettled: true,
    });

    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    // An empty list would render "no attachments" for a chat that has them;
    // this renders the markers, which is the honest answer.
    expect(state.presented.fidelity.missingPayloads).toBe(2);
  });

  it("uses a resolved list to mark what IS fetchable", async () => {
    const read = await readFixture();

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      payloadsOutcome: {
        status: "ok",
        refs: [{ kind: "file-snapshot", sha256: "aaa111" }],
      },
      payloadsSettled: true,
    });

    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.presented.fidelity.missingPayloads).toBe(1);
  });
});

describe("what counts as an error", () => {
  it("calls an older host UNSUPPORTED rather than failed", () => {
    const state = composeCloudChatTranscriptState({
      read: undefined,
      readError: rpcError("E_HOST_UNSUPPORTED"),
      payloadsOutcome: undefined,
      payloadsSettled: true,
    });

    expect(state.kind).toBe("unsupported");
  });

  it("keeps a real transport failure distinct", () => {
    const state = composeCloudChatTranscriptState({
      read: undefined,
      readError: rpcError("RPC_ERROR"),
      payloadsOutcome: undefined,
      payloadsSettled: true,
    });

    expect(state.kind).toBe("failed");
  });

  it("routes a non-ok READ outcome to refused, not to failed", () => {
    const read: CloudChatRead = {
      chat: UNPUBLISHED_SUMMARY,
      outcome: { kind: "unpublished" },
    };

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      payloadsOutcome: undefined,
      payloadsSettled: true,
    });

    // `unpublished` is a success value with its own remedy; presenting it as a
    // failure would offer a retry that cannot help.
    expect(state.kind).toBe("refused");
  });

  it("refuses WITHOUT waiting for the payload list, whose answer cannot matter", () => {
    const read: CloudChatRead = {
      chat: UNPUBLISHED_SUMMARY,
      outcome: { kind: "unpublished" },
    };

    const state = composeCloudChatTranscriptState({
      read,
      readError: null,
      payloadsOutcome: undefined,
      // Still in flight - and for a refusal it may stay that way. The remedy is
      // known, no transcript is presented, and there is no fidelity count for a
      // late list to contradict; holding the spinner on an unrelated request is
      // an indefinite wait for nothing.
      payloadsSettled: false,
    });

    expect(state.kind).toBe("refused");
  });
});
