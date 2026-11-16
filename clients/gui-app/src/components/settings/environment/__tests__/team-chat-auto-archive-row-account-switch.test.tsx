/**
 * A team's auto-archive saves queue in order, so a save can be sent well after
 * the person chose it. The bearer is read when it is sent, from the one
 * `AuthService` that outlives an account switch: this pins that a save queued
 * under account A is never sent with account B's token, and that one queued
 * across A's own token refresh is still sent, with the refreshed token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const TEAM_URL =
  "https://server.test.invalid/api/traycer/chat-auto-archive/teams/team-a";

const bound = vi.hoisted((): { auth: AuthService | null } => ({
  auth: null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({ auth: bound.auth }),
}));

const ACME: EnvironmentDescriptorV11 = {
  environmentId: "env-a",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: null,
};

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: { environments: [ACME] } }),
}));

import { TeamChatAutoArchiveRow } from "@/components/settings/environment/team-chat-auto-archive-row";

interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

function installFetch(
  handler: (input: unknown, init: FetchInit | undefined) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
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

/** The identity route's answer for the account the bearer belongs to. */
function profileFor(userId: string): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: userId,
        name: userId,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
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
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

function savedRecord(enabled: boolean): Response {
  return new Response(
    JSON.stringify({
      enabled,
      includeUserCreated: false,
      idleSeconds: 3600,
      updatedAt: 1,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const services: AuthService[] = [];
let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  useAuthStore.getState().setSignedOut();
});

afterEach(() => {
  cleanup();
  while (services.length > 0) services.pop()?.dispose();
  useAuthStore.getState().setSignedOut();
  restoreFetch();
  bound.auth = null;
});

interface MountedRow {
  readonly host: MockRunnerHost;
  readonly service: AuthService;
  readonly queryClient: QueryClient;
  /** The Authorization header of every PUT, in the order sent. */
  readonly puts: string[];
  /** Answers the first PUT, which is held until then. */
  readonly releaseFirstPut: () => void;
}

/**
 * Account A signed in on a real AuthService, the row mounted and read, and
 * A's two saves made: on (held at the server), then off, queued behind it.
 */
async function mountWithQueuedSave(): Promise<MountedRow> {
  const puts: string[] = [];
  const firstPut: { release: (() => void) | null } = { release: null };
  restoreFetch = installFetch((input, init) => {
    const url = String(input);
    const authorization = init?.headers?.["Authorization"] ?? "";
    if (url === VALIDATION_URL)
      return Promise.resolve(
        profileFor(authorization === "Bearer token-b" ? "user-b" : "user-a"),
      );
    if (url === TEAM_URL && init?.method === "PUT") {
      puts.push(authorization);
      if (puts.length === 1)
        return new Promise<Response>((resolve) => {
          firstPut.release = () => resolve(savedRecord(true));
        });
      return Promise.resolve(savedRecord(false));
    }
    if (url === TEAM_URL)
      return Promise.resolve(
        new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return Promise.resolve(new Response(null, { status: 500 }));
  });
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
  services.push(service);
  await host.tokenStore.signIn(
    { token: "token-a", refreshToken: "token-a-refresh" },
    { id: "user-a", email: "user-a@example.com", name: "user-a" },
  );
  await service.start();
  bound.auth = service;

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <TeamChatAutoArchiveRow environmentId="env-a" role={ACME.effectiveRole} />,
    {
      wrapper: (props: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      ),
    },
  );
  const mainSwitch = (): HTMLElement =>
    screen.getByRole("switch", {
      name: "Archive idle agents automatically",
    });
  await waitFor(() =>
    expect(mainSwitch().hasAttribute("disabled")).toBe(false),
  );

  await userEvent.click(mainSwitch());
  await waitFor(() => expect(puts).toEqual(["Bearer token-a"]));
  await userEvent.click(mainSwitch());
  return {
    host,
    service,
    queryClient,
    puts,
    releaseFirstPut: () => firstPut.release?.(),
  };
}

function mutationStatuses(queryClient: QueryClient): string[] {
  return queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.status);
}

describe("TeamChatAutoArchiveRow across a sign-in change", () => {
  it("never sends a save queued under one account with the next account's token", async () => {
    const row = await mountWithQueuedSave();

    await row.host.tokenStore.signIn(
      { token: "token-b", refreshToken: "token-b-refresh" },
      { id: "user-b", email: "user-b@example.com", name: "user-b" },
    );
    await vi.waitFor(() => {
      expect(row.service.getCurrentSessionSnapshot().token).toBe("token-b");
    });

    row.releaseFirstPut();
    await waitFor(() =>
      expect(mutationStatuses(row.queryClient)).toEqual(["success", "error"]),
    );
    expect(row.puts).toEqual(["Bearer token-a"]);
  });

  it("sends a save queued across the same account's token refresh, with the refreshed token", async () => {
    const row = await mountWithQueuedSave();
    const credentialGeneration = row.service.getCredentialGeneration();

    await row.host.tokenStore.signIn(
      { token: "token-a2", refreshToken: "token-a2-refresh" },
      { id: "user-a", email: "user-a@example.com", name: "user-a" },
    );
    await vi.waitFor(() => {
      expect(row.service.getCurrentSessionSnapshot().token).toBe("token-a2");
    });
    expect(row.service.getCredentialGeneration()).toBeGreaterThan(
      credentialGeneration,
    );

    row.releaseFirstPut();
    await waitFor(() =>
      expect(mutationStatuses(row.queryClient)).toEqual(["success", "success"]),
    );
    expect(row.puts).toEqual(["Bearer token-a", "Bearer token-a2"]);
  });
});
