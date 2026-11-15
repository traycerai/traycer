import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type {
  EnvironmentMoveAcceptance,
  EnvironmentMoveStageResponse,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentMoveStartMutation } from "@/hooks/environment/use-environment-move-start-mutation";
import { useRemoteAccessTurnOnMutation } from "@/hooks/environment/use-remote-access-turn-on-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";

interface PressTestAuth {
  getIdentityGeneration(): number;
  isIdentityCurrent(generation: number): boolean;
  environmentCloud(): EnvironmentCloud;
}

const binding = vi.hoisted((): { current: { auth: PressTestAuth } | null } => ({
  current: null,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => binding.current,
}));

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "environment-press-test";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const ACCEPTANCE_ID = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

let generation: { value: number } = { value: 1 };
let stageRequests: unknown[] = [];
let startRequests: unknown[] = [];
let environmentRequests: string[] = [];

afterEach(() => {
  cleanup();
  binding.current = null;
  generation = { value: 1 };
  stageRequests = [];
  startRequests = [];
  environmentRequests = [];
  useAuthStore.setState({ status: "signed-out" });
});

function authForCurrentGeneration(): PressTestAuth {
  return {
    getIdentityGeneration: () => generation.value,
    isIdentityCurrent: (pressedAt) => pressedAt === generation.value,
    environmentCloud: () => {
      const pressedAt = generation.value;
      return {
        authnBaseUrl: "https://authn.example.test/",
        bearer: { kind: "cloud", getBearerToken: () => "synthetic-token" },
        transport: async (request) => {
          environmentRequests.push(new URL(request.url).pathname);
          return {
            status: 200,
            text: JSON.stringify(
              new URL(request.url).pathname.endsWith("move-acceptances")
                ? { acceptanceId: ACCEPTANCE_ID }
                : { remoteAccess: { enabled: true, epoch: 1 } },
            ),
          };
        },
        onOriginSignIn: () => pressedAt === generation.value,
      };
    },
  };
}

function wrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return (props) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

const ACCEPTANCE: EnvironmentMoveAcceptance = {
  hostId: HOST_ID,
  target: { kind: "personal", environmentId: ENVIRONMENT_ID },
  planHash: HASH,
  keyChoices: [],
  personal: null,
};

function stagedResponse(request: {
  readonly target: EnvironmentMoveAcceptance["target"];
  readonly keyChoices: EnvironmentMoveAcceptance["keyChoices"];
}): EnvironmentMoveStageResponse {
  return {
    evidence: {
      attemptId: ATTEMPT_ID,
      planHash: HASH,
      planRevision: 1,
      hostVersion: "1.0.0",
      itemCount: 0,
      keyChoices: request.keyChoices,
      sourceHostId: HOST_ID,
      sharingGeneration: 1,
      targetKind: "personal",
      environmentId: request.target.environmentId,
      disclosureVersion: 1,
    },
    authorization: { manifestHash: HASH },
  };
}

describe("the press-captured environment mutations", () => {
  it("does not stage a move after its pressed sign-in ends", async () => {
    useAuthStore.setState({ status: "signed-in" });
    binding.current = { auth: authForCurrentGeneration() };
    const fixture = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.move.stage": (request) => {
          stageRequests.push(request);
          return stagedResponse(request);
        },
        "environment.move.start": (request) => {
          startRequests.push(request);
          return {
            state: "running",
            attemptId: ATTEMPT_ID,
            acceptanceId: ACCEPTANCE_ID,
          };
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useEnvironmentMoveStartMutation(fixture.client, null),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await expect(result.current.mutateAsync(ACCEPTANCE)).resolves.toMatchObject({
        kind: "started",
      });
    });
    expect(stageRequests).toHaveLength(1);
    expect(startRequests).toHaveLength(1);
    expect(environmentRequests).toHaveLength(1);

    await act(async () => {
      const pending = result.current.mutateAsync(ACCEPTANCE);
      generation.value += 1;
      await expect(pending).resolves.toEqual({ kind: "sign_in_changed" });
    });
    expect(stageRequests).toHaveLength(1);
    expect(startRequests).toHaveLength(1);
    expect(environmentRequests).toHaveLength(1);
  });

  it("does not send Remote access after its pressed sign-in ends", async () => {
    useAuthStore.setState({ status: "signed-in" });
    binding.current = { auth: authForCurrentGeneration() };
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useRemoteAccessTurnOnMutation(null, HOST_ID),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toBeUndefined();
    });
    expect(environmentRequests).toEqual([`/api/v3/hosts/${HOST_ID}/remote-access`]);

    await act(async () => {
      const pending = result.current.mutateAsync();
      generation.value += 1;
      await expect(pending).resolves.toBeUndefined();
    });
    expect(environmentRequests).toEqual([`/api/v3/hosts/${HOST_ID}/remote-access`]);
  });
});
