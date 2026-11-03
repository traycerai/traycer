import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readVerifiedProfile,
  useVerifiedProfileCacheStore,
} from "@/stores/auth/verified-profile-cache-store";

/**
 * A relaunch restores the session from the credentials file, which carries no
 * picture. The service paints the one it last verified for that account, and
 * keeps that cache current with each verdict.
 */

const NEGOTIATED_URL = "http://localhost:5005/api/v3/user/negotiated";
const OLD_PICTURE = "https://example.com/old.png";
const NEW_PICTURE = "https://example.com/new.png";

interface Authn {
  /** What authn reports for user-1, or null while it is unreachable. */
  answer: { readonly name: string; readonly avatarUrl: string | null } | null;
}

let authn: Authn;
const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

function userPayload(
  userId: string,
  name: string,
  avatarUrl: string | null,
): unknown {
  return {
    user: {
      id: userId,
      name,
      providerId: `gh-${userId}`,
      providerHandle: userId,
      providerType: "GITHUB",
      email: `${userId}@example.com`,
      avatarUrl,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: `sub-${userId}`,
      userID: userId,
      orgID: null,
      teamID: null,
      customerId: `cus-${userId}`,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "FREE",
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  };
}

/** Authn answers the negotiated user read as `authn.answer` says, else 500. */
function answerFromAuthn(input: unknown): Promise<Response> {
  const url = typeof input === "string" ? input : String(input);
  if (url !== NEGOTIATED_URL || authn.answer === null) {
    return Promise.resolve(new Response(null, { status: 500 }));
  }
  return Promise.resolve(
    new Response(
      JSON.stringify(
        userPayload("user-1", authn.answer.name, authn.answer.avatarUrl),
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-traycer-user-record-version": "2.0",
        },
      },
    ),
  );
}

async function storeCredentials(
  host: MockRunnerHost,
  userId: string,
  fileName: string,
): Promise<void> {
  await host.tokenStore.signIn(
    { token: `${userId}-token`, refreshToken: `${userId}-refresh` },
    { id: userId, email: `${userId}@example.com`, name: fileName },
  );
}

/** Starts the service and lets its startup validation's retry budget elapse. */
async function start(service: AuthService): Promise<void> {
  const started = service.start();
  for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
    await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
  }
  await started;
}

function rememberPicture(userId: string, avatarUrl: string | null): void {
  useVerifiedProfileCacheStore
    .getState()
    .remember(userId, { avatarUrl, displayName: "Cached Name" });
}

beforeEach(() => {
  vi.useFakeTimers();
  authn = { answer: null };
  vi.stubGlobal("fetch", answerFromAuthn);
  useAuthStore.getState().setSignedOut();
  useVerifiedProfileCacheStore.setState({ profilesByUserId: {} });
});

afterEach(() => {
  while (trackedServices.length > 0) trackedServices.pop()?.dispose();
  useAuthStore.getState().setSignedOut();
  useVerifiedProfileCacheStore.setState({ profilesByUserId: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AuthService restored session profile", () => {
  describe("while authn cannot be reached", () => {
    it("paints the picture last verified for the restored account", async () => {
      const { service, host } = makeService();
      rememberPicture("user-1", OLD_PICTURE);
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(useAuthStore.getState().status).toBe("unverified");
      expect(useAuthStore.getState().profile?.avatarUrl).toBe(OLD_PICTURE);
    });

    it("paints no picture for an account never verified here", async () => {
      const { service, host } = makeService();
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(useAuthStore.getState().status).toBe("unverified");
      expect(useAuthStore.getState().profile?.avatarUrl).toBeNull();
    });

    it("does not fill from another account's cached picture", async () => {
      const { service, host } = makeService();
      rememberPicture("user-2", OLD_PICTURE);
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(useAuthStore.getState().profile?.avatarUrl).toBeNull();
    });

    it("takes the cached display name when the credentials file has none", async () => {
      const { service, host } = makeService();
      rememberPicture("user-1", OLD_PICTURE);
      await storeCredentials(host, "user-1", "");

      await start(service);

      expect(useAuthStore.getState().profile?.userName).toBe("Cached Name");
    });

    it("keeps the credentials file's name over the cached one", async () => {
      const { service, host } = makeService();
      rememberPicture("user-1", OLD_PICTURE);
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(useAuthStore.getState().profile?.userName).toBe("File Name");
    });

    it("replaces the cached picture, and the cache entry, when authn answers with another", async () => {
      const { service, host } = makeService();
      rememberPicture("user-1", OLD_PICTURE);
      await storeCredentials(host, "user-1", "File Name");
      await start(service);
      expect(useAuthStore.getState().profile?.avatarUrl).toBe(OLD_PICTURE);

      authn.answer = { name: "Verified Name", avatarUrl: NEW_PICTURE };
      await vi.advanceTimersByTimeAsync(1_000);

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(useAuthStore.getState().profile?.avatarUrl).toBe(NEW_PICTURE);
      expect(readVerifiedProfile("user-1")).toEqual({
        avatarUrl: NEW_PICTURE,
        displayName: "Verified Name",
      });
    });

    it("keeps the picture when a verified session is demoted to unverified", async () => {
      const { service, host } = makeService();
      authn.answer = { name: "Verified Name", avatarUrl: NEW_PICTURE };
      await storeCredentials(host, "user-1", "File Name");
      await start(service);
      expect(useAuthStore.getState().status).toBe("signed-in");

      vi.stubGlobal("fetch", (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        const refused =
          url.includes("/api/v3/user") || url.includes("/auth/refresh");
        return Promise.resolve(
          new Response(null, { status: refused ? 401 : 500 }),
        );
      });
      const outcome = await service.revalidateCurrentContext();

      expect(outcome?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("unverified");
      expect(useAuthStore.getState().profile?.avatarUrl).toBe(NEW_PICTURE);
    });
  });

  describe("when authn answers at launch", () => {
    it("remembers the verified picture and name", async () => {
      const { service, host } = makeService();
      authn.answer = { name: "Verified Name", avatarUrl: NEW_PICTURE };
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(readVerifiedProfile("user-1")).toEqual({
        avatarUrl: NEW_PICTURE,
        displayName: "Verified Name",
      });
    });

    it("overwrites an older cached picture with none when the account has none now", async () => {
      const { service, host } = makeService();
      rememberPicture("user-1", OLD_PICTURE);
      authn.answer = { name: "Verified Name", avatarUrl: null };
      await storeCredentials(host, "user-1", "File Name");

      await start(service);

      expect(readVerifiedProfile("user-1")?.avatarUrl).toBeNull();
      expect(useAuthStore.getState().profile?.avatarUrl).toBeNull();
    });
  });

  describe("signing out", () => {
    it("forgets that account's picture and leaves another account's alone", async () => {
      const { service, host } = makeService();
      authn.answer = { name: "Verified Name", avatarUrl: NEW_PICTURE };
      rememberPicture("user-2", OLD_PICTURE);
      await storeCredentials(host, "user-1", "File Name");
      await start(service);
      expect(readVerifiedProfile("user-1")).not.toBeNull();

      await service.signOut();

      expect(readVerifiedProfile("user-1")).toBeNull();
      expect(readVerifiedProfile("user-2")?.avatarUrl).toBe(OLD_PICTURE);
    });
  });
});
