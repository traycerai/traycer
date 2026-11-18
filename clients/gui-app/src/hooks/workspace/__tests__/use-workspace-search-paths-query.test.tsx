import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useWorkspaceSearchPaths } from "../use-workspace-search-paths-query";

function createFixture() {
  const queryClient = createAppQueryClient();
  let gate: Promise<void> | null = null;
  let requestSeq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq += 1;
      return `req-${String(requestSeq)}`;
    },
    handlers: {
      "workspace.searchPaths": async (params) => {
        if (gate !== null) await gate;
        return {
          epicId: params.epicId,
          root: "root" in params.reference ? params.reference.root : "",
          outcome: "ready" as const,
          results: [
            { kind: "file" as const, relPath: "src/app.ts", name: "app.ts" },
          ],
          truncated: false,
        };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return null;
    },
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    spine,
    client: spine.createRequester(mockLocalHostEntry),
    Wrapper,
    setGate: (next: Promise<void> | null) => {
      gate = next;
    },
  };
}

describe("useWorkspaceSearchPaths", () => {
  afterEach(() => {
    cleanup();
  });

  it("drops placeholder data when the bound host changes", async () => {
    const fixture = createFixture();
    let client = fixture.client;
    const rendered = renderHook(
      () =>
        useWorkspaceSearchPaths({
          client,
          epicId: "epic-1",
          root: "/repo",
          query: "app",
          kinds: "files",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.outcome).toBe("ready");
    });

    let release: () => void = () => undefined;
    fixture.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    // A host switch is now a NEW pinned requester passed on the next render,
    // not a mutation of the same client's bound identity (redesign P4.2
    // deleted the active slot `.bind()` used to drive this).
    act(() => {
      client = fixture.spine.createRequester(mockRemoteHostEntry);
    });
    rendered.rerender();

    await waitFor(() => {
      expect(rendered.result.current.isFetching).toBe(true);
    });
    // Host boundary: the previous host's search results must not render as
    // placeholder data while the new host's request is in flight.
    expect(rendered.result.current.data).toBeUndefined();
    expect(rendered.result.current.isPlaceholderData).toBe(false);

    release();
    await waitFor(() => {
      expect(rendered.result.current.data?.outcome).toBe("ready");
    });
  });
});
