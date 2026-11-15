import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderAuthAction } from "@traycer/protocol/host/provider-native-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useProvidersModelProviderAuth } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import type { ModelProviderAuthVariables } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { createAppQueryClient } from "@/lib/query-client";

const clientHolder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (clientHolder.client === null)
        throw new Error("Model provider test client is unavailable");
      return clientHolder.client;
    },
  };
});

interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

interface SecretActionCase {
  readonly name: string;
  readonly action: ModelProviderAuthAction;
  readonly variables: ModelProviderAuthVariables;
  readonly secrets: readonly string[];
}

const secretActionCases: readonly SecretActionCase[] = [
  {
    name: "connect key and inputs",
    action: {
      action: "connect",
      modelProviderId: "openai",
      methodIndex: 0,
      key: "synthetic-model-provider-key",
      inputs: {
        account: "synthetic-model-provider-account",
        token: "synthetic-model-provider-input-token",
      },
    },
    variables: {
      providerId: "opencode",
      action: {
        action: "connect",
        modelProviderId: "openai",
        methodIndex: 0,
      },
    },
    secrets: [
      "synthetic-model-provider-key",
      "synthetic-model-provider-account",
      "synthetic-model-provider-input-token",
    ],
  },
  {
    name: "OAuth inputs",
    action: {
      action: "startOauth",
      modelProviderId: "openai",
      methodIndex: 0,
      inputs: { account: "synthetic-model-provider-oauth-input" },
    },
    variables: {
      providerId: "opencode",
      action: {
        action: "startOauth",
        modelProviderId: "openai",
        methodIndex: 0,
      },
    },
    secrets: ["synthetic-model-provider-oauth-input"],
  },
  {
    name: "verification code",
    action: {
      action: "submitCode",
      modelProviderId: "openai",
      attemptId: "synthetic-model-provider-attempt",
      code: "synthetic-model-provider-code",
    },
    variables: {
      providerId: "opencode",
      action: {
        action: "submitCode",
        modelProviderId: "openai",
        attemptId: "synthetic-model-provider-attempt",
      },
    },
    secrets: ["synthetic-model-provider-code"],
  },
  {
    name: "custom key and headers",
    action: {
      action: "createCustom",
      modelProviderId: "myprovider",
      name: "My Provider",
      baseUrl: "https://api.example.test/v1",
      models: [{ id: "model-a", name: "Model A" }],
      key: "synthetic-custom-provider-key",
      headers: [{ key: "Authorization", value: "synthetic-custom-header" }],
      env: [],
    },
    variables: {
      providerId: "opencode",
      action: { action: "createCustom", modelProviderId: "myprovider" },
    },
    secrets: ["synthetic-custom-provider-key", "synthetic-custom-header"],
  },
];

function containsSecrets(value: unknown, secrets: readonly string[]): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string")
      return secrets.some((secret) => current.includes(secret));
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return false;
    }
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      current instanceof Error &&
      (secrets.some((secret) => current.message.includes(secret)) ||
        contains(current.cause))
    ) {
      return true;
    }
    return Object.values(current).some(contains);
  }
  return contains(value);
}

function captureMutationObservers(
  queryClient: QueryClient,
): MutationObserverReference[] {
  const observers: MutationObserverReference[] = [];
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
  return observers;
}

function mutationCacheContainsSecrets(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  secrets: readonly string[],
): boolean {
  return (
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        containsSecrets(
          {
            variables: mutation.state.variables,
            context: mutation.state.context,
            data: mutation.state.data,
            error: mutation.state.error,
            meta: mutation.options.meta,
          },
          secrets,
        ),
      ) ||
    observers.some((observer) =>
      containsSecrets(
        { options: observer.options, result: observer.getCurrentResult() },
        secrets,
      ),
    )
  );
}

function withQueryClient(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

const clients: HostClient<HostRpcRegistry>[] = [];
const queryClients: QueryClient[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleSpyRestorers: Array<() => void> = [];

function captureConsoleOutput(): unknown[][] {
  const output: unknown[][] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation((...values) => {
    output.push(values);
  });
  const info = vi.spyOn(console, "info").mockImplementation((...values) => {
    output.push(values);
  });
  const log = vi.spyOn(console, "log").mockImplementation((...values) => {
    output.push(values);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...values) => {
    output.push(values);
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    output.push(values);
  });
  consoleSpyRestorers.push(
    () => debug.mockRestore(),
    () => info.mockRestore(),
    () => log.mockRestore(),
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return output;
}

afterEach(() => {
  cleanup();
  clientHolder.client = null;
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleSpyRestorers.splice(0)) restore();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const client of clients.splice(0)) client.dispose();
});

for (const scenario of secretActionCases) {
  it.each([
    { settles: "successfully" as const, fail: false },
    { settles: "with a transport error" as const, fail: true },
  ])(
    `${scenario.name} stays outside mutation state after it settles $settles`,
    async ({ fail }) => {
      const consoleOutput = captureConsoleOutput();
      const observations = {
        requestContainsSecrets: false,
        rejectionContainsSecrets: false,
      };
      const queryClient = createAppQueryClient();
      queryClients.push(queryClient);
      const observers = captureMutationObservers(queryClient);
      const messenger = new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-model-secret-retention",
        handlers: {
          "providers.modelProviderAuth": (params) => {
            observations.requestContainsSecrets = containsSecrets(
              params,
              scenario.secrets,
            );
            if (fail) throw new Error("Safe model provider failure");
            return { result: { kind: "done" } };
          },
        },
      });
      const client = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById: (hostId) =>
          hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
        messenger,
      });
      clients.push(client);
      client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "synthetic-model-session",
        }),
      );
      clientHolder.client = client.createRequester(mockLocalHostEntry);
      const { result } = renderHook(
        () => {
          const submitted = useSubmittedSecretInput<ModelProviderAuthAction>(
            "Model provider input is unavailable.",
          );
          return {
            input: submitted,
            mutation: useProvidersModelProviderAuth(
              (_target) => submitted.read(),
              submitted.clear,
            ),
          };
        },
        { wrapper: withQueryClient(queryClient) },
      );
      await act(async () => {
        result.current.input.set(scenario.action);
        try {
          await result.current.mutation.mutateAsync(scenario.variables);
        } catch (error) {
          observations.rejectionContainsSecrets = containsSecrets(
            error,
            scenario.secrets,
          );
        }
      });
      await waitFor(() =>
        expect(result.current.mutation.status).toBe(fail ? "error" : "success"),
      );
      const retainedMutation = queryClient.getMutationCache().getAll().at(-1);
      if (retainedMutation === undefined)
        throw new Error("Model provider mutation was not retained");
      const mutationFn = retainedMutation.options.mutationFn;
      if (mutationFn === undefined)
        throw new Error("Model provider mutation has no mutation function");
      const rpcCount = messenger.calls.filter(
        (call) => call.method === "providers.modelProviderAuth",
      ).length;
      let replayRefused = false;
      let replayErrorContainsSecrets = false;
      try {
        await mutationFn(scenario.variables, {
          client: queryClient,
          meta: retainedMutation.options.meta,
          mutationKey: retainedMutation.options.mutationKey ?? [],
        });
      } catch (error) {
        replayRefused =
          error instanceof Error &&
          error.message === "Model provider input is unavailable.";
        replayErrorContainsSecrets = containsSecrets(error, scenario.secrets);
      }
      expect(
        observations.requestContainsSecrets &&
          retainedMutation.state.status === (fail ? "error" : "success") &&
          !mutationCacheContainsSecrets(
            queryClient,
            observers,
            scenario.secrets,
          ) &&
          !containsSecrets(consoleOutput, scenario.secrets) &&
          !containsSecrets(result.current, scenario.secrets) &&
          !observations.rejectionContainsSecrets &&
          replayRefused &&
          !replayErrorContainsSecrets &&
          messenger.calls.filter(
            (call) => call.method === "providers.modelProviderAuth",
          ).length === rpcCount,
      ).toBe(true);
    },
  );
}
