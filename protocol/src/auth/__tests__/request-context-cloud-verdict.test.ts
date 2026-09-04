import { describe, expect, it } from "vitest";
import {
  buildBearerHeadersFromContext,
  createRequestContext,
  type AuthenticatedIdentity,
  type RequestContext,
  type RequestContextOrigin,
} from "@traycer/protocol/auth/request-context";

/**
 * The cloud VERDICT half of a request context - "may this session spend the
 * account's capability" - as distinct from the credential half, "does it hold
 * a usable bearer".
 *
 * The distinction is the whole point: an `unverified` session holds a
 * perfectly well-formed bearer and is deliberately kept alive so the local
 * plane stays readable. Every assertion below therefore uses a context with a
 * NON-EMPTY token, because a test that withheld the token would pass for the
 * wrong reason - the pre-existing empty-token guard - and would keep passing
 * if the verdict check were deleted.
 */
describe("RequestContext cloud verdict", () => {
  const identity: AuthenticatedIdentity = {
    userId: "user-1",
    username: "user-one",
    providerHandle: null,
  };

  class TestCloudUnauthorizedError extends Error {}

  function newContext(input: {
    readonly origin: RequestContextOrigin;
    readonly cloudAuthorized: boolean | undefined;
  }): RequestContext {
    return createRequestContext({
      identity,
      origin: input.origin,
      connectionId: "conn-1",
      operationId: "op-1",
      bearerToken: "a-real-bearer-token",
      externalAbortSignal: undefined,
      cloudAuthorized: input.cloudAuthorized,
    });
  }

  function buildHeaders(ctx: RequestContext): Headers {
    return buildBearerHeadersFromContext(ctx, {
      operationLabel: "Test cloud call",
      errorClass: TestCloudUnauthorizedError,
    });
  }

  it("reads authorized when the peer said nothing", () => {
    // A peer that predates the verdict has no `unverified` state to be in, so
    // it is always authorized IN FACT. Defaulting it closed would fail every
    // cloud call for every existing client.
    const ctx = newContext({ origin: "host-rpc", cloudAuthorized: undefined });
    expect(ctx.cloudAuthorized).toBe(true);
    expect(buildHeaders(ctx).get("Authorization")).toBe(
      "Bearer a-real-bearer-token",
    );
  });

  it("refuses to mint headers for a context with no verdict", () => {
    const ctx = newContext({ origin: "host-rpc", cloudAuthorized: false });
    expect(ctx.cloudAuthorized).toBe(false);
    expect(() => buildHeaders(ctx)).toThrow(TestCloudUnauthorizedError);
  });

  it("refuses BEFORE reading the bearer, not because the bearer is missing", () => {
    // The failure has to be attributable to the verdict. An unauthorized
    // context still holds its token, and the message is what tells an operator
    // which of the two gates refused.
    const ctx = newContext({ origin: "host-rpc", cloudAuthorized: false });
    expect(ctx.credentials.getBearerToken()).toBe("a-real-bearer-token");
    expect(() => buildHeaders(ctx)).toThrow(/holds no cloud verdict/);
  });

  it("applies a withdrawal in place, to the context callers already hold", () => {
    // The reason this is a setter and not a replacement: background workers,
    // timers and in-flight promises captured THIS object. A new context would
    // leave the permissive one in every closure that already has it.
    const ctx = newContext({ origin: "host-stream", cloudAuthorized: true });
    expect(buildHeaders(ctx).get("Authorization")).not.toBeNull();

    ctx.setCloudAuthorized(false);

    expect(ctx.cloudAuthorized).toBe(false);
    expect(() => buildHeaders(ctx)).toThrow(TestCloudUnauthorizedError);
  });

  it("restores spending when the verdict returns", () => {
    const ctx = newContext({ origin: "host-stream", cloudAuthorized: false });
    expect(() => buildHeaders(ctx)).toThrow(TestCloudUnauthorizedError);

    ctx.setCloudAuthorized(true);

    expect(ctx.cloudAuthorized).toBe(true);
    expect(buildHeaders(ctx).get("Authorization")).toBe(
      "Bearer a-real-bearer-token",
    );
  });

  it("keeps a host-background context authorized, and unwithdrawable", () => {
    // The host acting on its own credential rather than for a caller. No GUI
    // session's verdict speaks for that authority, so none may withdraw it -
    // this is the carve-out that lets headless publication keep working while
    // the retained-user fallback is removed.
    const ctx = newContext({
      origin: "host-background",
      cloudAuthorized: false,
    });
    expect(ctx.cloudAuthorized).toBe(true);

    ctx.setCloudAuthorized(false);

    expect(ctx.cloudAuthorized).toBe(true);
    expect(buildHeaders(ctx).get("Authorization")).toBe(
      "Bearer a-real-bearer-token",
    );
  });

  it("still refuses an aborted context that holds a verdict", () => {
    // The two gates are independent; adding the verdict must not displace the
    // abort check that was already there.
    const ctx = newContext({ origin: "host-rpc", cloudAuthorized: true });
    ctx.abort("test");
    expect(() => buildHeaders(ctx)).toThrow(/has been aborted/);
  });
});
