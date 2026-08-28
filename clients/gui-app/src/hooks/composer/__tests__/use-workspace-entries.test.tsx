import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContext } from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@/lib/host";
import { useWorkspaceEntries } from "../use-workspace-entries";

const HOST_ENTRY: HostDirectoryEntry = {
  hostId: "host-test",
  label: "Test Host",
  kind: "mock",
  websocketUrl: "ws://host.test",
  version: "test",
  transportDialability: "dialable",
};

const OTHER_HOST_ENTRY: HostDirectoryEntry = {
  hostId: "host-test-2",
  label: "Test Host 2",
  kind: "mock",
  websocketUrl: "ws://host2.test",
  version: "test",
  transportDialability: "dialable",
};

let messenger: MockHostMessenger<HostRpcRegistry>;
let hostClient: HostClient<HostRpcRegistry>;
let hostClientSpine: HostClient<HostRpcRegistry>;

function createHostClient(): HostClient<HostRpcRegistry> {
  messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {},
    requestId: () => "request-test",
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) => {
      if (hostId === HOST_ENTRY.hostId) return HOST_ENTRY;
      if (hostId === OTHER_HOST_ENTRY.hostId) return OTHER_HOST_ENTRY;
      return null;
    },
  });
  spine.setRequestContext(
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
  hostClientSpine = spine;
  return spine.createRequester(HOST_ENTRY);
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

function isScopedSearchForEpic(
  call: { readonly method: string; readonly params: unknown },
  epicId: string,
) {
  return (
    call.method === "workspace.searchPaths" &&
    typeof call.params === "object" &&
    call.params !== null &&
    "epicId" in call.params &&
    call.params.epicId === epicId
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

  it("drops placeholder data across a host switch instead of showing the previous host's matches", async () => {
    let resolveGated: (() => void) | null = null;
    messenger.setHandlers({
      "workspace.mentionFiles": (params) => {
        // Gate only the request issued under the second host, so the first
        // host's result is settled and cached before the switch.
        if (params.roots[0] === "/repo-2") {
          return new Promise<void>((resolve) => {
            resolveGated = resolve;
          }).then(() => ({ entries: [legacyFileSuggestion()] }));
        }
        return { entries: [legacyFileSuggestion()] };
      },
    });

    const { result, rerender } = renderHook(
      ({ root }: { readonly root: string }) =>
        useWorkspaceEntries({
          client: hostClient,
          requests: [
            {
              method: "workspace.mentionFiles",
              params: { roots: [root], query: "app", limit: 8 },
            },
          ],
        }),
      { wrapper, initialProps: { root: "/repo" } },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    // A host switch is now a NEW pinned requester, not a mutation of the
    // same client (redesign P4.2 deleted the active-slot change event that
    // `bind()` used to drive `useReactiveHostReadiness` off). The hook
    // reads whatever `client` it is re-rendered with.
    act(() => {
      hostClient = hostClientSpine.createRequester(OTHER_HOST_ENTRY);
    });
    rerender({ root: "/repo-2" });

    await waitFor(() => expect(result.current.isFetching).toBe(true));
    // Host boundary: the previous host's matches must not render as placeholder
    // data for the new host's in-flight request.
    expect(result.current.data).toHaveLength(0);

    act(() => {
      resolveGated?.();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
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

  function scopedFileSearchRequest(root: string, epicId: string) {
    return {
      method: "workspace.searchPaths" as const,
      suggestionKind: "file" as const,
      root,
      params: {
        epicId,
        reference: { root },
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

  it("does not reuse a pending root's placeholder state after the request slot changes", async () => {
    let resolveFirst: (() => void) | null = null;
    messenger.setHandlers({
      "workspace.searchPaths": (params) => {
        if ("root" in params.reference && params.reference.root === "/repo-a") {
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }).then(() => ({
            epicId: params.epicId,
            root: "/repo-a",
            outcome: "root_unavailable" as const,
            results: [],
            truncated: false,
          }));
        }
        return {
          epicId: params.epicId,
          root: "root" in params.reference ? params.reference.root : "",
          outcome: "ready" as const,
          results: [],
          truncated: false,
        };
      },
      "workspace.mentionFiles": () => ({ entries: [legacyFileSuggestion()] }),
    });

    const { result, rerender } = renderHook(
      ({ request }) =>
        useWorkspaceEntries({ client: hostClient, requests: [request] }),
      {
        initialProps: {
          request: scopedFileSearchRequest("/repo-a", "epic-a"),
        },
        wrapper,
      },
    );

    await waitFor(() =>
      expect(
        messenger.calls.some((call) => isScopedSearchForEpic(call, "epic-a")),
      ).toBe(true),
    );

    rerender({ request: scopedFileSearchRequest("/repo-b", "epic-b") });

    await waitFor(() =>
      expect(
        messenger.calls.some((call) => isScopedSearchForEpic(call, "epic-b")),
      ).toBe(true),
    );
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toHaveLength(0);
    expect(messenger.calls.map((call) => call.method)).not.toContain(
      "workspace.mentionFiles",
    );

    act(() => {
      resolveFirst?.();
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toHaveLength(0);
    expect(messenger.calls.map((call) => call.method)).not.toContain(
      "workspace.mentionFiles",
    );
  });

  it("does not fall back for a previous root_unavailable reply after the request slot changes", async () => {
    let resolveSecond: (() => void) | null = null;
    messenger.setHandlers({
      "workspace.searchPaths": (params) => {
        if ("root" in params.reference && params.reference.root === "/repo-a") {
          return {
            epicId: params.epicId,
            root: "/repo-a",
            outcome: "root_unavailable" as const,
            results: [],
            truncated: false,
          };
        }
        return new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }).then(() => ({
          epicId: params.epicId,
          root: "/repo-b",
          outcome: "ready" as const,
          results: [],
          truncated: false,
        }));
      },
      "workspace.mentionFiles": () => ({ entries: [legacyFileSuggestion()] }),
    });

    const { result, rerender } = renderHook(
      ({ request }) =>
        useWorkspaceEntries({ client: hostClient, requests: [request] }),
      {
        initialProps: {
          request: scopedFileSearchRequest("/repo-a", "epic-a"),
        },
        wrapper,
      },
    );

    await waitFor(() =>
      expect(messenger.calls.map((call) => call.method)).toContain(
        "workspace.mentionFiles",
      ),
    );
    const legacyCallCount = messenger.calls.filter(
      (call) => call.method === "workspace.mentionFiles",
    ).length;

    rerender({ request: scopedFileSearchRequest("/repo-b", "epic-b") });

    await waitFor(() =>
      expect(
        messenger.calls.some((call) => isScopedSearchForEpic(call, "epic-b")),
      ).toBe(true),
    );
    expect(
      messenger.calls.filter(
        (call) => call.method === "workspace.mentionFiles",
      ),
    ).toHaveLength(legacyCallCount);
    expect(result.current.data).toHaveLength(0);

    act(() => {
      resolveSecond?.();
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toHaveLength(0);
    expect(
      messenger.calls.filter(
        (call) => call.method === "workspace.mentionFiles",
      ),
    ).toHaveLength(legacyCallCount);
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
