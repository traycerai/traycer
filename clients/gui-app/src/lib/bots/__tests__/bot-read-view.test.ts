import { describe, expect, it } from "vitest";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  botReadFailureKind,
  type BotReadFailureKind,
} from "@/lib/bots/bot-read-view";

const METHOD = "bot.conversation.list";

function hostError(
  code: RpcErrorCode,
  fatalDetails: FatalErrorDetails | null,
): HostRpcError {
  return new HostRpcError({
    code,
    message: `${METHOD} failed with ${code}`,
    requestId: "req-1",
    method: METHOD,
    fatalDetails,
  });
}

/** What the host sends with an `UNAUTHORIZED` it marks as its own passing trouble. */
const RETRYABLE: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "the host could not verify the bearer yet",
  incompatibleMethods: null,
  upgradeGuidance: null,
  retryable: true,
};

describe("botReadFailureKind", () => {
  it.each<{
    readonly name: string;
    readonly error: unknown;
    readonly kind: BotReadFailureKind;
  }>([
    {
      name: "E_CLOUD_REQUEST_REFUSED is reconnecting",
      error: hostError("E_CLOUD_REQUEST_REFUSED", null),
      kind: "reconnecting",
    },
    {
      name: "a transport failure is host-not-answering",
      error: new RetryableTransportError({
        code: "RPC_ERROR",
        message: "Lost the connection to this computer.",
        requestId: "req-1",
        method: METHOD,
        fatalDetails: null,
        replaySafetyFromKey: false,
      }),
      kind: "host-not-answering",
    },
    {
      name: "an UNAUTHORIZED the host marks retryable is a server failure, not signed-out",
      error: hostError("UNAUTHORIZED", RETRYABLE),
      kind: "server",
    },
    {
      name: "VERB_NOT_ALLOWED is access-refused",
      error: hostError("VERB_NOT_ALLOWED", null),
      kind: "access-refused",
    },
    {
      name: "DOWNGRADE_UNSUPPORTED is cannot-serve",
      error: hostError("DOWNGRADE_UNSUPPORTED", null),
      kind: "cannot-serve",
    },
    {
      name: "INCOMPATIBLE is cannot-serve",
      error: hostError("INCOMPATIBLE", null),
      kind: "cannot-serve",
    },
    {
      name: "an error that is not the host's is a server failure",
      error: new Error("boom"),
      kind: "server",
    },
  ])("$name", ({ error, kind }) => {
    expect(botReadFailureKind(error)).toBe(kind);
  });
});
