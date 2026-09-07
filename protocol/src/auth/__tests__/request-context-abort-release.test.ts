import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  CredentialLeaseReleasedError,
  type RequestContext,
} from "../request-context";

/**
 * `isAborted` implies `isReleased`. The converse is not true: bare `release()` leaves the context un-aborted; suppression keys on the lease, not abort.
 */
describe("request context: abort always releases the credential lease", () => {
  const identity = {
    userId: "user-1",
    username: "user-one",
    providerHandle: null,
  };

  function newContext(
    externalAbortSignal: AbortSignal | undefined,
  ): RequestContext {
    return createRequestContext({
      identity,
      origin: "host-rpc",
      connectionId: "conn-1",
      operationId: "op-1",
      bearerToken: "bearer-token",
      externalAbortSignal,
    });
  }

  it("releases the lease when the context aborts itself", () => {
    const ctx = newContext(undefined);
    expect(ctx.credentials.getBearerToken()).toBe("bearer-token");

    ctx.abort("client went away");

    expect(ctx.isAborted).toBe(true);
    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("releases the lease when an external signal aborts after construction", () => {
    const external = new AbortController();
    const ctx = newContext(external.signal);
    expect(ctx.credentials.getBearerToken()).toBe("bearer-token");

    external.abort("stream connection closed");

    expect(ctx.isAborted).toBe(true);
    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("releases the lease when the external signal was ALREADY aborted at construction", () => {
    // The ordering case: the constructor adopts a pre-aborted signal by aborting itself, which only releases because the listener was already registered.
    const external = new AbortController();
    external.abort("closed before the context existed");

    const ctx = newContext(external.signal);

    expect(ctx.isAborted).toBe(true);
    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("does NOT abort when the lease is released on its own", () => {
    const ctx = newContext(undefined);

    ctx.release();

    expect(ctx.credentials.isReleased).toBe(true);
    expect(ctx.isAborted).toBe(false);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });
});
