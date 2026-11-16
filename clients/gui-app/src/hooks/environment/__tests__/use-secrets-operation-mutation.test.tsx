import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
});
