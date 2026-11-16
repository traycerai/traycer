import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useSecretsOperationMutation } from "@/hooks/environment/use-environment-secrets-calls";
import { useAuthStore } from "@/stores/auth/auth-store";
import { OwnEnvironmentAuthProvider } from "./own-environment-auth-provider";
import {
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironmentAs,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
} from "./own-environment-authn-test-support";

interface MutationInput {
  readonly label: string;
  readonly fail: boolean;
}

type MutationSettledArgs = readonly [
  unknown,
  unknown,
  MutationInput,
  unknown,
  unknown,
];

type VerifyRequest = RequestOfMethod<
  HostRpcRegistry,
  "environment.secrets.verify"
>;

const VERIFY_REQUEST: VerifyRequest = {
  environmentId: "env-test",
  target: "candidate",
  kind: "api_key",
  protocol: "https",
  hosts: ["api.example.test"],
  port: null,
  identity: null,
  database: null,
  policy: null,
  tlsPolicy: null,
  pinnedHostKeys: null,
  connectorId: null,
  confirmedAddresses: null,
  value: null,
};

let runtime: OwnEnvironmentAuthRuntime | null = null;
let transport: OwnEnvironmentTransport | null = null;

afterEach(() => {
  cleanup();
  transport?.restore();
  transport = null;
  runtime?.dispose();
  runtime = null;
  useAuthStore.setState({ status: "signed-out" });
});

function mutationOptions(
  variables: MutationInput[],
  callbacks: {
    readonly onSuccess: (variables: MutationInput) => void;
    readonly onError: (variables: MutationInput) => void;
    readonly onSettled: (variables: MutationInput) => void;
  },
) {
  const onSettled = (...args: MutationSettledArgs) =>
    callbacks.onSettled(args[2]);
  return {
    mutationKey: ["secrets-operation-controls"],
    mutationFn: async (
      input: MutationInput,
      send: Parameters<
        Parameters<typeof useSecretsOperationMutation>[0]["mutationFn"]
      >[1],
    ) => {
      variables.push(input);
      if (input.fail) throw new Error("synthetic mutation failure");
      return send("environment.secrets.verify", VERIFY_REQUEST);
    },
    onMutate: (input: MutationInput) => input.label,
    onSuccess: (
      _data: unknown,
      input: MutationInput,
      _result: unknown,
      _context: unknown,
    ) => callbacks.onSuccess(input),
    onError: (
      _error: unknown,
      input: MutationInput,
      _result: unknown,
      _context: unknown,
    ) => callbacks.onError(input),
    onSettled,
  };
}

function wrapWithRuntime(
  queryClient: QueryClient,
  authRuntime: OwnEnvironmentAuthRuntime,
): (props: { readonly children: ReactNode }) => ReactNode {
  return (props) => (
    <OwnEnvironmentAuthProvider binding={authRuntime.binding}>
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>
  );
}

describe("the Secrets operation mutation wrapper", () => {
  it("unwraps public variables for mutate, mutateAsync and their callbacks", async () => {
    runtime = createOwnEnvironmentAuthRuntime();
    transport = installOwnEnvironmentTransport(
      (request) =>
        request.url.pathname.endsWith("/secrets/verify")
          ? jsonResponse(200, { evidence: "probe_accepted" })
          : undefined,
      null,
    );
    await signInOwnEnvironmentAs(runtime, "user-1", "synthetic-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const mutationVariables: MutationInput[] = [];
    const successVariables: MutationInput[] = [];
    const errorVariables: MutationInput[] = [];
    const settledVariables: MutationInput[] = [];
    const perCallSuccessVariables: MutationInput[] = [];
    const perCallErrorVariables: MutationInput[] = [];
    const perCallSettledVariables: MutationInput[] = [];
    const { result } = renderHook(
      () =>
        useSecretsOperationMutation({
          ...mutationOptions(mutationVariables, {
            onSuccess: (input) => successVariables.push(input),
            onError: (input) => errorVariables.push(input),
            onSettled: (input) => settledVariables.push(input),
          }),
        }),
      { wrapper: wrapWithRuntime(queryClient, runtime) },
    );

    const asyncInput = { label: "mutateAsync", fail: false };
    await act(async () => {
      await result.current.mutateAsync(asyncInput, {
        onSuccess: (_data, input) => perCallSuccessVariables.push(input),
        onSettled: (_data, _error, input) =>
          perCallSettledVariables.push(input),
      });
    });
    await waitFor(() => expect(result.current.variables).toBe(asyncInput));

    const mutateInput = { label: "mutate", fail: false };
    act(() => {
      result.current.mutate(mutateInput, {
        onSuccess: (_data, input) => perCallSuccessVariables.push(input),
        onSettled: (_data, _error, input) =>
          perCallSettledVariables.push(input),
      });
    });
    await waitFor(() => expect(settledVariables).toHaveLength(2));

    const errorInput = { label: "failure", fail: true };
    await act(async () => {
      await expect(
        result.current.mutateAsync(errorInput, {
          onError: (_error, input) => perCallErrorVariables.push(input),
          onSettled: (_data, _error, input) =>
            perCallSettledVariables.push(input),
        }),
      ).rejects.toThrow("synthetic mutation failure");
    });

    expect(mutationVariables).toEqual([asyncInput, mutateInput, errorInput]);
    expect(successVariables).toEqual([asyncInput, mutateInput]);
    expect(errorVariables).toEqual([errorInput]);
    expect(settledVariables).toEqual([asyncInput, mutateInput, errorInput]);
    expect(perCallSuccessVariables).toEqual([asyncInput, mutateInput]);
    expect(perCallErrorVariables).toEqual([errorInput]);
    expect(perCallSettledVariables).toEqual([
      asyncInput,
      mutateInput,
      errorInput,
    ]);
    await waitFor(() => expect(result.current.variables).toBe(errorInput));
  });

  it("captures a separate same-account bearer for concurrent presses with reused variables", async () => {
    const authRuntime = createOwnEnvironmentAuthRuntime();
    runtime = authRuntime;
    const authorizationHeaders: Array<string | null> = [];
    transport = installOwnEnvironmentTransport((request) => {
      if (!request.url.pathname.endsWith("/secrets/verify")) return undefined;
      authorizationHeaders.push(request.headers.get("authorization"));
      return jsonResponse(200, { evidence: "probe_accepted" });
    }, null);
    await signInOwnEnvironmentAs(authRuntime, "user-1", "synthetic-token-one");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const release = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let pressIndex = 0;
    const sharedInput = { label: "same-object", fail: false };
    const observedVariables: MutationInput[] = [];
    const { result } = renderHook(
      () =>
        useSecretsOperationMutation({
          mutationKey: ["secrets-operation-concurrency"],
          onMutate: async (input: MutationInput) => {
            observedVariables.push(input);
            const index = pressIndex++;
            entered[index]?.resolve();
            await release[index]?.promise;
            return index;
          },
          mutationFn: (_input, send) =>
            send("environment.secrets.verify", VERIFY_REQUEST),
        }),
      { wrapper: wrapWithRuntime(queryClient, authRuntime) },
    );

    let first: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.mutateAsync(sharedInput);
      await entered[0]?.promise;
    });
    await act(async () => {
      await authRuntime.auth.signOut();
    });
    await signInOwnEnvironmentAs(authRuntime, "user-1", "synthetic-token-two");

    let second: Promise<unknown> | undefined;
    await act(async () => {
      second = result.current.mutateAsync(sharedInput);
      await entered[1]?.promise;
    });
    expect(observedVariables).toEqual([sharedInput, sharedInput]);
    expect(observedVariables[0]).toBe(sharedInput);
    expect(observedVariables[1]).toBe(sharedInput);

    let outcomes: PromiseSettledResult<unknown>[] | undefined;
    await act(async () => {
      release[0]?.resolve();
      release[1]?.resolve();
      outcomes = await Promise.allSettled([first, second]);
    });

    expect(outcomes?.[0]?.status).toBe("rejected");
    expect(outcomes?.[1]?.status).toBe("fulfilled");
    expect(authorizationHeaders).toEqual(["Bearer synthetic-token-two"]);
  });

  it("serializes captured sends with the same TanStack scope id", async () => {
    const authRuntime = createOwnEnvironmentAuthRuntime();
    runtime = authRuntime;
    const firstResponse = Promise.withResolvers<Response>();
    const firstRequestStarted = Promise.withResolvers<void>();
    const secondRequestStarted = Promise.withResolvers<void>();
    let requestCount = 0;
    transport = installOwnEnvironmentTransport((request) => {
      if (!request.url.pathname.endsWith("/secrets/verify")) return undefined;
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestStarted.resolve();
        return firstResponse.promise;
      }
      secondRequestStarted.resolve();
      return jsonResponse(200, { evidence: "probe_accepted" });
    }, null);
    await signInOwnEnvironmentAs(authRuntime, "user-1", "scope-token");

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const firstInput = { label: "scope-first", fail: false };
    const secondInput = { label: "scope-second", fail: false };
    const secondOnMutate = Promise.withResolvers<void>();
    const mutationStarts: string[] = [];
    const { result } = renderHook(
      () =>
        useSecretsOperationMutation({
          mutationKey: ["secrets-operation-scope"],
          scope: { id: "secrets-operation-serial" },
          onMutate: (input: MutationInput) => {
            if (input === secondInput) secondOnMutate.resolve();
            return input.label;
          },
          mutationFn: (input, send) => {
            mutationStarts.push(input.label);
            return send("environment.secrets.verify", VERIFY_REQUEST);
          },
        }),
      { wrapper: wrapWithRuntime(queryClient, authRuntime) },
    );

    let first: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.mutateAsync(firstInput);
      await firstRequestStarted.promise;
    });

    let second: Promise<unknown> | undefined;
    await act(async () => {
      second = result.current.mutateAsync(secondInput);
      await secondOnMutate.promise;
    });

    const queuedMutation = queryClient
      .getMutationCache()
      .getAll()
      .find((mutation) => mutation.state.variables === secondInput);
    expect(queuedMutation?.state.isPaused).toBe(true);
    expect(mutationStarts).toEqual(["scope-first"]);
    expect(requestCount).toBe(1);

    if (first === undefined || second === undefined) {
      throw new Error("Both scoped sends should have started");
    }
    await act(async () => {
      firstResponse.resolve(jsonResponse(200, { evidence: "probe_accepted" }));
      await secondRequestStarted.promise;
      await Promise.all([first, second]);
    });

    expect(mutationStarts).toEqual(["scope-first", "scope-second"]);
    expect(requestCount).toBe(2);
  });

  it("routes a synchronous capture error through mutation callbacks without dispatch", async () => {
    const authRuntime = createOwnEnvironmentAuthRuntime();
    runtime = authRuntime;
    transport = installOwnEnvironmentTransport(() => undefined, null);
    const captureError = new TypeError("capture failed synchronously");
    const environmentCloud = vi
      .spyOn(authRuntime.auth, "environmentCloud")
      .mockImplementation(() => {
        throw captureError;
      });
    const mutationVariables: MutationInput[] = [];
    const observedErrors: unknown[] = [];
    const settledErrors: unknown[] = [];
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useSecretsOperationMutation({
          mutationKey: ["secrets-operation-capture-error"],
          mutationFn: (input, send) => {
            mutationVariables.push(input);
            return send("environment.secrets.verify", VERIFY_REQUEST);
          },
          onError: (error) => observedErrors.push(error),
          onSettled: (_data, error) => settledErrors.push(error),
        }),
      { wrapper: wrapWithRuntime(queryClient, authRuntime) },
    );

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        label: "capture-error",
        fail: false,
      });
      expect(environmentCloud).toHaveBeenCalledOnce();
    });
    if (mutation === undefined) throw new Error("The mutation did not start");
    await act(async () => {
      await expect(mutation).rejects.toBe(captureError);
    });

    expect(observedErrors).toEqual([captureError]);
    expect(settledErrors).toEqual([captureError]);
    expect(mutationVariables).toEqual([]);
    expect(
      transport.requests.filter((request) =>
        request.url.pathname.endsWith("/secrets/verify"),
      ),
    ).toEqual([]);
  });

  it("keeps hook callbacks and drops per-call callbacks when the mutation hook unmounts", async () => {
    const authRuntime = createOwnEnvironmentAuthRuntime();
    runtime = authRuntime;
    const response = Promise.withResolvers<Response>();
    const requestStarted = Promise.withResolvers<void>();
    transport = installOwnEnvironmentTransport((request) => {
      if (!request.url.pathname.endsWith("/secrets/verify")) return undefined;
      requestStarted.resolve();
      return response.promise;
    }, null);
    await signInOwnEnvironmentAs(authRuntime, "user-1", "unmount-token");

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const input = { label: "unmount", fail: false };
    const hookSuccess: MutationInput[] = [];
    const hookSettled: MutationInput[] = [];
    const perCallSuccess: MutationInput[] = [];
    const perCallSettled: MutationInput[] = [];
    const { result, unmount } = renderHook(
      () =>
        useSecretsOperationMutation({
          mutationKey: ["secrets-operation-unmount"],
          mutationFn: (_input, send) =>
            send("environment.secrets.verify", VERIFY_REQUEST),
          onSuccess: (_data, variables) => hookSuccess.push(variables),
          onSettled: (_data, _error, variables) => hookSettled.push(variables),
        }),
      { wrapper: wrapWithRuntime(queryClient, authRuntime) },
    );

    let mutation: Promise<unknown> | undefined;
    await act(async () => {
      mutation = result.current.mutateAsync(input, {
        onSuccess: (_data, variables) => perCallSuccess.push(variables),
        onSettled: (_data, _error, variables) => perCallSettled.push(variables),
      });
      await requestStarted.promise;
    });
    if (mutation === undefined) throw new Error("The mutation did not start");
    unmount();

    await act(async () => {
      response.resolve(jsonResponse(200, { evidence: "probe_accepted" }));
      await mutation;
    });

    expect(hookSuccess).toEqual([input]);
    expect(hookSettled).toEqual([input]);
    expect(perCallSuccess).toEqual([]);
    expect(perCallSettled).toEqual([]);
  });
});
