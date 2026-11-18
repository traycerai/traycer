import { describe, expect, it } from "vitest";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  botReadFailureKind,
  botReadView,
  type BotReadFailureKind,
  type BotReadView,
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

describe("botReadView", () => {
  const LOADED_AT = 1_700_000_000_000;
  const ANSWER = { threads: [] };

  function failing(
    error: unknown,
    data: unknown,
    retainedReadable: boolean,
  ): BotReadView {
    return botReadView(
      { isError: true, data, error, dataUpdatedAt: LOADED_AT },
      retainedReadable,
    );
  }

  it.each<{
    readonly name: string;
    readonly error: Error;
    readonly data: unknown;
    readonly retainedReadable: boolean;
    readonly view: BotReadView;
  }>([
    {
      name: "keeps readable rows through a recoverable failure",
      error: hostError("RPC_ERROR", null),
      data: ANSWER,
      retainedReadable: true,
      view: { kind: "stale", failure: "server", loadedAt: LOADED_AT },
    },
    {
      name: "withholds kept rows the person may not read",
      error: hostError("RPC_ERROR", null),
      data: ANSWER,
      retainedReadable: false,
      view: { kind: "failed", failure: "server", rowsWithheld: true },
    },
    {
      name: "withholds the rows of a lasting refusal even when they are readable",
      error: hostError("FORBIDDEN", null),
      data: ANSWER,
      retainedReadable: true,
      view: { kind: "failed", failure: "access-refused", rowsWithheld: true },
    },
    {
      name: "withholds nothing when nothing has loaded",
      error: hostError("RPC_ERROR", null),
      data: undefined,
      retainedReadable: false,
      view: { kind: "failed", failure: "server", rowsWithheld: false },
    },
  ])("$name", ({ error, data, retainedReadable, view }) => {
    expect(failing(error, data, retainedReadable)).toEqual(view);
  });

  it("is ok while the read has not failed", () => {
    expect(
      botReadView(
        { isError: false, data: ANSWER, error: null, dataUpdatedAt: LOADED_AT },
        false,
      ),
    ).toEqual({ kind: "ok" });
  });
});
