/**
 * AuthService cloud calls use a verified session before reaching their cloud
 * request boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import type {
  EnvironmentProvidersFetchResult,
  SandboxGrantsFetchResult,
  TeamEnvironmentFetchResult,
  SecretRequestDecideFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-secrets";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

// The identity route the sign-in validation hits; every fixture answers it.
const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const BEARER = "user-token";
const providerKeySetBodySchema = z.strictObject({
  key: z.string(),
  onlyIfAbsent: z.literal(false),
});

const SUMMARY_RESULT: SandboxGrantsFetchResult = {
  kind: "ok",
  summary: {
    version: 4,
    grants: [
      {
        secretName: "DB_PASSWORD",
        kind: "password",
        protocol: "mysql",
        source: "approved",
        connectorName: null,
        rotation: null,
        routes: [
          {
            route: "route-1",
            destination: "db.example.com",
            port: 3306,
            unready: null,
          },
        ],
      },
    ],
    github: null,
  },
};

function installFetch(
  handler: (input: unknown, init: RequestInit | undefined) => Promise<Response>,
): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function okWithProfile(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        user: {
          id: "user-1",
          name: "Test User",
          providerId: "gh-1",
          providerHandle: "test-user",
          providerType: "GITHUB",
          email: "test@example.com",
          avatarUrl: null,
          activatedAt: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          lastSeenAt: null,
          privacyMode: false,
          isLearningEnabled: true,
        },
        userSubscription: {
          id: "sub-1",
          userID: "user-1",
          orgID: null,
          teamID: null,
          customerId: "cus-1",
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
      }),
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

async function signedInService(): Promise<{
  service: AuthService;
  host: MockRunnerHost;
}> {
  const made = makeService();
  await made.host.tokenStore.signIn(
    { token: BEARER, refreshToken: "user-token-refresh" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  await made.service.start();
  return made;
}

describe("AuthService cloud calls", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch((input) => {
      if (String(input) === VALIDATION_URL) return okWithProfile();
      return Promise.resolve(new Response(null, { status: 500 }));
    });
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      trackedServices.pop()?.dispose();
    }
    useAuthStore.getState().setSignedOut();
    restoreFetch();
    vi.restoreAllMocks();
  });

  describe("signed out", () => {
    it("getSandboxGrants answers unauthorized and never reaches the runner host", async () => {
      const { service, host } = makeService();
      const getSandboxGrants = vi.spyOn(host, "getSandboxGrants");

      await expect(
        service.getSandboxGrants("env-1", "host-1"),
      ).resolves.toEqual({
        kind: "unauthorized",
      });

      expect(getSandboxGrants).not.toHaveBeenCalled();
    });

    it("decideSecretRequest answers unauthorized and never reaches the runner host", async () => {
      const { service, host } = makeService();
      const decideSecretRequest = vi.spyOn(host, "decideSecretRequest");

      await expect(
        service.decideSecretRequest("env-1", "req-1", "approve"),
      ).resolves.toEqual({ kind: "unauthorized" });

      expect(decideSecretRequest).not.toHaveBeenCalled();
    });
  });

  describe("signed out, environments", () => {
    it("getTeamEnvironment answers unauthorized and never reaches the runner host", async () => {
      const { service, host } = makeService();
      const getTeamEnvironment = vi.spyOn(host, "getTeamEnvironment");

      await expect(service.getTeamEnvironment("team-1")).resolves.toEqual({
        kind: "unauthorized",
      });

      expect(getTeamEnvironment).not.toHaveBeenCalled();
    });

    it("getEnvironmentProviders answers unauthorized and never reaches the runner host", async () => {
      const { service, host } = makeService();
      const getEnvironmentProviders = vi.spyOn(host, "getEnvironmentProviders");

      await expect(service.getEnvironmentProviders("env-1")).resolves.toEqual({
        kind: "unauthorized",
      });

      expect(getEnvironmentProviders).not.toHaveBeenCalled();
    });
  });

  describe("signed in, environments", () => {
    it("getTeamEnvironment hands the runner host the bearer and the team and returns its result", async () => {
      const { service, host } = await signedInService();
      const result: TeamEnvironmentFetchResult = {
        kind: "ok",
        environmentId: "env-acme",
      };
      const getTeamEnvironment = vi
        .spyOn(host, "getTeamEnvironment")
        .mockResolvedValue(result);

      await expect(service.getTeamEnvironment("team-1")).resolves.toBe(result);

      expect(getTeamEnvironment).toHaveBeenCalledTimes(1);
      expect(getTeamEnvironment).toHaveBeenCalledWith(BEARER, "team-1");
    });

    it("getEnvironmentProviders hands the runner host the bearer and the environment and returns its result", async () => {
      const { service, host } = await signedInService();
      const result: EnvironmentProvidersFetchResult = {
        kind: "ok",
        counts: { providerSecretCount: 1, connectedPlanCount: 2 },
      };
      const getEnvironmentProviders = vi
        .spyOn(host, "getEnvironmentProviders")
        .mockResolvedValue(result);

      await expect(service.getEnvironmentProviders("env-1")).resolves.toBe(
        result,
      );

      expect(getEnvironmentProviders).toHaveBeenCalledTimes(1);
      expect(getEnvironmentProviders).toHaveBeenCalledWith(BEARER, "env-1");
    });
  });

  describe("signed in", () => {
    it("uses the verified service bearer for its own provider-record request", async () => {
      const { service } = await signedInService();
      restoreFetch();
      const directRequests: Array<{
        readonly url: string;
        readonly authorized: boolean;
        readonly setBody: boolean;
      }> = [];
      restoreFetch = installFetch((input, init) => {
        const url = String(input);
        if (url.includes("/provider-keys/")) {
          const bodyText = init?.body;
          const parsedBody: unknown =
            typeof bodyText === "string" ? JSON.parse(bodyText) : null;
          const body = providerKeySetBodySchema.safeParse(parsedBody);
          directRequests.push({
            url,
            authorized:
              new Headers(init?.headers).get("Authorization") ===
              `Bearer ${BEARER}`,
            setBody: body.success,
          });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                profileId: "profile-synthetic",
                providerId: "cursor",
                state: "live",
                signInNumber: "3",
                recordRevision: "5",
                personIntentNumber: "2",
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 500 }));
      });

      const result = await service.changeProviderKeyRecord(
        "env-synthetic",
        "cursor",
        { action: "set", apiKey: "synthetic-provider-key" },
        null,
      );

      expect(result.kind === "record").toBe(true);
      const [directRequest] = directRequests;
      expect(
        directRequests.length === 1 &&
          directRequest.authorized &&
          directRequest.setBody,
      ).toBe(true);
      expect(
        directRequest.url.includes(
          "/environments/env-synthetic/provider-keys/cursor",
        ),
      ).toBe(true);
    });

    it("refuses the provider-record request while the retained session is unverified", async () => {
      vi.useFakeTimers();
      const { service, host } = makeService();
      await host.tokenStore.signIn(
        { token: BEARER, refreshToken: "user-token-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        Promise.reject(new TypeError("offline")),
      );
      const starting = service.start();
      for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
        await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
      }
      await starting;
      expect(useAuthStore.getState().status).toBe("unverified");

      restoreFetch();
      let providerRecordRequests = 0;
      restoreFetch = installFetch((input) => {
        if (String(input).includes("/provider-keys/"))
          providerRecordRequests += 1;
        return Promise.reject(new TypeError("offline"));
      });
      const result = await service.changeProviderKeyRecord(
        "env-synthetic",
        "cursor",
        { action: "clear" },
        null,
      );

      expect(result.kind === "refused" && result.code === "UNAUTHORIZED").toBe(
        true,
      );
      expect(providerRecordRequests).toBe(0);
    });

    it("getSandboxGrants hands the runner host the bearer and the host id and returns its result", async () => {
      const { service, host } = await signedInService();
      const getSandboxGrants = vi
        .spyOn(host, "getSandboxGrants")
        .mockResolvedValue(SUMMARY_RESULT);

      await expect(service.getSandboxGrants("env-1", "host-1")).resolves.toBe(
        SUMMARY_RESULT,
      );

      expect(getSandboxGrants).toHaveBeenCalledTimes(1);
      expect(getSandboxGrants).toHaveBeenCalledWith(BEARER, "env-1", "host-1");
    });

    it("getSandboxGrants returns a failure the runner host reports unchanged", async () => {
      const { service, host } = await signedInService();
      const failure: SandboxGrantsFetchResult = { kind: "not-found" };
      vi.spyOn(host, "getSandboxGrants").mockResolvedValue(failure);

      await expect(service.getSandboxGrants("env-1", "host-1")).resolves.toBe(
        failure,
      );
    });

    it("decideSecretRequest hands the runner host the bearer, the request and the decision and returns its result", async () => {
      const { service, host } = await signedInService();
      const result: SecretRequestDecideFetchResult = {
        kind: "ok",
        status: "approved",
        decidedBy: "Ana",
      };
      const decideSecretRequest = vi
        .spyOn(host, "decideSecretRequest")
        .mockResolvedValue(result);

      await expect(
        service.decideSecretRequest("env-1", "req-1", "approve"),
      ).resolves.toBe(result);

      expect(decideSecretRequest).toHaveBeenCalledTimes(1);
      expect(decideSecretRequest).toHaveBeenCalledWith(
        BEARER,
        "env-1",
        "req-1",
        "approve",
      );
    });

    it("hands the runner host a null environment as null", async () => {
      const { service, host } = await signedInService();
      const getSandboxGrants = vi
        .spyOn(host, "getSandboxGrants")
        .mockResolvedValue(SUMMARY_RESULT);
      const decideSecretRequest = vi
        .spyOn(host, "decideSecretRequest")
        .mockResolvedValue({ kind: "not-found" });

      await service.getSandboxGrants(null, "host-1");
      await service.decideSecretRequest(null, "req-1", "decline");

      expect(getSandboxGrants).toHaveBeenCalledWith(BEARER, null, "host-1");
      expect(decideSecretRequest).toHaveBeenCalledWith(
        BEARER,
        null,
        "req-1",
        "decline",
      );
    });

    it("decideSecretRequest returns a conflict the runner host reports unchanged", async () => {
      const { service, host } = await signedInService();
      const conflict: SecretRequestDecideFetchResult = {
        kind: "conflict",
        status: "pending",
        code: "secret_required",
        decidedBy: null,
      };
      vi.spyOn(host, "decideSecretRequest").mockResolvedValue(conflict);

      await expect(
        service.decideSecretRequest("env-1", "req-1", "approve_default"),
      ).resolves.toBe(conflict);
    });
  });
});
