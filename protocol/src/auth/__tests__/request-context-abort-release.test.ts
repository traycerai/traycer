import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  CredentialLeaseReleasedError,
  type RequestContext,
} from "../request-context";

/**
 * Pins the one-way relationship between a context's two teardown flags.
 *
 * `buildBearerHeadersFromContext` fails closed on `isAborted` BEFORE it ever
 * asks the lease for a token, and it converts that case into the caller's own
 * error class - not `CredentialLeaseReleasedError`. Host-side teardown
 * suppression (the epic token refresher's released-lease branch) classifies on
 * `CredentialLeaseReleasedError` instead, and `getBearerToken()` does not
 * consult `isAborted` at all. So a context that could be ABORTED while its
 * lease was still live would be a teardown this classification cannot see - it
 * would surface as the WARN that suppression exists to remove.
 *
 * It cannot happen, and these are the three constructions that could produce
 * it if the wiring ever moved. The release listener is registered in the
 * constructor ahead of every abort path, including the already-aborted
 * external signal adopted later in that same constructor, so `isAborted`
 * implies `isReleased` unconditionally.
 *
 * The converse is deliberately NOT symmetric and is pinned here too: a bare
 * `release()` is the ordinary "last client for this epic went away" teardown
 * and leaves the context un-aborted. That asymmetry is exactly why the
 * suppression keys on the lease rather than on the abort flag.
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
      cloudAuthorized: undefined,
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
    // The ordering case: the constructor adopts a pre-aborted signal by
    // aborting itself, which only releases because the listener was already
    // registered. Wiring the external signal first would leave a context born
    // aborted with a live lease.
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
