/**
 * Characterization tests for the shared `RequestContext` foundation.
 *
 * These tests pin the auth/identity invariants documented in
 * spec:97ca9f6a / spec:aca3ac84 (§4) BEFORE production services are
 * converted to accept context as their explicit first argument:
 *
 *   1. immutable identity snapshots
 *   2. same-user credential rotation through the credential lease
 *   3. context abort
 *   4. clearing retained bearer material on release/abort
 *   5. no identity switch when credentials rotate
 */
import { describe, expect, it } from "vitest";
import {
  CredentialLeaseReleasedError,
  IdentityMismatchError,
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import {
  createHostRpcContextFixture,
  createHostStreamContextFixture,
  createExtensionContextFixture,
  createRendererContextFixture,
  createRequestContextFixture,
} from "../../test-fixtures/request-context";

describe("RequestContext - immutable identity snapshots", () => {
  it("derives userId/username/providerHandle from the supplied AuthenticatedUser", () => {
    const user = createAuthenticatedUserFixture({});
    const ctx = createRequestContextFixture({ user });

    expect(ctx.identity.userId).toBe(user.user.id);
    expect(ctx.identity.username).toBe(
      user.user.name ?? user.user.providerHandle,
    );
    expect(ctx.identity.providerHandle).toBe(user.user.providerHandle);
  });

  it("captures derived fields by value so post-creation mutation of the source does not leak in", () => {
    const user = createAuthenticatedUserFixture({});
    const ctx = createRequestContextFixture({ user });

    const capturedUserId = ctx.identity.userId;
    const capturedUsername = ctx.identity.username;
    const capturedHandle = ctx.identity.providerHandle;

    (user.user as { id: string }).id = "mutated-id";
    (user.user as { name: string | null }).name = "Mutated Name";
    (user.user as { providerHandle: string }).providerHandle = "mutated-handle";

    expect(ctx.identity.userId).toBe(capturedUserId);
    expect(ctx.identity.username).toBe(capturedUsername);
    expect(ctx.identity.providerHandle).toBe(capturedHandle);
  });

  it("falls back to providerHandle when user.name is null", () => {
    const userWithoutName = createAuthenticatedUserFixture({});
    (userWithoutName.user as { name: string | null }).name = null;

    const identity = identityFromAuthenticatedUser(userWithoutName);

    expect(identity.username).toBe(userWithoutName.user.providerHandle);
  });

  it("prefers user.name over providerHandle when both are present", () => {
    const namedUser = createAuthenticatedUserFixture({});
    (namedUser.user as { name: string | null }).name = "Display Name";

    const identity = identityFromAuthenticatedUser(namedUser);

    expect(identity.username).toBe("Display Name");
  });

  it("freezes the identity snapshot so userId cannot be reassigned", () => {
    const ctx = createRequestContextFixture({});

    expect(Object.isFrozen(ctx.identity)).toBe(true);
    expect(() => {
      (ctx.identity as { userId: string }).userId = "mutated-user";
    }).toThrow();
    expect(ctx.identity.userId).not.toBe("mutated-user");
  });

  it("two contexts for different users do not share mutable identity state", () => {
    const userA = createAuthenticatedUserFixture({});
    (userA.user as { id: string }).id = "user-a";
    const userB = createAuthenticatedUserFixture({});
    (userB.user as { id: string }).id = "user-b";

    const ctxA = createRequestContextFixture({ user: userA });
    const ctxB = createRequestContextFixture({ user: userB });

    expect(ctxA.identity.userId).toBe("user-a");
    expect(ctxB.identity.userId).toBe("user-b");

    ctxA.credentials.rotateBearerToken({
      userId: "user-a",
      bearerToken: "rotated-a",
    });

    expect(ctxA.credentials.getBearerToken()).toBe("rotated-a");
    expect(ctxB.identity.userId).toBe("user-b");
    expect(ctxA.identity).not.toBe(ctxB.identity);
  });
});

describe("RequestContext - same-user credential rotation via credential lease", () => {
  it("returns the initial bearer when no rotation has happened", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });
    expect(ctx.credentials.getBearerToken()).toBe("initial");
  });

  it("replaces bearer material when rotated for the same user id", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "rotated",
    });

    expect(ctx.credentials.getBearerToken()).toBe("rotated");
  });

  it("supports repeated rotations for long-lived sessions", () => {
    const ctx = createRequestContextFixture({ bearerToken: "v1" });

    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "v2",
    });
    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "v3",
    });

    expect(ctx.credentials.getBearerToken()).toBe("v3");
  });

  it("exposes the immutable identity through the credential lease", () => {
    const ctx = createRequestContextFixture({});
    expect(ctx.credentials.identity).toBe(ctx.identity);
  });
});

describe("RequestContext - no identity switch on credential rotation", () => {
  it("rejects rotation when supplied userId does not match the lease identity", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    expect(() =>
      ctx.credentials.rotateBearerToken({
        userId: "different-user",
        bearerToken: "stolen-bearer",
      }),
    ).toThrow(IdentityMismatchError);
  });

  it("preserves existing bearer when a cross-user rotation is rejected", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    expect(() =>
      ctx.credentials.rotateBearerToken({
        userId: "different-user",
        bearerToken: "stolen-bearer",
      }),
    ).toThrow(IdentityMismatchError);
    expect(ctx.credentials.getBearerToken()).toBe("initial");
  });

  it("does not change the immutable identity snapshot after a same-user rotation", () => {
    const ctx = createRequestContextFixture({});
    const identityBefore = ctx.identity;

    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "rotated",
    });

    expect(ctx.identity).toBe(identityBefore);
    expect(ctx.identity.userId).toBe(identityBefore.userId);
  });
});

describe("RequestContext - abort", () => {
  it("starts with isAborted=false and an unsignalled abort signal", () => {
    const ctx = createRequestContextFixture({});
    expect(ctx.isAborted).toBe(false);
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  it("fires abortSignal when abort() is called", () => {
    const ctx = createRequestContextFixture({});
    let aborted = false;
    ctx.abortSignal.addEventListener("abort", () => {
      aborted = true;
    });

    ctx.abort("test-reason");

    expect(aborted).toBe(true);
    expect(ctx.isAborted).toBe(true);
    expect(ctx.abortSignal.aborted).toBe(true);
  });

  it("propagates the abort reason on the signal", () => {
    const ctx = createRequestContextFixture({});
    ctx.abort("user signed out");
    expect(ctx.abortSignal.reason).toBe("user signed out");
  });

  it("is idempotent: a second abort does not re-fire the signal", () => {
    const ctx = createRequestContextFixture({});
    let abortFireCount = 0;
    ctx.abortSignal.addEventListener("abort", () => {
      abortFireCount += 1;
    });

    ctx.abort("first");
    ctx.abort("second");

    expect(abortFireCount).toBe(1);
  });

  it("aborts when an external abort signal is already aborted at construction", () => {
    const external = new AbortController();
    external.abort("external");

    const ctx = createRequestContextFixture({
      externalAbortSignal: external.signal,
    });

    expect(ctx.isAborted).toBe(true);
  });

  it("aborts when an external abort signal fires after construction", () => {
    const external = new AbortController();
    const ctx = createRequestContextFixture({
      externalAbortSignal: external.signal,
    });
    expect(ctx.isAborted).toBe(false);

    external.abort("external-after");

    expect(ctx.isAborted).toBe(true);
  });
});

describe("RequestContext - clearing retained bearer material on release/abort", () => {
  it("release() clears retained bearer so subsequent get throws", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    ctx.release();

    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("abort() clears retained bearer in addition to firing the signal", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    ctx.abort("teardown");

    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("aborted contexts reject credential rotation as well as access", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });
    ctx.abort("teardown");

    expect(() =>
      ctx.credentials.rotateBearerToken({
        userId: ctx.identity.userId,
        bearerToken: "rotated",
      }),
    ).toThrow(CredentialLeaseReleasedError);
  });

  it("external abort clears retained bearer", () => {
    const external = new AbortController();
    const ctx = createRequestContextFixture({
      bearerToken: "initial",
      externalAbortSignal: external.signal,
    });

    external.abort("auth-transition");

    expect(ctx.isAborted).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("release() is idempotent and stays released", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    ctx.release();
    ctx.release();

    expect(ctx.credentials.isReleased).toBe(true);
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("releasing the lease directly also fails closed for getBearerToken", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });

    ctx.credentials.release();

    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
  });

  it("does not fire the abort signal on plain release()", () => {
    const ctx = createRequestContextFixture({ bearerToken: "initial" });
    let aborted = false;
    ctx.abortSignal.addEventListener("abort", () => {
      aborted = true;
    });

    ctx.release();

    expect(aborted).toBe(false);
    expect(ctx.isAborted).toBe(false);
  });
});

describe("RequestContext - origin fixtures", () => {
  it("host RPC fixture sets origin and a connection id", () => {
    const ctx = createHostRpcContextFixture({});
    expect(ctx.origin).toBe("host-rpc");
    expect(ctx.connectionId).toBe("test-rpc-connection");
  });

  it("host stream fixture sets origin and a connection id", () => {
    const ctx = createHostStreamContextFixture({});
    expect(ctx.origin).toBe("host-stream");
    expect(ctx.connectionId).toBe("test-stream-connection");
  });

  it("renderer fixture has no connection id", () => {
    const ctx = createRendererContextFixture({});
    expect(ctx.origin).toBe("renderer");
    expect(ctx.connectionId).toBeUndefined();
  });

  it("extension fixture has no connection id", () => {
    const ctx = createExtensionContextFixture({});
    expect(ctx.origin).toBe("extension");
    expect(ctx.connectionId).toBeUndefined();
  });

  it("test fixture default origin is 'test'", () => {
    const ctx = createRequestContextFixture({});
    expect(ctx.origin).toBe("test");
  });

  it("createRequestContext directly accepts an external abort + operation id", () => {
    const external = new AbortController();
    const identity = identityFromAuthenticatedUser(
      createAuthenticatedUserFixture({}),
    );

    const ctx = createRequestContext({
      identity,
      bearerToken: "bearer",
      origin: "host-stream",
      connectionId: "conn-1",
      operationId: "op-1",
      externalAbortSignal: external.signal,
    });

    expect(ctx.connectionId).toBe("conn-1");
    expect(ctx.operationId).toBe("op-1");
    expect(ctx.isAborted).toBe(false);
    external.abort("close");
    expect(ctx.isAborted).toBe(true);
  });
});
