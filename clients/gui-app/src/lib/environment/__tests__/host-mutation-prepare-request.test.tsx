import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";

type EnvSetRequest = RequestOfMethod<HostRpcRegistry, "config.env.set">;
type EnvSetResponse = ResponseOfMethod<HostRpcRegistry, "config.env.set">;

interface EnvWrite {
  readonly key: string;
  readonly value: string | null;
}

afterEach(() => {
  cleanup();
});

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

interface RecordingHost extends EnvironmentClientFixture {
  readonly dispatched: EnvSetRequest[];
}

/** A host that records every `config.env.set` it is dispatched. */
function recordingHost(): RecordingHost {
  const dispatched: EnvSetRequest[] = [];
  const fixture = buildEnvironmentClient({
    hostId: "11111111-1111-4111-8111-111111111111",
    handlers: {
      "environment.status": () =>
        environmentStatusFixture({ principal: { kind: "personal" } }),
      "config.env.set": (request): EnvSetResponse => {
        dispatched.push(request);
        return { key: request.key, value: request.value };
      },
    },
  });
  return { ...fixture, dispatched };
}

describe("useHostMutation prepareRequest", () => {
  it("dispatches what prepareRequest resolved from the mapped request, on the dispatch client", async () => {
    const { client, dispatched } = recordingHost();
    const seen: Array<{
      readonly request: EnvSetRequest;
      readonly client: unknown;
    }> = [];
    const { result } = renderHook(
      () =>
        useHostMutation<HostRpcRegistry, "config.env.set", unknown, EnvWrite>({
          client,
          method: "config.env.set",
          options: null,
          mapVariables: (variables) => ({
            key: variables.key,
            value: variables.value,
            executableWriteGrant: null,
          }),
          prepareRequest: (request, dispatchClient) => {
            seen.push({ request, client: dispatchClient });
            return Promise.resolve({
              ...request,
              value: "https://prepared.invalid",
            });
          },
        }),
      { wrapper: wrapperFor(newQueryClient()) },
    );
    act(() => {
      result.current.mutate({ key: "API_URL", value: "https://x.invalid" });
    });
    await waitFor(() => {
      expect(dispatched).toHaveLength(1);
    });
    expect(dispatched[0]).toEqual({
      key: "API_URL",
      value: "https://prepared.invalid",
      executableWriteGrant: null,
    });
    // It saw the mapped value before preparation and the client the
    // write goes out on.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.value).toBe("https://x.invalid");
    expect(seen[0]?.client).toBe(client);
  });

  it("dispatches the mapped request unchanged when prepareRequest is omitted", async () => {
    const { client, dispatched } = recordingHost();
    const { result } = renderHook(
      () =>
        useHostMutation<HostRpcRegistry, "config.env.set", unknown, EnvWrite>({
          client,
          method: "config.env.set",
          options: null,
          mapVariables: (variables) => ({
            key: variables.key,
            value: variables.value,
            executableWriteGrant: null,
          }),
          prepareRequest: undefined,
        }),
      { wrapper: wrapperFor(newQueryClient()) },
    );
    act(() => {
      result.current.mutate({ key: "API_URL", value: null });
    });
    await waitFor(() => {
      expect(dispatched).toHaveLength(1);
    });
    expect(dispatched[0]).toEqual({
      key: "API_URL",
      value: null,
      executableWriteGrant: null,
    });
  });

  it("surfaces a throw in prepareRequest as a HostRpcError and dispatches nothing", async () => {
    const { client, dispatched } = recordingHost();
    const { result } = renderHook(
      () =>
        useHostMutation<HostRpcRegistry, "config.env.set", unknown, EnvWrite>({
          client,
          method: "config.env.set",
          options: null,
          mapVariables: (variables) => ({
            key: variables.key,
            value: variables.value,
            executableWriteGrant: null,
          }),
          prepareRequest: () => Promise.reject(new Error("preparation failed")),
        }),
      { wrapper: wrapperFor(newQueryClient()) },
    );
    act(() => {
      result.current.mutate({ key: "API_URL", value: "v" });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.name).toBe("HostRpcError");
    expect(dispatched).toEqual([]);
  });
});
