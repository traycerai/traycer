import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContext } from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useWorkspaceEntries } from "../use-workspace-entries";

let messenger: MockHostMessenger<HostRpcRegistry>;
let hostClient: HostClient<HostRpcRegistry>;

function createHostClient(): HostClient<HostRpcRegistry> {
  messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {},
    requestId: () => "request-test",
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
  });
  client.bind({
    hostId: "host-test",
    label: "Test Host",
    kind: "mock",
    websocketUrl: "ws://host.test",
    version: "test",
    status: "available",
  });
  client.setRequestContext(
    createRequestContext({
      identity: {
        userId: "user-test",
        username: "test",
        providerHandle: null,
      },
      bearerToken: "token-test",
      origin: "test",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    }),
  );
  return client;
}

function wrapper(props: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useWorkspaceEntries", () => {
  beforeEach(() => {
    hostClient = createHostClient();
  });

  afterEach(() => {
    cleanup();
  });

  it("requests host-backed workspace mention suggestions", async () => {
    messenger.setHandlers({
      "workspace.mentionFiles": () => ({
        entries: [
          {
            kind: "file",
            id: "file:/repo/src/app.ts",
            label: "app.ts",
            relPath: "src/app.ts",
            absolutePath: "/repo/src/app.ts",
            workspacePath: "/repo",
            description: "src",
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [
            {
              method: "workspace.mentionFiles",
              params: { roots: ["/repo"], query: "app", limit: 8 },
            },
          ],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(messenger.calls).toEqual([
      expect.objectContaining({
        method: "workspace.mentionFiles",
        params: { roots: ["/repo"], query: "app", limit: 8 },
        requestId: "request-test",
      }),
    ]);
  });

  it("does not request suggestions without request descriptors", () => {
    renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [],
        }),
      { wrapper },
    );

    expect(messenger.calls).toHaveLength(0);
  });

  function fileSearchRequest() {
    return {
      method: "workspace.searchPaths" as const,
      suggestionKind: "file" as const,
      root: "/repo",
      params: {
        epicId: "epic-1",
        reference: { root: "/repo" },
        query: "app",
        limit: 50,
        kinds: "files" as const,
      },
    };
  }

  it("reconstructs scoped searchPaths results into mention suggestions", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": (params) => ({
        epicId: params.epicId,
        root: "root" in params.reference ? params.reference.root : "",
        outcome: "ready",
        results: [{ kind: "file", relPath: "src/app.ts", name: "app.ts" }],
        truncated: false,
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [fileSearchRequest()],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data[0]).toMatchObject({
      kind: "file",
      relPath: "src/app.ts",
      absolutePath: "/repo/src/app.ts",
      workspacePath: "/repo",
    });
    // The scoped RPC was used - not the legacy raw-root one.
    expect(messenger.calls.map((call) => call.method)).toEqual([
      "workspace.searchPaths",
    ]);
  });

  it("reconstructs a folders-only scoped result into folder suggestions", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": (params) => ({
        epicId: params.epicId,
        root: "root" in params.reference ? params.reference.root : "",
        outcome: "ready",
        results: [{ kind: "folder", relPath: "src/lib", name: "lib" }],
        truncated: false,
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [
            {
              method: "workspace.searchPaths",
              suggestionKind: "folder",
              root: "/repo",
              params: {
                epicId: "epic-1",
                reference: { root: "/repo" },
                query: "lib",
                limit: 50,
                kinds: "folders",
              },
            },
          ],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data[0]).toMatchObject({
      kind: "folder",
      relPath: "src/lib/",
      absolutePath: "/repo/src/lib",
      workspacePath: "/repo",
    });
  });

  it("falls back to the legacy RPC when a scoped request errors", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": () => {
        throw new Error("host does not support searchPaths");
      },
      "workspace.mentionFiles": () => ({
        entries: [legacyFileSuggestion()],
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [fileSearchRequest()],
        }),
      { wrapper },
    );

    // The scoped failure is recovered by a legacy fallback for the same root,
    // so the suggestion never disappears and no error surfaces.
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(messenger.calls.map((call) => call.method)).toContain(
      "workspace.mentionFiles",
    );
  });

  it("falls back to the legacy RPC on a typed root_unavailable outcome", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": (params) => ({
        epicId: params.epicId,
        root: "root" in params.reference ? params.reference.root : "",
        outcome: "root_unavailable",
        results: [],
        truncated: false,
      }),
      "workspace.mentionFiles": () => ({
        entries: [legacyFileSuggestion()],
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [fileSearchRequest()],
        }),
      { wrapper },
    );

    // A rejected root is observably distinct from a match-less search: it routes
    // through the legacy RPC rather than dropping the root's suggestions.
    await waitFor(() =>
      expect(messenger.calls.map((call) => call.method)).toContain(
        "workspace.mentionFiles",
      ),
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });

  it("does NOT fall back on a ready outcome with zero matches", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": (params) => ({
        epicId: params.epicId,
        root: "root" in params.reference ? params.reference.root : "",
        outcome: "ready",
        results: [],
        truncated: false,
      }),
      "workspace.mentionFiles": () => ({
        entries: [legacyFileSuggestion()],
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [fileSearchRequest()],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    // Ready + empty means "searched, nothing matched" - no legacy fallback and
    // no suggestions.
    expect(result.current.data).toHaveLength(0);
    expect(messenger.calls.map((call) => call.method)).toEqual([
      "workspace.searchPaths",
    ]);
  });

  it("drops a late scoped reply whose echoed root no longer matches", async () => {
    messenger.setHandlers({
      "workspace.searchPaths": (params) => ({
        epicId: params.epicId,
        // A stale reply for a previously-selected workspace.
        root: "/some/other/workspace",
        outcome: "ready",
        results: [{ kind: "file", relPath: "x.ts", name: "x.ts" }],
        truncated: false,
      }),
    });

    const { result } = renderHook(
      () =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [fileSearchRequest()],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toHaveLength(0);
  });
});

function legacyFileSuggestion() {
  return {
    kind: "file" as const,
    id: "file:/repo:src/app.ts",
    label: "app.ts",
    relPath: "src/app.ts",
    absolutePath: "/repo/src/app.ts",
    workspacePath: "/repo",
    description: "src",
  };
}
