// `useExecutableWriteGrant` reads the signed-in session's minter from the host
// binding. Mocked at that boundary, as the shell panel suite does, because the
// bare hook renders without a host runtime.
const bindingMock = vi.hoisted(
  (): { current: { readonly auth: unknown } | null } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => bindingMock.current };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutableWriteGrantFetchResult } from "@traycer-clients/shared/host-client/executable-write-grant";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
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
  bindingMock.current = null;
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

function okMinter(grant: string) {
  const mintedFor: string[] = [];
  return {
    mintedFor,
    mintExecutableWriteGrant: (
      hostId: string,
    ): Promise<ExecutableWriteGrantFetchResult> => {
      mintedFor.push(hostId);
      return Promise.resolve({ kind: "ok", grant, expiresInSeconds: 600 });
    },
    getCredentialGeneration: () => 0,
  };
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
              executableWriteGrant: "grant-from-prepare",
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
      value: "https://x.invalid",
      executableWriteGrant: "grant-from-prepare",
    });
    // It saw the MAPPED request (the grant not yet filled) and the client the
    // write goes out on.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.executableWriteGrant).toBeNull();
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
          prepareRequest: () => Promise.reject(new Error("no grant today")),
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

describe("useExecutableWriteGrant as a mutation's prepareRequest", () => {
  function renderWriter(host: RecordingHost) {
    return renderHook(
      () => {
        const prepare = useExecutableWriteGrant();
        return useHostMutation<
          HostRpcRegistry,
          "config.env.set",
          unknown,
          EnvWrite
        >({
          client: host.client,
          method: "config.env.set",
          options: null,
          mapVariables: (variables) => ({
            key: variables.key,
            value: variables.value,
            executableWriteGrant: null,
          }),
          prepareRequest: prepare,
        });
      },
      { wrapper: wrapperFor(newQueryClient()) },
    );
  }

  it("sends the minted grant with the write, and mints once for a burst of edits", async () => {
    const host = recordingHost();
    const minter = okMinter("minted-grant");
    bindingMock.current = { auth: minter };
    const { result } = renderWriter(host);
    act(() => {
      result.current.mutate({ key: "A", value: "1" });
    });
    await waitFor(() => {
      expect(host.dispatched).toHaveLength(1);
    });
    act(() => {
      result.current.mutate({ key: "B", value: "2" });
    });
    await waitFor(() => {
      expect(host.dispatched).toHaveLength(2);
    });
    expect(
      host.dispatched.map((request) => request.executableWriteGrant),
    ).toEqual(["minted-grant", "minted-grant"]);
    expect(minter.mintedFor).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("sends the write with no grant when the app is signed out (no binding)", async () => {
    const host = recordingHost();
    bindingMock.current = null;
    const { result } = renderWriter(host);
    act(() => {
      result.current.mutate({ key: "A", value: "1" });
    });
    await waitFor(() => {
      expect(host.dispatched).toHaveLength(1);
    });
    expect(host.dispatched[0]?.executableWriteGrant).toBeNull();
  });
});
