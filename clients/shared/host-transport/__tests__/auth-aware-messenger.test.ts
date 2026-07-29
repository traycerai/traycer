import { describe, expect, it, vi } from "vitest";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import {
  HostAuthoritySupersededError,
  HostRpcError,
  type HostRequestAuthority,
  type IHostMessenger,
} from "../host-messenger";
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
    await wrapped.request(METHOD, PARAMS, authorityFor(lease));
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
      wrapped.request(METHOD, PARAMS, authorityFor(lease)),
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
      .request(METHOD, PARAMS, authorityFor(lease))
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
      .request(METHOD, PARAMS, authorityFor(lease))
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
      wrapped.request(METHOD, PARAMS, authorityFor(lease)),
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
    await wrapped.request(METHOD, PARAMS, authorityFor(lease));
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
      wrapped.request(METHOD, PARAMS, authorityFor(lease)),
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
      wrapped.request(METHOD, PARAMS, authorityFor(staleLease)),
    ).rejects.toBeInstanceOf(HostAuthoritySupersededError);
    expect(replacementLease.getBearerToken()).toBe("replacement");
    expect(inner.request).toHaveBeenCalledTimes(1);
  });
});
