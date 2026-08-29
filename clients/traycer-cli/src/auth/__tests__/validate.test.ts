import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { validateAuthTokenIdentityAccessOnly } from "../../../../shared/auth/auth-validation";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { config } from "../../config";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import { readCredentials } from "../../store/credentials";
import { validateStoredCredentials } from "../validate";

// Access-only validation (§3/§7): the spend/write goes through the locked store.
// Keep the real (pure) identity projection, stub the network probe, and inject a
// fake store through the store-facing helpers `validate` imports directly. Mocking
// `createCliCredentialsStore` alone would NOT work: `runWithCliStore` calls it
// intra-module, so we mock `runWithCliStore` / `withCommitRetry` instead and steer
// `updateProfile` / `rotate` per-test.
const { fakeStore, updateProfileMock, rotateMock } = vi.hoisted(() => {
  const updateProfileMock = vi.fn();
  const rotateMock = vi.fn();
  return {
    updateProfileMock,
    rotateMock,
    fakeStore: {
      read: vi.fn(),
      rotate: rotateMock,
      signIn: vi.fn(),
      signOut: vi.fn(),
      updateProfile: updateProfileMock,
      guardedSignIn: vi.fn(),
      migrateFirstWrite: vi.fn(),
      hasPendingContinuation: () => false,
      dispose: vi.fn(),
    },
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return { ...actual, validateAuthTokenIdentityAccessOnly: vi.fn() };
});

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// `validateStoredCredentials` emits diagnostic logs. Keep this unit test
// hermetic rather than appending those diagnostics to the live CLI log.
vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
}));

vi.mock("../../store/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials")>();
  return { ...actual, readCredentials: vi.fn() };
});

// Mirrors the real `withCommitRetry`'s retry-on-`commit-failed` shape (see
// `store/credentials-store.ts`) closely enough to exercise it: re-drive `op`
// while the outcome is `commit-failed`, capped, no artificial delay. A flat
// `(op) => op()` would call `store.rotate` at most once per test and could
// never reproduce "a retried continuation lands and resurfaces as
// `superseded`" - exactly the case the fix under test depends on.
const RETRY_CAP = 3;
vi.mock("../../store/credentials-store", () => ({
  createCliCredentialsStore: () => fakeStore,
  runWithCliStore: (fn: (store: unknown) => unknown) => fn(fakeStore),
  withCommitRetry: async (
    op: () => Promise<{ outcome: string }>,
  ): Promise<{ outcome: string }> => {
    let result = await op();
    for (
      let attempt = 0;
      attempt < RETRY_CAP && result.outcome === "commit-failed";
      attempt += 1
    ) {
      result = await op();
    }
    return result;
  },
}));

const identityMock = vi.mocked(validateAuthTokenIdentityAccessOnly);
const readMock = vi.mocked(readCredentials);

const ORIGINAL_ENVIRONMENT = config.environment;
const ORIGINAL_SLOT = process.env[DEV_DESKTOP_SLOT_ENV];

const storedCreds = {
  token: "stored-token",
  refreshToken: "stored-refresh",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "old@traycer.ai", name: "Old" },
};

// Build an AuthenticatedUser with a specific identity, keeping every other
// required field from the canonical fixture.
function userWith(id: string, email: string, name: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id, email, name } };
}

const unchangedUser = userWith("u1", "old@traycer.ai", "Old");
const changedUser = userWith("u1", "ada@traycer.ai", "Ada");

beforeEach(() => {
  vi.clearAllMocks();
  config.environment = "dev";
  process.env[DEV_DESKTOP_SLOT_ENV] = "test-slot";
  readMock.mockResolvedValue(storedCreds);
  // Default: access token valid, profile unchanged (no store write).
  identityMock.mockResolvedValue({ kind: "valid", user: unchangedUser });
  updateProfileMock.mockResolvedValue({
    outcome: "applied",
    credentials: null,
  });
  rotateMock.mockResolvedValue({ outcome: "applied", credentials: null });
});

afterEach(() => {
  config.environment = ORIGINAL_ENVIRONMENT;
  if (ORIGINAL_SLOT === undefined) {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  } else {
    process.env[DEV_DESKTOP_SLOT_ENV] = ORIGINAL_SLOT;
  }
});

describe("validateStoredCredentials", () => {
  it("validates dev-desktop run credentials against the current config authn URL and merges a drifted profile", async () => {
    identityMock.mockResolvedValue({ kind: "valid", user: changedUser });
    updateProfileMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        ...storedCreds,
        user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      },
    });

    const outcome = await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      config.authnBaseUrl,
      "stored-token",
    );
    expect(updateProfileMock).toHaveBeenCalledWith({
      expectedToken: "stored-token",
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      signal: null,
    });
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: {
        user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      },
      effect: "profile-refreshed",
    });
  });

  it("reports effect='none' and keeps the file's own savedAt when the advisory write is superseded (never attempted, not merely unconfirmed)", async () => {
    identityMock.mockResolvedValue({ kind: "valid", user: changedUser });
    // `superseded` always carries the FILE's current pair - never `null` (see
    // `protocol/src/config/credentials-mutation.ts`). A `null` fixture here
    // would be an impossible shape that could hide a real bug in this branch
    // (Codex review, PR #1501): give it a realistic sibling pair - a
    // different token and a later `savedAt` than `storedCreds`, exactly what
    // a sibling's rotation would leave in the file.
    updateProfileMock.mockResolvedValue({
      outcome: "superseded",
      credentials: {
        token: "sibling-token",
        refreshToken: "sibling-refresh",
        savedAt: "2026-03-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });

    const outcome = await validateStoredCredentials();

    expect(outcome).toMatchObject({ kind: "valid", effect: "none" });
    // A write that never ran must not report a save that did not happen -
    // the timestamp has to stay the file's own, not a freshly minted one, and
    // NOT the sibling's pair above (this branch ignores `result.credentials`
    // entirely on a non-`applied` outcome).
    if (outcome.kind === "valid") {
      expect(outcome.credentials.savedAt).toBe(storedCreds.savedAt);
    }
  });

  it("reports effect='profile-refresh-unconfirmed' (not 'none') when the advisory write's commit does not confirm - the bytes may already be on disk", async () => {
    identityMock.mockResolvedValue({ kind: "valid", user: changedUser });
    updateProfileMock.mockResolvedValue({
      outcome: "commit-failed",
      credentials: null,
    });

    const outcome = await validateStoredCredentials();

    // This is the distinction the fix exists for: `superseded` above is a
    // certainty (`none`) because the write never ran; `commit-failed` here
    // cannot claim either way, so it must NOT collapse to the same `none`.
    expect(outcome).toMatchObject({
      kind: "valid",
      effect: "profile-refresh-unconfirmed",
    });
    if (outcome.kind === "valid") {
      expect(outcome.credentials.savedAt).toBe(storedCreds.savedAt);
    }
  });

  it("validates against the configured authn URL outside a run slot too (the file carries no URL)", async () => {
    delete process.env[DEV_DESKTOP_SLOT_ENV];

    await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      config.authnBaseUrl,
      "stored-token",
    );
  });

  it("validates against the configured authn URL in production", async () => {
    config.environment = "production";

    await validateStoredCredentials();

    expect(identityMock).toHaveBeenCalledWith(
      config.authnBaseUrl,
      "stored-token",
    );
  });

  it("does not write when the profile is unchanged", async () => {
    const outcome = await validateStoredCredentials();

    expect(updateProfileMock).not.toHaveBeenCalled();
    expect(rotateMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: { user: { id: "u1", email: "old@traycer.ai", name: "Old" } },
      effect: "none",
    });
  });

  it("returns no-credentials when nothing is stored", async () => {
    readMock.mockResolvedValue(null);
    expect(await validateStoredCredentials()).toEqual({
      kind: "no-credentials",
      effect: "none",
    });
    expect(identityMock).not.toHaveBeenCalled();
  });

  it("returns network-error (without spending) when the access probe is unreachable", async () => {
    identityMock.mockResolvedValue({ kind: "network-error" });
    expect(await validateStoredCredentials()).toEqual({
      kind: "network-error",
      effect: "none",
    });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("refreshes via the locked rotate when the access token is rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "applied",
      credentials: {
        token: "fresh-token",
        refreshToken: "fresh-refresh",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });

    const outcome = await validateStoredCredentials();

    expect(rotateMock).toHaveBeenCalledWith({
      expectedUserId: "u1",
      expectedToken: "stored-token",
      refreshTokenOverride: null,
      signal: null,
    });
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: { token: "fresh-token" },
      effect: "token-rotated",
    });
  });

  it("maps a dead refresh token to rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "refresh-rejected",
      credentials: null,
    });
    // The server refused the refresh token, so nothing was minted and nothing
    // was written - `none` here is a fact, not an assumption.
    expect(await validateStoredCredentials()).toEqual({
      kind: "rejected",
      effect: "none",
    });
  });

  // `refresh-network` is spend-AMBIGUOUS on its own: the refresh POST left the
  // process and the reply was lost, so the server may have rotated. The store
  // keeps its spent-base marker armed for that reason, and `none` is defined
  // here as a certainty - so this outcome must never report it.
  it("maps a lost refresh reply to network-error with an UNCONFIRMED rotation, never 'none'", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "refresh-network",
      credentials: null,
    });
    expect(await validateStoredCredentials()).toEqual({
      kind: "network-error",
      effect: "token-rotation-unconfirmed",
    });
  });

  // The contrast that gives the case above its meaning: these two are guards
  // that return BEFORE the attempt spends anything, so `none` is a fact.
  it.each(["lock-busy", "spend-pending"] as const)(
    "maps %s to network-error with effect='none' - it returns before any spend",
    async (outcome) => {
      identityMock.mockResolvedValue({ kind: "rejected" });
      rotateMock.mockResolvedValue({ outcome, credentials: null });
      expect(await validateStoredCredentials()).toEqual({
        kind: "network-error",
        effect: "none",
      });
    },
  );

  it("maps user-mismatch to rejected WITHOUT reporting the foreign account", async () => {
    // rotate carries the OTHER account's pair on user-mismatch; whoami must NOT
    // surface it as valid. This switch is independent of the host-rpc
    // revalidator's, so its cross-user safety needs its own guard here.
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "user-mismatch",
      credentials: {
        token: "foreign-token",
        refreshToken: "foreign-refresh",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: { id: "u2", email: "other@traycer.ai", name: "Other" },
      },
    });
    expect(await validateStoredCredentials()).toEqual({
      kind: "rejected",
      effect: "none",
    });
  });

  it("adopts a sibling's pair on superseded (valid) and reports effect='none' - nothing was spent or written here", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({
      outcome: "superseded",
      credentials: {
        token: "sibling-token",
        refreshToken: "sibling-refresh",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });
    expect(await validateStoredCredentials()).toMatchObject({
      kind: "valid",
      credentials: { token: "sibling-token" },
      effect: "none",
    });
  });

  it("reports effect='token-rotation-unconfirmed' on a terminal commit-failed - the spend happened but whether it landed is unknowable, not false", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    // Retries are exhausted (every attempt keeps failing the commit), so this
    // is the terminal case: `withCommitRetry` gives up still holding
    // `commit-failed`. `commitMutation` writes the file at its apply step and
    // only then finalizes the sidecar, so a `commit-failed` here does NOT mean
    // the pair never reached disk - it means this process cannot tell.
    rotateMock.mockResolvedValue({
      outcome: "commit-failed",
      credentials: {
        token: "orphaned-token",
        refreshToken: "orphaned-refresh",
        savedAt: "2026-02-01T00:00:00.000Z",
        user: storedCreds.user,
      },
    });
    expect(await validateStoredCredentials()).toMatchObject({
      kind: "valid",
      credentials: { token: "orphaned-token" },
      effect: "token-rotation-unconfirmed",
    });
  });

  it("reports effect='token-rotated' when a retried continuation lands and resurfaces as superseded", async () => {
    // The bug Codex caught: `withCommitRetry` re-drives `rotate` after a
    // `commit-failed`, and a landed continuation resurfaces as `superseded` -
    // identical to the outcome a process that spent NOTHING gets when a
    // sibling rotated first. The effect must come from whether THIS process
    // spent (tracked across the retried attempts), not from the final
    // outcome alone.
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock
      .mockResolvedValueOnce({ outcome: "commit-failed", credentials: null })
      .mockResolvedValueOnce({
        outcome: "superseded",
        credentials: {
          token: "landed-continuation-token",
          refreshToken: "landed-continuation-refresh",
          savedAt: "2026-02-01T00:00:00.000Z",
          user: storedCreds.user,
        },
      });

    const outcome = await validateStoredCredentials();

    expect(rotateMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      kind: "valid",
      credentials: { token: "landed-continuation-token" },
      effect: "token-rotated",
    });
  });

  // A failure can arrive AFTER a spend: the first attempt mints a pair and
  // loses the commit, and by the retry a concurrent logout/account switch has
  // turned the file into something this rotate refuses. The command failed, but
  // it did not fail without consuming the refresh token - and a caller auditing
  // what this invocation touched has no other way to learn that.
  it.each([
    ["deleted", "rejected"],
    ["tombstoned", "rejected"],
    ["user-mismatch", "rejected"],
    ["refresh-network", "network-error"],
  ] as const)(
    "carries the spend into a terminal %s: reports %s with effect='token-rotation-unconfirmed'",
    async (outcome, kind) => {
      identityMock.mockResolvedValue({ kind: "rejected" });
      rotateMock
        .mockResolvedValueOnce({
          outcome: "commit-failed",
          credentials: {
            token: "minted-token",
            refreshToken: "minted-refresh",
            savedAt: "2026-03-01T00:00:00.000Z",
            user: storedCreds.user,
          },
        })
        .mockResolvedValueOnce({ outcome, credentials: null });

      expect(await validateStoredCredentials()).toEqual({
        kind,
        effect: "token-rotation-unconfirmed",
      });
      expect(rotateMock).toHaveBeenCalledTimes(2);
    },
  );

  it("maps a tombstoned file (a sign-out stands) to rejected", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    rotateMock.mockResolvedValue({ outcome: "tombstoned", credentials: null });
    expect(await validateStoredCredentials()).toEqual({
      kind: "rejected",
      effect: "none",
    });
  });
});
