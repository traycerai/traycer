import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialsMutationStore,
  MutationOutcome,
  MutationResult,
} from "@traycer/protocol/config/credentials-mutation";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import {
  createStoreBackedRevalidator,
  withCommitRetry,
} from "../credentials-store";

// Unit-tests the store-backed revalidator's outcome mapping (§7). The locked
// `rotate` itself (WAL commit, guards, single-spend) is covered in the protocol
// `credentials-mutation` tests; here we pin how each outcome maps onto the
// transport `RevalidateOutcome` and how the lease is (or isn't) rotated.

function pair(token: string): StoredCredentials {
  return {
    token,
    refreshToken: `${token}-refresh`,
    authnBaseUrl: "https://authn.test",
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: "u1", email: "a@b.c", name: "A" },
  };
}

function storeReturning(
  rotate: () => Promise<MutationResult>,
): CredentialsMutationStore {
  return {
    read: vi.fn(),
    rotate: vi.fn(rotate),
    signIn: vi.fn(),
    signOut: vi.fn(),
    updateProfile: vi.fn(),
    guardedSignIn: vi.fn(),
    migrateFirstWrite: vi.fn(),
    hasPendingContinuation: () => false,
    dispose: vi.fn(),
  };
}

function revalidatorFor(
  outcome: MutationOutcome,
  credentials: StoredCredentials | null,
): { revalidate: () => Promise<unknown>; lease: MutableBearerLease } {
  const lease = new MutableBearerLease("old-token", "u1");
  const store = storeReturning(async () => ({ outcome, credentials }));
  const reval = createStoreBackedRevalidator({ store, lease });
  return { revalidate: () => reval.revalidateCurrentContext(), lease };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createStoreBackedRevalidator", () => {
  it("reports rotated and adopts the refreshed token on applied", async () => {
    const { revalidate, lease } = revalidatorFor("applied", pair("fresh"));
    expect(await revalidate()).toBe("rotated");
    expect(lease.getBearerToken()).toBe("fresh");
  });

  it("reports rotated and adopts the sibling/desktop token on superseded", async () => {
    const { revalidate, lease } = revalidatorFor("superseded", pair("sibling"));
    expect(await revalidate()).toBe("rotated");
    expect(lease.getBearerToken()).toBe("sibling");
  });

  it("passes the lease identity + current bearer to rotate, overriding nothing", async () => {
    const lease = new MutableBearerLease("old-token", "u1");
    const store = storeReturning(async () => ({
      outcome: "applied",
      credentials: pair("fresh"),
    }));
    const reval = createStoreBackedRevalidator({ store, lease });
    await reval.revalidateCurrentContext();
    expect(store.rotate).toHaveBeenCalledWith({
      expectedUserId: "u1",
      expectedToken: "old-token",
      refreshTokenOverride: null,
      signal: null,
    });
    // Exactly one rotate per revalidate — the revalidator body never re-spends.
    expect(store.rotate).toHaveBeenCalledTimes(1);
  });

  it("treats commit-failed as rotated - the minted pair is server-issued and live", async () => {
    vi.useFakeTimers();
    const lease = new MutableBearerLease("old-token", "u1");
    // Always commit-failed: withCommitRetry re-drives (bounded) before the
    // revalidator still surfaces the live minted token as rotated.
    const store = storeReturning(async () => ({
      outcome: "commit-failed",
      credentials: pair("minted"),
    }));
    const reval = createStoreBackedRevalidator({ store, lease });
    const pending = reval.revalidateCurrentContext();
    await vi.runAllTimersAsync();
    expect(await pending).toBe("rotated");
    expect(lease.getBearerToken()).toBe("minted");
  });

  it("reports network-error and leaves the bearer untouched on refresh-network", async () => {
    const { revalidate, lease } = revalidatorFor("refresh-network", null);
    expect(await revalidate()).toBe("network-error");
    expect(lease.getBearerToken()).toBe("old-token");
  });

  it("reports network-error on a contended lock (lock-busy)", async () => {
    const { revalidate, lease } = revalidatorFor("lock-busy", null);
    expect(await revalidate()).toBe("network-error");
    expect(lease.getBearerToken()).toBe("old-token");
  });

  it("reports rejected on a dead refresh token, leaving the bearer untouched", async () => {
    const { revalidate, lease } = revalidatorFor("refresh-rejected", null);
    expect(await revalidate()).toBe("rejected");
    expect(lease.getBearerToken()).toBe("old-token");
  });

  it("reports rejected on deleted (concurrent logout)", async () => {
    const { revalidate } = revalidatorFor("deleted", null);
    expect(await revalidate()).toBe("rejected");
  });

  it("reports rejected on tombstoned (a sign-out stands)", async () => {
    const { revalidate } = revalidatorFor("tombstoned", null);
    expect(await revalidate()).toBe("rejected");
  });

  it("reports rejected WITHOUT adopting the foreign token on user-mismatch", async () => {
    const { revalidate, lease } = revalidatorFor(
      "user-mismatch",
      pair("foreign"),
    );
    expect(await revalidate()).toBe("rejected");
    // Never rotate this lease into a different account's session.
    expect(lease.getBearerToken()).toBe("old-token");
  });

  it("never throws: a store fault maps to network-error", async () => {
    const lease = new MutableBearerLease("old-token", "u1");
    const store = storeReturning(async () => {
      throw new Error("disk fault");
    });
    const reval = createStoreBackedRevalidator({ store, lease });
    expect(await reval.revalidateCurrentContext()).toBe("network-error");
    expect(lease.getBearerToken()).toBe("old-token");
  });
});

describe("withCommitRetry", () => {
  it("returns immediately on a non-commit-failed outcome", async () => {
    const op = vi.fn(async (): Promise<MutationResult> => ({
      outcome: "applied",
      credentials: pair("x"),
    }));
    const result = await withCommitRetry(op);
    expect(result.outcome).toBe("applied");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("re-drives a commit-failed continuation until it lands", async () => {
    vi.useFakeTimers();
    const op = vi
      .fn<() => Promise<MutationResult>>()
      .mockResolvedValueOnce({
        outcome: "commit-failed",
        credentials: pair("m"),
      })
      .mockResolvedValueOnce({ outcome: "superseded", credentials: pair("m") });
    const pending = withCommitRetry(op);
    await vi.runAllTimersAsync();
    expect((await pending).outcome).toBe("superseded");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("gives up (still commit-failed) after the bounded retry budget", async () => {
    vi.useFakeTimers();
    const op = vi.fn(async (): Promise<MutationResult> => ({
      outcome: "commit-failed",
      credentials: pair("m"),
    }));
    const pending = withCommitRetry(op);
    await vi.runAllTimersAsync();
    expect((await pending).outcome).toBe("commit-failed");
    // Initial attempt + COMMIT_RETRY_ATTEMPTS (3) re-drives.
    expect(op).toHaveBeenCalledTimes(4);
  });
});
