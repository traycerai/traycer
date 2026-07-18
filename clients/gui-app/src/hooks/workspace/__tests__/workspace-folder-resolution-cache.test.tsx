import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  WORKSPACE_FOLDER_CHECK_FAILED_HINT,
  deriveFolderlessAllowedWorkspaceAvailability,
} from "@/lib/composer/workspace-composer-availability";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
});

describe("workspace folder resolution cache", () => {
  it("refetches a stale unresolved mapping after preparing the folder", async () => {
    const fixture = createFixture(0);
    const source = workspaceSource(fixture);
    const rendered = renderHook(
      () => ({
        resolved: useResolvedWorkspaceFolders(source, fixture.client),
        actions: useWorkspaceFolderActionsForClient(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.resolved.folders).toEqual([
        expect.objectContaining({ kind: "unresolved" }),
      ]);
    });

    await act(async () => {
      await rendered.result.current.actions.prepareFoldersMutation.mutateAsync({
        folderPaths: [fixture.workspacePath],
      });
    });

    await waitFor(() => {
      expect(rendered.result.current.resolved.folders).toEqual([
        expect.objectContaining({
          kind: "resolved",
          path: fixture.workspacePath,
        }),
      ]);
    });
    expect(fixture.resolveRequestCount()).toBe(2);
  });

  it("distinguishes a failed check and recovers on app focus", async () => {
    const fixture = createFixture(1);
    const source = workspaceSource(fixture);
    const rendered = renderHook(
      () => {
        const resolved = useResolvedWorkspaceFolders(source, fixture.client);
        return {
          resolved,
          availability: deriveFolderlessAllowedWorkspaceAvailability(
            resolved.folders,
            resolved.isLoading,
            resolved.isError,
          ),
        };
      },
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.resolved.isError).toBe(true);
    });
    expect(rendered.result.current.availability).toEqual({
      status: "blocked",
      disabledHint: WORKSPACE_FOLDER_CHECK_FAILED_HINT,
    });

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => {
      expect(rendered.result.current.resolved.folders).toEqual([
        expect.objectContaining({ kind: "resolved" }),
      ]);
    });
  });
});

interface WorkspaceFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly repoIdentifier: { readonly owner: string; readonly repo: string };
  readonly workspacePath: string;
  readonly resolveRequestCount: () => number;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function workspaceSource(fixture: WorkspaceFixture) {
  return {
    folders: [fixture.workspacePath],
    folderInfoByPath: {
      [fixture.workspacePath]: {
        path: fixture.workspacePath,
        name: "traycer",
        repoIdentifier: fixture.repoIdentifier,
      },
    },
  };
}

function createFixture(resolveFailures: number): WorkspaceFixture {
  const queryClient = createAppQueryClient();
  if (resolveFailures > 0) {
    // MockHostMessenger preserves the wire error but not its subclass. Match
    // production's no-query-retry policy for RetryableTransportError here.
    queryClient.setQueryDefaults(
      hostQueryKeys.methodScope(
        mockLocalHostEntry.hostId,
        "workspace.resolvePathsByRepoIdentifiers",
      ),
      { retry: false },
    );
  }
  const repoIdentifier = { owner: "traycerai", repo: "traycer" };
  const workspacePath = "/workspace/traycer";
  let prepared = false;
  let resolveRequests = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-workspace-folders",
    handlers: {
      "workspace.resolvePathsByRepoIdentifiers": () => {
        resolveRequests += 1;
        if (resolveRequests <= resolveFailures) {
          throw new RetryableTransportError({
            code: "RPC_ERROR",
            message: "Host temporarily unavailable",
            requestId: "req-workspace-folders",
            method: "workspace.resolvePathsByRepoIdentifiers",
            fatalDetails: null,
          });
        }
        return {
          mappings:
            prepared || resolveFailures > 0
              ? [{ repoIdentifier, workspacePath }]
              : [],
        };
      },
      "workspace.prepareFolders": () => {
        prepared = true;
        return {
          folders: [
            {
              workspacePath,
              workspaceName: "traycer",
              repoIdentifier,
              repoUrl: "https://github.com/traycerai/traycer.git",
            },
          ],
          repoIdentifiers: [repoIdentifier],
        };
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://traycer.invalid/sign-in",
    authnBaseUrl: "https://traycer.invalid/auth",
    localHost: null,
    hosts: [mockLocalHostEntry],
    workspaceFolderPickerPaths: [],
    hasLocalHost: true,
    traycerCli: null,
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        {props.children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  return {
    client,
    repoIdentifier,
    workspacePath,
    resolveRequestCount: () => resolveRequests,
    Wrapper,
  };
}
