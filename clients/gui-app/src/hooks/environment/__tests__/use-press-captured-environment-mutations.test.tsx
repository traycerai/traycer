import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type {
  EnvironmentMoveAcceptance,
  EnvironmentMoveResult,
} from "@traycer-clients/shared/environment/environment-move-flow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { EnvironmentMoveStageResponse } from "@traycer/protocol/host/environment/move-contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentMoveStartMutation } from "@/hooks/environment/use-environment-move-start-mutation";
import { useRemoteAccessTurnOnMutation } from "@/hooks/environment/use-remote-access-turn-on-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  buildEnvironmentClient,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

interface PressTestAuth {
  getIdentityGeneration(): number;
  isIdentityCurrent(generation: number): boolean;
  environmentCloud(): EnvironmentCloud;
}

interface PressTestDirectory {
  findById(hostId: string): HostDirectoryEntry | null;
  onChange(): { dispose(): void };
}

interface PressTestBinding {
  readonly auth: PressTestAuth;
  readonly directory: PressTestDirectory;
}

const binding = vi.hoisted((): { current: PressTestBinding | null } => ({
  current: null,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => binding.current,
}));

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST_ID = "44444444-4444-4444-8444-444444444444";
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
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
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
        transport: (request) => {
          environmentRequests.push(new URL(request.url).pathname);
          return Promise.resolve({
            status: 200,
            text: JSON.stringify(
              new URL(request.url).pathname.endsWith("move-acceptances")
                ? { acceptanceId: ACCEPTANCE_ID }
                : { remoteAccess: { enabled: true, epoch: 1 } },
            ),
          });
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

function bindPressHosts(hostIds: readonly string[]): void {
  const entries = new Map<string, HostDirectoryEntry>();
  for (const hostId of hostIds) {
    entries.set(hostId, hostEntryFixture(hostId));
  }
  binding.current = {
    auth: authForCurrentGeneration(),
    directory: {
      findById: (hostId) => entries.get(hostId) ?? null,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function heldMutationStart(
  queryClient: QueryClient,
  mutationKey: ReadonlyArray<unknown>,
): { readonly started: Promise<void>; release(): void } {
  let announceStarted: () => void = () => undefined;
  let releaseGate: () => void = () => undefined;
  let holdNext = true;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  queryClient.setMutationDefaults(mutationKey, {
    onMutate: async () => {
      if (!holdNext) return;
      holdNext = false;
      announceStarted();
      await gate;
    },
  });
  return { started, release: () => releaseGate() };
}

const ACCEPTANCE: EnvironmentMoveAcceptance = {
  hostId: HOST_ID,
  target: { kind: "personal", environmentId: ENVIRONMENT_ID },
  planHash: HASH,
  keyChoices: [],
  personal: null,
};

function stagedResponse(
  hostId: string,
  request: {
    readonly target: EnvironmentMoveAcceptance["target"];
    readonly keyChoices: EnvironmentMoveAcceptance["keyChoices"];
  },
): EnvironmentMoveStageResponse {
  return {
    evidence: {
      attemptId: ATTEMPT_ID,
      planHash: HASH,
      planRevision: 1,
      hostVersion: "1.0.0",
      itemCount: 0,
      keyChoices: [...request.keyChoices],
      sourceHostId: hostId,
      sharingGeneration: 1,
      targetKind: "personal",
      environmentId: request.target.environmentId,
      disclosureVersion: 1,
    },
    authorization: { manifestHash: HASH },
  };
}

interface MoveClientLog {
  readonly client: HostClient<HostRpcRegistry>;
  readonly stageRequests: unknown[];
  readonly startRequests: unknown[];
}

function moveClientLog(hostId: string): MoveClientLog {
  const stageRequests: unknown[] = [];
  const startRequests: unknown[] = [];
  const fixture = buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.move.stage": (request) => {
        stageRequests.push(request);
        return stagedResponse(hostId, request);
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
  return { client: fixture.client, stageRequests, startRequests };
}

interface RefreshClientLog {
  readonly client: HostClient<HostRpcRegistry>;
  readonly refreshRequests: unknown[];
}

function refreshClientLog(hostId: string): RefreshClientLog {
  const refreshRequests: unknown[] = [];
  const fixture = buildEnvironmentClient({
    hostId,
    handlers: {
      "host.status.refresh": (request) => {
        refreshRequests.push(request);
        return {};
      },
    },
  });
  return { client: fixture.client, refreshRequests };
}

function acceptanceFor(hostId: string): EnvironmentMoveAcceptance {
  return { ...ACCEPTANCE, hostId };
}

describe("the press-captured environment mutations", () => {
  it("does not stage a move after its pressed sign-in ends", async () => {
    useAuthStore.setState({ status: "signed-in" });
    bindPressHosts([HOST_ID]);
    const fixture = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.move.stage": (request) => {
          stageRequests.push(request);
          return stagedResponse(HOST_ID, request);
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
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const { result } = renderHook(
      () => useEnvironmentMoveStartMutation(fixture.client, null),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync(ACCEPTANCE),
      ).resolves.toMatchObject({
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
    bindPressHosts([HOST_ID]);
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const { result } = renderHook(
      () => useRemoteAccessTurnOnMutation(null, HOST_ID),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toBeUndefined();
    });
    expect(environmentRequests).toEqual([
      `/api/v3/hosts/${HOST_ID}/remote-access`,
    ]);

    await act(async () => {
      const pending = result.current.mutateAsync();
      generation.value += 1;
      await expect(pending).resolves.toBeUndefined();
    });
    expect(environmentRequests).toEqual([
      `/api/v3/hosts/${HOST_ID}/remote-access`,
    ]);
  });

  it("keeps Move on its pressed client across a held onMutate and host rerender", async () => {
    useAuthStore.setState({ status: "signed-in" });
    bindPressHosts([HOST_ID, OTHER_HOST_ID]);
    const pressedHost = moveClientLog(HOST_ID);
    const currentHost = moveClientLog(OTHER_HOST_ID);
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const held = heldMutationStart(
      queryClient,
      environmentMutationKeys.moveStart(),
    );
    const { result, rerender } = renderHook(
      ({ client }) => useEnvironmentMoveStartMutation(client, null),
      {
        initialProps: { client: pressedHost.client },
        wrapper: wrapper(queryClient),
      },
    );

    let pressedRun: Promise<EnvironmentMoveResult> | null = null;
    await act(async () => {
      pressedRun = result.current.mutateAsync(ACCEPTANCE);
      await held.started;
    });
    rerender({ client: currentHost.client });
    await act(async () => {
      held.release();
      if (pressedRun === null) throw new Error("Move press did not start");
      await expect(pressedRun).resolves.toMatchObject({ kind: "started" });
    });

    expect(pressedHost.stageRequests).toHaveLength(1);
    expect(pressedHost.startRequests).toHaveLength(1);
    expect(currentHost.stageRequests).toEqual([]);
    expect(currentHost.startRequests).toEqual([]);

    await act(async () => {
      await expect(
        result.current.mutateAsync(acceptanceFor(OTHER_HOST_ID)),
      ).resolves.toMatchObject({ kind: "started" });
    });
    expect(currentHost.stageRequests).toHaveLength(1);
    expect(currentHost.startRequests).toHaveLength(1);
  });

  it("keeps Remote access and its refresh on the pressed host across a rerender", async () => {
    useAuthStore.setState({ status: "signed-in" });
    bindPressHosts([HOST_ID, OTHER_HOST_ID]);
    const pressedHost = refreshClientLog(HOST_ID);
    const currentHost = refreshClientLog(OTHER_HOST_ID);
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const held = heldMutationStart(
      queryClient,
      environmentMutationKeys.remoteAccessTurnOn(),
    );
    const { result, rerender } = renderHook(
      ({ client, hostId }) => useRemoteAccessTurnOnMutation(client, hostId),
      {
        initialProps: { client: pressedHost.client, hostId: HOST_ID },
        wrapper: wrapper(queryClient),
      },
    );

    let pressedRun: Promise<void> | null = null;
    await act(async () => {
      pressedRun = result.current.mutateAsync();
      await held.started;
    });
    rerender({ client: currentHost.client, hostId: OTHER_HOST_ID });
    await act(async () => {
      held.release();
      if (pressedRun === null)
        throw new Error("Remote access press did not start");
      await expect(pressedRun).resolves.toBeUndefined();
    });

    expect(environmentRequests).toEqual([
      `/api/v3/hosts/${HOST_ID}/remote-access`,
    ]);
    expect(pressedHost.refreshRequests).toEqual([{}]);
    expect(currentHost.refreshRequests).toEqual([]);
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [HOST_ID]: true,
    });

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toBeUndefined();
    });
    expect(environmentRequests).toEqual([
      `/api/v3/hosts/${HOST_ID}/remote-access`,
      `/api/v3/hosts/${OTHER_HOST_ID}/remote-access`,
    ]);
    expect(currentHost.refreshRequests).toEqual([{}]);
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [HOST_ID]: true,
      [OTHER_HOST_ID]: true,
    });
  });
});
