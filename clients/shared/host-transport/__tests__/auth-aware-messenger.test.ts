import { describe, expect, it, vi } from "vitest";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import {
  createRetryingMessenger,
  RetryEpisodeOutcomeUnknownError,
} from "../retrying-messenger";
import {
  HostAuthoritySupersededError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  mayHaveReachedHost,
  type HostRequestAuthority,
  type HostRequestOptions,
  type IHostMessenger,
} from "../host-messenger";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { AuthorityBoundAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

type Registry = typeof hostRpcRegistry;

const METHOD = "epic.listTasks";
const PARAMS = {
  limit: 1,
  filters: null,
  extensionPhaseVersion: "0.0.0",
  extensionEpicVersion: "0.0.0",
} as const;

function unauthorizedError(): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: "Invalid token",
    requestId: "req-1",
    method: METHOD,
    fatalDetails: null,
  });
}

function rpcError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "boom",
    requestId: "req-2",
    method: METHOD,
    fatalDetails: null,
  });
}

// A transient host-side rejection (JWKS fetch timeout): wire `code` stays
// UNAUTHORIZED but `fatalDetails.retryable` marks it recoverable-without-authn.
function retryableUnauthorizedError(): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: "Signing key unavailable: request timed out",
    requestId: "req-3",
    method: METHOD,
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "Signing key unavailable: request timed out",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
    },
  });
}

// These tests drive only the unary `request` path; the wrapper routes the two
// methods independently. Stub the long-poll variant with a throwing mock rather
// than a bare `vi.fn()` (which resolves `undefined`) so an accidental route of
// `request` through it fails loudly instead of silently passing on an invalid
// result.
function uncalledLongPoll() {
  return vi.fn(() => {
    throw new Error(
      "requestWithResponseTimeout must not be called by these unary-path tests",
    );
  });
}

function authorityFor(bearer: MutableBearerLease): HostRequestAuthority {
  return {
    endpoint: {
      hostId: "test-host",
      websocketUrl: "ws://test-host/rpc",
    },
    bearer,
    abortSignal: new AbortController().signal,
  };
}

function authRevalidator(
  revalidateExpectedBearer: AuthorityBoundAuthRevalidator["revalidateExpectedBearer"],
): AuthorityBoundAuthRevalidator {
  return { revalidateExpectedBearer };
}

function defaultLease(): MutableBearerLease {
  return new MutableBearerLease("token", "u1");
}

describe("createAuthAwareMessenger", () => {
  it("passes results through without revalidating on success", async () => {
    const revalidate = vi.fn();
    const auth = authRevalidator(revalidate);
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockResolvedValue(undefined),
      requestWithResponseTimeout: uncalledLongPoll(),
    };

    const lease = defaultLease();
    const wrapped = createAuthAwareMessenger(inner, auth);
    await wrapped.request(METHOD, PARAMS, {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority: authorityFor(lease),
    });
    expect(revalidate).not.toHaveBeenCalled();
    expect(inner.request).toHaveBeenCalledTimes(1);
  });

  it("renderer mode: revalidates on UNAUTHORIZED then rethrows (no retry)", async () => {
    const revalidate = vi.fn().mockResolvedValue("rejected");
    const auth = authRevalidator(revalidate);
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(unauthorizedError()),
      requestWithResponseTimeout: uncalledLongPoll(),
    };

    const lease = defaultLease();
    const wrapped = createAuthAwareMessenger(inner, auth);
    await expect(
      wrapped.request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(lease),
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(inner.request).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate a retryable transient UNAUTHORIZED (rethrows for the caller to retry)", async () => {
    const revalidate = vi.fn();
    const auth = authRevalidator(revalidate);
    const original = retryableUnauthorizedError();
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(original),
      requestWithResponseTimeout: uncalledLongPoll(),
    };

    const lease = defaultLease();
    const wrapped = createAuthAwareMessenger(inner, auth);
    const thrown = await wrapped
      .request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(lease),
      })
      .catch((e: unknown) => e);
    // Transient host-side failure - the bearer is fine, so no authn churn.
    expect(thrown).toBe(original);
    expect(revalidate).not.toHaveBeenCalled();
    expect(inner.request).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original UNAUTHORIZED when revalidation itself throws", async () => {
    const original = unauthorizedError();
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(original),
      requestWithResponseTimeout: uncalledLongPoll(),
    };
    const auth = authRevalidator(
      vi
        .fn()
        .mockRejectedValue(
          new Error("RequestContextProvider has been disposed"),
        ),
    );

    const lease = defaultLease();
    const wrapped = createAuthAwareMessenger(inner, auth);
    const thrown = await wrapped
      .request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(lease),
      })
      .catch((e: unknown) => e);
    // The typed UNAUTHORIZED must survive so recovery keyed on `code` still works.
    expect(thrown).toBe(original);
    expect((thrown as HostRpcError).code).toBe("UNAUTHORIZED");
  });

  it("does not revalidate on a non-UNAUTHORIZED error", async () => {
    const revalidate = vi.fn();
    const auth = authRevalidator(revalidate);
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(rpcError()),
      requestWithResponseTimeout: uncalledLongPoll(),
    };

    const lease = defaultLease();
    const wrapped = createAuthAwareMessenger(inner, auth);
    await expect(
      wrapped.request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(lease),
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("CLI mode: retries once after a revalidation that rotated the bearer", async () => {
    const lease = new MutableBearerLease("stale", "u1");
    const request = vi.fn();
    request.mockRejectedValueOnce(unauthorizedError());
    request.mockResolvedValueOnce(undefined);
    const inner: IHostMessenger<Registry> = {
      request,
      requestWithResponseTimeout: uncalledLongPoll(),
    };
    const revalidate = vi
      .fn()
      .mockImplementation((expected: MutableBearerLease) => {
        expect(expected).toBe(lease);
        lease.rotate("fresh");
        return Promise.resolve("rotated");
      });
    const auth = authRevalidator(revalidate);

    const wrapped = createAuthAwareMessenger(inner, auth);
    await wrapped.request(METHOD, PARAMS, {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority: authorityFor(lease),
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(inner.request).toHaveBeenCalledTimes(2);
  });

  it("CLI mode: does not retry when the bearer did not rotate", async () => {
    const lease = new MutableBearerLease("stale", "u1");
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(unauthorizedError()),
      requestWithResponseTimeout: uncalledLongPoll(),
    };
    // refresh failed → lease unchanged, so no retry.
    const revalidate = vi.fn().mockResolvedValue("rejected");
    const auth = authRevalidator(revalidate);

    const wrapped = createAuthAwareMessenger(inner, auth);
    await expect(
      wrapped.request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(lease),
      }),
    ).rejects.toBeInstanceOf(HostRpcError);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(inner.request).toHaveBeenCalledTimes(1);
  });

  it("surfaces a typed superseded result without touching a replacement session", async () => {
    const staleLease = new MutableBearerLease("stale", "u1");
    const replacementLease = new MutableBearerLease("replacement", "u2");
    const inner: IHostMessenger<Registry> = {
      request: vi.fn().mockRejectedValue(unauthorizedError()),
      requestWithResponseTimeout: uncalledLongPoll(),
    };
    const revalidateExpectedBearer = vi
      .fn()
      .mockImplementation((expected: MutableBearerLease) => {
        expect(expected).toBe(staleLease);
        return Promise.resolve("superseded");
      });

    const wrapped = createAuthAwareMessenger(
      inner,
      authRevalidator(revalidateExpectedBearer),
    );
    await expect(
      wrapped.request(METHOD, PARAMS, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: authorityFor(staleLease),
      }),
    ).rejects.toBeInstanceOf(HostAuthoritySupersededError);
    expect(replacementLease.getBearerToken()).toBe("replacement");
    expect(inner.request).toHaveBeenCalledTimes(1);
  });
});

// A pending request answered by a session that went terminally fatal: the same
// class a host refusal arrives as, marked because the request was already sent.
function sessionFatalError(marked: boolean): HostRpcError {
  const error = new HostRpcError({
    code: "UNAUTHORIZED",
    message: "Host access was revoked",
    requestId: "session-fatal",
    method: "",
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "Host access was revoked",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
  if (marked) markMayHaveReachedHost(error);
  return error;
}

function hostRefusal(): HostRpcError {
  return new HostRpcError({
    code: "FORBIDDEN",
    message: "not allowed",
    requestId: "req-retry",
    method: METHOD,
    fatalDetails: null,
  });
}

function preSendRetryable(): RetryableTransportError {
  return new RetryableTransportError({
    code: "RPC_ERROR",
    message: "WebSocket dial timed out",
    requestId: "req-retry",
    method: METHOD,
    fatalDetails: null,
    replaySafetyFromKey: false,
  });
}

function requestOptions(authority: HostRequestAuthority): HostRequestOptions {
  return {
    replayMustBeKeyed: false,
    requiredHostMethodVersion: null,
    idempotencyKey: null,
    authority,
  };
}

function innerFailing(
  ...outcomes: ReadonlyArray<HostRpcError>
): IHostMessenger<Registry> {
  const request = vi.fn();
  for (const outcome of outcomes) request.mockRejectedValueOnce(outcome);
  return { request, requestWithResponseTimeout: uncalledLongPoll() };
}

async function failureOf(
  inner: IHostMessenger<Registry>,
  authority: HostRequestAuthority,
  revalidate: AuthorityBoundAuthRevalidator["revalidateExpectedBearer"],
): Promise<unknown> {
  return createAuthAwareMessenger(inner, authRevalidator(revalidate))
    .request(METHOD, PARAMS, requestOptions(authority))
    .then(
      () => null,
      (reason: unknown) => reason,
    );
}

function abortDispatchOf(thrown: unknown): boolean | null {
  return thrown instanceof HostRequestAbortedError
    ? thrown.mayHaveDispatched
    : null;
}

function rotateTo(
  lease: MutableBearerLease,
): AuthorityBoundAuthRevalidator["revalidateExpectedBearer"] {
  return () => {
    lease.rotate("fresh");
    return Promise.resolve("rotated");
  };
}

describe("createAuthAwareMessenger dispatch provenance", () => {
  it("an abort before recovery says whether the first attempt may have been sent", async () => {
    const outcomes: Array<boolean | null> = [];
    for (const marked of [true, false]) {
      const controller = new AbortController();
      controller.abort();
      const revalidate = vi.fn();
      const thrown = await failureOf(
        innerFailing(sessionFatalError(marked)),
        { ...authorityFor(defaultLease()), abortSignal: controller.signal },
        revalidate,
      );
      expect(revalidate).not.toHaveBeenCalled();
      outcomes.push(abortDispatchOf(thrown));
    }
    expect(outcomes).toEqual([true, false]);
  });

  it("an abort during recovery says whether the first attempt may have been sent", async () => {
    const outcomes: Array<boolean | null> = [];
    for (const marked of [true, false]) {
      const lease = new MutableBearerLease("stale", "u1");
      const controller = new AbortController();
      const inner = innerFailing(sessionFatalError(marked));
      const thrown = await failureOf(
        inner,
        { ...authorityFor(lease), abortSignal: controller.signal },
        () => {
          controller.abort();
          lease.rotate("fresh");
          return Promise.resolve("rotated");
        },
      );
      expect(inner.request).toHaveBeenCalledTimes(1);
      outcomes.push(abortDispatchOf(thrown));
    }
    expect(outcomes).toEqual([true, false]);
  });

  it("a superseded recovery after a sent first attempt is an unattested transport failure", async () => {
    const marked = await failureOf(
      innerFailing(sessionFatalError(true)),
      authorityFor(defaultLease()),
      () => Promise.resolve("superseded"),
    );
    expect(marked).toBeInstanceOf(HostTransportFailureError);
    expect(marked).not.toBeInstanceOf(HostAuthoritySupersededError);
    expect(marked).toMatchObject({ fatalDetails: null });
    expect(mayHaveReachedHost(marked)).toBe(true);

    const unmarked = await failureOf(
      innerFailing(sessionFatalError(false)),
      authorityFor(defaultLease()),
      () => Promise.resolve("superseded"),
    );
    expect(unmarked).toBeInstanceOf(HostAuthoritySupersededError);
  });

  it("a refused retry after a sent first attempt is an unknown outcome carrying the refusal", async () => {
    const refusal = hostRefusal();
    const lease = new MutableBearerLease("stale", "u1");
    const marked = await failureOf(
      innerFailing(sessionFatalError(true), refusal),
      authorityFor(lease),
      rotateTo(lease),
    );
    expect(marked).toBeInstanceOf(RetryEpisodeOutcomeUnknownError);
    expect(marked).toHaveProperty("finalRefusal", refusal);
    expect(mayHaveReachedHost(marked)).toBe(true);

    const unmarkedRefusal = hostRefusal();
    const unmarkedLease = new MutableBearerLease("stale", "u1");
    const unmarked = await failureOf(
      innerFailing(sessionFatalError(false), unmarkedRefusal),
      authorityFor(unmarkedLease),
      rotateTo(unmarkedLease),
    );
    expect(unmarked).toBe(unmarkedRefusal);
  });

  it("a pre-send retry failure after a sent first attempt is restored to the keyed ground", async () => {
    const preSend = preSendRetryable();
    const lease = new MutableBearerLease("stale", "u1");
    const marked = await failureOf(
      innerFailing(sessionFatalError(true), preSend),
      authorityFor(lease),
      rotateTo(lease),
    );
    expect(marked).toBeInstanceOf(RetryableTransportError);
    expect(marked).not.toBe(preSend);
    expect(marked).toMatchObject({
      code: preSend.code,
      message: preSend.message,
      requestId: preSend.requestId,
      replaySafetyFromKey: true,
    });

    const unmarkedPreSend = preSendRetryable();
    const unmarkedLease = new MutableBearerLease("stale", "u1");
    const unmarked = await failureOf(
      innerFailing(sessionFatalError(false), unmarkedPreSend),
      authorityFor(unmarkedLease),
      rotateTo(unmarkedLease),
    );
    expect(unmarked).toBe(unmarkedPreSend);
  });

  it("an unrotated recovery rethrows the same first failure, mark intact", async () => {
    const markedCause = sessionFatalError(true);
    const marked = await failureOf(
      innerFailing(markedCause),
      authorityFor(defaultLease()),
      () => Promise.resolve("rejected"),
    );
    expect(marked).toBe(markedCause);
    expect(mayHaveReachedHost(marked)).toBe(true);

    const unmarkedCause = sessionFatalError(false);
    const unmarked = await failureOf(
      innerFailing(unmarkedCause),
      authorityFor(defaultLease()),
      () => Promise.resolve("rejected"),
    );
    expect(unmarked).toBe(unmarkedCause);
    expect(mayHaveReachedHost(unmarked)).toBe(false);
  });

  it("makes a retrying layer above key its replay once recovery's retry fails before sending", async () => {
    const replayRequirementsFor = async (
      marked: boolean,
    ): Promise<boolean[]> => {
      const lease = new MutableBearerLease("stale", "u1");
      const outcomes = [sessionFatalError(marked), preSendRetryable()];
      const seen: boolean[] = [];
      const request = vi
        .fn()
        .mockImplementation(
          (_method: string, _params: object, options: HostRequestOptions) => {
            const outcome = outcomes[seen.length];
            seen.push(options.replayMustBeKeyed);
            return outcome === undefined
              ? Promise.resolve(undefined)
              : Promise.reject(outcome);
          },
        );
      const composed = createRetryingMessenger(
        createAuthAwareMessenger(
          { request, requestWithResponseTimeout: uncalledLongPoll() },
          authRevalidator(rotateTo(lease)),
        ),
        {
          maxRetries: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          sleep: () => Promise.resolve(),
          random: () => 0,
        },
      );
      await composed.request(
        METHOD,
        PARAMS,
        requestOptions(authorityFor(lease)),
      );
      return seen;
    };

    expect(await replayRequirementsFor(true)).toEqual([false, false, true]);
    expect(await replayRequirementsFor(false)).toEqual([false, false, false]);
  });
});
