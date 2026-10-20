import { describe, expect, it } from "vitest";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  markMayHaveReachedHost,
  mayHaveReachedHost,
  RetryableTransportError,
} from "../rpc-types";

function plainRpcError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "boom",
    requestId: "req",
    method: "host.echo",
    fatalDetails: null,
  });
}

function markedRpcError(): HostRpcError {
  const error = plainRpcError();
  markMayHaveReachedHost(error);
  return error;
}

const ATTESTED = {
  code: "INCOMPATIBLE",
  reason: "no overlap",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

describe("mayHaveReachedHost", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly error: () => unknown;
    readonly expected: boolean;
  }> = [
    {
      name: "an abort before dispatch",
      error: () =>
        new HostRequestAbortedError({
          message: "aborted",
          requestId: "req",
          method: "host.echo",
          mayHaveDispatched: false,
        }),
      expected: false,
    },
    {
      name: "an abort after dispatch",
      error: () =>
        new HostRequestAbortedError({
          message: "aborted",
          requestId: "req",
          method: "host.echo",
          mayHaveDispatched: true,
        }),
      expected: true,
    },
    {
      name: "a retryable failure that is provably pre-send",
      error: () =>
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "dial timed out",
          requestId: "req",
          method: "host.echo",
          fatalDetails: null,
          replaySafetyFromKey: false,
        }),
      expected: false,
    },
    {
      name: "a retryable failure earned by a negotiated key",
      error: () =>
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "dropped after send",
          requestId: "req",
          method: "host.echo",
          fatalDetails: null,
          replaySafetyFromKey: true,
        }),
      expected: true,
    },
    {
      name: "a plain HostRpcError that was marked",
      error: markedRpcError,
      expected: true,
    },
    {
      name: "the same kind of HostRpcError left unmarked",
      error: plainRpcError,
      expected: false,
    },
    {
      name: "an unattested transport failure",
      error: () =>
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "dropped",
          requestId: "req",
          method: "host.echo",
          fatalDetails: null,
        }),
      expected: true,
    },
    {
      name: "a transport failure the host attested",
      error: () =>
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "closed terminally",
          requestId: "req",
          method: "host.echo",
          fatalDetails: ATTESTED,
        }),
      expected: false,
    },
    {
      name: "an error that is not a HostRpcError",
      error: () => new Error("boom"),
      expected: false,
    },
  ];

  it.each(cases)("is $expected for $name", ({ error, expected }) => {
    expect(mayHaveReachedHost(error())).toBe(expected);
  });
});
