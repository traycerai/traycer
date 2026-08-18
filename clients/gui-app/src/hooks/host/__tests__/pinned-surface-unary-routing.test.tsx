import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

/**
 * A host-pinned surface's UNARY reads must reach the host the surface names.
 *
 * The file-tree sidebar and the git-diff panel both resolve a surface pin and
 * then hand `hostId` down to their leaf hooks. Several of those hooks used the
 * id to KEY their cache slot and to fill the `hostId` request PARAM, while
 * taking the client itself from `useHostClient()` - and the param does not
 * route: `HostClient.request()` sends through its own bound messenger. So the
 * app-wide host was asked about the pinned host's repo and filesystem, and the
 * answer was cached under the pinned host's key.
 *
 * `useGitListChangedFilesWithSubmodules` beside them already resolved its client
 * from its `hostId`, which is why this is a correction rather than a new rule.
 *
 * The ambient host is A and every pin below is B, so the two sources always
 * disagree and a build that reads the wrong one fails on the VALUE. The
 * assertion is the messenger ENDPOINT the request actually reached - not which
 * client object came back, and not the `hostId` param, which is precisely the
 * field that looked right the whole time it was wrong.
 */
const HOST_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59998/stream",
};

const directory: ReadonlyArray<HostDirectoryEntry> = [
  mockLocalHostEntry,
  HOST_B,
];

const spineRef = vi.hoisted<{ value: HostClient<HostRpcRegistry> | null }>(
  () => ({ value: null }),
);

function getSpine(): HostClient<HostRpcRegistry> {
  if (spineRef.value === null) {
    throw new Error("test spine not configured");
  }
  return spineRef.value;
}

vi.mock("@/lib/host/runtime", () => ({
  // The SPINE - what an explicit host id is resolved AGAINST.
  useHostRuntimeClient: getSpine,
  // The AMBIENT client, pinned to host A. Any hook still reading this instead
  // of its own `hostId` lands on A, which is the whole point of the fixture.
  useHostClient: () =>
    getSpine().createRequesterForHostId(mockLocalHostEntry.hostId),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directory }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-b", isReady: true }),
}));

import { useGitCapabilitiesQuery } from "@/hooks/git/use-git-capabilities-query";
import { useWorkspaceListFileTree } from "@/hooks/workspace/use-list-file-tree-query";

const messengerRef: { value: MockHostMessenger<HostRpcRegistry> | null } = {
  value: null,
};

function endpointHostIdOfFirstCall(): string | undefined {
  return messengerRef.value?.calls[0]?.authority.endpoint.hostId;
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    props.children,
  );
}

beforeEach(() => {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "git.getCapabilities": () => ({
        available: true,
        gitVersion: "2.44.0",
        reason: null,
      }),
      "workspace.listFileTree": () => ({
        workspacePath: "/repo",
        files: [],
        gitStatus: [],
        truncated: false,
      }),
    },
  });
  messengerRef.value = messenger;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (hostId) =>
      directory.find((entry) => entry.hostId === hostId) ?? null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  spineRef.value = spine;
});

afterEach(() => {
  cleanup();
  spineRef.value = null;
  messengerRef.value = null;
});

describe("a pinned surface's unary reads reach the pinned host", () => {
  it("asks the SURFACE's host about git capabilities, not the app-wide one", async () => {
    renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: HOST_B.hostId,
          runningDir: "/repo",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(messengerRef.value?.calls.length).toBeGreaterThan(0);
    });
    expect(endpointHostIdOfFirstCall()).toBe(HOST_B.hostId);
  });

  it("lists the SURFACE's host's file tree, not the app-wide one", async () => {
    renderHook(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- pinning the DEPRECATED fallback's host routing is the point: it is still the old-host path in `epic-sidebar-file-tree.tsx`, and it routed to the app-wide host before this epic
        useWorkspaceListFileTree({
          hostId: HOST_B.hostId,
          workspacePath: "/repo",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(messengerRef.value?.calls.length).toBeGreaterThan(0);
    });
    expect(endpointHostIdOfFirstCall()).toBe(HOST_B.hostId);
  });

  it("follows the app-wide host when the surface names none - the control", async () => {
    // `null` is "this surface has no pin", which must keep meaning "follow the
    // app" rather than "address nothing". Without this the cases above would
    // also pass for a build that had simply hardwired the requester to the id
    // in its params, never resolving anything.
    renderHook(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- pinning the DEPRECATED fallback's host routing is the point: it is still the old-host path in `epic-sidebar-file-tree.tsx`, and it routed to the app-wide host before this epic
        useWorkspaceListFileTree({
          hostId: null,
          workspacePath: "/repo",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(messengerRef.value?.calls.length).toBeGreaterThan(0);
    });
    expect(endpointHostIdOfFirstCall()).toBe(mockLocalHostEntry.hostId);
  });
});
